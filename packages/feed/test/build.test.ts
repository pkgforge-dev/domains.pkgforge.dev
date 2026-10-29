// packages/feed/src/build.ts: the rows of a day pack from the exact join of
// DOM-021 (exactNew), of an hour pack from its provisional filter, and the pack
// with its time copy. Real packs (DOM-017's writer and reader, node:zlib at
// level 9); the OpenINTEL payloads are recorded (helpers.ts), every other row
// synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BloomFilter, exactNew, HashDelta, hashKey, ProvisionalFilter } from "@domains/ledger";
import {
  DOMAINS_CODEC,
  FEED_CODEC,
  FEED_CORROBORATED,
  FEED_PROVISIONAL,
  FEED_SUSPECT,
  FEED_SUSPECT_CERT,
  FEED_SUSPECT_RDAP,
  FEED_TIME_CODEC,
  type FeedRecord,
  MAX_TIME_FIRST_SEEN,
  MemorySink,
  NEW_NAME_CODEC,
  NEW_NAME_TIME_CODEC,
  PackError,
  PackReader,
  partsSource,
  timeKey,
  writePack,
} from "@domains/pack";
import { nodeCompress } from "@domains/pack/node";
import { buildFeedDay, buildFeedHour, compareRows, type DomainEvent, describeRow, FeedError, feedRowOf, rowPrecision, writeFeedPack } from "../src/index.ts";
import {
  BIT,
  CONFIRMED_EVENT,
  collect,
  D,
  DAY,
  evidence,
  FRESH_CERT_EVENT,
  HOUR,
  isc,
  mergeEvents,
  OLD_CERT_EVENT,
  oiConfirmed,
  oiNrd,
  recorded,
  row,
  seen,
  table,
  whoisds,
  writeFeed,
} from "./helpers.ts";
import type { OiNrdPayload } from "./helpers.ts";

const isFeed = (code: string) => (e: unknown) => e instanceof FeedError && e.code === code;
const D27 = 299;
const day = (d: number) => ({ t0: d * DAY, t1: (d + 1) * DAY });
const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// The day 2026-10-27: two recorded oi-nrd events, one of them also in a
// synthetic ISC row of that day, the recorded confirmed event, an ISC-only
// row and a thc-ct-only row.
function day27(): DomainEvent[] {
  const tinifb = oiNrd(recorded<OiNrdPayload>("newly_registered_domain", 172_166_088));
  const onlinendib = mergeEvents(
    oiNrd(recorded<OiNrdPayload>("newly_registered_domain", 172_166_089)),
    isc({ domainname: "onlinendib.com", firstseen: "2026-10-27", score: 0, scorereason: "synthetic" }),
  );
  return [
    tinifb,
    onlinendib,
    oiConfirmed(CONFIRMED_EVENT),
    isc({ domainname: "isc-synthetic.com", ip: 3232235777, firstseen: "2026-10-27", score: 1, scorereason: "synthetic" }),
    { key: "com.thc-synthetic", flags: 1, sources: [seen(BIT.thc, D27)], evidence: [] },
  ].sort(byKey);
}

test("build: the day pack holds the domains the exact join of DOM-021 keeps, each row from its record", async () => {
  const records = day27();
  // An earlier tier holds com.isc-synthetic: the join drops it.
  const sink = new MemorySink();
  const earlier = await writePack([{ key: "com.isc-synthetic", flags: 0, sources: [seen(BIT.isc, 290)], evidence: [evidence(2, BIT.isc, 290)] }], {
    codec: DOMAINS_CODEC,
    compress: nodeCompress,
    sink,
  });
  const base = await PackReader.open(earlier.idx, partsSource(sink.parts()), DOMAINS_CODEC);
  const keys = (await collect(exactNew(records, [base], { since: D27 * DAY, precision: table.precision }))).map((r) => r.key);
  assert.deepEqual(keys, ["com.onlinendib", "com.thc-synthetic", "com.tuningledger", "net.tinifb"]);
  const rows = await collect(buildFeedDay(records, keys, { table, window: day(D27) }));
  assert.deepEqual(
    rows.map((r) => [r.key, r.firstSeen - D27 * DAY, r.sources, r.basis, r.confidence, r.feedFlags]),
    [
      // oi-nrd at 05:30:36 and ISC on the day: first_seen is the start of the day, corroborated.
      ["com.onlinendib", 0, [BIT.oiNrd, BIT.isc], 2 ** 2, 0, FEED_CORROBORATED],
      ["com.thc-synthetic", 0, [BIT.thc], 2 ** 4, 0, 0],
      ["com.tuningledger", 5 * HOUR + 30 * 60 + 31, [BIT.oiConfirmed], 2 ** 3, 3, 0],
      ["net.tinifb", 5 * HOUR + 30 * 60 + 36, [BIT.oiNrd], 2 ** 2, 0, 0],
    ],
  );
  assert.deepEqual(
    rows.map((r) => rowPrecision(r, table.precision)),
    ["day", "day", "second", "second"],
  );
  assert.equal(rows[2].flags, 0);
  assert.equal(rows[1].flags, 1, "the exact flag of the record");
});

