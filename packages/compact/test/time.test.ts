// The time copy of a feed or new-name tier pack (docs/format.md section 14):
// merged from the inputs' time copies when no key is in two inputs, sorted
// otherwise, each held byte for byte to the time copy writeFeedPack of
// @domains/feed writes for the same rows. Synthetic rows (test/helpers.ts).
//
//   node scripts/test.mjs packages/compact --name time
import assert from "node:assert/strict";
import { test } from "node:test";
import { FEED_CODEC, FEED_TIME_CODEC, type FeedRecord, MemorySink, mergePacks, NEW_NAME_CODEC, NEW_NAME_TIME_CODEC, partsSource, readIdx } from "@domains/pack";
import { nodeCompress } from "@domains/pack/node";
import { writeFeedPack } from "@domains/feed";
import {
  assembleRanges,
  bindFault,
  CompactError,
  checkMerged,
  countRange,
  factsOf,
  hashParts,
  mergeSpan,
  planRanges,
  type RangeCount,
  type RangeOutput,
  sortTimeCopy,
  timeMode,
  windowOf,
  writeRange,
} from "../src/index.ts";
import { collect, feedPack, feedRows, type FeedMem, keys, PartsByNumber, readerOf } from "./helpers.ts";

const R = 4;
const DAY = 86_400;
// 2026-10-19, a Monday, as seconds since 2026-01-01.
const MONDAY = (Date.UTC(2026, 9, 19) - Date.UTC(2026, 0, 1)) / 1000;
const WEEK = { start: "2026-10-19T00:00:00Z", end: "2026-10-26T00:00:00Z" };

// Seven day packs of feed, each with its time copy; with `shared`, a key of
// day 0 is also a key of day 3 (the merge then folds them).
async function days(codec = FEED_CODEC, timeCodec = FEED_TIME_CODEC, shared = false): Promise<FeedMem[]> {
  const out: FeedMem[] = [];
  for (let d = 0; d < 7; d += 1) {
    // Keys of one day only: a suffix of their own per day.
    let ks = keys(200 + d, 30, 300).map((k) => `${k}.d${d}`);
    if (shared && d === 3) ks = [...ks, keys(200, 30, 300).map((k) => `${k}.d0`)[5]].sort();
    out.push(await feedPack(feedRows(ks, MONDAY + d * DAY, 7 + d), codec, timeCodec, R));
  }
  return out;
}

// The rows of the merge, in key order.
const mergedRows = async (inputs: FeedMem[], codec = FEED_CODEC): Promise<FeedRecord[]> =>
  collect(
    mergePacks(
      inputs.map((i) => i.key.reader),
      codec,
    ),
  );

// writeFeedPack's time copy of `rows`: the reference.
async function reference(rows: FeedRecord[], codec = FEED_CODEC) {
  const sink = new MemorySink();
  const time = new MemorySink();
  const pack = await writeFeedPack(rows, { codec, compress: nodeCompress, sink, recordsPerBlock: R, time: { sink: time, recordsPerBlock: R } });
  return { key: pack.summary, time: pack.time, keyParts: sink.parts(), timeParts: time.parts() };
}

