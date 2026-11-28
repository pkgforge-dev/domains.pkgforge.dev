// The only R2 write door uses this fixed set of keys. A put replaces one
// object at a slot, with the body and its identity committed together. A
// collision, concurrent overwrite or failed write can lose a cache hit, and
// cannot create a key outside the table. Keep the key layout stable across
// deployments. The bound assumes a dedicated bucket and no other writer.
import { DIGEST, repoOf, sha256Digest, TIER_DATASETS } from "@domains/ghcr";

export const MAX_BUCKET_BYTES = 5_000_000_000;
// Allow the provider's full object key and metadata limits at every slot.
const OVERHEAD_PER_SLOT = 1_024 + 8_192;
const DAY_MS = 86_400_000;
const MIB = 1_048_576;
const ROOT_REPO = repoOf("root");
const PACK_REPOS = new Set([repoOf("obs"), ...Object.values(TIER_DATASETS).map(repoOf)]);
const LOOKUP_MS = 250;
const MAX_LOOKUPS = 8;
const IDENTITY_VERSION = 1;
const IDENTITY_MAX_BYTES = 256;

export type ImmutableKind = "root" | "idx" | "blk";

export const R2_SLOTS = Object.freeze(
  [
    { kind: "root", prefix: "root", slots: 5, bodyBytes: 8 * MIB, ttlDays: 365 },
    { kind: "idx", prefix: "idx", slots: 476, bodyBytes: MIB, ttlDays: 365 },
    // This pool is reserved for a future warmer and has no current put door.
    { kind: "hot", prefix: "hot", slots: 760, bodyBytes: MIB, ttlDays: 7 },
    { kind: "blk", prefix: "blk/s", slots: 65_536, bodyBytes: 32_768, ttlDays: 14 },
    { kind: "blk", prefix: "blk/m", slots: 4_096, bodyBytes: 131_072, ttlDays: 14 },
    { kind: "blk", prefix: "blk/l", slots: 14, bodyBytes: MIB, ttlDays: 14 },
  ].map((pool) => Object.freeze(pool)),
);

export const R2_CAPACITY_BYTES = R2_SLOTS.reduce((sum, pool) => sum + pool.slots * (pool.bodyBytes + OVERHEAD_PER_SLOT), 0);
if (R2_CAPACITY_BYTES > MAX_BUCKET_BYTES) throw new Error("R2 slot capacity exceeds 5 GB");

export interface ImmutableRange {
  readonly kind: ImmutableKind;
  readonly repo: string;
  readonly digest: string;
  readonly start: number;
  readonly end: number;
}

interface Candidate {
  readonly kind: ImmutableKind;
  readonly identity: string;
  readonly length: number;
  readonly pool: (typeof R2_SLOTS)[number];
}

function candidateOf({ kind, repo, digest, start, end }: ImmutableRange): Candidate | null {
  if (kind !== "root" && kind !== "idx" && kind !== "blk") return null;
  if (kind === "root" ? repo !== ROOT_REPO : !PACK_REPOS.has(repo)) return null;
  if (!DIGEST.test(digest) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || (kind !== "blk" && start !== 0)) return null;
  const length = end - start;
  const pool = R2_SLOTS.find((item) => item.kind === kind && length <= item.bodyBytes);
  if (pool === undefined) return null;
  // The allowed repositories, digest and non-negative safe integers are all
  // ASCII. The full range identity distinguishes objects sharing a slot.
  const identity = JSON.stringify([IDENTITY_VERSION, kind, repo, digest, start, end]);
  return identity.length <= IDENTITY_MAX_BYTES ? { kind, identity, length, pool } : null;
}

async function keyOf({ identity, pool }: Candidate): Promise<string> {
  const digest = await sha256Digest(new TextEncoder().encode(identity));
  const pick = Number.parseInt(digest.slice("sha256:".length, "sha256:".length + 8), 16) % pool.slots;
  return `${pool.prefix}/${String(pick).padStart(5, "0")}`;
}

// Exposes only the deterministic address for audits and fixtures. Neither
// cache operation accepts a key from the caller.
export async function r2SlotKey(ref: ImmutableRange): Promise<string | null> {
  const candidate = candidateOf(ref);
  return candidate === null ? null : keyOf(candidate);
}

interface R2Value {
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
  readonly customMetadata?: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
}

