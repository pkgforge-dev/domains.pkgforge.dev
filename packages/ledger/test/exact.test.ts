// packages/ledger/src/exact.ts: the exact join of a day's domains with the packs
// of the earlier tiers. Synthetic keys and times, real packs (DOM-017's writer
// and reader, node:zlib at level 9).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_SECONDS, exactNew, LedgerError, newExactStats, precisionsOf } from "../src/index.ts";
import { collect, DOMAINS_CODEC, domainKey, domainRecord, NAMES_CODEC, nameRecord, readerOf, rng, seen, writeMem } from "./helpers.ts";

const isLedger = (code: string) => (e: unknown) => e instanceof LedgerError && e.code === code;
const precision = precisionsOf([
  { bit: 0, precision: "day" },
  { bit: 5, precision: "second" },
]);

// n distinct domain keys, sorted.
const keysOf = (ns: Iterable<number>): string[] => [...new Set([...ns].map(domainKey))].sort();
const recordsOf = (keys: readonly string[], day: number) => keys.map((k) => domainRecord(k, [seen(0, day)]));

test("exact: a day domain absent from every earlier pack is new, and one any earlier pack holds is not", async () => {
  const next = rng(7);
  const draw = (n: number) => keysOf(Array.from({ length: n }, () => Math.floor(next() * 40_000)));
  const year = draw(6000);
  const month = draw(3000);
  const week = draw(1000);
  const day = draw(2500);
  const base = await Promise.all([recordsOf(year, 100), recordsOf(month, 200), recordsOf(week, 290)].map(async (r) => readerOf(await writeMem(r, DOMAINS_CODEC), DOMAINS_CODEC)));
  const stats = newExactStats();
  const out = await collect(exactNew(recordsOf(day, 298), base, { stats }));
  const earlier = new Set([...year, ...month, ...week]);
  const expected = day.filter((k) => !earlier.has(k));
  assert.deepEqual(
    out.map((r) => r.key),
    expected,
  );
  assert.ok(expected.length > 100 && expected.length < day.length, `${expected.length} of ${day.length} new`);
  assert.equal(stats.day, day.length);
  assert.equal(stats.new, expected.length);
});

test("exact: the join reads only the blocks a day key falls in, through the index, each once", async (t) => {
  // 64 records a block and 4 entries a page (helpers.ts): 10,000 domains are
  // 157 blocks on 40 pages. No page cache, so every page use is a read.
  const all = keysOf(Array.from({ length: 10_000 }, (_, i) => i));
  const table = await writeMem(recordsOf(all, 100), DOMAINS_CODEC);
  const reader = await readerOf(table, DOMAINS_CODEC, 0);
  // Day keys from three narrow runs of the table, plus keys it does not hold.
  const day = [...all.slice(1000, 1010), ...all.slice(5000, 5100), ...all.slice(9990), "com.zz-absent", "net.absent"].sort();
  const touched = new Set<number>();
  for (const k of day) {
    const e = await reader.blockOf(k);
    if (e !== null && k <= (reader.index.head.keyMax as string)) touched.add(e.index);
  }
  const stats = newExactStats();
  const readsBefore = reader.reads;
  const idxBefore = reader.idxReads;
  const out = await collect(exactNew(recordsOf(day, 298), [reader], { stats }));
  assert.deepEqual(
    out.map((r) => r.key),
    ["com.zz-absent", "net.absent"].filter((k) => !all.includes(k)),
  );
  assert.equal(stats.blocksRead, touched.size, "one read per block a day key falls in");
  assert.ok(touched.size < table.summary.blocks / 10, `${touched.size} of ${table.summary.blocks} blocks`);
  assert.equal(reader.reads - readsBefore, touched.size, "no block read twice");
  // Each block read costs one page to find it and one to learn where the next
  // block starts; a day key inside the block held costs no index read.
  assert.ok(reader.idxReads - idxBefore <= 2 * touched.size, `${reader.idxReads - idxBefore} index reads for ${touched.size} blocks and ${day.length} day keys`);
  // The figures this layout gives, pinned: the keys, the 64 records a block and
  // the 4 entries a page are fixed, so a change of any figure is a change of
  // the join or of the format, never noise.
  const idxReads = reader.idxReads - idxBefore;
  t.diagnostic(`${day.length} day keys, ${table.summary.blocks} blocks, ${stats.blocksRead} read (blocks ${[...touched].join(", ")}), ${idxReads} index page reads`);
  assert.equal(day.length, 122);
  assert.equal(table.summary.blocks, 157);
  assert.deepEqual([...touched], [15, 31, 78, 79, 156]);
  assert.equal(stats.blocksRead, 5);
  assert.equal(idxReads, 9);
});

test("exact: with since, a record whose own first seen is earlier is not new", async () => {
  const base = await readerOf(await writeMem(recordsOf(["com.old"], 100), DOMAINS_CODEC), DOMAINS_CODEC);
  const since = 298 * DAY_SECONDS;
  const day = [
    domainRecord("com.fresh", [seen(0, 298)]),
    // An RDAP-style day source dates it to day 120: an earlier observation.
    domainRecord("com.registered-long-ago", [seen(0, 120), seen(5, since + 50)]),
    domainRecord("com.second", [seen(5, since + 3600)]),
    domainRecord("com.old", [seen(0, 298)]),
  ].sort((a, b) => (a.key < b.key ? -1 : 1));
  const stats = newExactStats();
  const out = await collect(exactNew(day, [base], { since, precision, stats }));
  assert.deepEqual(
    out.map((r) => r.key),
    ["com.fresh", "com.second"],
  );
  assert.equal(stats.early, 1);
  assert.deepEqual((await collect(exactNew(day, [base]))).length, 3, "without since only the earlier packs decide");
});

test("exact: day keys out of order, since without precision and a pack of another dataset are refused", async () => {
  const base = await readerOf(await writeMem(recordsOf(["com.a"], 100), DOMAINS_CODEC), DOMAINS_CODEC);
  await assert.rejects(collect(exactNew(recordsOf(["com.c", "com.b"], 298), [base])), isLedger("order"));
  await assert.rejects(collect(exactNew(recordsOf(["com.c"], 298), [base], { since: 5 })), isLedger("usage"));
  const names = await readerOf(await writeMem([nameRecord("com.a", [seen(0, 1)])], NAMES_CODEC), NAMES_CODEC);
  // A names pack read as if it were domains: the join refuses it by the index's dataset.
  await assert.rejects(collect(exactNew(recordsOf(["com.c"], 298), [names as never])), isLedger("usage"));
});

test("exact: a since below 0 or not whole seconds is refused, and 0 is the epoch itself", async () => {
  const base = await readerOf(await writeMem(recordsOf(["com.a"], 100), DOMAINS_CODEC), DOMAINS_CODEC);
  const day = recordsOf(["com.c"], 298);
  for (const since of [-1, -DAY_SECONDS, 1.5, Number.NaN, 2 ** 53]) {
    await assert.rejects(collect(exactNew(day, [base], { since, precision })), isLedger("usage"), String(since));
  }
  assert.deepEqual(
    (await collect(exactNew(day, [base], { since: 0, precision }))).map((r) => r.key),
    ["com.c"],
  );
});