test("build: the recorded event with a 40-day certificate is a suspect row of its day, with the reason suspect-cert in the row", async () => {
  const rows = await collect(buildFeedDay([oiNrd(OLD_CERT_EVENT), oiNrd(FRESH_CERT_EVENT)].sort(byKey), ["com.creatorwide", "com.pracovento"], { table, window: day(287) }));
  assert.deepEqual(
    rows.map((r) => [r.key, r.feedFlags]),
    [
      ["com.creatorwide", FEED_SUSPECT | FEED_SUSPECT_CERT],
      ["com.pracovento", 0],
    ],
  );
  // The reason survives the pack: written, read back, and named by describeRow.
  const pack = await writeFeed(rows);
  const back = await collect((await PackReader.open(pack.summary.idx, partsSource(pack.parts), FEED_CODEC)).scan());
  assert.deepEqual(describeRow(back[0], table).reasons, ["cert-age"]);
  assert.deepEqual(describeRow(back[0], table).flags, ["suspect"]);
  assert.deepEqual(describeRow(back[1], table).reasons, []);
});

test("build: an RDAP creation date before 2026 sets suspect with the reason suspect-rdap, and both reasons together set both bits", () => {
  const w = day(D27);
  const event = (facts: DomainEvent["facts"]): DomainEvent => ({ key: "com.old-synthetic", flags: 0, sources: [seen(BIT.oiNrd, w.t0 + 5)], evidence: [], facts });
  const rdap = feedRowOf(event({ rdapCreated: [{ bit: BIT.rdap, date: "2012-03-04" }] }), { table, window: w }, false);
  assert.equal(rdap.feedFlags, FEED_SUSPECT | FEED_SUSPECT_RDAP);
  assert.deepEqual(describeRow(rdap, table).reasons, ["rdap-before-2026"]);
  const both = feedRowOf(event({ rdapCreated: [{ bit: BIT.rdap, date: "2012-03-04" }], certAges: [{ bit: BIT.oiNrd, seconds: 9 * DAY }] }), { table, window: w }, true);
  assert.equal(both.feedFlags, FEED_PROVISIONAL | FEED_SUSPECT | FEED_SUSPECT_CERT | FEED_SUSPECT_RDAP);
  assert.deepEqual(describeRow(both, table).reasons, ["cert-age", "rdap-before-2026"]);
  assert.deepEqual(describeRow(both, table).flags, ["provisional", "suspect"]);
  // A row that is not suspect carries no reason.
  assert.equal(feedRowOf(event(undefined), { table, window: w }, false).feedFlags, 0);
});

