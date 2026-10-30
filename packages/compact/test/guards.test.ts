// The guards of packages/compact that the tests of a whole merge do not reach:
// the shapes a call, a range count, a range output, a manifest's blobs, a
// plan file and the files of the range jobs must have. Each assertion plants
// one fault and names the message that refuses it, so a guard taken out fails
// its own assertion. Synthetic packs (test/helpers.ts).
//
//   node scripts/test.mjs packages/compact --name guard
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FEED_CODEC, FEED_TIME_CODEC, type Idx, MemorySink, NAMES_CODEC, NEW_NAME_TIME_CODEC, readIdx, sha256Hex } from "@domains/pack";
import { nodeCompress, writerId } from "@domains/pack/node";
import { canonical } from "@domains/root";
import {
  assembleRanges,
  CompactError,
  checkPlanFile,
  codecOf,
  countFile,
  countRange,
  countsOf,
  factsOf,
  layersOf,
  MAX_LAYERS,
  MAX_RANGES,
  type ManifestInput,
  type PlanFile,
  packManifest,
  planFile,
  planRanges,
  type RangeCount,
  type RangeOutput,
  rangeCeiling,
  rangeFile,
  rangesOf,
  sortTimeCopy,
  type TierPlan,
  tagDecision,
  timeCodecFor,
  timeMode,
  windowOf,
  writeRange,
} from "../src/index.ts";
import { feedPack, feedRows, keys, memPack, nameRecords, namesInputs, PartsByNumber } from "./helpers.ts";

const R = 4;
const PSL = "1f96bae40adfc22ca2474d7c0099bbcfcb25aefd3e2547b5c2147c0dd2e3ebd9";
const ROOT = `sha256:${"1".repeat(64)}`;
const digestOf = (b: Uint8Array) => ({ digest: `sha256:${createHash("sha256").update(b).digest("hex")}`, size: b.length });
const refused = (fn: () => unknown, code: string, message: RegExp): void => {
  assert.throws(fn, (e: unknown) => e instanceof CompactError && e.code === code && message.test(e.message), `${code} ${message}`);
};
const refusedAsync = async (fn: () => Promise<unknown>, code: string, message: RegExp): Promise<void> => {
  await assert.rejects(fn, (e: unknown) => e instanceof CompactError && e.code === code && message.test(e.message), `${code} ${message}`);
};

// Three ranges of a merge of four names packs, counted and written.
async function threeRanges() {
  const inputs = await namesInputs(4, 50);
  const readers = inputs.map((p) => p.reader);
  const plan = planRanges(
    inputs.map((p) => readIdx(p.summary.idx)),
    { ranges: 3 },
  );
  const counts: RangeCount[] = [];
  for (let r = 0; r < 3; r += 1) counts.push(await countRange(readers, NAMES_CODEC, plan.cuts, r));
  const outs: RangeOutput[] = [];
  for (let r = 0; r < 3; r += 1) outs.push(await writeRange(readers, NAMES_CODEC, plan.cuts, windowOf(counts, r, R), new PartsByNumber(), { compress: nodeCompress, recordsPerBlock: R }));
  return { inputs, readers, plan, counts, outs };
}

test("guard range: cuts that do not ascend or are too many, an input of another dataset, and a range or a plan out of bounds are refused (usage)", async () => {
  const inputs = await namesInputs(2, 20);
  const readers = inputs.map((p) => p.reader);
  await refusedAsync(() => countRange(readers, NAMES_CODEC, ["net", "com"], 0), "usage", /cut 1 is not above cut 0/);
  const many = Array.from({ length: 256 }, (_, i) => `k${String(i).padStart(3, "0")}`);
  await refusedAsync(() => countRange(readers, NAMES_CODEC, many, 0), "usage", /the cuts are not a list of at most 255 keys/);
  await refusedAsync(() => countRange(readers, NAMES_CODEC, ["net"], 2), "usage", /the range is 2, not a whole number of 0 to 1/);
  const feed = await feedPack(
    feedRows(
      keys(1, 10).map((k) => `${k}.d1`),
      86_400,
      1,
    ),
    FEED_CODEC,
    FEED_TIME_CODEC,
  );
  await refusedAsync(() => countRange([feed.key.reader as never, ...readers], NAMES_CODEC, [], 0), "usage", /input 0 is dataset 3, the codec names is dataset 1/);
  const idx = [readIdx(inputs[0].summary.idx)];
  refused(() => planRanges(idx, { ranges: 0 }), "usage", /ranges is 0, not a whole number of 1 to 256/);
  refused(() => planRanges(idx, { ranges: 257 }), "usage", /ranges is 257, not a whole number of 1 to 256/);
  refused(() => planRanges(idx, { targetBytes: 0 }), "usage", /targetBytes is 0/);
});

