// packages/testkit/src/world.ts — a test world for a Worker module run in Node:
// a GHCR stand-in behind a mock fetch, a Cache API stub with a clock, a ctx that
// collects waitUntil promises, and a capture of console.error. No network.
// A TypeScript port of mirror-archlinux worker/test/world.js at 669ac72, with
// the Worker module and the registry passed in instead of imported.
//
//   const w = world(worker);                    // installs the globals
//   w.manifest("root:latest", [["root.json", digest("a")]]);
//   const res = await w.get("/v1/index/latest");
//   w.close();                                  // restores them
//
// Every response body the stand-in returns is tracked: w.unusedBodies() lists
// the ones the Worker neither read nor cancelled, and inWorld() fails a test
// that leaves one.

export const HOST = "domains.example.test";
// The repository namespace of docs/architecture.md section 4.1.
export const REGISTRY = "https://ghcr.io/v2/pkgforge-dev/domains.pkgforge.dev";
export const BLOB_HOST = "https://pkg-containers.githubusercontent.com";
export const T0 = Date.parse("2026-10-27T03:00:00Z");
export const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";

export const hex = (c: string): string => c.repeat(64);
export const digest = (c: string): string => `sha256:${hex(c)}`;

// A layer as [title, digest, size].
export type LayerSpec = readonly [title: string, digest: string, size?: number];

export function manifestJson(layers: readonly LayerSpec[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: digest("4"), size: 2 },
    layers: layers.map(([title, d, size = 100]) => ({
      mediaType: "application/octet-stream",
      digest: d,
      size,
      annotations: { "org.opencontainers.image.title": title },
    })),
    ...extra,
  });
}

export async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Clock {
  now: number;
}

export interface BodyTrack {
  status: number;
  read: boolean;
  cancelled: boolean;
  url: string;
}

// A body that records whether it was read or cancelled. highWaterMark 0: the
// source is pulled only when a reader asks for data.
function trackedBody(bytes: Uint8Array, track: BodyTrack, chunk = 0): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(c) {
        track.read = true;
        if (off >= bytes.byteLength) {
          c.close();
          return;
        }
        const end = chunk > 0 ? Math.min(off + chunk, bytes.byteLength) : bytes.byteLength;
        c.enqueue(bytes.slice(off, end));
        off = end;
        if (off >= bytes.byteLength) c.close();
      },
      cancel() {
        track.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
}

export interface CacheEntry {
  body: string;
  status: number;
  headers: [string, string][];
  until: number;
}

// The Cache API as the Worker sees it: a GET Request key, a max-age the entry
// expires by on the world's clock, no 206 and no no-store.
export class CacheStub {
  readonly clock: Clock;
  readonly entries = new Map<string, CacheEntry>();
  matches = 0;
  readonly puts: { url: string; ttl: number; body: string }[] = [];
  failMatch = false;
  failPut = false;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async match(key: Request | string): Promise<Response | undefined> {
    this.matches += 1;
    if (this.failMatch) throw new Error("cache stub: match failed");
    const url = typeof key === "string" ? key : key.url;
    const e = this.entries.get(url);
    if (!e) return undefined;
    if (e.until <= this.clock.now) {
      this.entries.delete(url);
      return undefined;
    }
    return new Response(e.body, { status: e.status, headers: e.headers });
  }

  async put(key: Request | string, res: Response): Promise<void> {
    if (this.failPut) throw new Error("cache stub: put failed");
    if (typeof key === "string" || key.method !== "GET") throw new TypeError("cache stub: the key must be a GET Request");
    if (res.status === 206) throw new TypeError("cache stub: 206 cannot be stored");
    const cc = res.headers.get("cache-control") || "";
    const m = /(?:^|,)\s*max-age=(\d+)/.exec(cc);
    if (!m || /no-store/.test(cc)) throw new TypeError(`cache stub: no max-age in "${cc}"`);
    const ttl = Number(m[1]);
    const body = await res.text();
    this.entries.set(key.url, { body, status: res.status, headers: [...res.headers], until: this.clock.now + ttl * 1000 });
    this.puts.push({ url: key.url, ttl, body });
  }

  // The stored entries whose key path starts with /__cache/v1/<kind>/.
  ofKind(kind: string): { url: string; ttl: number; body: string }[] {
    return this.puts.filter((p) => new URL(p.url).pathname.startsWith(`/__cache/v1/${kind}/`));
  }
}

export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface WorkerModule {
  fetch(request: Request, env: unknown, ctx: Ctx): Response | Promise<Response>;
}

export interface WorldOptions {
  // Called first, so each test starts in a new isolate (module-level caches).
  resetIsolate?: () => void;
  env?: unknown;
  host?: string;
  registry?: string;
  t0?: number;
}

type BlobAnswer = true | string | ((url: string, init: RequestInit) => Response | Promise<Response>);

export interface World {
  clock: Clock;
  cache: CacheStub;
  requests: { url: string; init: RequestInit }[];
  errors: unknown[][];
  bodies: BodyTrack[];
  timeouts: number[];
  // GHCR state: manifests by "package:ref", blobs by "package@digest". A blob of
  // `true` answers 307 to a signed URL, a string answers 307 to that location,
  // and a function answers for itself.
  manifests: Map<string, string>;
  blobs: Map<string, BlobAnswer>;
  // Tried before the maps; answering undefined falls through to them.
  intercept: ((url: string, init: RequestInit) => Response | undefined | Promise<Response | undefined>) | null;
  // Seconds from the request time to the signed URL's se.
  seAfter: number;
  response(status: number, body?: string | Uint8Array, headers?: Record<string, string>, opts?: { url?: string; chunk?: number }): Response;
  manifest(repoRef: string, layers: readonly LayerSpec[], extra?: Record<string, unknown>): string;
  signedUrl(d: string): string;
  request(path: string, method?: string, headers?: Record<string, string>): Promise<Response>;
  get(path: string): Promise<Response>;
  head(path: string): Promise<Response>;
  since(from: number): { url: string; init: RequestInit }[];
  unusedBodies(): BodyTrack[];
  advance(seconds: number): void;
  close(): void;
}

