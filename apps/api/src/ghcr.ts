// apps/api/src/ghcr.ts — the Worker's reads of GHCR, through ghcrReader of
// packages/ghcr: the one token flow of this project (mirror-archlinux's,
// ported once from docs/research/reference/ghcr.ts), with its checks. This file
// sets the Worker's limits on it and adds the `body` entries of cache.ts.
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
  bytes: Uint8Array;
  tier: ReadTier;
}

export interface ImmutableOptions {
  // The blob's size: a read of [0, whole) is the whole blob, held to its digest.
  readonly whole?: number;
  // Skip the `body` entry and read GHCR: the entry failed a later check.
  readonly fresh?: boolean;
  // false: keep nothing; the caller keeps the bytes (keepBytes) once a later
  // check holds them, as a pack block's CRC-32 does.
  readonly keep?: boolean;
}

// The name of the `body` entry of the bytes [start, end) of a blob.
export const bodyName = (repo: string, digest: string, start: number, end: number): string => `${repo}@${digest}/${start}-${end}`;

// The bytes [start, end) of the blob `digest`: the `body` entry first, else
// GHCR, then kept in `body` for 1 year. A read of the whole blob is also held
// to its digest, from the cache and from GHCR alike; a cached entry that fails
// its length or its digest is a miss, logged.
export async function readImmutable(g: GhcrReader, cache: ApiCache, repo: string, digest: string, start: number, end: number, options: ImmutableOptions = {}): Promise<ImmutableRead> {
  const name = bodyName(repo, digest, start, end);
  const isWhole = start === 0 && end === options.whole;
  const hit = options.fresh === true ? null : await cache.getBytes(name);
  if (hit !== null) {
    if (hit.byteLength !== end - start) cache.refused(name, `it holds ${hit.byteLength} bytes, not ${end - start}`);
    else if (isWhole && (await sha256Digest(hit)) !== digest) cache.refused(name, "its bytes do not hash to the digest");
    else return { bytes: hit, tier: "cache" };
  }
  const read = await g.readRange(repo, digest, start, end);
  if (isWhole) {
    const got = await sha256Digest(read.bytes);
    if (got !== digest) throw new ImmutableError(`the blob ${digest} of ${repo} hashes to ${got}`);
  }
  if (options.keep !== false) cache.putBytes(name, read.bytes);
  return { bytes: read.bytes, tier: "ghcr" };
}

// Bytes GHCR gave that are not the bytes their digest names.
export class ImmutableError extends Error {
  override name = "ImmutableError";
}