test("guard range: windows from no count, or from counts of two plans, are refused (plan)", () => {
  const c = (range: number, of: number): RangeCount => ({ range, of, count: 5, inputRecords: 5, first: null, last: null });
  refused(() => windowOf([], 0, R), "plan", /no range count was given/);
  refused(() => windowOf([c(0, 3), c(1, 4), c(2, 3)], 0, R), "plan", /the count of range 1 is of 4 ranges, the others of 3/);
});

test("guard range: a window of another plan, or one that passes over more records than the inputs hold, is refused", async () => {
  const { readers, plan, counts } = await threeRanges();
  const w = windowOf(counts, 1, R);
  assert.notEqual(w.part, null);
  await refusedAsync(
    () => writeRange(readers, NAMES_CODEC, plan.cuts.slice(0, 1), w, new PartsByNumber(), { compress: nodeCompress, recordsPerBlock: R }),
    "plan",
    /the window is of 3 ranges and the plan cuts 2/,
  );
  await refusedAsync(
    () => writeRange(readers, NAMES_CODEC, plan.cuts, { ...w, skip: 10_000 }, new PartsByNumber(), { compress: nodeCompress, recordsPerBlock: R }),
    "range",
    /range 1 of 3: the inputs end after \d+ of the 10000 records it passes over/,
  );
});

test("guard range: assembly refuses no output, outputs of two plans, no part at all, an index of two parts and a part of other bytes", async () => {
  const { outs } = await threeRanges();
  const facts = outs.map(factsOf);
  const format = { dataset: NAMES_CODEC.id, recordsPerBlock: R };
  refused(() => assembleRanges([], format), "plan", /no range output was given/);
  refused(() => assembleRanges([facts[0], { ...facts[1], of: 4 }, facts[2]], format), "plan", /range 1 is of 4 ranges, the others of 3/);
  refused(
    () =>
      assembleRanges(
        facts.map((f) => ({ ...f, part: null })),
        format,
      ),
    "plan",
    /no range wrote a part/,
  );
  const twoParts = facts[1].entries.map((e, i) => (i === 0 ? { ...e, part: 1 } : e));
  refused(() => assembleRanges([facts[0], { ...facts[1], entries: twoParts }, facts[2]], format), "range", /range 1: its index names part 1; a range writes one part/);
  refused(() => assembleRanges([facts[0], { ...facts[1], partBytes: facts[1].partBytes + 1 }, facts[2]], format), "range", /range 1: its blocks fill \d+ B and its part is \d+ B/);
  // The outputs as written assemble.
  assert.equal(
    assembleRanges(facts, format).records,
    facts.reduce((n, f) => n + f.records, 0),
  );
});

test("guard time: a mode of more records than the inputs, a sort of a dataset with no time copy, and a sort of no row are refused (usage)", async () => {
  refused(() => timeMode(11, 10, true), "usage", /a merge of 10 input records cannot give 11 records/);
  await refusedAsync(() => sortTimeCopy([], NAMES_CODEC as never, new MemorySink(), { compress: nodeCompress }), "usage", /dataset 1 \(names\) has no time copy/);
  await refusedAsync(() => sortTimeCopy([], FEED_CODEC, new MemorySink(), { compress: nodeCompress, maxRows: 0 }), "usage", /maxRows is 0, not a whole number of at least 1/);
});

