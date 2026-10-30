// mergeSpan, checkMerged and the ranged merge: one merge cut into key ranges
// for an Actions matrix (count, window, part) and assembled into one pack,
// held byte for byte to the merge of one process. Synthetic names whose keys
// overlap across inputs (test/helpers.ts), 4 records a block so a small merge
// has many blocks.
//
//   node scripts/test.mjs packages/compact --name range
//   node scripts/test.mjs packages/compact --name merge
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Idx, MemorySink, mergePacks, type NameRecord, NAMES_CODEC, PART_HEADER_BYTES, type PackReader, partsSource, readIdx, writePack } from "@domains/pack";
import { nodeCompress } from "@domains/pack/node";
import {
  assembleRanges,
  CompactError,
  checkMerged,
  checkRange,
  countRange,
  factsOf,
  hashParts,
  mergeSpan,
  planRanges,
  type RangeCount,
  type RangeOutput,
  WHOLE_WINDOW,
  windowOf,
  writeRange,
} from "../src/index.ts";
import { collect, concat, memPack, namesInputs, PartsByNumber, readerOf } from "./helpers.ts";

const R = 4;
const readersOf = (packs: { reader: PackReader<NameRecord> }[]) => packs.map((p) => p.reader);
const refusedAsync = async (fn: () => Promise<unknown>, code: string, message: RegExp): Promise<void> => {
  await assert.rejects(fn, (e: unknown) => e instanceof CompactError && e.code === code && message.test(e.message));
};

// The plain merge of one process: writePack over mergePacks.
async function plainMerge(readers: PackReader<NameRecord>[]) {
  const sink = new MemorySink();
  const summary = await writePack(mergePacks(readers, NAMES_CODEC), { codec: NAMES_CODEC, compress: nodeCompress, sink, recordsPerBlock: R });
  return { summary, parts: sink.parts() };
}

// Stage 1 and stage 2 as the matrix runs them: every range counted, then every
// range written to a sink of its own, in `order`.
async function matrix(readers: PackReader<NameRecord>[], cuts: readonly string[], order?: number[]) {
  const n = cuts.length + 1;
  const counts: RangeCount[] = [];
  for (let r = 0; r < n; r += 1) counts.push(await countRange(readers, NAMES_CODEC, cuts, r));
  const outs: RangeOutput[] = [];
  const parts: Uint8Array[] = [];
  for (const r of order ?? Array.from({ length: n }, (_, i) => i)) {
    const sink = new PartsByNumber();
    const out = await writeRange(readers, NAMES_CODEC, cuts, windowOf(counts, r, R), sink, { compress: nodeCompress, recordsPerBlock: R });
    outs.push(out);
    assert.deepEqual(sink.numbers(), out.part === null ? [] : [out.part]);
    if (out.part !== null) parts[out.part] = sink.part(out.part);
  }
  return { counts, outs, parts };
}

test("merge: a single merge with no cut is writePack over mergePacks, byte for byte", async () => {
  const inputs = await namesInputs(5, 60);
  const plain = await plainMerge(readersOf(inputs));
  const sink = new MemorySink();
  const summary = await mergeSpan(readersOf(inputs), NAMES_CODEC, sink, { compress: nodeCompress, recordsPerBlock: R });
  assert.deepEqual(summary.idx, plain.summary.idx);
  assert.deepEqual(sink.parts(), plain.parts);
  assert.equal(summary.sha256, plain.summary.sha256);
});

test("merge: a record is never dropped: the second pass finds exactly the inputs' distinct keys, each the merge of its records", async () => {
  const inputs = await namesInputs(5, 60);
  const sink = new MemorySink();
  const summary = await mergeSpan(readersOf(inputs), NAMES_CODEC, sink, { compress: nodeCompress, recordsPerBlock: R });
  const out = await readerOf(summary.idx, sink.parts(), NAMES_CODEC);
  const check = await checkMerged(
    inputs.map((p) => p.reader.scan()),
    out.scan(),
    NAMES_CODEC,
  );
  assert.equal(check.records, summary.records);
  assert.equal(check.distinct, summary.records);
  assert.equal(check.inputRecords, 300);
  assert.ok(check.distinct < check.inputRecords, "the inputs share keys, so the merge folds some");
});

