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
import { CompactError, EMPTY_CONFIG, type ExtraLayer, type ManifestInput, packManifest, tagDecision, WORKFLOW_RUN_ID } from "../src/index.ts";
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

// A names segment of one second-precision source, its window ten minutes (D12 of DOM-024).
async function segmentInput(): Promise<ManifestInput> {
  const p = await memPack(nameRecords(keys(5, 12), 0, 298), NAMES_CODEC);
  return {
    dataset: "names",
    tier: "seg",
    span: { start: "2026-10-30T08:00:00Z", end: "2026-10-30T08:10:00Z" },
    tag: "oi-cs.20261030t080000z.20261030t081000z",
    sources: ["oi-cs"],
    precision: "second",
    psl: PSL,
    run: "40000000001",
    summary: p.summary,
    writer: writerId(),
    parts: p.parts.map(digestOf),
    idx: digestOf(p.summary.idx),
  };
}

test("manifest: a segment of tier seg is a segment of obs, which the promotion reads, with the annotations added after the pack's own", async () => {
  const input = await segmentInput();
  const added = { "dev.pkgforge.domains.adapter": "fixture-stream", "dev.pkgforge.domains.cursor.after": '{"n":2}', "dev.pkgforge.domains.raw": "raw-oi-cs.20261030t080000z.20261030t081000z" };
  const m = packManifest({ ...input, annotations: added });
  assert.equal(m.json.artifactType, "application/vnd.pkgforge.domains.segment.v1");
  assert.equal(m.annotations["dev.pkgforge.domains.tier"], "seg");
  for (const [k, v] of Object.entries(added)) assert.equal(m.annotations[k], v);
  // After the pack's own, in the order given, in the manifest as in the returned annotations.
  assert.deepEqual(Object.keys(m.annotations).slice(-3), Object.keys(added));
  assert.deepEqual(Object.keys(m.json.annotations as object), Object.keys(m.annotations));
  assert.equal(Object.keys(m.annotations).at(-4), "org.opencontainers.image.source");
  assert.equal(m.annotations["org.opencontainers.image.created"], "2026-10-30T08:10:00Z");
  const head = { dataset: 1, records: input.summary.records, keyMin: input.summary.keyMin, keyMax: input.summary.keyMax, parts: input.summary.parts.map((p) => p.bytes) };
  const entry = packFromManifest({ repo: "pkgforge-dev/domains.pkgforge.dev/obs", tag: input.tag, digest: m.digest, json: m.json, head });
  assert.equal(entry.pack.tier, "seg");
  assert.equal(entry.pack.repo, "pkgforge-dev/domains.pkgforge.dev/obs");
  // A segment holds names or domains, and carries no time copy.
  assert.throws(
    () => packManifest({ ...input, dataset: "feed" }),
    (e: unknown) => e instanceof CompactError && e.code === "usage" && /a segment holds names or domains, not feed/.test(e.message),
  );
  const t = digestOf(new Uint8Array([1]));
  assert.throws(
    () => packManifest({ ...input, time: { idxBytes: input.summary.idx, parts: [t], idx: t } }),
    (e: unknown) => e instanceof CompactError && e.code === "time" && /a segment carries no time copy/.test(e.message),
  );
});

