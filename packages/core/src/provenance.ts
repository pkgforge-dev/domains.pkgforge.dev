// packages/core/src/provenance.ts — the `x-domains-*` headers of
// docs/architecture.md section 7.1, built from an explicit record of what
// answered. A header names only what the path used (AGENTS.md absolute 11).
//
//   const headers = provenanceHeaders({
//     root: "sha256:<64 hex>", asOf: "2026-10-27T05:50:00Z",
//     reads: [{ tier: "ghcr", pack: "names-d-20261026", sources: ["thc-ct", "oi-nrd"] }],
//     cache: "ghcr", sourcesUsed: ["thc-ct"], body: "derived",
//   });
//
// The record lists every read the answer used, each with the tier that served
// its bytes and the sources its pack holds. The builder refuses (throws
// ProvenanceError), never corrects:
//   - a `cache` value that differs from the one the reads give: one tier read
//     gives that tier (`hit` for the Cache API), two or more give `mixed`, so
//     `cache: "r2"` with no R2 read is refused;
//   - a source in `sourcesUsed` that no read lists, or one that also failed;
//   - a `verbatim` body that is not one pack read whole;
//   - a malformed root digest, time, pack or source id.
// `x-domains-degraded: 1` is derived, not claimed: it is set when the answer
// used stale data or a source failed, and absent otherwise.

export type ReadTier = "cache" | "r2" | "ghcr";
export type CacheValue = "hit" | "r2" | "ghcr" | "mixed";

export interface PackRead {
  // Which tier served the bytes of this read.
  tier: ReadTier;
  // The pack, segment or root the read took, as its GHCR tag or digest.
  pack: string;
  // The source ids whose records the pack holds.
  sources: readonly string[];
}

export interface ProvenanceRecord {
  // The digest of the root the answer was computed from.
  root: string;
  // The root's `as_of`, ISO 8601 UTC to the second.
  asOf: string;
  reads: readonly PackRead[];
  // The cache value the path reports; it must equal the one the reads give.
  cache: CacheValue;
  sourcesUsed: readonly string[];
  sourcesFailed?: readonly string[];
  body: "derived" | "verbatim";
  // True when the answer used data older than its tier's freshness.
  stale?: boolean;
}

export class ProvenanceError extends Error {
  override name = "ProvenanceError";
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A GHCR tag (docs/architecture.md section 4.1) or a digest.
const PACK = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[0-9a-f]{64})$/;
const TIER_VALUE: Readonly<Record<ReadTier, CacheValue>> = { cache: "hit", r2: "r2", ghcr: "ghcr" };

const fail = (message: string): never => {
  throw new ProvenanceError(`provenance: ${message}`);
};

function sourceIds(list: readonly string[], what: string): string[] {
  for (const id of list) if (!SOURCE_ID.test(id)) fail(`${what} holds "${id}", which is not a source id`);
  return [...new Set(list)].sort();
}

// The cache value the reads give: the one tier they used, or `mixed`.
export function cacheOf(reads: readonly PackRead[]): CacheValue {
  const tiers = new Set(reads.map((r) => r.tier));
  if (tiers.size === 0) return fail("the record holds no read");
  if (tiers.size > 1) return "mixed";
  const [only] = tiers;
  return only === undefined ? fail("the record holds no read") : TIER_VALUE[only];
}

export function provenanceHeaders(record: ProvenanceRecord): Record<string, string> {
  if (!DIGEST.test(record.root)) fail(`root "${record.root}" is not sha256:<64 hex>`);
  if (!UTC_SECOND.test(record.asOf) || Number.isNaN(Date.parse(record.asOf))) fail(`as_of "${record.asOf}" is not an ISO 8601 UTC time to the second`);
  for (const r of record.reads) {
    if (!Object.hasOwn(TIER_VALUE, r.tier)) fail(`a read names the tier "${r.tier}"`);
    if (!PACK.test(r.pack)) fail(`a read names the pack "${r.pack}", which is neither a tag nor a digest`);
    sourceIds(r.sources, `the read of ${r.pack}`);
  }
  const cache = cacheOf(record.reads);
  if (record.cache !== cache) fail(`cache "${record.cache}" is claimed, but the reads give "${cache}"`);

  const read = new Set(record.reads.flatMap((r) => r.sources));
  const used = sourceIds(record.sourcesUsed, "sources_used");
  const failed = sourceIds(record.sourcesFailed ?? [], "sources_failed");
  for (const id of used) {
    if (!read.has(id)) fail(`source "${id}" is reported as used, but no read holds it`);
    if (failed.includes(id)) fail(`source "${id}" is reported as both used and failed`);
  }

  const packs = new Set(record.reads.map((r) => r.pack));
  if (record.body === "verbatim" && packs.size !== 1) fail(`a verbatim body comes from one stored object, and the reads name ${packs.size}`);
  if (record.body !== "verbatim" && record.body !== "derived") fail(`body "${record.body}" is neither derived nor verbatim`);

  const headers: Record<string, string> = {
    "x-domains-root": record.root,
    "x-domains-as-of": record.asOf,
    "x-domains-tiers-read": String(packs.size),
    "x-domains-sources-used": used.join(","),
    "x-domains-cache": cache,
    "x-domains-body": record.body,
  };
  if (failed.length > 0) headers["x-domains-sources-failed"] = failed.join(",");
  if (record.stale === true || failed.length > 0) headers["x-domains-degraded"] = "1";
  return headers;
}
