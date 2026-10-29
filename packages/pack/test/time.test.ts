// packages/pack/src/codec.ts and time.ts: the suspect reason bits of feed_flags
// (docs/format.md section 5.4), the time copies of datasets 6 and 7 (section 14):
// their time key, their record and their order, and the bind of a time copy to
// its key copy. Each refusal is a record or a head that breaks one rule. Every
// row is synthetic (helpers.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ByteReader, ByteWriter, fromHex, toHex } from "../src/bytes.ts";
import {
  BUILTIN_CODECS,
  type DatasetCodec,
  FEED_CODEC,
  FEED_PROVISIONAL,
  FEED_SUSPECT,
  FEED_SUSPECT_CERT,
  FEED_SUSPECT_RDAP,
  FEED_TIME_CODEC,
  type FeedRecord,
  MAX_TIME_FIRST_SEEN,
  NEW_NAME_CODEC,
  NEW_NAME_TIME_CODEC,
  splitTimeKey,
  TIME_KEY_BYTES,
  timeCodecOf,
  timeKey,
} from "../src/codec.ts";
import { PackError } from "../src/errors.ts";
import { DATASET_LABELS, TIME_IDX_TITLE, timePartTitle } from "../src/format.ts";
import { parseHead } from "../src/idx.ts";
import { RowSum, timeBindFault } from "../src/time.ts";
import { packAnnotations } from "../src/writer.ts";
import { collect, randomFeed, readerOf, writeMem } from "./helpers.ts";

function block<R>(codec: DatasetCodec<R>, records: readonly R[]): Uint8Array {
  const out = new ByteWriter();
  let prev: R | null = null;
  for (const r of records) {
    codec.encodeRecord(prev, r, out);
    prev = r;
  }
  return out.take();
}

function unblock<R>(codec: DatasetCodec<R>, bytes: Uint8Array): R[] {
  const input = new ByteReader(bytes, "record", "test block");
  const out: R[] = [];
  let prev: R | null = null;
  while (input.pos < input.end) {
    prev = codec.decodeRecord(prev, input);
    out.push(prev);
  }
  return out;
}

const refused = (fn: () => unknown, code: string, pattern: RegExp) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PackError, String(e));
    assert.equal(e.code, code, e.message);
    assert.match(e.message, pattern);
    return true;
  });

const row = (key: string, firstSeen: number, extra: Partial<FeedRecord> = {}): FeedRecord => ({ key, flags: 0, firstSeen, sources: [1], basis: 4, confidence: 0, feedFlags: 0, ...extra });
const byTime = (a: FeedRecord, b: FeedRecord): number => a.firstSeen - b.firstSeen || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