test("build: a join key the day lacks, keys out of order, a row outside its span and a span that is not a day are refused", async () => {
  const records = day27();
  await assert.rejects(collect(buildFeedDay(records, ["com.not-in-the-day"], { table, window: day(D27) })), isFeed("usage"));
  await assert.rejects(collect(buildFeedDay([...records].reverse(), ["net.tinifb"], { table, window: day(D27) })), isFeed("order"));
  // A WhoisDS row of the file dated 2026-10-28 is dated 2026-10-27: it belongs
  // to that day's pack, and the pack of 2026-10-28 refuses it.
  const w = whoisds("whoisds-synthetic.com", "2026-10-28");
  assert.equal(w.sources[0].first, D27);
  assert.equal((await collect(buildFeedDay([w], [w.key], { table, window: day(D27) })))[0].firstSeen, D27 * DAY);
  await assert.rejects(collect(buildFeedDay([w], [w.key], { table, window: day(D27 + 1) })), isFeed("window"));
  await assert.rejects(collect(buildFeedDay(records, [], { table, window: { t0: D27 * DAY, t1: D27 * DAY + HOUR } })), isFeed("window"));
  await assert.rejects(collect(buildFeedDay(records, [], { table, window: { t0: D27 * DAY + 1, t1: (D27 + 1) * DAY + 1 } })), isFeed("window"));
  assert.throws(() => feedRowOf(records[0], { table, window: { t0: 5, t1: 5 } }, false), isFeed("window"));
});

test("build: a row at the last second of its pack's span is kept, and one at the span's end is refused: it belongs to the next pack", () => {
  const w = day(D27);
  const at = (t: number): DomainEvent => ({ key: "com.edge-synthetic", flags: 0, sources: [seen(BIT.oiNrd, t)], evidence: [] });
  assert.equal(feedRowOf(at(w.t1 - 1), { table, window: w }, false).firstSeen, w.t1 - 1);
  assert.throws(() => feedRowOf(at(w.t1), { table, window: w }, false), isFeed("window"));
  assert.equal(feedRowOf(at(w.t0), { table, window: w }, false).firstSeen, w.t0);
  assert.throws(() => feedRowOf(at(w.t0 - 1), { table, window: w }, false), isFeed("window"));
});

test("build: the hour pack holds the domains its filter did not hold, provisional, and adds each to it", async () => {
  const hour = { t0: D27 * DAY + 5 * HOUR, t1: D27 * DAY + 6 * HOUR };
  const events = day27().filter((e) => e.sources.every((s) => table.precision(s.bit) === "second"));
  assert.deepEqual(
    events.map((e) => e.key),
    ["com.tuningledger", "net.tinifb"],
  );
  const filter = BloomFilter.forKeys(100, { asOf: D27 * DAY });
  filter.add(hashKey("com.tuningledger"));
  const membership = new ProvisionalFilter(filter, HashDelta.empty(filter));
  const rows = await collect(buildFeedHour(events, membership, { table, window: hour }));
  assert.deepEqual(
    rows.map((r) => [r.key, r.feedFlags]),
    [["net.tinifb", FEED_PROVISIONAL]],
  );
  assert.equal(membership.has(hashKey("net.tinifb")), true, "added: the next hour does not judge it new again");
  assert.deepEqual(await collect(buildFeedHour(events, membership, { table, window: hour })), []);
  await assert.rejects(collect(buildFeedHour(events, membership, { table, window: day(D27) })), isFeed("window"));
  // A day source in an hour: its first_seen is the start of the day, outside the hour.
  const fresh = new ProvisionalFilter(filter, HashDelta.empty(filter));
  const dayRow = isc({ domainname: "isc-hour-synthetic.com", firstseen: "2026-10-27", score: 0, scorereason: "synthetic" });
  await assert.rejects(collect(buildFeedHour([dayRow], fresh, { table, window: hour })), isFeed("window"));
});

test("build: writeFeedPack writes the key copy and the time copy: the same rows, in key order and in (first_seen, key) order", async () => {
  const rows = await collect(buildFeedDay(day27(), ["com.onlinendib", "com.thc-synthetic", "com.tuningledger", "net.tinifb"], { table, window: day(D27) }));
  const pack = await writeFeed(rows, { recordsPerBlock: 2, timeRecordsPerBlock: 3 });
  const reader = await PackReader.open(pack.summary.idx, partsSource(pack.parts), FEED_CODEC);
  assert.deepEqual(await collect(reader.scan()), rows);
  assert.ok(pack.time !== null);
  const time = await PackReader.open(pack.time.summary.idx, partsSource(pack.time.parts), FEED_TIME_CODEC);
  assert.deepEqual([time.index.header.dataset, time.index.header.records, time.index.header.blocks], [6, 4, 2]);
  const inTime = await collect(time.scan());
  assert.deepEqual(inTime, [...rows].sort(compareRows), "the same rows, whole");
  assert.deepEqual(
    inTime.map((r) => r.key),
    ["com.onlinendib", "com.thc-synthetic", "com.tuningledger", "net.tinifb"],
    "the two rows at the start of the day in key order, then the seconds",
  );
  // A row is found in the time copy by its time key.
  assert.deepEqual(await time.get(timeKey(rows[2].firstSeen, rows[2].key)), rows[2]);
  // new-name gets dataset 7; a pack written without `time` has no time copy.
  const nn = await writeFeedPack(rows, { codec: NEW_NAME_CODEC, compress: nodeCompress, sink: new MemorySink(), time: { sink: new MemorySink() } });
  assert.equal(nn.time?.dataset, NEW_NAME_TIME_CODEC.id);
  assert.equal((await writeFeedPack(rows, { compress: nodeCompress, sink: new MemorySink() })).time, null);
});