async function namesManifest(): Promise<ManifestInput> {
  const p = await memPack(nameRecords(keys(1, 30), 0, 298), NAMES_CODEC);
  return {
    dataset: "names",
    tier: "d",
    span: { start: "2026-10-26T00:00:00Z", end: "2026-10-27T00:00:00Z" },
    tag: "names-d-20261026",
    sources: ["oi-cs", "thc-ct"],
    psl: PSL,
    run: "1",
    summary: p.summary,
    writer: writerId(),
    parts: p.parts.map(digestOf),
    idx: digestOf(p.summary.idx),
  };
}

async function feedManifest(): Promise<ManifestInput & { time: NonNullable<ManifestInput["time"]> }> {
  const day0 = (Date.UTC(2026, 9, 19) - Date.UTC(2026, 0, 1)) / 1000;
  const f = await feedPack(feedRows(keys(3, 40), day0, 5), FEED_CODEC, FEED_TIME_CODEC);
  return {
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
}

test("guard manifest: no source, sources out of order, a precision of many sources, a bad PSL, part blobs that are not the index's, and a time copy of names are refused", async () => {
  const base = await namesManifest();
  assert.equal(packManifest(base).annotations["dev.pkgforge.domains.count"], "30");
  refused(() => packManifest({ ...base, sources: [] }), "plan", /^the pack names no source/);
  refused(() => packManifest({ ...base, sources: ["thc-ct", "oi-cs"] }), "plan", /^the sources are not sorted and distinct/);
  refused(() => packManifest({ ...base, precision: "day" }), "plan", /^a precision belongs to a pack of one source/);
  refused(() => packManifest({ ...base, psl: "X" }), "plan", /^psl is not 64 lowercase hex digits/);
  refused(() => packManifest({ ...base, parts: [] }), "plan", /^0 part blob\(s\) for the 1 part\(s\) of the index/);
  refused(() => packManifest({ ...base, parts: [{ digest: "sha256:abc", size: 1 }] }), "plan", /^part\.000 is not \{ digest: sha256:<64 hex>, size \}/);
  refused(() => packManifest({ ...base, idx: { ...base.idx, size: base.idx.size + 1 } }), "plan", /^idx is \d+ B and the index written is \d+ B/);
  const feed = await feedManifest();
  refused(() => packManifest({ ...base, time: feed.time }), "time", /^a names pack has no time copy/);
});

test("guard manifest: a source named twice is refused: the sources are distinct", async () => {
  const base = await namesManifest();
  refused(() => packManifest({ ...base, sources: ["oi-cs", "oi-cs"] }), "plan", /^the sources are not sorted and distinct/);
  refused(() => packManifest({ ...base, sources: ["oi-cs", "thc-ct", "thc-ct"] }), "plan", /^the sources are not sorted and distinct/);
});

test("guard manifest: time part blobs that are not the time index's, and a time index of another size, are refused", async () => {
  const feed = await feedManifest();
  assert.equal(packManifest(feed).annotations["dev.pkgforge.domains.dataset"], "feed");
  refused(() => packManifest({ ...feed, time: { ...feed.time, parts: [] } }), "plan", /^0 time part blob\(s\) for the 1 part\(s\) of the time index/);
  const bigger = feed.time.parts.map((p, i) => (i === 0 ? { ...p, size: p.size + 1 } : p));
  refused(() => packManifest({ ...feed, time: { ...feed.time, parts: bigger } }), "plan", /^time\.part\.000 is \d+ B and the time index gives it \d+ B/);
  refused(() => packManifest({ ...feed, time: { ...feed.time, idx: { ...feed.time.idx, size: feed.time.idx.size + 1 } } }), "plan", /^time\.idx is \d+ B and the time index written is \d+ B/);
});

test("guard tag: existing tags that are not a list of tags are refused (usage)", () => {
  const start = "2026-10-26T00:00:00Z";
  refused(() => tagDecision("names", "d", start, "names-d-20261026" as never, false), "usage", /the existing tags are not a list/);
  refused(() => tagDecision("names", "d", start, [1] as never, false), "usage", /the existing tags hold a value that is not a tag/);
});

// A ready plan of a feed week, synthetic: two key ranges and one time range merged.
function readyPlan(): TierPlan {
  return {
    verdict: "ready",
    dataset: "feed",
    tier: "w",
    span: { start: "2026-10-19T00:00:00Z", end: "2026-10-26T00:00:00Z" },
    tag: "feed-w-2026w43",
    reason: "synthetic",
    inputs: [],
    replaces: [],
    excluded: [],
    missing: [],
    gapDays: [],
    present: null,
    sources: ["isc-new"],
    psl: [PSL],
    records: 10,
  };
}
const KEY = { cuts: ["m"], ranges: 2, bytes: [5, 5], total: 10 };
const TIME = { cuts: [], ranges: 1, bytes: [10], total: 10, mode: "merge" as const };
const goodPlan = (): PlanFile => planFile({ plan: readyPlan(), root: ROOT, key: KEY, time: TIME });
// A plan file edited and given the id of its edited body, so a check past the id is reached.
const reId = (body: Record<string, unknown>): unknown => {
  const { id: _, ...rest } = body;
  return { ...rest, id: sha256Hex(new TextEncoder().encode(canonical(rest))) };
};

test("guard plan file: a ready plan with no cuts, a plan of other verdict with cuts, and a time copy of more ranges are refused (usage)", () => {
  refused(() => planFile({ plan: readyPlan(), root: ROOT, key: null, time: null }), "usage", /a ready plan has key cuts, and no other plan has/);
  refused(() => planFile({ plan: { ...readyPlan(), verdict: "wait" }, root: ROOT, key: KEY, time: null }), "usage", /a ready plan has key cuts, and no other plan has/);
  refused(
    () => planFile({ plan: readyPlan(), root: ROOT, key: { ...KEY, cuts: [], ranges: 1, bytes: [10] }, time: { ...TIME, cuts: ["m"], ranges: 2, bytes: [5, 5] } }),
    "usage",
    /the time copy is cut into more ranges than the key copy/,
  );
});

test("guard plan file: a plan read back is held to its format, its id and its shape (plan)", () => {
  const good = goodPlan() as unknown as Record<string, unknown>;
  assert.equal(checkPlanFile(JSON.parse(JSON.stringify(good))).id, good.id);
  const cases: [unknown, RegExp][] = [
    [{ ...good, format: "domains.compact-plan.v0" }, /the plan is not domains\.compact-plan\.v1/],
    [{ ...good, records: 11 }, /the plan's id is not the SHA-256 of its body/],
    [reId({ ...good, inputs: null }), /the plan lacks its inputs, sources, psl or records/],
    [reId({ ...good, records_per_block: 0 }), /records_per_block or page_entries is not a whole number of 1 to 65535/],
    [reId({ ...good, key: { ranges: 2 } }), /key is not \{ ranges, cuts, bytes \}/],
    [reId({ ...good, key: { ranges: 3, cuts: ["m"], bytes: [1, 1, 1] } }), /key holds 3 ranges and 1 cuts/],
    [reId({ ...good, key: { ranges: 3, cuts: ["n", "m"], bytes: [1, 1, 1] } }), /key: cut 1 is not a key above the one before it/],
    [reId({ ...good, time: { ...TIME, mode: "stream" } }), /time\.mode is not merge or sort/],
    [reId({ ...good, time: { ranges: 3, cuts: ["a", "b"], bytes: [1, 1, 1], mode: "merge" } }), /the time copy is cut into more ranges than the key copy/],
    [reId({ ...good, verdict: "wait" }), /a plan whose verdict is wait has no cuts/],
  ];
  for (const [v, why] of cases) refused(() => checkPlanFile(v), "plan", why);
});

test("guard plan file: count files and range files of another format, of another plan, or of fields of other kinds are refused (plan)", () => {
  const plan = goodPlan();
  const c = countFile(plan, "key", { range: 0, of: 2, count: 5, inputRecords: 5, first: "a", last: "b" });
  assert.deepEqual(countsOf(plan, "key", [c]), [{ range: 0, of: 2, count: 5, inputRecords: 5, first: "a", last: "b" }]);
  assert.deepEqual(countsOf(plan, "time", [c]), []);
  refused(() => countsOf(plan, "key", [{ ...c, format: "x" }]), "plan", /a count file is not domains\.compact-count\.v1/);
  refused(() => countsOf(plan, "key", [{ ...c, plan: "0".repeat(64) }]), "plan", /the count of range 0 is of the plan 0{64}, not /);
  refused(() => countsOf(plan, "key", [{ ...c, count: -1 }]), "plan", /a count file's range, of, count or input_records is not a whole number/);
  const blob = { digest: `sha256:${"2".repeat(64)}`, size: 64 };
  const out: RangeOutput = { range: 0, of: 2, part: 0, records: 5, first: "a", last: "b", next: "c", summary: null };
  const f = rangeFile(plan, "key", { out, disjoint: true, writer: "w", part: { file: "part.000", ...blob }, idx: { file: "range.key.000.idx", ...blob } });
  assert.equal(rangesOf(plan, "key", [f]).length, 1);
  refused(() => rangesOf(plan, "key", [{ ...f, format: "x" }]), "plan", /a range file is not domains\.compact-range\.v1/);
  refused(() => rangesOf(plan, "key", [{ ...f, plan: "0".repeat(64) }]), "plan", /the output of range 0 is of the plan 0{64}, not /);
  refused(() => rangesOf(plan, "key", [{ ...f, disjoint: "yes" }]), "plan", /a range file's fields are not of their kinds/);
  refused(() => rangesOf(plan, "key", [{ ...f, file: null }]), "plan", /range 0: a part, its file and its index are given all or none/);
});

// An index of `n` blocks of 100 B, one a page: as many cut candidates as blocks.
const wideIdx = (n: number): Idx => {
  const keys = Array.from({ length: n }, (_, i) => `com.k${String(i).padStart(4, "0")}`);
  return { entries: keys.map((key) => ({ key, packed: 100 })), head: { pages: keys.map((key) => ({ key })) } } as unknown as Idx;
};

test("guard range: a count of ranges or a ceiling that is not a whole number in bounds is refused (usage); a count from the bytes is held to the ceiling", () => {
  const idx = [wideIdx(300)];
  for (const v of [Number.NaN, 1.5, -1]) refused(() => planRanges(idx, { ranges: v }), "usage", /^ranges is .+, not a whole number of 1 to 256$/);
  refused(() => planRanges(idx, { targetBytes: Number.NaN }), "usage", /^targetBytes is NaN/);
  refused(() => planRanges(idx, { maxRanges: 0 }), "usage", /^maxRanges is 0, not a whole number of 1 to 256$/);
  refused(() => planRanges(idx, { maxRanges: 257 }), "usage", /^maxRanges is 257, not a whole number of 1 to 256$/);
  refused(() => planRanges(idx, { ranges: 256, maxRanges: 255 }), "usage", /^ranges is 256, not a whole number of 1 to 255$/);
  assert.equal(planRanges(idx, { targetBytes: 1 }).ranges, MAX_RANGES);
  assert.equal(planRanges(idx, { targetBytes: 1, maxRanges: 255 }).ranges, 255);
  assert.equal(planRanges(idx, { targetBytes: 1, maxRanges: 127 }).ranges, 127);
  assert.equal(planRanges(idx, { ranges: 255, maxRanges: 255 }).cuts.length, 254);
});

test("guard range: cuts that are equal, empty or not keys are refused (usage)", async () => {
  const inputs = await namesInputs(2, 20);
  const readers = inputs.map((p) => p.reader);
  await refusedAsync(() => countRange(readers, NAMES_CODEC, ["com", "com"], 0), "usage", /^cut 1 is not above cut 0$/);
  await refusedAsync(() => countRange(readers, NAMES_CODEC, ["", "com"], 0), "usage", /^cut 0 is not a key$/);
  await refusedAsync(() => countRange(readers, NAMES_CODEC, [1 as never], 0), "usage", /^cut 0 is not a key$/);
  await refusedAsync(() => countRange(readers, NAMES_CODEC, "com" as never, 0), "usage", /^the cuts are not a list of at most 255 keys$/);
});

test("guard layers: the ceiling of ranges keeps a pack's parts and indexes to one manifest of MAX_LAYERS layers, and one range more passes it", () => {
  assert.equal(MAX_LAYERS, 256);
  const cases: [Parameters<typeof rangeCeiling>[0], Parameters<typeof rangeCeiling>[1], number, boolean][] = [
    ["names", "w", 255, false],
    ["domains", "y", 255, false],
    ["feed", "w", 127, true],
    ["new-name", "d", 127, true],
    ["feed", "m", 127, true],
  ];
  for (const [dataset, tier, ceiling, timed] of cases) {
    assert.equal(rangeCeiling(dataset, tier), ceiling, `${dataset} ${tier}`);
    const time = (n: number) => (timed ? { ranges: n } : null);
    assert.ok(layersOf({ ranges: ceiling }, time(ceiling)) <= MAX_LAYERS, `${dataset} ${tier} at the ceiling`);
    assert.ok(layersOf({ ranges: ceiling + 1 }, time(ceiling + 1)) > MAX_LAYERS, `${dataset} ${tier} past the ceiling`);
  }
  assert.equal(timeCodecFor("feed", "w"), FEED_TIME_CODEC);
  assert.equal(timeCodecFor("new-name", "y"), NEW_NAME_TIME_CODEC);
  assert.equal(timeCodecFor("names", "w"), null);
  refused(() => codecOf("rev"), "usage", /^no codec merges rev: the record of rev is DOM-043's$/);
});

// A copy plan of `n` ranges, its cuts ascending.
const copyOfN = (n: number) => ({
  cuts: Array.from({ length: n - 1 }, (_, i) => `com.k${String(i).padStart(4, "0")}`),
  ranges: n,
  bytes: Array.from({ length: n }, () => 1),
  total: n,
});

test("guard plan file: a plan whose pack would hold more layers than one manifest is refused, written (usage) or read back (plan)", () => {
  const sort = { cuts: [], ranges: 1, bytes: [0], total: 0, mode: "sort" as const };
  refused(() => planFile({ plan: readyPlan(), root: ROOT, key: copyOfN(255), time: sort }), "usage", /^the pack would hold 258 layers, and one manifest holds at most 256: plan fewer ranges$/);
  refused(() => planFile({ plan: readyPlan(), root: ROOT, key: copyOfN(256), time: null }), "usage", /^the pack would hold 257 layers/);
  assert.equal(planFile({ plan: readyPlan(), root: ROOT, key: copyOfN(255), time: null }).key?.ranges, 255);
  const good = goodPlan() as unknown as Record<string, unknown>;
  refused(() => checkPlanFile(reId({ ...good, key: copyOfN(256), time: null })), "plan", /^the pack would hold 257 layers, and one manifest holds at most 256$/);
  refused(() => checkPlanFile(reId({ ...good, key: copyOfN(128), time: { ...copyOfN(128), mode: "merge" } })), "plan", /^the pack would hold 258 layers/);
});

test("guard plan file: each field a job reads is held to its kind, one fault at a time (plan)", () => {
  const good = goodPlan() as unknown as Record<string, unknown>;
  const key = good.key as Record<string, unknown>;
  const SHAPE = /^key is not \{ ranges, cuts, bytes \}$/;
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ sources: null }, /the plan lacks its inputs, sources, psl or records/],
    [{ psl: "x" }, /the plan lacks its inputs, sources, psl or records/],
    [{ records: -1 }, /the plan lacks its inputs, sources, psl or records/],
    [{ records: 1.5 }, /the plan lacks its inputs, sources, psl or records/],
    [{ records_per_block: 70_000 }, /records_per_block or page_entries is not a whole number of 1 to 65535/],
    [{ page_entries: 0 }, /records_per_block or page_entries is not a whole number of 1 to 65535/],
    [{ page_entries: 70_000 }, /records_per_block or page_entries is not a whole number of 1 to 65535/],
    [{ key: null }, SHAPE],
    [{ key: { ...key, ranges: 257 } }, SHAPE],
    [{ key: { ...key, ranges: 0 } }, SHAPE],
    [{ key: { ...key, cuts: "abc" } }, SHAPE],
    [{ key: { ...key, bytes: 10 } }, SHAPE],
    [{ key: { ...key, bytes: [10] } }, /^key holds 2 ranges and 1 cuts$/],
    [{ key: { ...key, cuts: [""] } }, /^key: cut 0 is not a key above the one before it$/],
    [{ key: { ...key, cuts: [7] } }, /^key: cut 0 is not a key above the one before it$/],
    [{ key: { ranges: 3, cuts: ["m", "m"], bytes: [1, 1, 1] } }, /^key: cut 1 is not a key above the one before it$/],
    [{ time: { ...TIME, ranges: 0 } }, /^time is not \{ ranges, cuts, bytes \}$/],
    [{ verdict: "present", key: null }, /^a plan whose verdict is present has no cuts$/],
  ];
  for (const [change, why] of cases) refused(() => checkPlanFile(reId({ ...good, ...change })), "plan", why);
});

test("guard plan file: each field of a count file and of a range file is held to its kind, one fault at a time (plan)", () => {
  const plan = goodPlan();
  const c = countFile(plan, "key", { range: 0, of: 2, count: 5, inputRecords: 5, first: "a", last: "b" });
  for (const change of [{ range: "0" }, { range: -1 }, { of: 0 }, { of: 257 }, { count: 1.5 }, { input_records: "5" }]) {
    refused(() => countsOf(plan, "key", [{ ...c, ...change }]), "plan", /^a count file's range, of, count or input_records is not a whole number$/);
  }
  const blob = { digest: `sha256:${"2".repeat(64)}`, size: 64 };
  const out: RangeOutput = { range: 0, of: 2, part: 0, records: 5, first: "a", last: "b", next: "c", summary: null };
  const f = rangeFile(plan, "key", { out, disjoint: true, writer: "w", part: { file: "part.000", ...blob }, idx: { file: "range.key.000.idx", ...blob } });
  for (const change of [{ range: "0" }, { of: 0 }, { of: 257 }, { records: -1 }, { writer: 5 }]) {
    refused(() => rangesOf(plan, "key", [{ ...f, ...change }]), "plan", /^a range file's fields are not of their kinds$/);
  }
  refused(() => rangesOf(plan, "key", [{ ...f, idx: null }]), "plan", /^range 0: a part, its file and its index are given all or none$/);
  refused(() => rangesOf(plan, "key", [{ ...f, part: null, file: null }]), "plan", /^range 0: a part, its file and its index are given all or none$/);
  assert.equal(rangesOf(plan, "key", [{ ...f, part: null, file: null, idx: null }]).length, 1);
});

test("guard manifest: a manifest of more layers than the push takes is refused before it is read back", async () => {
  const base = await namesManifest();
  // The key copy of 256 parts: 257 layers with its idx.
  const parts = Array.from({ length: 256 }, () => ({ bytes: 100, firstBlock: 0, blocks: 1 }));
  const summary = { ...base.summary, parts };
  const blobs = Array.from({ length: 256 }, (_, i) => ({ digest: `sha256:${i.toString(16).padStart(64, "0")}`, size: 100 }));
  refused(() => packManifest({ ...base, summary, parts: blobs }), "plan", /^the manifest holds 257 layers, and the push takes at most 256 \(scripts\/ghcr\/push\.mjs\): plan fewer ranges$/);
  // 255 parts and the idx are 256 layers: past the layer count, the promotion's reading refuses the parts the index does not give.
  refused(() => packManifest({ ...base, summary: { ...summary, parts: parts.slice(1) }, parts: blobs.slice(1) }), "plan", /^the promotion would refuse this manifest/);
});