test("feed flags: suspect is set exactly when a reason is, bit 4 suspect-cert or bit 5 suspect-rdap; bits 6 and 7 stay reserved", () => {
  assert.deepEqual([FEED_SUSPECT_CERT, FEED_SUSPECT_RDAP], [16, 32]);
  const out = () => new ByteWriter();
  for (const codec of [FEED_CODEC, NEW_NAME_CODEC, FEED_TIME_CODEC, NEW_NAME_TIME_CODEC]) {
    for (const flags of [0, FEED_SUSPECT | FEED_SUSPECT_CERT, FEED_SUSPECT | FEED_SUSPECT_RDAP, FEED_SUSPECT | FEED_SUSPECT_CERT | FEED_SUSPECT_RDAP, FEED_PROVISIONAL | 4 | 8])
      codec.encodeRecord(null, row("com.a", 1, { feedFlags: flags }), out());
    const reason = /suspect \(bit 1\) is set exactly when a reason is \(bit 4 suspect-cert, bit 5 suspect-rdap\)/;
    refused(() => codec.encodeRecord(null, row("com.a", 1, { feedFlags: FEED_SUSPECT }), out()), "record", reason);
    refused(() => codec.encodeRecord(null, row("com.a", 1, { feedFlags: FEED_SUSPECT_CERT }), out()), "record", reason);
    refused(() => codec.encodeRecord(null, row("com.a", 1, { feedFlags: FEED_SUSPECT_RDAP | FEED_PROVISIONAL }), out()), "record", reason);
    refused(() => codec.encodeRecord(null, row("com.a", 1, { feedFlags: 64 | FEED_SUSPECT | FEED_SUSPECT_CERT }), out()), "record", /feed flags 82; the known bits are 0 to 5/);
  }
  // A merge ORs the reasons, so a merged row keeps the rule.
  const merged = FEED_CODEC.merge(row("com.a", 5, { feedFlags: FEED_SUSPECT | FEED_SUSPECT_CERT }), row("com.a", 3, { feedFlags: FEED_SUSPECT | FEED_SUSPECT_RDAP }));
  assert.equal(merged.feedFlags, FEED_SUSPECT | FEED_SUSPECT_CERT | FEED_SUSPECT_RDAP);
  // A reader keeps what it reads: a row of a suspect bit with no reason, or
  // reserved bits, from a writer this code does not know.
  assert.equal(FEED_CODEC.decodeRecord(null, new ByteReader(fromHex("0004610501010a02"), "record", "test")).feedFlags, FEED_SUSPECT);
});

test("time key: first_seen as 4 big-endian bytes, then the row's key; it orders as (first_seen, key), and holds 0 to 2^32 - 1", () => {
  assert.equal(toHex(Uint8Array.from(timeKey(0x01020304, "com.a"), (c) => c.charCodeAt(0))), "01020304636f6d2e61");
  assert.deepEqual(splitTimeKey(timeKey(MAX_TIME_FIRST_SEEN, "np.com.x")), { firstSeen: MAX_TIME_FIRST_SEEN, key: "np.com.x" });
  assert.deepEqual(splitTimeKey(timeKey(0, "a")), { firstSeen: 0, key: "a" });
  refused(() => timeKey(MAX_TIME_FIRST_SEEN + 1, "com.a"), "record", /first_seen 4294967296 is not 0 to 4294967295/);
  refused(() => timeKey(-1, "com.a"), "record", /first_seen -1/);
  refused(() => splitTimeKey("abc"), "record", /shorter than its 4 bytes of time/);
  // The bytewise order of time keys is the order by (first_seen, key), across
  // byte boundaries of first_seen: 255 and 256, 65,535 and 65,536.
  const rows = [row("com.b", 256), row("com.a", 255), row("a", 65_536), row("zz", 65_535), row("com.a", 256), row("com.a", 2 ** 24), row("b", 2 ** 24 - 1)];
  const byKey = [...rows].sort((a, b) => (timeKey(a.firstSeen, a.key) < timeKey(b.firstSeen, b.key) ? -1 : 1));
  assert.deepEqual(byKey, [...rows].sort(byTime));
});

test("time codecs: dataset 6 is the time copy of feed and 7 of new-name, and their records read back as the rows of the key copy", () => {
  assert.deepEqual([FEED_TIME_CODEC.id, FEED_TIME_CODEC.name, NEW_NAME_TIME_CODEC.id, NEW_NAME_TIME_CODEC.name], [6, "feed-time", 7, "new-name-time"]);
  assert.deepEqual([DATASET_LABELS[6], DATASET_LABELS[7]], ["feed-time", "new-name-time"]);
  assert.equal(BUILTIN_CODECS.get(6), FEED_TIME_CODEC);
  assert.equal(BUILTIN_CODECS.get(7), NEW_NAME_TIME_CODEC);
  assert.deepEqual([timeCodecOf(3), timeCodecOf(5), timeCodecOf(1), timeCodecOf(6)], [FEED_TIME_CODEC, NEW_NAME_TIME_CODEC, null, null]);
  assert.equal(FEED_TIME_CODEC.maxKeyBytes, TIME_KEY_BYTES);
  assert.equal(TIME_KEY_BYTES, 257);
  assert.deepEqual([TIME_IDX_TITLE, timePartTitle(0), timePartTitle(12)], ["time.idx", "time.part.000", "time.part.012"]);
  const rows = randomFeed(2000, 41).sort(byTime);
  for (const codec of [FEED_TIME_CODEC, NEW_NAME_TIME_CODEC]) assert.deepEqual(unblock(codec, block(codec, rows)), rows, codec.name);
  // One record by hand: shared 00, word 0x24 = 9 << 2 | 0, the time key
  // 00 00 01 2c "com.a", mask 02 (bit 1), basis 04, confidence 00, flags 12.
  const one = row("com.a", 300, { feedFlags: FEED_SUSPECT | FEED_SUSPECT_CERT });
  assert.equal(toHex(block(FEED_TIME_CODEC, [one])), "00240000012c636f6d2e6102040012");
  assert.deepEqual(unblock(FEED_TIME_CODEC, fromHex("00240000012c636f6d2e6102040012")), [one]);
});