// A sink that counts its writes, so a test sees whether any byte reached it.
class CountingSink extends MemorySink {
  writes = 0;
  override write(part: number, bytes: Uint8Array): void {
    this.writes += 1;
    super.write(part, bytes);
  }
}

test("build: writeFeedPack refuses a first_seen above 2^32 - 1 before its first write to either sink, wherever the row stands", async () => {
  // 300 rows at 64 a block: the key copy's writer would have written four
  // blocks before it reached the last row.
  const rows: FeedRecord[] = Array.from({ length: 300 }, (_, i) => row(`com.syn${String(i).padStart(4, "0")}`, D * DAY + i));
  for (const at of [0, 150, 299]) {
    const bad = rows.map((r, i) => (i === at ? { ...r, firstSeen: MAX_TIME_FIRST_SEEN + 1 } : r));
    const sink = new CountingSink();
    const timeSink = new CountingSink();
    await assert.rejects(
      writeFeedPack(bad, { compress: nodeCompress, sink, recordsPerBlock: 64, time: { sink: timeSink } }),
      (e: unknown) => e instanceof FeedError && e.code === "time" && /first_seen 4294967296/.test(e.message) && /nothing is written/.test(e.message),
      `row ${at}`,
    );
    assert.deepEqual([sink.writes, timeSink.writes], [0, 0], `row ${at}: neither sink holds a byte`);
  }
  // The largest first_seen a time key holds is written, and reads back.
  const edge = [row("com.edge-synthetic", MAX_TIME_FIRST_SEEN)];
  const timeSink = new MemorySink();
  const ok = await writeFeedPack(edge, { compress: nodeCompress, sink: new MemorySink(), time: { sink: timeSink } });
  const back = await PackReader.open(ok.time?.idx as Uint8Array, partsSource(timeSink.parts()), FEED_TIME_CODEC);
  assert.deepEqual(await collect(back.scan()), edge);
  // Without a time copy the key copy holds any first_seen up to 2^53 - 1.
  const far = await writeFeedPack([row("com.far-synthetic", MAX_TIME_FIRST_SEEN + 1)], { compress: nodeCompress, sink: new MemorySink() });
  assert.equal(far.summary.records, 1);
  // The time codec itself refuses the value too, as a record.
  assert.throws(
    () => FEED_TIME_CODEC.key(row("com.far-synthetic", MAX_TIME_FIRST_SEEN + 1)),
    (e: unknown) => e instanceof PackError && e.code === "record",
  );
});

test("build: a row the key copy's writer refuses leaves the key sink with the blocks before it and the time sink empty", async () => {
  const rows: FeedRecord[] = Array.from({ length: 200 }, (_, i) => row(`com.syn${String(i).padStart(4, "0")}`, D * DAY + i));
  // Row 150's key is below the row before it.
  const bad = rows.map((r, i) => (i === 150 ? { ...r, key: "com.a-synthetic" } : r));
  const sink = new CountingSink();
  const timeSink = new CountingSink();
  await assert.rejects(writeFeedPack(bad, { compress: nodeCompress, sink, recordsPerBlock: 64, time: { sink: timeSink } }), (e: unknown) => e instanceof PackError && e.code === "order");
  // The part header and blocks 0 and 1 (rows 0 to 127).
  assert.equal(sink.writes, 3);
  assert.equal(timeSink.writes, 0);
});