test("manifest: an added annotation outside dev.pkgforge.domains., one packManifest sets, the quarantine mark, or a value push.mjs refuses is refused", async () => {
  const input = await segmentInput();
  const refused = (annotations: Record<string, string>, why: RegExp) =>
    assert.throws(
      () => packManifest({ ...input, annotations }),
      (e: unknown) => e instanceof CompactError && e.code === "usage" && why.test(e.message),
    );
  refused({ "org.example.cursor": "1" }, /is not dev\.pkgforge\.domains\. and lowercase words/);
  refused({ "dev.pkgforge.domains.Cursor": "1" }, /is not dev\.pkgforge\.domains\. and lowercase words/);
  refused({ "dev.pkgforge.domains.quarantine": "1" }, /added at the push of a quarantined segment/);
  for (const k of ["dev.pkgforge.domains.sha256", "dev.pkgforge.domains.tier", "dev.pkgforge.domains.run", "dev.pkgforge.domains.source"]) refused({ [k]: "x" }, /is one packManifest sets/);
  // precision is packManifest's own even on a pack of two sources, which carries none.
  const two = await namesInput();
  assert.throws(
    () => packManifest({ ...two, annotations: { "dev.pkgforge.domains.precision": "day" } }),
    (e: unknown) => e instanceof CompactError && e.code === "usage" && /is one packManifest sets/.test(e.message),
  );
  // The key's grammar to its end: the prefix with its dot, then words joined by . _ or -.
  for (const k of [
    "dev.pkgforge.domains.cursor.Before",
    "dev.pkgforge.domains.cursor after",
    "dev.pkgforge.domainsxcursor",
    "dev.pkgforge.domains.",
    "dev.pkgforge.domains.cursor.",
    "",
    "xdev.pkgforge.domains.cursor",
  ])
    refused({ [k]: "1" }, /is not dev\.pkgforge\.domains\. and lowercase words/);
  // The value: annotationProblem of @domains/ghcr, the push tool's own rule.
  refused({ "dev.pkgforge.domains.cursor.before": "x".repeat(1025) }, /^the annotation dev\.pkgforge\.domains\.cursor\.before is 1025 characters, over 1024/);
  refused({ "dev.pkgforge.domains.url": "a\nb" }, /holds a control character/);
  refused({ "dev.pkgforge.domains.url": "a\u007fb" }, /holds a control character/);
  refused({ "dev.pkgforge.domains.url": "a\tb" }, /holds a control character/);
  // push.mjs refuses --annotation KEY= as not KEY=VALUE: an empty value is refused here too.
  refused({ "dev.pkgforge.domains.adapter": "" }, /^the annotation dev\.pkgforge\.domains\.adapter is empty/);
  refused({ "dev.pkgforge.domains.adapter": 7 as unknown as string }, /is number, not a string/);
  // The annotations themselves are a plain object: a Map, a list, a number or true would add nothing.
  for (const bad of [new Map([["dev.pkgforge.domains.adapter", "x"]]), [], ["x"], 7, true, "x"]) {
    assert.throws(
      () => packManifest({ ...input, annotations: bad as unknown as Record<string, string> }),
      (e: unknown) => e instanceof CompactError && e.code === "usage" && /^annotations is not a plain object/.test(e.message),
      String(bad),
    );
  }
  assert.equal(packManifest({ ...input, annotations: { "dev.pkgforge.domains.cursor.before": "x".repeat(1024) } }).annotations["dev.pkgforge.domains.cursor.before"].length, 1024);
});