test("time codecs: a key copy row's key of 253 bytes is written, one of 254 refused, and a time key of no row key is refused when read", () => {
  const out = () => new ByteWriter();
  FEED_TIME_CODEC.encodeRecord(null, row("a".repeat(253), 1), out());
  refused(() => FEED_TIME_CODEC.encodeRecord(null, row("a".repeat(254), 1), out()), "record", /its key is 254 bytes, above the 253 of feed/);
  refused(() => FEED_TIME_CODEC.encodeRecord(null, row("com.a", MAX_TIME_FIRST_SEEN + 1), out()), "record", /first_seen 4294967296, not 0 to 4294967295/);
  // shared 00, word 0x10 = 4 << 2: a time key of 4 bytes, then the fields.
  refused(() => FEED_TIME_CODEC.decodeRecord(null, new ByteReader(fromHex("00100000012c02040000"), "record", "test")), "record", /a time key of 4 bytes holds no row key/);
  // A record whose time key is not above the one before it.
  const prev = row("com.b", 300);
  refused(() => FEED_TIME_CODEC.encodeRecord(prev, row("com.a", 300), out()), "order", /not above/);
  refused(() => FEED_TIME_CODEC.merge(row("com.a", 1), row("com.a", 2)), "usage", /different time keys/);
  assert.equal(FEED_TIME_CODEC.merge(row("com.a", 1, { confidence: 4 }), row("com.a", 1, { confidence: 2 })).confidence, 2);
});

test("time copy: a pack of dataset 6 reads back in time order through the one reader, and finds a row by its time key", async () => {
  const rows = randomFeed(3000, 42);
  const key = await writeMem(rows, { codec: FEED_CODEC, recordsPerBlock: 256 });
  const time = await writeMem([...rows].sort(byTime), { codec: FEED_TIME_CODEC, recordsPerBlock: 256 });
  const reader = await readerOf(time, FEED_TIME_CODEC);
  assert.deepEqual(await collect(reader.scan()), [...rows].sort(byTime));
  for (const r of [rows[0], rows[1234], rows[2999]]) assert.deepEqual(await reader.get(timeKey(r.firstSeen, r.key)), r);
  assert.equal(await reader.get(timeKey(rows[5].firstSeen + 1, rows[5].key)), null);
  assert.equal(timeBindFault(parseHead(key.summary.idx), parseHead(time.summary.idx)), null);
  // The time copy has no manifest of its own: packAnnotations refuses it.
  assert.throws(
    () => packAnnotations(time.summary, "synthetic writer"),
    (e: unknown) => e instanceof PackError && e.code === "usage" && /is a time copy/.test(e.message),
  );
});

