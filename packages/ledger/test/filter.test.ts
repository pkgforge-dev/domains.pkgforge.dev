// packages/ledger/src/filter.ts: the Bloom filter's rate on 1,000,000 absent
// keys, no false negative, its bytes and every refusal of them, the delta that
// carries the domains of the hours between two builds, and the pairing of the
// two. The keys are synthetic: `syn<n>` under a few suffixes (helpers.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "@domains/pack";
import { BloomFilter, buildFilter, DELTA_HEADER_BYTES, FILTER_HEADER_BYTES, HashDelta, hashKey, LedgerError, ProvisionalFilter, provisionalNew } from "../src/index.ts";
import { DOMAINS_CODEC, domainKey, domainRecord, readerOf, seen, writeMem } from "./helpers.ts";

const isLedger = (code: string, pattern?: RegExp) => (e: unknown) => e instanceof LedgerError && e.code === code && (pattern === undefined || pattern.test(e.message));
const AS_OF = 298 * 86_400;

function filterOf(keys: Iterable<string>, expected: number): BloomFilter {
  const f = BloomFilter.forKeys(expected, { asOf: AS_OF });
  for (const k of keys) f.add(hashKey(k));
  return f;
}

const range = function* (from: number, to: number): Generator<string> {
  for (let n = from; n < to; n += 1) yield domainKey(n);
};

test("filter: the false-positive rate on 1,000,000 absent keys is 0.8% to 1.2% at 10 bits a key and 7 hashes", (t) => {
  const n = 1_000_000;
  const started = performance.now();
  const f = filterOf(range(0, n), n);
  let hits = 0;
  for (const k of range(n, 2 * n)) if (f.has(hashKey(k))) hits += 1;
  const ms = performance.now() - started;
  const rate = hits / n;
  // (1 - e^(-n/P))^k with P the partition bits the filter chose.
  const expected = (1 - Math.exp(-n / f.partitionBits)) ** f.hashes;
  const sigma = Math.sqrt((expected * (1 - expected)) / n);
  t.diagnostic(`keys ${n}, absent ${n}, false positives ${hits}, rate ${(100 * rate).toFixed(4)}%, theory ${(100 * expected).toFixed(4)}%, bits ${f.bitBytes} B, ${ms.toFixed(0)} ms`);
  // P = ceil(10^7 / 7 / 64) * 64 = 1,428,608 bits a partition, 7 partitions.
  assert.equal(f.bitBytes, 1_250_032);
  assert.ok(rate >= 0.008 && rate <= 0.012, `rate ${rate}`);
  assert.ok(Math.abs(rate - expected) < 5 * sigma, `rate ${rate} is more than 5 sigma from ${expected}`);
});

test("filter: every key added is found: a Bloom filter has no false negative", () => {
  const f = filterOf(range(0, 50_000), 50_000);
  for (const k of range(0, 50_000)) assert.ok(f.has(hashKey(k)), k);
  assert.equal(f.keys, 50_000);
});

test("filter: encode and decode give the same filter, byte for byte", () => {
  const f = filterOf(range(0, 3000), 3000);
  const bytes = f.encode();
  assert.equal(bytes.length, FILTER_HEADER_BYTES + f.bitBytes);
  const back = BloomFilter.decode(bytes);
  assert.deepEqual(back.encode(), bytes);
  assert.equal(back.crc, f.crc);
  assert.equal(back.asOf, AS_OF);
  assert.equal(back.keys, 3000);
  for (const k of range(0, 3000)) assert.ok(back.has(hashKey(k)));
});

// The filter's bytes with `edit` applied, then the header CRC written again,
// so a refusal comes from the field the edit changed and not from the CRC.
function edited(bytes: Uint8Array, edit: (b: Uint8Array, v: DataView) => void, fixCrc = true): Uint8Array {
  const b = new Uint8Array(bytes);
  const v = new DataView(b.buffer);
  edit(b, v);
  if (fixCrc) v.setUint32(32, crc32(b.subarray(0, 32)), true);
  return b;
}

test("filter: decode refuses bytes that are not a whole filter of this format", () => {
  const good = filterOf(range(0, 100), 100).encode();
  const cases: [string, Uint8Array, (e: unknown) => boolean][] = [
    ["short", good.subarray(0, 20), isLedger("format", /at least/)],
    ["magic", edited(good, (b) => (b[0] = 0x58)), isLedger("format", /DLBF/)],
    ["header crc", edited(good, (b) => (b[13] ^= 1), false), isLedger("crc", /header/)],
    ["version", edited(good, (b) => (b[4] = 2)), isLedger("format", /version 2/)],
    ["hash id", edited(good, (b) => (b[5] = 9)), isLedger("format", /hash 9/)],
    ["hashes", edited(good, (b) => (b[6] = 0)), isLedger("format", /0 hashes/)],
    ["reserved", edited(good, (b) => (b[7] = 1)), isLedger("format", /reserved/)],
    ["partition", edited(good, (_b, v) => v.setUint32(8, 100, true)), isLedger("format", /multiple of 64/)],
    ["length", good.subarray(0, good.length - 8), isLedger("format", /says/)],
    ["bits crc", edited(good, (b) => (b[FILTER_HEADER_BYTES + 3] ^= 0x10)), isLedger("crc", /bits/)],
  ];
  for (const [name, bytes, check] of cases) assert.throws(() => BloomFilter.decode(bytes), check, name);
});

test("filter: forKeys refuses a size no partition holds and options out of range", () => {
  assert.throws(() => BloomFilter.forKeys(2_000_000_000, { asOf: 0, hashes: 1 }), isLedger("usage", /partitions/));
  assert.throws(() => BloomFilter.forKeys(10, { asOf: 0, hashes: 0 }), isLedger("usage"));
  assert.throws(() => BloomFilter.forKeys(-1, { asOf: 0 }), isLedger("usage"));
  assert.throws(() => BloomFilter.forKeys(10, { asOf: 1.5 }), isLedger("usage"));
});

