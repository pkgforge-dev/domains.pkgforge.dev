// packManifest and tagDecision: the manifest of a compacted pack, held to what
// the promotion accepts (packFromManifest of @domains/root), and whether a
// compaction writes and under which tag (section 4.7 rule 1, ruling 25).
// Synthetic packs; the digests of the blobs are of their bytes.
//
//   node scripts/test.mjs packages/compact --name "manifest|tag"
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { packFromManifest } from "@domains/root";
import { FEED_CODEC, FEED_TIME_CODEC, NAMES_CODEC } from "@domains/pack";
import { writerId } from "@domains/pack/node";
import { CompactError, EMPTY_CONFIG, type ManifestInput, packManifest, tagDecision } from "../src/index.ts";
import { feedPack, feedRows, keys, memPack, nameRecords } from "./helpers.ts";

const PSL = "1f96bae40adfc22ca2474d7c0099bbcfcb25aefd3e2547b5c2147c0dd2e3ebd9";
const digestOf = (b: Uint8Array) => ({ digest: `sha256:${createHash("sha256").update(b).digest("hex")}`, size: b.length });
const DAY0 = (Date.UTC(2026, 9, 26) - Date.UTC(2026, 0, 1)) / 1000;

async function namesInput(): Promise<ManifestInput> {
  const p = await memPack(nameRecords(keys(1, 30), 0, 298), NAMES_CODEC);
  return {
    dataset: "names",
    tier: "d",
    span: { start: "2026-10-26T00:00:00Z", end: "2026-10-27T00:00:00Z" },
    tag: "names-d-20261026",
    sources: ["oi-cs", "thc-ct"],
    psl: PSL,
    run: "40905625954",
    summary: p.summary,
    writer: writerId(),
    parts: p.parts.map(digestOf),
    idx: digestOf(p.summary.idx),
  };
}