// Exactly the two R2 binding operations used here. The Node fixture uses a
// structural double and the Worker binding supplies the same methods.
export interface R2CacheBucket {
  get(key: string): Promise<R2Value | null>;
  put(key: string, body: ArrayBuffer, options: { customMetadata: Record<string, string> }): Promise<unknown>;
}

interface R2CacheOptions {
  readonly bucket: R2CacheBucket;
  readonly waitUntil: (p: Promise<unknown>) => void;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly lookupMs?: number;
}

// Enforce the body length during reading as well as checking object metadata.
// A timed-out read cancels its stream when the binding hands it back, even
// when it arrives after the caller has moved on to GHCR.
async function boundedBody(body: ReadableStream<Uint8Array>, size: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  let canceled: Promise<void> | undefined;
  const cancel = (): void => {
    canceled ??= reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const bytes = new Uint8Array(size);
  let at = 0;
  let done = false;
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        return !signal.aborted && at === size ? bytes : null;
      }
      if (chunk.value.byteLength === 0 || chunk.value.byteLength > size - at) return null;
      bytes.set(chunk.value, at);
      at += chunk.value.byteLength;
    }
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!done) cancel();
    reader.releaseLock();
    await canceled;
  }
}

// One observer/cache per request. Capping lookups and admitting one background
// copy bounds its R2 work. An outstanding non-abortable binding GET continues
// to occupy the one read slot if the request timed it out.
export class R2Cache {
  readonly #options: R2CacheOptions;
  #lookups = 0;
  #reading = false;
  #putAdmitted = false;

  constructor(options: R2CacheOptions) {
    this.#options = options;
  }

  async get(ref: ImmutableRange): Promise<Uint8Array<ArrayBuffer> | null> {
    const candidate = candidateOf(ref);
    if (candidate === null || this.#reading || this.#lookups >= MAX_LOOKUPS) return null;
    this.#reading = true;
    this.#lookups += 1;
    const cancel = new AbortController();
    const lookupMs = this.#options.lookupMs ?? LOOKUP_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        cancel.abort();
        this.#options.log(`R2 ${candidate.kind} lookup exceeded ${lookupMs} ms`);
        resolve(null);
      }, lookupMs);
    });
    try {
      return await Promise.race([this.#get(candidate, cancel.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #get(candidate: Candidate, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const key = await keyOf(candidate);
      if (signal.aborted) return null;
      const value = await this.#options.bucket.get(key);
      if (value === null) return null;
      const age = value.uploaded instanceof Date ? (this.#options.now ?? Date.now)() - value.uploaded.getTime() : Number.NaN;
      if (signal.aborted || value.key !== key || value.customMetadata?.identity !== candidate.identity || !Number.isFinite(age) || age < 0 || age >= candidate.pool.ttlDays * DAY_MS) {
        await value.body.cancel();
        return null;
      }
      if (value.size !== candidate.length) {
        await value.body.cancel();
        this.refused(candidate.kind, "wrong object size");
        return null;
      }
      const bytes = await boundedBody(value.body, candidate.length, signal);
      if (bytes === null && !signal.aborted) this.refused(candidate.kind, "wrong body length");
      return bytes;
    } catch {
      if (!signal.aborted) this.refused(candidate.kind, "binding or body read failed");
      return null;
    } finally {
      this.#reading = false;
    }
  }

  refused(kind: ImmutableKind, why: string): void {
    this.#options.log(`R2 ${kind} read failed: ${why}`);
  }

  // The caller has checked the GHCR bytes against the digest (whole blob)
  // or the held pack entry (block). The copy decouples it from the caller's
  // buffer before any asynchronous work. Only a bounded slot key is written.
  putVerified(ref: ImmutableRange, bytes: Uint8Array): void {
    const candidate = candidateOf(ref);
    if (candidate === null || bytes.byteLength !== candidate.length || this.#putAdmitted) return;
    this.#putAdmitted = true;
    const copy = new Uint8Array(bytes);
    this.#options.waitUntil(this.#put(candidate, copy.buffer));
  }

  async #put(candidate: Candidate, bytes: ArrayBuffer): Promise<void> {
    try {
      const key = await keyOf(candidate);
      await this.#options.bucket.put(key, bytes, { customMetadata: { identity: candidate.identity } });
    } catch {
      this.#options.log(`R2 ${candidate.kind} fill failed`);
    }
  }
}