test("manifest: an extra layer given by its blob names that digest and size, and one given by both or neither is refused", async () => {
  const input = await segmentInput();
  const raw = { digest: `sha256:${"ab".repeat(32)}`, size: 734_003_200 };
  const m = packManifest({ ...input, extra: [{ title: "raw", mediaType: "application/octet-stream", blob: raw }] });
  const layers = m.json.layers as { annotations: Record<string, string>; digest: string; size: number; mediaType: string }[];
  const last = layers.at(-1) as (typeof layers)[number];
  assert.deepEqual([last.annotations["org.opencontainers.image.title"], last.digest, last.size, last.mediaType], ["raw", raw.digest, raw.size, "application/octet-stream"]);
  // The bytes form still names the bytes' own digest.
  const bytes = new TextEncoder().encode("{}\n");
  const b = (packManifest({ ...input, extra: [{ title: "summary.json", mediaType: "application/json", bytes }] }).json.layers as { digest: string; size: number }[]).at(-1);
  assert.deepEqual(b, { ...b, ...digestOf(bytes) });
  assert.throws(
    () => packManifest({ ...input, extra: [{ title: "raw", mediaType: "application/octet-stream", blob: { digest: "sha256:zz", size: 1 } }] }),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /raw is not \{ digest/.test(e.message),
  );
  const both = { title: "raw", mediaType: "application/octet-stream", bytes, blob: raw } as unknown as ExtraLayer;
  const neither = { title: "raw", mediaType: "application/octet-stream" } as unknown as ExtraLayer;
  for (const x of [both, neither]) {
    assert.throws(
      () => packManifest({ ...input, extra: [x] }),
      (e: unknown) => e instanceof CompactError && e.code === "usage" && /^the extra layer raw is given by its bytes or by its blob, one of the two$/.test(e.message),
    );
  }
  // An extra layer that is not one: each refused as usage, never a TypeError.
  const plants: [unknown, RegExp][] = [
    [[null], /^extra\[0\] is not an object$/],
    [["raw"], /^extra\[0\] is not an object$/],
    [[{ title: "raw", mediaType: "application/octet-stream", bytes: "abc" }], /^the bytes of the extra layer raw are not a Uint8Array$/],
    [[{ title: "raw", mediaType: "application/octet-stream", bytes: [1, 2] }], /^the bytes of the extra layer raw are not a Uint8Array$/],
    [[{ title: "raw", blob: raw }], /^the extra layer raw has no media type$/],
    [[{ title: "raw", mediaType: "", blob: raw }], /^the extra layer raw has no media type$/],
    [[{ mediaType: "application/octet-stream", blob: raw }], /is not the title of an extra layer/],
    [{ title: "raw" }, /^extra is not a list of layers$/],
  ];
  for (const [extra, re] of plants) {
    assert.throws(
      () => packManifest({ ...input, extra: extra as ExtraLayer[] }),
      (e: unknown) => e instanceof CompactError && e.code === "usage" && re.test(e.message),
      JSON.stringify(extra),
    );
  }
});

test("manifest: a segment's tag is the one its source, window and dataset give, and a segment is of one source", async () => {
  const input = await segmentInput();
  const plan = (patch: Partial<ManifestInput>, re: RegExp) =>
    assert.throws(
      () => packManifest({ ...input, ...patch }),
      (e: unknown) => e instanceof CompactError && e.code === "plan" && re.test(e.message),
      String(patch.tag ?? patch.dataset ?? patch.sources),
    );
  plan({ tag: "x" }, /^the tag of the segment: x is not the tag of a names segment of oi-cs/);
  plan({ tag: "other-src.20261030t080000z.20261030t081000z" }, /which is oi-cs\.20261030t080000z\.20261030t081000z$/);
  plan({ tag: "oi-cs.20261030t080000z.20261030t082000z" }, /which is oi-cs\.20261030t080000z\.20261030t081000z$/);
  plan({ span: { start: "2026-10-30T08:00:00Z", end: "2026-10-30T08:20:00Z" } }, /which is oi-cs\.20261030t080000z\.20261030t082000z$/);
  // The dataset's variant: -d for domains, none for names.
  plan({ dataset: "domains" }, /which is oi-cs\.20261030t080000z\.20261030t081000z-d$/);
  plan({ tag: "oi-cs.20261030t080000z.20261030t081000z-d" }, /is not the tag of a names segment/);
  plan({ sources: ["a-b", "oi-cs"], precision: undefined }, /^a segment is of one source, not a-b,oi-cs$/);
  // The domains segment of the window, and a file segment of a day source, are taken.
  const d = packManifest({ ...input, dataset: "domains", tag: "oi-cs.20261030t080000z.20261030t081000z-d" });
  assert.equal(d.annotations["dev.pkgforge.domains.tier"], "seg");
  const day = { ...input, span: { start: "2026-10-29T00:00:00Z", end: "2026-10-30T00:00:00Z" }, sources: ["isc-new"], precision: "day" as const };
  assert.equal(packManifest({ ...day, tag: "isc-new.20261029.0232f4df0831" }).annotations["dev.pkgforge.domains.tier"], "seg");
  plan({ ...day, tag: "isc-new.20261028.0232f4df0831" }, /which is isc-new\.20261029\.0232f4df0831$/);
});

test("manifest: the run annotation is a workflow run id, digits with no leading zero, at most 20; never local", async () => {
  assert.equal(String(WORKFLOW_RUN_ID), String(/^[1-9][0-9]{0,19}$/));
  for (const ok of ["40905625954", "1", `9${"0".repeat(19)}`]) assert.ok(WORKFLOW_RUN_ID.test(ok), ok);
  for (const bad of ["0123", "0", `1${"0".repeat(20)}`, `1${"0".repeat(29)}`, "40000000001x", "x40000000001", "local", "", "4e10"]) assert.ok(!WORKFLOW_RUN_ID.test(bad), bad);
  const input = await segmentInput();
  for (const run of ["0123", "local", `1${"0".repeat(20)}`, "40000000001x"]) {
    assert.throws(
      () => packManifest({ ...input, run }),
      (e: unknown) => e instanceof CompactError && e.code === "plan" && /is not a workflow run id/.test(e.message),
      run,
    );
  }
});