test("manifest: a names day pack's manifest has its layers in order and the annotations the promotion reads", async () => {
  const input = await namesInput();
  const m = packManifest(input);
  assert.equal(m.json.artifactType, "application/vnd.pkgforge.domains.pack.v1");
  assert.deepEqual(m.json.config, { ...EMPTY_CONFIG });
  assert.equal(EMPTY_CONFIG.digest, "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  const layers = m.json.layers as { annotations: Record<string, string>; digest: string; size: number; mediaType: string }[];
  assert.deepEqual(
    layers.map((l) => l.annotations["org.opencontainers.image.title"]),
    [...input.parts.map((_, i) => `part.${String(i).padStart(3, "0")}`), "idx"],
  );
  assert.ok(layers.every((l) => l.mediaType === "application/octet-stream"));
  assert.equal(m.digest, `sha256:${createHash("sha256").update(m.text).digest("hex")}`);
  assert.deepEqual(m.annotations, {
    "dev.pkgforge.domains.dataset": "names",
    "dev.pkgforge.domains.count": String(input.summary.records),
    "dev.pkgforge.domains.bytes": String(input.summary.bytes),
    "dev.pkgforge.domains.sha256": input.summary.sha256,
    "dev.pkgforge.domains.writer": input.writer,
    "dev.pkgforge.domains.tier": "d",
    "dev.pkgforge.domains.span.start": "2026-10-26T00:00:00Z",
    "dev.pkgforge.domains.span.end": "2026-10-27T00:00:00Z",
    "dev.pkgforge.domains.psl": PSL,
    "dev.pkgforge.domains.source": "oi-cs,thc-ct",
    "dev.pkgforge.domains.run": "40905625954",
    "org.opencontainers.image.created": "2026-10-27T00:00:00Z",
    "org.opencontainers.image.source": "https://github.com/pkgforge-dev/domains.pkgforge.dev",
  });
  // The promotion reads it as the root's entry for the pack.
  const head = { dataset: 1, records: input.summary.records, keyMin: input.summary.keyMin, keyMax: input.summary.keyMax, parts: input.summary.parts.map((p) => p.bytes) };
  const entry = packFromManifest({ repo: "pkgforge-dev/domains.pkgforge.dev/names", tag: input.tag, digest: m.digest, json: m.json, head }).pack;
  assert.equal(entry.count, input.summary.records);
  assert.deepEqual(entry.sources, ["oi-cs", "thc-ct"]);
});

test("manifest: a feed week pack carries its time copy, the layers time.part.NNN and time.idx after idx", async () => {
  const rows = feedRows(keys(3, 40), DAY0 - 7 * 86_400, 5);
  const f = await feedPack(rows, FEED_CODEC, FEED_TIME_CODEC);
  const input: ManifestInput = {
    dataset: "feed",
    tier: "w",
    span: { start: "2026-10-19T00:00:00Z", end: "2026-10-26T00:00:00Z" },
    tag: "feed-w-2026w43",
    sources: ["isc-new", "oi-nrd"],
    psl: PSL,
    run: "1",
    summary: f.key.summary,
    writer: writerId(),
    parts: f.key.parts.map(digestOf),
    idx: digestOf(f.key.summary.idx),
    time: { idxBytes: f.time.summary.idx, parts: f.time.parts.map(digestOf), idx: digestOf(f.time.summary.idx) },
  };
  const m = packManifest(input);
  const titles = (m.json.layers as { annotations: Record<string, string> }[]).map((l) => l.annotations["org.opencontainers.image.title"]);
  assert.deepEqual(titles.slice(-2), [`time.part.${String(f.time.parts.length - 1).padStart(3, "0")}`, "time.idx"]);
  assert.equal(titles.indexOf("idx"), f.key.parts.length);
  // A feed week pack of records with no time copy is refused (time).
  assert.throws(
    () => packManifest({ ...input, time: null }),
    (e: unknown) => e instanceof CompactError && e.code === "time",
  );
});

test("manifest: a part whose size the index does not give, one source with no precision, or a tag of another span is refused", async () => {
  const input = await namesInput();
  assert.throws(
    () => packManifest({ ...input, parts: [{ ...input.parts[0], size: input.parts[0].size + 1 }] }),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /part\.000 is \d+ B and the index gives it/.test(e.message),
  );
  assert.throws(
    () => packManifest({ ...input, sources: ["thc-ct"] }),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /no precision/.test(e.message),
  );
  assert.equal(packManifest({ ...input, sources: ["thc-ct"], precision: "day" }).annotations["dev.pkgforge.domains.precision"], "day");
  assert.throws(
    () => packManifest({ ...input, tag: "names-d-20261027" }),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /the promotion would refuse this manifest/.test(e.message),
  );
  assert.throws(
    () => packManifest({ ...input, run: "run-1" }),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /not a workflow run id/.test(e.message),
  );
});

test("tag: a unit already built is present, and a re-run skips; a rebuild takes -r2, then -r3 (ruling 25)", () => {
  const start = "2026-10-26T00:00:00Z";
  assert.deepEqual(tagDecision("names", "d", start, [], false), { action: "write", tag: "names-d-20261026", builds: [] });
  assert.deepEqual(tagDecision("names", "d", start, ["names-d-20261025", "names-d-20261026"], false), { action: "present", tag: "names-d-20261026", builds: ["names-d-20261026"] });
  assert.deepEqual(tagDecision("names", "d", start, ["names-d-20261026"], true), { action: "write", tag: "names-d-20261026-r2", builds: ["names-d-20261026"] });
  assert.deepEqual(tagDecision("names", "d", start, ["names-d-20261026-r2", "NAMES-D-20261026", "names-d-20261026-rx"], true), {
    action: "write",
    tag: "names-d-20261026-r3",
    builds: ["names-d-20261026", "names-d-20261026-r2"],
  });
  assert.deepEqual(tagDecision("names", "d", start, ["names-d-20261026-r2", "names-d-20261026"], false), {
    action: "present",
    tag: "names-d-20261026-r2",
    builds: ["names-d-20261026", "names-d-20261026-r2"],
  });
  // A rebuild of a span with no build is its first build: no suffix.
  assert.deepEqual(tagDecision("names", "d", start, [], true), { action: "write", tag: "names-d-20261026", builds: [] });
  assert.throws(
    () => tagDecision("names", "d", "2026-10-26T01:00:00Z", [], false),
    (e: unknown) => e instanceof CompactError && e.code === "tag",
  );
});

test("tag: a rebuild whose sha256 a build already holds is present at that build, so a re-run pushes nothing; another sha256 takes the next tag (D3)", () => {
  const start = "2026-10-26T00:00:00Z";
  const existing = ["names-d-20261026", "names-d-20261026-r2"];
  const builds = ["names-d-20261026", "names-d-20261026-r2"];
  const [A, B, C] = ["a", "b", "c"].map((c) => c.repeat(64));
  const held = new Map([
    ["names-d-20261026", A],
    ["names-d-20261026-r2", B],
  ]);
  // The re-run of the rebuild that pushed -r2: its bytes are -r2's.
  assert.deepEqual(tagDecision("names", "d", start, existing, true, { sha256: B, buildSha256: held }), { action: "present", tag: "names-d-20261026-r2", builds });
  // Bytes no build holds: the next tag.
  assert.deepEqual(tagDecision("names", "d", start, existing, true, { sha256: C, buildSha256: held }), { action: "write", tag: "names-d-20261026-r3", builds });
  // The first build's bytes, as a plain record: the first build.
  assert.deepEqual(tagDecision("names", "d", start, existing, true, { sha256: A, buildSha256: Object.fromEntries(held) }), { action: "present", tag: "names-d-20261026", builds });
  // Two builds that hold the same bytes: the latest of them.
  const twice = ["names-d-20261026", "names-d-20261026-r2", "names-d-20261026-r3"];
  const same = new Map([
    ["names-d-20261026", A],
    ["names-d-20261026-r2", B],
    ["names-d-20261026-r3", B],
  ]);
  assert.deepEqual(tagDecision("names", "d", start, twice, true, { sha256: B, buildSha256: same }), { action: "present", tag: "names-d-20261026-r3", builds: twice });
  // A build the caller did not read is refused, never passed over.
  assert.throws(
    () => tagDecision("names", "d", start, existing, true, { sha256: B, buildSha256: new Map([["names-d-20261026", A]]) }),
    (e: unknown) => e instanceof CompactError && e.code === "usage" && /the build names-d-20261026-r2 has no dev\.pkgforge\.domains\.sha256/.test(e.message),
  );
  assert.throws(
    () => tagDecision("names", "d", start, existing, true, { sha256: B }),
    (e: unknown) => e instanceof CompactError && e.code === "usage" && /the build names-d-20261026 has no/.test(e.message),
  );
  assert.throws(
    () => tagDecision("names", "d", start, existing, true, { sha256: "B", buildSha256: held }),
    (e: unknown) => e instanceof CompactError && e.code === "usage" && /not 64 lowercase hex digits/.test(e.message),
  );
  // Without opts, or without a rebuild, the answers are the ones before D3.
  assert.deepEqual(tagDecision("names", "d", start, existing, true), { action: "write", tag: "names-d-20261026-r3", builds });
  assert.deepEqual(tagDecision("names", "d", start, existing, false, { sha256: C, buildSha256: held }), { action: "present", tag: "names-d-20261026-r2", builds });
  // A span with no build reads no annotation: its first build.
  assert.deepEqual(tagDecision("names", "d", start, [], true, { sha256: C, buildSha256: new Map() }), { action: "write", tag: "names-d-20261026", builds: [] });
});
