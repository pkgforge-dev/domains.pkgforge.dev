// apps/api/src/cache.ts — the Worker's Cache API entries (docs/worker.md,
// "Caching"; docs/architecture.md section 7.5).
//
// The Cache API is per data centre and does not replicate. Every key is a GET
// request on the request host under CACHE_PREFIX, so changing /__cache/v1 to
// /__cache/v2 clears every entry with one deploy. A cache that fails is a miss,
// never a failed answer: each failure is logged with the request's id, and a
// write runs in ctx.waitUntil, after the answer.
//
// | entry  | holds                                   | time to live                                  |
// | ------ | --------------------------------------- | --------------------------------------------- |
// | `man`  | a manifest, by repository and reference | `latest` and any tag 30 s; a digest 1 year    |
// | `blob` | a blob's signed URL                     | its `se` less 120 s, at most 600 s            |
// | `body` | immutable bytes, by digest and range    | 1 year                                        |
//
// `man` and `blob` are what ghcrReader of packages/ghcr keeps through its
// GhcrCache; this file maps the reader's keys to entries and sets their time to
// live, which is the Worker's own (the table above), not the reader's defaults.
// The reader still checks what it reads back: a manifest against its digest, a
// signed URL against its host and its `se`. `body` is read back through
// readImmutable of ghcr.ts, which checks every entry's length and a whole
// blob's digest; a pack block's entry is written only once its CRC-32 held,
// and one that later fails it is read again from GHCR (pack.ts).
// No `token` entry: a pull token stays in the isolate (packages/ghcr). No `loc`
// entry: no route of DOM-030 answers a location.
import { DIGEST, type GhcrCache, SIGNED_MARGIN_S } from "@domains/ghcr";

export const CACHE_PREFIX = "/__cache/v1";
const YEAR_S = 365 * 24 * 60 * 60;
export const TTL_S = Object.freeze({
  manifestByTag: 30,
  manifestByDigest: YEAR_S,
  // A signed URL is kept until its se less this margin, and at most signedMax.
  signedMargin: 120,
  signedMax: 600,
  body: YEAR_S,
});

export type EntryKind = "man" | "blob" | "body";

// The Cache API as this Worker uses it: workerd's caches.default, or the
// testkit's stub in Node.
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export function defaultCache(): CacheLike {
  return (globalThis as unknown as { caches: { default: CacheLike } }).caches.default;
}

// The entry and time to live of a key of ghcrReader, or null for a key this
// Worker does not keep. `readerTtl` is the reader's own: for a signed URL it is
// min(se - now, SIGNED_MAX_S) - SIGNED_MARGIN_S, so less
// (signedMargin - SIGNED_MARGIN_S) it is se - now - signedMargin.
export function entryOf(key: string, readerTtl: number): { kind: EntryKind; name: string; ttl: number } | null {
  const m = /^ghcr:([mu]):(.+)$/.exec(key);
  if (!m) return null;
  const name = m[2] ?? "";
  if (m[1] === "m") {
    const ref = name.slice(name.lastIndexOf("@") + 1);
    return { kind: "man", name, ttl: DIGEST.test(ref) ? TTL_S.manifestByDigest : TTL_S.manifestByTag };
  }
  return { kind: "blob", name, ttl: Math.min(readerTtl - (TTL_S.signedMargin - SIGNED_MARGIN_S), TTL_S.signedMax) };
}

export interface ApiCacheOptions {
  // The request host: every key is on it.
  host: string;
  // The request's id for the log (cf-ray), never a caller's value beyond it.
  ray: string;
  waitUntil: (p: Promise<unknown>) => void;
  cache?: CacheLike;
}

// The Cache API entries of one request: the GhcrCache of its reader, and the
// `body` entries.
export class ApiCache implements GhcrCache {
  readonly #host: string;
  readonly #ray: string;
  readonly #waitUntil: (p: Promise<unknown>) => void;
  readonly #cache: CacheLike | null;

  constructor(options: ApiCacheOptions) {
    this.#host = options.host;
    this.#ray = options.ray;
    this.#waitUntil = options.waitUntil;
    let cache: CacheLike | null = options.cache ?? null;
    if (cache === null) {
      try {
        cache = defaultCache();
      } catch {
        // No Cache API in this runtime: every read is a miss, and fail() logs it.
        cache = null;
      }
    }
    this.#cache = cache ?? null;
  }

  key(kind: EntryKind, name: string): Request {
    return new Request(`https://${this.#host}${CACHE_PREFIX}/${kind}/${encodeURIComponent(name)}`);
  }

  #fail(what: string, err: unknown): void {
    console.error(`domains-pkgforge-dev ${this.#ray}: cache ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  async #match(kind: EntryKind, name: string): Promise<Response | null> {
    if (this.#cache === null) {
      this.#fail(`read of ${kind}`, new Error("no Cache API"));
      return null;
    }
    try {
      return (await this.#cache.match(this.key(kind, name))) ?? null;
    } catch (err) {
      this.#fail(`read of ${kind}`, err);
      return null;
    }
  }

  #store(kind: EntryKind, name: string, body: string | Uint8Array<ArrayBuffer>, contentType: string, ttl: number): void {
    const seconds = Math.floor(ttl);
    if (!(seconds >= 1) || this.#cache === null) return;
    const cache = this.#cache;
    const response = new Response(body, { headers: { "content-type": contentType, "cache-control": `max-age=${seconds}` } });
    this.#waitUntil(cache.put(this.key(kind, name), response).catch((err: unknown) => this.#fail(`write of ${kind}`, err)));
  }

  // GhcrCache: a key of ghcrReader, as text.
  async get(key: string): Promise<string | null> {
    const entry = entryOf(key, 0);
    if (entry === null) return null;
    const res = await this.#match(entry.kind, entry.name);
    if (res === null) return null;
    try {
      return await res.text();
    } catch (err) {
      this.#fail(`read of ${entry.kind}`, err);
      return null;
    }
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    const entry = entryOf(key, ttlSeconds);
    if (entry === null) return;
    this.#store(entry.kind, entry.name, value, "text/plain; charset=utf-8", entry.ttl);
  }

  // A `body` entry: immutable bytes by repository, digest and range.
  async getBytes(name: string): Promise<Uint8Array | null> {
    const res = await this.#match("body", name);
    if (res === null) return null;
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      this.#fail("read of body", err);
      return null;
    }
  }

  putBytes(name: string, bytes: Uint8Array): void {
    this.#store("body", name, bytes.slice(), "application/octet-stream", TTL_S.body);
  }

  // A `body` entry that did not hold the bytes its name promises: logged as a
  // failed read, so the caller reads GHCR instead.
  refused(name: string, why: string): void {
    this.#fail(`read of body ${name}`, new Error(why));
  }
}