test("delta: a domain added to the delta by one hourly job is found by the next", () => {
  const filter = filterOf(range(0, 20_000), 20_000);
  const fresh = "com.syn-fresh-domain";
  assert.equal(filter.has(hashKey(fresh)), false, "the test needs a key the filter does not hold");
  // Hour 1: the filter and an empty delta; the fresh domain is new and goes to the delta.
  const hour1 = new ProvisionalFilter(filter, HashDelta.empty(filter));
  assert.deepEqual(provisionalNew([domainKey(5), fresh, fresh], hour1), [fresh]);
  const pushed = hour1.delta.encode();
  // Hour 2: the same filter and the delta hour 1 pushed.
  const hour2 = new ProvisionalFilter(BloomFilter.decode(filter.encode()), HashDelta.decode(pushed));
  assert.ok(hour2.has(hashKey(fresh)));
  assert.deepEqual(provisionalNew([fresh], hour2), [], "not new a second time");
  assert.equal(hour2.delta.size, 1);
});

test("delta: encode and decode keep the hashes ascending, and decode refuses a broken delta", () => {
  const filter = filterOf(range(0, 100), 100);
  const delta = HashDelta.empty(filter);
  for (const k of range(500, 900)) delta.add(hashKey(k));
  const once = HashDelta.decode(delta.encode());
  for (const k of range(900, 950)) once.add(hashKey(k));
  once.add(hashKey(domainKey(600)));
  const bytes = once.encode();
  assert.equal(bytes.length, DELTA_HEADER_BYTES + 8 * 450);
  const back = HashDelta.decode(bytes);
  assert.equal(back.size, 450);
  for (const k of range(500, 950)) assert.ok(back.has(hashKey(k)), k);
  const hashes = [...back.hashes()];
  for (let i = 1; i < hashes.length; i += 1) assert.ok(hashes[i - 1].hi < hashes[i].hi || (hashes[i - 1].hi === hashes[i].hi && hashes[i - 1].lo < hashes[i].lo));
  const fix = (b: Uint8Array) => {
    const v = new DataView(b.buffer);
    v.setUint32(24, crc32(b.subarray(DELTA_HEADER_BYTES)), true);
    v.setUint32(28, crc32(b.subarray(0, 28)), true);
    return b;
  };
  const swapped = new Uint8Array(bytes);
  swapped.copyWithin(DELTA_HEADER_BYTES, DELTA_HEADER_BYTES + 8, DELTA_HEADER_BYTES + 16);
  swapped.set(bytes.subarray(DELTA_HEADER_BYTES, DELTA_HEADER_BYTES + 8), DELTA_HEADER_BYTES + 8);
  assert.throws(() => HashDelta.decode(fix(swapped)), isLedger("format", /not above/));
  const flipped = new Uint8Array(bytes);
  flipped[DELTA_HEADER_BYTES + 5] ^= 1;
  assert.throws(() => HashDelta.decode(flipped), isLedger("crc", /hashes/));
  const header = new Uint8Array(bytes);
  header[13] ^= 1;
  assert.throws(() => HashDelta.decode(header), isLedger("crc", /header/));
  const short = new Uint8Array(bytes.subarray(0, bytes.length - 8));
  assert.throws(() => HashDelta.decode(fix(short)), isLedger("format", /says 450/));
  const magic = new Uint8Array(bytes);
  magic[3] = 0x58;
  assert.throws(() => HashDelta.decode(magic), isLedger("format", /DLBD/));
});

test("delta: a delta of another filter is refused, and rebase moves it to the newer one", () => {
  const old = filterOf(range(0, 1000), 2000);
  const delta = HashDelta.empty(old);
  for (const k of range(1000, 1100)) delta.add(hashKey(k));
  // The next day's build holds the first 50 of the delta's domains.
  const newer = BloomFilter.forKeys(2000, { asOf: AS_OF + 86_400 });
  for (const k of range(0, 1050)) newer.add(hashKey(k));
  assert.throws(() => new ProvisionalFilter(newer, delta), isLedger("pair"));
  const moved = delta.rebase(newer);
  const seen1 = new ProvisionalFilter(newer, moved);
  assert.equal(moved.size, [...range(1050, 1100)].filter((k) => !newer.has(hashKey(k))).length);
  for (const k of range(0, 1100)) assert.ok(seen1.has(hashKey(k)), k);
  // A filter changed after its delta was made no longer pairs with it.
  const later = filterOf(range(0, 10), 100);
  const d = HashDelta.empty(later);
  later.add(hashKey("com.added-after"));
  assert.throws(() => new ProvisionalFilter(later, d), isLedger("pair"));
});

test("filter: buildFilter adds every domain of the packs once, sized by their records", async () => {
  const a = await writeMem(
    [...range(0, 300)].sort().map((k) => domainRecord(k, [seen(0, 100)])),
    DOMAINS_CODEC,
  );
  const b = await writeMem(
    [...range(200, 500)].sort().map((k) => domainRecord(k, [seen(0, 200)])),
    DOMAINS_CODEC,
  );
  const f = await buildFilter([await readerOf(a, DOMAINS_CODEC), await readerOf(b, DOMAINS_CODEC)], { asOf: AS_OF });
  assert.equal(f.keys, 500, "the 100 domains in both packs are added once");
  assert.equal(f.partitionBits, Math.ceil((600 * 10) / 7 / 64) * 64, "sized for the 600 records of the two packs");
  for (const k of range(0, 500)) assert.ok(f.has(hashKey(k)), k);
});