test("merge: an output that drops one input key, invents one or changes a record fails the count check", async () => {
  const inputs = await namesInputs(3, 40);
  const merged = await collect(mergePacks(readersOf(inputs), NAMES_CODEC));
  const check = async (records: NameRecord[]) =>
    checkMerged(
      inputs.map((p) => p.reader.scan()),
      (await memPack(records, NAMES_CODEC)).reader.scan(),
      NAMES_CODEC,
    );
  const n = merged.length;
  // One key dropped, in the middle and at the end.
  const middle = merged[Math.floor(n / 2)].key;
  await refusedAsync(
    () => check(merged.filter((r) => r.key !== middle)),
    "count",
    new RegExp(`holds ${n - 1} record\\(s\\) and its inputs ${n} distinct key\\(s\\): the output lacks the key "${middle.replaceAll(".", "\\.")}"`),
  );
  await refusedAsync(() => check(merged.slice(0, -1)), "count", new RegExp(`holds ${n - 1} record\\(s\\) and its inputs ${n} distinct key\\(s\\): the output lacks the key .* after its last key`));
  // One key no input holds.
  const invented = [...merged, { key: "zz.invented", flags: 1, sources: [{ bit: 0, first: 298, last: 298 }] }];
  await refusedAsync(() => check(invented), "count", /holds \d+ record\(s\) and its inputs \d+ distinct key\(s\): the output holds the key "zz\.invented", which no input holds/);
  // One record whose fields are not the merge of its inputs'.
  const changed = merged.map((r, i) => (i === 3 ? { ...r, sources: [{ ...r.sources[0], last: r.sources[0].last + 1 }, ...r.sources.slice(1)] } : r));
  await refusedAsync(() => check(changed), "count", /is not the merge of the inputs' records of that key/);
  // The whole merge passes.
  assert.equal((await check(merged)).records, n);
});

test("merge: an output with a key twice, or an input whose keys do not ascend, fails the check", async () => {
  const inputs = await namesInputs(3, 40);
  const merged = await collect(mergePacks(readersOf(inputs), NAMES_CODEC));
  // Plain lists, not packs: a pack's writer refuses either fault before the check could see it.
  async function* of<T>(xs: readonly T[]): AsyncGenerator<T> {
    yield* xs;
  }
  const twice = [...merged.slice(0, 5), merged[4], ...merged.slice(5)];
  await refusedAsync(
    () =>
      checkMerged(
        inputs.map((p) => p.reader.scan()),
        of(twice),
        NAMES_CODEC,
      ),
    "count",
    new RegExp(`the output's key "${merged[4].key.replaceAll(".", "\\.")}" is not above the key before it`),
  );
  const six = merged.slice(0, 6);
  const swapped = [six[1], six[0], ...six.slice(2)];
  await refusedAsync(() => checkMerged([of(swapped)], of(six), NAMES_CODEC), "count", new RegExp(`input 0: the key "${six[0].key.replaceAll(".", "\\.")}" is not above the key before it`));
});

test("range: a range merge assembled equals a single merge of the same inputs, byte for byte", async () => {
  const inputs = await namesInputs(5, 60);
  const readers = readersOf(inputs);
  const plain = await plainMerge(readers);
  const indexes = inputs.map((p) => readIdx(p.summary.idx));
  for (const ranges of [2, 3, 4, 7]) {
    const plan = planRanges(indexes, { ranges });
    assert.equal(plan.cuts.length, ranges - 1);
    const single = new MemorySink();
    const one = await mergeSpan(readers, NAMES_CODEC, single, { compress: nodeCompress, recordsPerBlock: R, cuts: plan.cuts });
    // The matrix, its ranges written in reverse order.
    const m = await matrix(
      readers,
      plan.cuts,
      Array.from({ length: ranges }, (_, i) => ranges - 1 - i),
    );
    const asm = assembleRanges(m.outs.map(factsOf), { dataset: NAMES_CODEC.id, recordsPerBlock: R });
    assert.deepEqual(asm.idx, one.idx, `the index of ${ranges} ranges`);
    assert.deepEqual(m.parts, single.parts(), `the parts of ${ranges} ranges`);
    const digest = await hashParts(
      asm.idx,
      partsSource(m.parts),
      m.parts.map((p) => p.length),
      NAMES_CODEC,
    );
    assert.equal(digest.sha256, one.sha256);
    // The blocks are the plain merge's blocks: only the part headers and the parts table differ.
    assert.equal(one.sha256, plain.summary.sha256);
    assert.equal(asm.records, plain.summary.records);
    assert.deepEqual(concat(m.parts.map((p) => p.subarray(PART_HEADER_BYTES))), plain.parts[0].subarray(PART_HEADER_BYTES));
    assert.deepEqual(
      asm.entries.map((e) => [e.key, e.records, e.crc, e.packed]),
      plain.summary.entries.map((e) => [e.key, e.records, e.crc, e.packed]),
    );
    // Every range's count adds up to the merge.
    assert.equal(
      m.counts.reduce((t, c) => t + c.count, 0),
      plain.summary.records,
    );
  }
});

test("range: a range that owns no block writes no part, and the parts are numbered without it", async () => {
  // 64 records a block over ranges of about 20 records: most ranges own no block.
  const inputs = await namesInputs(3, 50, 64);
  const readers = readersOf(inputs);
  const plan = planRanges(
    inputs.map((p) => readIdx(p.summary.idx)),
    { ranges: 3 },
  );
  const counts: RangeCount[] = [];
  for (let r = 0; r < 3; r += 1) counts.push(await countRange(readers, NAMES_CODEC, plan.cuts, r));
  const windows = counts.map((_, r) => windowOf(counts, r, 64));
  assert.equal(windows[0].part, 0);
  assert.ok(
    windows.slice(1).some((w) => w.part === null),
    JSON.stringify(windows),
  );
  const outs: RangeOutput[] = [];
  const parts: Uint8Array[] = [];
  for (const w of windows) {
    const sink = new PartsByNumber();
    const out = await writeRange(readers, NAMES_CODEC, plan.cuts, w, sink, { compress: nodeCompress, recordsPerBlock: 64 });
    outs.push(out);
    if (out.part !== null) parts[out.part] = sink.part(out.part);
  }
  const asm = assembleRanges(outs.map(factsOf), { dataset: NAMES_CODEC.id, recordsPerBlock: 64 });
  const single = new MemorySink();
  const one = await mergeSpan(readers, NAMES_CODEC, single, { compress: nodeCompress, recordsPerBlock: 64, cuts: plan.cuts });
  assert.deepEqual(asm.idx, one.idx);
  assert.deepEqual(parts, single.parts());
});

test("range: an empty range whose offset is a multiple of the records a block owns no block, and the part numbers skip it", () => {
  // Range 1 holds no key and starts at record 8, where a block of 4 records starts.
  const counts: RangeCount[] = [
    { range: 0, of: 3, count: 8, inputRecords: 8, first: "com.a", last: "com.h" },
    { range: 1, of: 3, count: 0, inputRecords: 0, first: null, last: null },
    { range: 2, of: 3, count: 4, inputRecords: 4, first: "com.i", last: "com.l" },
  ];
  assert.deepEqual(windowOf(counts, 1, R), { range: 1, of: 3, part: null, offset: 8, skip: 0, take: 0, total: 12 });
  assert.deepEqual(windowOf(counts, 2, R), { range: 2, of: 3, part: 1, offset: 8, skip: 0, take: 4, total: 12 });
});

// An index as planRanges reads one: the first key and the compressed bytes of
// each block, and the first key of each index page (here one block a page).
const idxOf = (blocks: readonly (readonly [string, number])[]): Idx =>
  ({ entries: blocks.map(([key, packed]) => ({ key, packed })), head: { pages: blocks.map(([key]) => ({ key })) } }) as unknown as Idx;

test("range: a cut of uneven page bytes is the page key nearer the equal share, below it or above it", () => {
  // 100 B in four blocks; two ranges want 50 B each. The cuts at com.c and com.d
  // leave 20 B and 90 B before them: 20 B is nearer.
  const below = planRanges(
    [
      idxOf([
        ["com.a", 10],
        ["com.b", 10],
        ["com.c", 70],
        ["com.d", 10],
      ]),
    ],
    { ranges: 2 },
  );
  assert.deepEqual([below.cuts, below.bytes], [["com.c"], [20, 80]]);
  // 20 B and 60 B before them: 60 B is nearer.
  const above = planRanges(
    [
      idxOf([
        ["com.a", 10],
        ["com.b", 10],
        ["com.c", 40],
        ["com.d", 40],
      ]),
    ],
    { ranges: 2 },
  );
  assert.deepEqual([above.cuts, above.bytes], [["com.d"], [60, 40]]);
});

test("range: one range alone needs no count and is writePack over mergePacks, byte for byte", async () => {
  const inputs = await namesInputs(4, 50);
  const readers = readersOf(inputs);
  const plain = await plainMerge(readers);
  const sink = new MemorySink();
  const out = await writeRange(readers, NAMES_CODEC, [], WHOLE_WINDOW, sink, { compress: nodeCompress, recordsPerBlock: R });
  const asm = assembleRanges([factsOf(out)], { dataset: NAMES_CODEC.id, recordsPerBlock: R });
  assert.deepEqual(asm.idx, plain.summary.idx);
  assert.deepEqual(sink.parts(), plain.parts);
  // A merge of no record is one pack of no record: part 0, its header alone.
  const none = await memPack<NameRecord>([], NAMES_CODEC);
  const empty = new MemorySink();
  const zero = await writeRange([none.reader], NAMES_CODEC, [], WHOLE_WINDOW, empty, { compress: nodeCompress, recordsPerBlock: R });
  const asm0 = assembleRanges([factsOf(zero)], { dataset: NAMES_CODEC.id, recordsPerBlock: R });
  assert.equal(asm0.records, 0);
  assert.deepEqual(
    empty.parts().map((p) => p.length),
    [PART_HEADER_BYTES],
  );
});

test("range: assembly refuses a missing range, a range twice, parts out of order and a broken chain", async () => {
  const inputs = await namesInputs(4, 50);
  const readers = readersOf(inputs);
  const plan = planRanges(
    inputs.map((p) => readIdx(p.summary.idx)),
    { ranges: 3 },
  );
  const m = await matrix(readers, plan.cuts);
  const facts = m.outs.map(factsOf);
  const format = { dataset: NAMES_CODEC.id, recordsPerBlock: R };
  assert.throws(
    () => assembleRanges([facts[0], facts[2]], format),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /range 1 of 3 is missing/.test(e.message),
  );
  assert.throws(
    () => assembleRanges([...facts, facts[1]], format),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /range 1 is given twice/.test(e.message),
  );
  const swapped = [facts[0], { ...facts[1], part: 2 }, { ...facts[2], part: 1 }];
  assert.throws(
    () => assembleRanges(swapped, format),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /wrote part 2, where part 1 belongs/.test(e.message),
  );
  const broken = [facts[0], { ...facts[1], first: facts[1].entries[0].key.concat("x") }, facts[2]];
  assert.throws(
    () => assembleRanges(broken, format),
    (e: unknown) => e instanceof CompactError && e.code === "range" && /a record is lost or written twice between them/.test(e.message),
  );
  const tail = [facts[0], facts[1], { ...facts[2], next: "zz" }];
  assert.throws(
    () => assembleRanges(tail, format),
    (e: unknown) => e instanceof CompactError && e.code === "range" && /writes the last part and the inputs go on/.test(e.message),
  );
});

test("range: counts that are not of the inputs are refused, never written around", async () => {
  const inputs = await namesInputs(4, 50);
  const readers = readersOf(inputs);
  const plan = planRanges(
    inputs.map((p) => readIdx(p.summary.idx)),
    { ranges: 3 },
  );
  const counts: RangeCount[] = [];
  for (let r = 0; r < 3; r += 1) counts.push(await countRange(readers, NAMES_CODEC, plan.cuts, r));
  // Range 1 counted one record short: the windows of ranges 1 and 2 no longer meet the inputs.
  const short = counts.map((c) => (c.range === 1 ? { ...c, count: c.count - 1 } : c));
  const outcomes: string[] = [];
  const outs: RangeOutput[] = [];
  for (let r = 0; r < 3; r += 1) {
    try {
      outs.push(await writeRange(readers, NAMES_CODEC, plan.cuts, windowOf(short, r, R), new PartsByNumber(), { compress: nodeCompress, recordsPerBlock: R }));
    } catch (e) {
      assert.ok(e instanceof CompactError && e.code === "range", String(e));
      outcomes.push(`range ${r}: ${e.message}`);
    }
  }
  if (outcomes.length === 0)
    assert.throws(
      () => assembleRanges(outs.map(factsOf), { dataset: NAMES_CODEC.id, recordsPerBlock: R }),
      (e: unknown) => e instanceof CompactError && e.code === "range",
    );
  // A set of counts with a range missing or twice is refused before a window.
  assert.throws(
    () => windowOf([counts[0], counts[2]], 0, R),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /range 1 of 3 has no count/.test(e.message),
  );
  assert.throws(
    () => windowOf([...counts, counts[0]], 0, R),
    (e: unknown) => e instanceof CompactError && e.code === "plan" && /range 0 is counted twice/.test(e.message),
  );
});

test("range: the plan cuts at index page keys into ranges of about equal input bytes", async () => {
  const inputs = await namesInputs(6, 200, 4, 2000);
  const indexes = inputs.map((p) => readIdx(p.summary.idx));
  const plan = planRanges(indexes, { ranges: 4 });
  assert.equal(plan.ranges, 4);
  assert.equal(
    plan.bytes.reduce((a, b) => a + b, 0),
    plan.total,
  );
  const mean = plan.total / 4;
  for (const b of plan.bytes) assert.ok(Math.abs(b - mean) < mean * 0.25, `range bytes ${plan.bytes.join(", ")} against a mean of ${mean}`);
  // Each cut is the key of an index page of some input.
  const pageKeys = new Set(indexes.flatMap((i) => i.head.pages.map((p) => p.key)));
  for (const c of plan.cuts) assert.ok(pageKeys.has(c), c);
  // The target bytes give the count of ranges, at most one more than the page keys.
  assert.equal(planRanges(indexes, { targetBytes: Math.ceil(plan.total / 3) }).ranges, 3);
  assert.equal(planRanges(indexes, { targetBytes: plan.total }).ranges, 1);
  const pages = new Set(indexes.flatMap((i) => i.head.pages.map((p) => p.key))).size;
  assert.equal(planRanges(indexes, { ranges: 256 }).ranges, Math.min(256, pages));
});

test("range: a last range counted one short refuses its own window: the inputs go on past it", async () => {
  const inputs = await namesInputs(4, 50);
  const readers = readersOf(inputs);
  const plan = planRanges(
    inputs.map((p) => readIdx(p.summary.idx)),
    { ranges: 3 },
  );
  const counts: RangeCount[] = [];
  for (let r = 0; r < 3; r += 1) counts.push(await countRange(readers, NAMES_CODEC, plan.cuts, r));
  const short = counts.map((c) => (c.range === 2 ? { ...c, count: c.count - 1 } : c));
  await refusedAsync(
    () => writeRange(readers, NAMES_CODEC, plan.cuts, windowOf(short, 2, R), new PartsByNumber(), { compress: nodeCompress, recordsPerBlock: R }),
    "range",
    /range 2 of 3: its window ends at record \d+ of \d+, and the inputs go on at /,
  );
  // Counted one over, the inputs end before the window does.
  const over = counts.map((c) => (c.range === 2 ? { ...c, count: c.count + 1 } : c));
  await refusedAsync(
    () => writeRange(readers, NAMES_CODEC, plan.cuts, windowOf(over, 2, R), new PartsByNumber(), { compress: nodeCompress, recordsPerBlock: R }),
    "range",
    /range 2 of 3: the inputs end after \d+ of the \d+ records its window holds/,
  );
});

test("range: a part whose header names another part number is refused when it is hashed", async () => {
  const inputs = await namesInputs(4, 50);
  const readers = readersOf(inputs);
  const plan = planRanges(
    inputs.map((p) => readIdx(p.summary.idx)),
    { ranges: 3 },
  );
  const m = await matrix(readers, plan.cuts);
  const asm = assembleRanges(m.outs.map(factsOf), { dataset: NAMES_CODEC.id, recordsPerBlock: R });
  const parts = m.parts.map((p) => p.slice());
  // Byte 8 of a part header is its part number, a u16 (docs/format.md section 3).
  parts[1][8] = 0;
  await refusedAsync(
    () =>
      hashParts(
        asm.idx,
        partsSource(parts),
        parts.map((p) => p.length),
        NAMES_CODEC,
      ),
    "range",
    /part 1: its header names part 0, dataset 1/,
  );
});

test("range: the check of part 0 starts at the key space's start, so a merge that drops the first key fails it", async () => {
  const inputs = await namesInputs(4, 50);
  const readers = readersOf(inputs);
  const plan = planRanges(
    inputs.map((p) => readIdx(p.summary.idx)),
    { ranges: 3 },
  );
  const m = await matrix(readers, plan.cuts);
  // Every part of the matrix passes its check.
  for (const out of m.outs) {
    if (out.part === null) continue;
    const written = await readerOf(out.summary?.idx as Uint8Array, [m.parts[out.part]], NAMES_CODEC);
    const check = await checkRange(readers, written.scan(), out, NAMES_CODEC);
    assert.equal(check.records, out.records);
  }
  // Part 0 written from the merge less its first key: its own first key is then the second.
  const out0 = m.outs.find((o) => o.part === 0) as RangeOutput;
  const merged = await collect(mergePacks(readers, NAMES_CODEC));
  const short = await memPack(merged.slice(1, out0.records), NAMES_CODEC);
  const facts = { part: 0, first: merged[1].key, next: out0.next };
  await refusedAsync(() => checkRange(readers, short.reader.scan(), facts, NAMES_CODEC), "count", new RegExp(`the output lacks the key "${merged[0].key.replaceAll(".", "\\.")}" of its inputs`));
  // A range that writes no part has nothing to check.
  await refusedAsync(() => checkRange(readers, short.reader.scan(), { part: null, first: null, next: null }, NAMES_CODEC), "usage", /writes no part/);
});

test("range: a range whose blocks pass one part is refused (span)", async () => {
  const inputs = await namesInputs(3, 60);
  const readers = readersOf(inputs);
  await refusedAsync(
    () => writeRange(readers, NAMES_CODEC, [], WHOLE_WINDOW, new MemorySink(), { compress: nodeCompress, recordsPerBlock: R, partLimit: 200 }),
    "span",
    /its blocks pass one part; plan more ranges/,
  );
});