test("time bind: the heads give the dataset pair, the records (fewer or more), time keys as bounds and the span; each refused alone", async () => {
  const rows = randomFeed(500, 43).map((r, i) => ({ ...r, firstSeen: 1000 + (i % 50) }));
  const key = parseHead((await writeMem(rows, { codec: FEED_CODEC, recordsPerBlock: 64 })).summary.idx);
  const time = parseHead((await writeMem([...rows].sort(byTime), { codec: FEED_TIME_CODEC, recordsPerBlock: 64 })).summary.idx);
  assert.equal(timeBindFault(key, time, { t0: 1000, t1: 1050 }), null);
  const nn = parseHead((await writeMem([...rows].sort(byTime), { codec: NEW_NAME_TIME_CODEC, recordsPerBlock: 64 })).summary.idx);
  assert.equal(timeBindFault(key, nn), "the time copy is dataset 7; the time copy of dataset 3 is dataset 6");
  const fewer = parseHead((await writeMem([...rows].sort(byTime).slice(1), { codec: FEED_TIME_CODEC, recordsPerBlock: 64 })).summary.idx);
  assert.equal(timeBindFault(key, fewer), "the time copy holds 499 records and its key copy 500");
  const extra = row("com.synthetic-extra-row", 1000);
  assert.ok(!rows.some((r) => r.key === extra.key));
  const more = parseHead((await writeMem([...rows, extra].sort(byTime), { codec: FEED_TIME_CODEC, recordsPerBlock: 64 })).summary.idx);
  assert.equal(timeBindFault(key, more), "the time copy holds 501 records and its key copy 500");
  // A head whose key bounds are 4 bytes, no row key after the time: each bound alone.
  const notTime = "the time copy's key bounds are not time keys: 4 bytes of first_seen and a row key";
  assert.equal(timeBindFault(key, { ...time, keyMin: (time.keyMin as string).slice(0, 4) }), notTime);
  assert.equal(timeBindFault(key, { ...time, keyMax: (time.keyMax as string).slice(0, 4) }), notTime);
  assert.equal(timeBindFault(key, time, { t0: 1001, t1: 1050 }), "the time copy's rows run from first_seen 1000 to 1049, outside the span [1001, 1050) of the pack");
  assert.equal(timeBindFault(key, time, { t0: 1000, t1: 1049 }), "the time copy's rows run from first_seen 1000 to 1049, outside the span [1000, 1049) of the pack");
  assert.equal(timeBindFault(time, time), "the key copy is dataset 6, which has no time copy");
  // Two empty copies bind.
  const emptyKey = parseHead((await writeMem([], { codec: FEED_CODEC })).summary.idx);
  const emptyTime = parseHead((await writeMem([], { codec: FEED_TIME_CODEC })).summary.idx);
  assert.equal(timeBindFault(emptyKey, emptyTime, { t0: 0, t1: 1 }), null);
});

test("row sum: the same rows in two orders give one sum, and one changed field or one row more another", () => {
  const rows = randomFeed(400, 44);
  const sum = (list: readonly FeedRecord[]) => {
    const s = new RowSum();
    for (const r of list) s.add(r);
    return [s.count, s.hex()];
  };
  const [count, hex] = sum(rows);
  assert.equal(count, 400);
  assert.match(hex as string, /^[0-9a-f]{64}$/);
  assert.deepEqual(sum([...rows].sort(byTime)), [count, hex]);
  assert.deepEqual(sum([...rows].reverse()), [count, hex]);
  for (const field of ["flags", "firstSeen", "basis", "confidence", "feedFlags"] as const) {
    const changed = rows.map((r, i) => (i === 7 ? { ...r, [field]: (r[field] as number) + 1 } : r));
    assert.notEqual(sum(changed)[1], hex, field);
  }
  assert.notEqual(sum(rows.map((r, i) => (i === 7 ? { ...r, sources: [...r.sources, 63] } : r)))[1], hex, "sources");
  assert.notEqual(sum(rows.map((r, i) => (i === 7 ? { ...r, key: `${r.key}x` } : r)))[1], hex, "key");
  assert.notEqual(sum([...rows, rows[0]])[0], count);
});
