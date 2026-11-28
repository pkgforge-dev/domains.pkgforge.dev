// apps/api/src/ghcr.ts — the Worker's reads of GHCR, through ghcrReader of
// packages/ghcr: the one token flow of this project (mirror-archlinux's,
// ported once from docs/research/reference/ghcr.ts), with its checks. This file
// sets the Worker's limits and reads immutable bodies through its cache tiers.
//
// - Every request sends the dummy token `Bearer QQ==` first. On a 401 or a 403
//   the reader reads the Bearer challenge, accepts the realm only as
//   https://ghcr.io/token, asks it for `repository:<repo>:pull`, and asks once
//   more with that token, which it keeps in the isolate (packages/ghcr).
// - A manifest is at most 64 KiB (MANIFEST_MAX_BYTES), and a subrequest has
//   10 s for its head and 10 s for its body (LIMITS.subrequestMs). The reads of
//   one request's root have 25 s in all (LIMITS.rootMs, root.ts).
// - A blob is read through its 307 with redirect "manual", to an https Location
//   on *.githubusercontent.com, then by Range on that signed URL. The bytes are
//   exactly the range asked for, or the read fails. readRange(repo, digest,
//   start, end) reads [start, end): `end` is exclusive.
// - The reader reads only `pkgforge-dev/domains.pkgforge.dev/<package>`.
import { type ReadTier, USER_AGENT } from "@domains/core";
import { type GhcrReader, ghcrReader, MANIFEST_MAX_BYTES, sha256Digest } from "@domains/ghcr";
import type { ApiCache } from "./cache.ts";
import type { ImmutableKind, ImmutableRange } from "./r2cache.ts";

// TODO/RULES.md section 5, ruling 11: every reader sends the contact, the one
// USER_AGENT of packages/core/src/contact.ts, which scripts/lib/user-agent.mjs
// re-exports.
export { USER_AGENT };

export const LIMITS = Object.freeze({
  // mirror-archlinux's deadline. DOM-007 saw 2 of 30 cold reads of 1 MiB pass
  // it at the blob store on 2026-10-29 and 0 of 30 on 2026-10-30.
  subrequestMs: 10_000,
  // Every read of one request's root: DOM-007's probe Worker capped a whole
  // answer at 25 s. Without it, steps that each stay under 10 s add up, and a
  // token flow on the manifest and the blob reaches about 90 s.
  rootMs: 25_000,
  manifestBytes: MANIFEST_MAX_BYTES,
});

export function readerOf(cache: ApiCache): GhcrReader {
  return ghcrReader({ userAgent: USER_AGENT, cache, timeoutMs: LIMITS.subrequestMs });
}

// What a read of immutable bytes gives, and the tier that served them.
export interface ImmutableRead {
  readonly bytes: Uint8Array;
  readonly tier: ReadTier;
  readonly name: string;
  readonly ref: ImmutableRange | null;
}

export type ImmutableCacheTier = Exclude<ReadTier, "ghcr">;

export interface ImmutableOptions {
  // The blob's size: a read of [0, whole) is the whole blob, held to its digest.
  readonly whole?: number;
  // Only explicitly classified immutable bodies go into R2.
  readonly kind?: ImmutableKind;
  // A block whose bytes failed verification starts at the next tier on retry.
  readonly after?: ImmutableCacheTier;
}

// The name of the `body` entry of the bytes [start, end) of a blob.
export const bodyName = (repo: string, digest: string, start: number, end: number): string => `${repo}@${digest}/${start}-${end}`;

// A caller uses this after its own root, index or block checks pass. A hit
// can refill a nearer tier. An R2 fill uses only verified GHCR bytes.
export function keepImmutable(cache: ApiCache, read: ImmutableRead): void {
  if (read.tier !== "cache") cache.putBytes(read.name, read.bytes);
  if (read.tier === "ghcr" && read.ref !== null) cache.r2?.putVerified(read.ref, read.bytes);
}

// The bytes [start, end) of `digest`: Cache API, admissible R2 slot, or
// GHCR. A whole blob is held to its digest at every tier. A cached entry
// that fails length or digest is a logged miss. The caller confirms any
// remaining checks and keeps the bytes with keepImmutable.
export async function readImmutable(g: GhcrReader, cache: ApiCache, repo: string, digest: string, start: number, end: number, options: ImmutableOptions = {}): Promise<ImmutableRead> {
  const name = bodyName(repo, digest, start, end);
  const isWhole = start === 0 && end === options.whole;
  const kind = options.kind;
  const ref: ImmutableRange | null = kind === undefined ? null : { kind, repo, digest, start, end };
  const found = (bytes: Uint8Array, tier: ReadTier): ImmutableRead => ({ bytes, tier, name, ref });
  const hit = options.after === undefined ? await cache.getBytes(name) : null;
  if (hit !== null) {
    if (hit.byteLength !== end - start) cache.refused(name, `it holds ${hit.byteLength} bytes, not ${end - start}`);
    else if (isWhole && (await sha256Digest(hit)) !== digest) cache.refused(name, "its bytes do not hash to the digest");
    else return found(hit, "cache");
  }
  if (ref !== null && cache.r2 !== undefined && options.after !== "r2") {
    const cached = await cache.r2.get(ref);
    if (cached !== null) {
      if (isWhole && (await sha256Digest(cached)) !== digest) cache.r2.refused(ref.kind, "its bytes do not hash to the digest");
      else return found(cached, "r2");
    }
  }
  const read = await g.readRange(repo, digest, start, end);
  if (isWhole) {
    const got = await sha256Digest(read.bytes);
    if (got !== digest) throw new ImmutableError(`the blob ${digest} of ${repo} hashes to ${got}`);
  }
  return found(read.bytes, "ghcr");
}

// Bytes GHCR gave that are not the bytes their digest names.
export class ImmutableError extends Error {
  override name = "ImmutableError";
}
