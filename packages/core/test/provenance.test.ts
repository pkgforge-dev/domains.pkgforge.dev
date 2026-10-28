// packages/core/src/provenance.ts: the x-domains-* headers say what answered and
// nothing the record does not show (AGENTS.md absolute 11). A cache value the
// reads do not give, a source no read holds, and a verbatim body from more than
// one object are refused; degraded is derived from staleness and failures.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProvenanceRecord } from "../src/provenance.ts";
import { cacheOf, ProvenanceError, provenanceHeaders } from "../src/provenance.ts";

const ROOT = `sha256:${"a".repeat(64)}`;
const base = (over: Partial<ProvenanceRecord> = {}): ProvenanceRecord => ({
  root: ROOT,
  asOf: "2026-10-27T05:50:00Z",
  reads: [
    { tier: "ghcr", pack: "names-d-20261026", sources: ["thc-ct", "oi-nrd"] },
    { tier: "ghcr", pack: "names-h-2026102705", sources: ["oi-nrd"] },
  ],
  cache: "ghcr",
  sourcesUsed: ["thc-ct", "oi-nrd"],
  body: "derived",
  ...over,
});

test("provenance: a GHCR answer names its root, time, pack count, sources, cache and body, and nothing else", () => {
  assert.deepEqual(provenanceHeaders(base()), {
    "x-domains-root": ROOT,
    "x-domains-as-of": "2026-10-27T05:50:00Z",
    "x-domains-tiers-read": "2",
    "x-domains-sources-used": "oi-nrd,thc-ct",
    "x-domains-cache": "ghcr",
    "x-domains-body": "derived",
  });
});

test("provenance: cache r2 with no R2 read is refused", () => {
  assert.throws(
    () => provenanceHeaders(base({ cache: "r2" })),
    (err: unknown) => err instanceof ProvenanceError && /cache "r2" is claimed, but the reads give "ghcr"/.test(err.message),
  );
});

test("provenance: one tier gives that tier, the Cache API gives hit, and two tiers give mixed", () => {
  assert.equal(cacheOf([{ tier: "cache", pack: "root-latest", sources: [] }]), "hit");
  assert.equal(cacheOf([{ tier: "r2", pack: "feed-h-2026102608", sources: [] }]), "r2");
  const reads = [
    { tier: "cache" as const, pack: "names-d-20261026", sources: ["thc-ct"] },
    { tier: "r2" as const, pack: "feed-h-2026102608", sources: ["oi-nrd"] },
  ];
  assert.equal(cacheOf(reads), "mixed");
  assert.equal(provenanceHeaders(base({ reads, cache: "mixed" }))["x-domains-cache"], "mixed");
  for (const claim of ["hit", "r2", "ghcr"] as const) assert.throws(() => provenanceHeaders(base({ reads, cache: claim })), ProvenanceError, claim);
});

test("provenance: a record with no read is refused", () => {
  assert.throws(() => provenanceHeaders(base({ reads: [], sourcesUsed: [] })), /no read/);
});

test("provenance: a source that no read holds is refused", () => {
  assert.throws(() => provenanceHeaders(base({ sourcesUsed: ["thc-ct", "ct-geomys"] })), /source "ct-geomys" is reported as used, but no read holds it/);
});

test("provenance: a source reported as both used and failed is refused", () => {
  assert.throws(() => provenanceHeaders(base({ sourcesFailed: ["thc-ct"] })), /both used and failed/);
});

test("provenance: a failed source sets sources-failed and degraded; stale sets degraded alone; neither sets both absent", () => {
  const failed = provenanceHeaders(base({ sourcesUsed: ["oi-nrd"], sourcesFailed: ["ct-geomys", "ct-geomys"] }));
  assert.equal(failed["x-domains-sources-failed"], "ct-geomys");
  assert.equal(failed["x-domains-degraded"], "1");
  const stale = provenanceHeaders(base({ stale: true }));
  assert.equal(stale["x-domains-sources-failed"], undefined);
  assert.equal(stale["x-domains-degraded"], "1");
  const clean = provenanceHeaders(base({ stale: false }));
  assert.equal("x-domains-sources-failed" in clean, false);
  assert.equal("x-domains-degraded" in clean, false);
});

test("provenance: a verbatim body is one stored object read whole", () => {
  const one = [{ tier: "ghcr" as const, pack: "names-20261026", sources: ["thc-ct"] }];
  assert.equal(provenanceHeaders(base({ reads: one, sourcesUsed: ["thc-ct"], body: "verbatim" }))["x-domains-body"], "verbatim");
  assert.throws(() => provenanceHeaders(base({ body: "verbatim" })), /verbatim body comes from one stored object, and the reads name 2/);
});

test("provenance: tiers-read counts distinct packs, not reads", () => {
  const reads = [
    { tier: "ghcr" as const, pack: "names-d-20261026", sources: ["thc-ct"] },
    { tier: "ghcr" as const, pack: "names-d-20261026", sources: ["thc-ct"] },
  ];
  assert.equal(provenanceHeaders(base({ reads, sourcesUsed: ["thc-ct"] }))["x-domains-tiers-read"], "1");
});

test("provenance: a malformed root, time, tier, pack, source id or body is refused, each for its own fault", () => {
  // `as never` feeds a value the type forbids, as a caller from JSON could.
  const cases: [Partial<ProvenanceRecord>, RegExp][] = [
    [{ root: "sha256:abc" }, /root "sha256:abc"/],
    [{ root: `sha512:${"a".repeat(64)}` }, /root "sha512:/],
    // The digest is the whole value: no text before or after it.
    [{ root: `${ROOT}x` }, /root "sha256:a{64}x"/],
    [{ root: `x${ROOT}` }, /root "xsha256:/],
    [{ root: `${ROOT}\n` }, /root "sha256:a{64}\n"/],
    [{ asOf: "2026-10-27 05:50:00" }, /as_of "2026-10-27 05:50:00"/],
    [{ asOf: "2026-10-27T05:50:00.123Z" }, /as_of "2026-10-27T05:50:00\.123Z"/],
    [{ asOf: "2026-13-45T99:99:99Z" }, /as_of "2026-13-45T99:99:99Z"/],
    [{ reads: [{ tier: "disk" as never, pack: "names-d-20261026", sources: ["thc-ct"] }], sourcesUsed: [] }, /tier "disk"/],
    [{ reads: [{ tier: "ghcr", pack: "../etc", sources: ["thc-ct"] }], sourcesUsed: [] }, /pack "\.\.\/etc"/],
    [{ reads: [{ tier: "ghcr", pack: "names-d-20261026", sources: ["THC_CT"] }], sourcesUsed: [] }, /"THC_CT", which is not a source id/],
    [{ sourcesUsed: ["thc ct"] }, /sources_used holds "thc ct"/],
    [{ sourcesUsed: ["oi-nrd"], sourcesFailed: ["ct-geomys", "CT GEOMYS"] }, /sources_failed holds "CT GEOMYS"/],
    [{ body: "raw" as never }, /body "raw"/],
  ];
  for (const [c, message] of cases)
    assert.throws(
      () => provenanceHeaders(base(c)),
      (err: unknown) => err instanceof ProvenanceError && message.test(err.message),
      JSON.stringify(c),
    );
});