export function world(worker: WorkerModule, options: WorldOptions = {}): World {
  options.resetIsolate?.();
  const host = options.host ?? HOST;
  const registry = options.registry ?? REGISTRY;
  const clock: Clock = { now: options.t0 ?? T0 };
  const cache = new CacheStub(clock);
  const saved = {
    fetch: globalThis.fetch,
    caches: Object.getOwnPropertyDescriptor(globalThis, "caches"),
    now: Date.now,
    error: console.error,
    timeout: AbortSignal.timeout,
  };

  const w: World = {
    clock,
    cache,
    requests: [],
    errors: [],
    bodies: [],
    timeouts: [],
    manifests: new Map(),
    blobs: new Map(),
    intercept: null,
    seAfter: 400,

    response(status, body = "", headers = {}, opts = {}) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const track: BodyTrack = { status, read: false, cancelled: false, url: opts.url ?? "" };
      w.bodies.push(track);
      if ([101, 204, 205, 304].includes(status)) {
        // A null body status: there is nothing to read or cancel.
        track.read = true;
        return new Response(null, { status, headers });
      }
      return new Response(trackedBody(bytes, track, opts.chunk ?? 0), { status, headers });
    },

    manifest(repoRef, layers, extra) {
      const body = manifestJson(layers, extra);
      w.manifests.set(repoRef, body);
      return body;
    },

    signedUrl(d) {
      const se = new Date(clock.now + w.seAfter * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      return `${BLOB_HOST}/ghcrblobs10/blobs/${d}?se=${encodeURIComponent(se)}&sig=abc%2Bdef%3D&sp=r`;
    },

    // GET (or METHOD) PATH; waits for every waitUntil promise before it returns.
    async request(path, method = "GET", headers = {}) {
      const pending: Promise<unknown>[] = [];
      const ctx: Ctx = {
        waitUntil: (p) => {
          pending.push(p);
        },
        passThroughOnException: () => {
          throw new Error("test world: passThroughOnException is not used");
        },
      };
      const req = new Request(`https://${host}${path}`, { method, headers });
      const res = await worker.fetch(req, options.env ?? {}, ctx);
      while (pending.length > 0) await Promise.all(pending.splice(0));
      return res;
    },
    get: (path) => w.request(path, "GET"),
    head: (path) => w.request(path, "HEAD"),

    // The requests the Worker made from index FROM on.
    since: (from) => w.requests.slice(from),
    unusedBodies: () => w.bodies.filter((b) => !b.read && !b.cancelled),
    advance(seconds) {
      clock.now += seconds * 1000;
    },

    close() {
      globalThis.fetch = saved.fetch;
      if (saved.caches) Object.defineProperty(globalThis, "caches", saved.caches);
      else Reflect.deleteProperty(globalThis, "caches");
      Date.now = saved.now;
      console.error = saved.error;
      AbortSignal.timeout = saved.timeout;
    },
  };

  globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    w.requests.push({ url, init });
    if (w.intercept) {
      const r = await w.intercept(url, init);
      if (r !== undefined) return r;
    }
    const u = new URL(url);
    if (!u.href.startsWith(`${registry}/`)) throw new Error(`test world: unexpected fetch ${url}`);
    const rest = u.pathname.slice(new URL(registry).pathname.length + 1);
    let m = /^(.+)\/manifests\/(.+)$/.exec(rest);
    if (m) {
      const body = w.manifests.get(`${m[1]}:${decodeURIComponent(m[2] ?? "")}`);
      if (body === undefined) {
        return w.response(404, '{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}', { "content-type": "application/json" }, { url });
      }
      return w.response(200, body, { "content-type": MANIFEST_TYPE, "content-length": String(new TextEncoder().encode(body).byteLength) }, { url });
    }
    m = /^(.+)\/blobs\/(sha256:[0-9a-f]{64})$/.exec(rest);
    if (m) {
      const d = m[2] ?? "";
      const b = w.blobs.get(`${m[1]}@${d}`);
      if (b === undefined) return w.response(404, '{"errors":[{"code":"BLOB_UNKNOWN"}]}', {}, { url });
      if (typeof b === "function") return b(url, init);
      return w.response(307, "", { location: b === true ? w.signedUrl(d) : b, "content-length": "0" }, { url });
    }
    throw new Error(`test world: unexpected GHCR path ${rest}`);
  };
  Object.defineProperty(globalThis, "caches", { value: { default: cache }, configurable: true, writable: true });
  Date.now = () => clock.now;
  console.error = (...args: unknown[]) => {
    w.errors.push(args);
  };
  AbortSignal.timeout = (ms: number) => {
    w.timeouts.push(ms);
    return saved.timeout.call(AbortSignal, ms);
  };
  return w;
}

// Runs FN in a world that SETUP has seeded, and restores the globals after it.
// It also fails the test when a GHCR body was left neither read nor cancelled.
export async function inWorld(worker: WorkerModule, setup: (w: World) => void | Promise<void>, fn: (w: World) => Promise<void>, options: WorldOptions = {}): Promise<void> {
  const w = world(worker, options);
  try {
    await setup(w);
    await fn(w);
    const unused = w.unusedBodies();
    if (unused.length > 0) throw new Error(`GHCR bodies neither read nor cancelled: ${JSON.stringify(unused)}`);
  } finally {
    w.close();
  }
}