test("time: with no key in two inputs, the merge of the inputs' time copies equals the sort, byte for byte", async () => {
  for (const [codec, timeCodec] of [
    [FEED_CODEC, FEED_TIME_CODEC],
    [NEW_NAME_CODEC, NEW_NAME_TIME_CODEC],
  ] as const) {
    const inputs = await days(codec, timeCodec);
    const keySink = new MemorySink();
    const key = await mergeSpan(
      inputs.map((i) => i.key.reader),
      codec,
      keySink,
      { compress: nodeCompress, recordsPerBlock: R },
    );
    const inputRecords = inputs.reduce((n, i) => n + i.key.summary.records, 0);
    assert.equal(timeMode(key.records, inputRecords, true), "merge");
    const timeSink = new MemorySink();
    const time = await mergeSpan(
      inputs.map((i) => i.time.reader),
      timeCodec,
      timeSink,
      { compress: nodeCompress, recordsPerBlock: R },
    );
    const ref = await reference(await mergedRows(inputs, codec), codec);
    assert.deepEqual(key.idx, ref.key.idx);
    assert.deepEqual(time.idx, ref.time?.idx, `${codec.name}: the time index`);
    assert.deepEqual(timeSink.parts(), ref.timeParts, `${codec.name}: the time parts`);
    // The sort gives the same bytes.
    const sortSink = new MemorySink();
    const sorted = await sortTimeCopy(await mergedRows(inputs, codec), codec, sortSink, { compress: nodeCompress, recordsPerBlock: R });
    assert.deepEqual(sorted.idx, ref.time?.idx);
    assert.deepEqual(sortSink.parts(), ref.timeParts);
    // It binds to its key copy, and the second pass holds it to the inputs' time copies.
    assert.equal(bindFault(key.idx, time.idx, WEEK), null);
    const out = await readerOf(time.idx, timeSink.parts(), timeCodec);
    const check = await checkMerged(
      inputs.map((i) => i.time.reader.scan()),
      out.scan(),
      timeCodec,
    );
    assert.equal(check.records, key.records);
  }
});

test("time: a ranged merge of the time copies assembled equals the merge of one process, byte for byte", async () => {
  const inputs = await days();
  const readers = inputs.map((i) => i.time.reader);
  const plan = planRanges(
    inputs.map((i) => readIdx(i.time.summary.idx)),
    { ranges: 4 },
  );
  assert.equal(plan.ranges, 4);
  const single = new MemorySink();
  const one = await mergeSpan(readers, FEED_TIME_CODEC, single, { compress: nodeCompress, recordsPerBlock: R, cuts: plan.cuts });
  const counts: RangeCount[] = [];
  for (let r = 0; r < 4; r += 1) counts.push(await countRange(readers, FEED_TIME_CODEC, plan.cuts, r));
  // No key in two inputs: each range's distinct keys are its inputs' records.
  for (const c of counts) assert.equal(c.count, c.inputRecords);
  const outs: RangeOutput[] = [];
  const parts: Uint8Array[] = [];
  for (let r = 0; r < 4; r += 1) {
    const sink = new PartsByNumber();
    const out = await writeRange(readers, FEED_TIME_CODEC, plan.cuts, windowOf(counts, r, R), sink, { compress: nodeCompress, recordsPerBlock: R });
    outs.push(out);
    if (out.part !== null) parts[out.part] = sink.part(out.part);
  }
  const asm = assembleRanges(outs.map(factsOf), { dataset: FEED_TIME_CODEC.id, recordsPerBlock: R });
  assert.deepEqual(asm.idx, one.idx);
  assert.deepEqual(parts, single.parts());
  const digest = await hashParts(
    asm.idx,
    partsSource(parts),
    parts.map((p) => p.length),
    FEED_TIME_CODEC,
  );
  assert.equal(digest.sha256, one.sha256);
});

test("time: a key in two inputs makes the mode sort, and the sort equals writeFeedPack's time copy", async () => {
  const inputs = await days(FEED_CODEC, FEED_TIME_CODEC, true);
  const keySink = new MemorySink();
  const key = await mergeSpan(
    inputs.map((i) => i.key.reader),
    FEED_CODEC,
    keySink,
    { compress: nodeCompress, recordsPerBlock: R },
  );
  const inputRecords = inputs.reduce((n, i) => n + i.key.summary.records, 0);
  assert.equal(key.records, inputRecords - 1);
  assert.equal(timeMode(key.records, inputRecords, true), "sort");
  // A merge of the time copies would hold the shared key twice: one row too many.
  const wrong = await mergeSpan(
    inputs.map((i) => i.time.reader),
    FEED_TIME_CODEC,
    new MemorySink(),
    { compress: nodeCompress, recordsPerBlock: R },
  );
  assert.equal(wrong.records, key.records + 1);
  assert.match(bindFault(key.idx, wrong.idx, WEEK) ?? "", /holds \d+ records and its key copy \d+/);
  const rows = await mergedRows(inputs);
  const ref = await reference(rows);
  const sink = new MemorySink();
  const sorted = await sortTimeCopy(rows, FEED_CODEC, sink, { compress: nodeCompress, recordsPerBlock: R });
  assert.deepEqual(sorted.idx, ref.time?.idx);
  assert.deepEqual(sink.parts(), ref.timeParts);
  assert.equal(bindFault(key.idx, sorted.idx, WEEK), null);
  // An input with no time copy makes it a sort too.
  assert.equal(timeMode(10, 10, false), "sort");
});

test("time: the sort refuses more rows than it holds, and a first_seen a time key cannot hold, before any write", async () => {
  const rows = feedRows(keys(9, 20), MONDAY, 1);
  let writes = 0;
  const counting = { write: () => void (writes += 1) };
  await assert.rejects(
    () => sortTimeCopy(rows, FEED_CODEC, counting, { compress: nodeCompress, maxRows: 19 }),
    (e: unknown) => e instanceof CompactError && e.code === "sort" && /more than the 19 rows/.test(e.message),
  );
  const far = rows.map((r, i) => (i === 10 ? { ...r, firstSeen: 2 ** 32 } : r));
  await assert.rejects(
    () => sortTimeCopy(far, FEED_CODEC, counting, { compress: nodeCompress }),
    (e: unknown) => e instanceof CompactError && e.code === "time",
  );
  assert.equal(writes, 0);
  assert.throws(
    () => timeMode(11, 10, true),
    (e: unknown) => e instanceof CompactError && e.code === "usage",
  );
});

test("time: a time copy outside the pack's span does not bind", async () => {
  const inputs = await days();
  const one = inputs[0];
  assert.equal(bindFault(one.key.summary.idx, one.time.summary.idx, { start: "2026-10-19T00:00:00Z", end: "2026-10-20T00:00:00Z" }), null);
  assert.match(bindFault(one.key.summary.idx, one.time.summary.idx, { start: "2026-10-20T00:00:00Z", end: "2026-10-21T00:00:00Z" }) ?? "", /outside the span/);
});

test("time: the sort takes first_seen 0 and 2^32 - 1, and refuses -1 and 1.5 before any write", async () => {
  const rows = feedRows(keys(9, 20), MONDAY, 1);
  // The two ends of the time key (docs/format.md section 14): 0 and MAX_TIME_FIRST_SEEN.
  const ends = rows.map((r, i) => (i === 3 ? { ...r, firstSeen: 0 } : i === 7 ? { ...r, firstSeen: 0xffff_ffff } : r));
  const sink = new MemorySink();
  const sorted = await sortTimeCopy(ends, FEED_CODEC, sink, { compress: nodeCompress, recordsPerBlock: R });
  assert.equal(sorted.records, rows.length);
  const out = await collect((await readerOf(sorted.idx, sink.parts(), FEED_TIME_CODEC)).scan());
  assert.deepEqual([out[0].firstSeen, out.at(-1)?.firstSeen], [0, 0xffff_ffff]);
  let writes = 0;
  const counting = { write: () => void (writes += 1) };
  for (const bad of [-1, 1.5]) {
    await assert.rejects(
      () =>
        sortTimeCopy(
          rows.map((r, i) => (i === 10 ? { ...r, firstSeen: bad } : r)),
          FEED_CODEC,
          counting,
          { compress: nodeCompress },
        ),
      (e: unknown) => e instanceof CompactError && e.code === "time" && e.message.includes(`has first_seen ${bad}, which a time key cannot hold`),
    );
  }
  assert.equal(writes, 0);
});
