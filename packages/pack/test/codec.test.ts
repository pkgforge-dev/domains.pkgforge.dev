// packages/pack/src/codec.ts: the records of the datasets 1, 2, 3 and 5. Each
// codec writes seeded random records as one block and reads them back. Each refusal
// of encodeRecord is a record that breaks one rule of docs/format.md section 5;
// each refusal of decodeRecord is a byte string, written by hand from the
// tables, that breaks one structural rule. The merge rules of section 5.6 are
// held to their laws on random records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ByteReader, ByteWriter, fromHex, toHex } from "../src/bytes.ts";
import {
  BUILTIN_CODECS,
  type DatasetCodec,
  DOMAINS_CODEC,
  type DomainRecord,
  FEED_CODEC,
  FEED_PROVISIONAL,
  FEED_SUSPECT,
  type FeedRecord,
  NAMES_CODEC,
  NEW_NAME_CODEC,
  type NameRecord,
  strongerConfidence,
} from "../src/codec.ts";
import { PackError } from "../src/errors.ts";
import { randomDomains, randomFeed, randomNames, rng } from "./helpers.ts";

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

const name = (key: string, extra: Partial<NameRecord> = {}): NameRecord => ({ key, flags: 1, sources: [{ bit: 0, first: 298, last: 298 }], ...extra });

test("pack codec: names, domains and feed records read back as written, 2,000 each", () => {
  const n = randomNames(2000, 1);
  assert.deepEqual(unblock(NAMES_CODEC, block(NAMES_CODEC, n)), n);
  const d = randomDomains(2000, 2);
  assert.deepEqual(unblock(DOMAINS_CODEC, block(DOMAINS_CODEC, d)), d);
  const f = randomFeed(2000, 3);
  assert.deepEqual(unblock(FEED_CODEC, block(FEED_CODEC, f)), f);
});

test("pack codec: a names record is the key prefix, the mask, then first and span per bit", () => {
  const r: NameRecord = {
    key: "de.example.www",
    flags: 3,
    sources: [
      { bit: 0, first: 298, last: 298 },
      { bit: 9, first: 25_747_320, last: 25_833_599 },
    ],
  };
  // 00 shared · 3b = 14 << 2 | 3 · the 14 key bytes · mask 81 04 (bits 0 and 9)
  // · aa02 00 (298, span 0) · f8bea30c (25,747,320) · 87a205 (span 86,279),
  // each worked by hand from the LEB128 rule.
  const hex = toHex(block(NAMES_CODEC, [r]));
  assert.equal(hex, `003b${toHex(new TextEncoder().encode("de.example.www"))}8104aa0200f8bea30c87a205`);
  assert.deepEqual(unblock(NAMES_CODEC, fromHex(hex)), [r]);
});

test("pack codec: encodeRecord refuses a record that breaks a rule of the format", () => {
  const out = () => new ByteWriter();
  refused(() => NAMES_CODEC.encodeRecord(null, name(""), out()), "record", /empty/);
  refused(() => NAMES_CODEC.encodeRecord(null, name("com.Ā"), out()), "record", /code unit 256/);
  refused(() => NAMES_CODEC.encodeRecord(null, name("com.a", { flags: 0 }), out()), "record", /flags 0/);
  refused(() => NAMES_CODEC.encodeRecord(null, name("com.a", { flags: 4 }), out()), "record", /flags 4/);
  refused(() => NAMES_CODEC.encodeRecord(null, name("com.a", { sources: [] }), out()), "record", /no source/);
  refused(() => NAMES_CODEC.encodeRecord(null, name("com.a", { sources: [{ bit: 64, first: 1, last: 1 }] }), out()), "record", /ascend from 0 to 63/);
  refused(
    () =>
      NAMES_CODEC.encodeRecord(
        null,
        name("com.a", {
          sources: [
            { bit: 3, first: 1, last: 1 },
            { bit: 3, first: 1, last: 1 },
          ],
        }),
        out(),
      ),
    "record",
    /none twice/,
  );
  refused(() => NAMES_CODEC.encodeRecord(null, name("com.a", { sources: [{ bit: 0, first: 5, last: 4 }] }), out()), "record", /first 5 and last 4/);
  refused(() => NAMES_CODEC.encodeRecord(name("com.b"), name("com.a"), out()), "order", /not above/);
  refused(() => NAMES_CODEC.encodeRecord(name("com.a"), name("com.a"), out()), "order", /not above/);
  const domain = (evidence: DomainRecord["evidence"]): DomainRecord => ({ ...name("com.a"), evidence });
  refused(() => DOMAINS_CODEC.encodeRecord(null, domain([{ tier: 1, basis: 9, source: 0, at: 1, confidence: 0 }]), out()), "record", /basis 9/);
  refused(() => DOMAINS_CODEC.encodeRecord(null, domain([{ tier: 2, basis: 0, source: 0, at: 1, confidence: 0 }]), out()), "record", /basis 0 is tier 1/);
  refused(() => DOMAINS_CODEC.encodeRecord(null, domain([{ tier: 3, basis: 4, source: 64, at: 1, confidence: 0 }]), out()), "record", /source 64/);
  refused(() => DOMAINS_CODEC.encodeRecord(null, domain([{ tier: 3, basis: 4, source: 1, at: 1, confidence: 256 }]), out()), "record", /confidence 256/);
  refused(
    () =>
      DOMAINS_CODEC.encodeRecord(
        null,
        domain([
          { tier: 3, basis: 4, source: 1, at: 1, confidence: 0 },
          { tier: 1, basis: 0, source: 1, at: 1, confidence: 0 },
        ]),
        out(),
      ),
    "record",
    /ascend by \(tier, basis, source\)/,
  );
  const feed = (extra: Partial<FeedRecord>): FeedRecord => ({ key: "com.a", flags: 0, firstSeen: 1, sources: [0], basis: 1, confidence: 0, feedFlags: 0, ...extra });
  refused(() => FEED_CODEC.encodeRecord(null, feed({ sources: [] }), out()), "record", /no source/);
  refused(() => FEED_CODEC.encodeRecord(null, feed({ basis: 32 }), out()), "record", /basis bits 32/);
  refused(() => FEED_CODEC.encodeRecord(null, feed({ feedFlags: 16 }), out()), "record", /feed flags 16/);
  refused(() => FEED_CODEC.encodeRecord(null, feed({ firstSeen: -1 }), out()), "record", /first_seen -1/);
});

test("pack codec: decodeRecord refuses bytes that break the structure of a record", () => {
  const read = (hex: string, prev: NameRecord | null = null) => NAMES_CODEC.decodeRecord(prev, new ByteReader(fromHex(hex), "record", "test"));
  // A first record of a block that shares a byte: shared 01, word 05 (1 << 2 | 1), "a", mask 01, 00, 00.
  refused(() => read("010561010000"), "record", /first record of a block shares 1 bytes/);
  // A record that shares more bytes than the key before it holds.
  refused(() => read("090562010000", name("com.a")), "record", /shares 9 bytes of a key of 5/);
  // A suffix of no byte: word 01 is length 0, flags 1.
  refused(() => read("0001010000"), "record", /adds no byte/);
  // A name with flags 0: word 04 is length 1, flags 0.
  refused(() => read("000461010000"), "record", /flags 0/);
  // A key below the key before it: shares "com." (4), then "a" is below "b".
  refused(() => read("040561010000", name("com.b")), "order", /not above/);
  // Equal to the key before it is not above it: shares 4 of "com.a", then "a".
  refused(() => read("040561010000", name("com.a")), "order", /not above/);
  // A suffix that runs past the block.
  refused(() => read("0011616263"), "record", /runs past the end/);
  // The same record whole reads.
  assert.deepEqual(read("000561010000"), { key: "a", flags: 1, sources: [{ bit: 0, first: 0, last: 0 }] });
  // A domain whose evidence count cannot fit in the bytes left.
  refused(() => DOMAINS_CODEC.decodeRecord(null, new ByteReader(fromHex("000561010000ff01"), "record", "test")), "record", /does not fit/);
  // Evidence entries out of order: (3, 4, 0) then (1, 0, 0).
  refused(() => DOMAINS_CODEC.decodeRecord(null, new ByteReader(fromHex("0005610100000203040000000100000000"), "record", "test")), "record", /not above the entry before it/);
  // A source above 63 in an evidence entry.
  refused(() => DOMAINS_CODEC.decodeRecord(null, new ByteReader(fromHex("000561010000010304400000"), "record", "test")), "record", /source 64/);
});

test("pack codec: a reader keeps an evidence basis and feed flags it does not know", () => {
  // Evidence (tier 7, basis 9, source 1, at 2, confidence 3): no writer of this
  // version writes it, and a reader of this version passes it through.
  const d = DOMAINS_CODEC.decodeRecord(null, new ByteReader(fromHex("000561010000010709010203"), "record", "test"));
  assert.deepEqual(d.evidence, [{ tier: 7, basis: 9, source: 1, at: 2, confidence: 3 }]);
  // feed flags 0xf0: reserved bits.
  const f = FEED_CODEC.decodeRecord(null, new ByteReader(fromHex("0004610501010af0"), "record", "test"));
  assert.equal(f.feedFlags, 0xf0);
});

test("pack codec: merge keeps the earliest first and the latest last of each source, and ORs the flags", () => {
  const a: NameRecord = {
    key: "com.a",
    flags: 1,
    sources: [
      { bit: 0, first: 10, last: 20 },
      { bit: 5, first: 7, last: 7 },
    ],
  };
  const b: NameRecord = {
    key: "com.a",
    flags: 2,
    sources: [
      { bit: 0, first: 12, last: 30 },
      { bit: 9, first: 1, last: 2 },
    ],
  };
  assert.deepEqual(NAMES_CODEC.merge(a, b), {
    key: "com.a",
    flags: 3,
    sources: [
      { bit: 0, first: 10, last: 30 },
      { bit: 5, first: 7, last: 7 },
      { bit: 9, first: 1, last: 2 },
    ],
  });
  assert.throws(() => NAMES_CODEC.merge(a, { ...b, key: "com.b" }), /different keys/);
});

test("pack codec: merge of evidence takes the earliest time and the stronger confidence of a triple", () => {
  const a: DomainRecord = { ...name("com.a"), evidence: [{ tier: 3, basis: 4, source: 2, at: 50, confidence: 1 }] };
  const b: DomainRecord = {
    ...name("com.a"),
    evidence: [
      { tier: 1, basis: 0, source: 7, at: 60, confidence: 0 },
      { tier: 3, basis: 4, source: 2, at: 40, confidence: 0 },
    ],
  };
  assert.deepEqual(DOMAINS_CODEC.merge(a, b).evidence, [
    { tier: 1, basis: 0, source: 7, at: 60, confidence: 0 },
    { tier: 3, basis: 4, source: 2, at: 40, confidence: 1 },
  ]);
});

test("pack codec: the stronger confidence is the lowest level that is not 0, in evidence and in feed rows", () => {
  assert.equal(strongerConfidence(3, 7), 3);
  assert.equal(strongerConfidence(7, 3), 3);
  assert.equal(strongerConfidence(0, 7), 7);
  assert.equal(strongerConfidence(7, 0), 7);
  assert.equal(strongerConfidence(0, 0), 0);
  const evidence = (confidence: number): DomainRecord => ({ ...name("com.a"), evidence: [{ tier: 2, basis: 3, source: 3, at: 10, confidence }] });
  assert.equal(DOMAINS_CODEC.merge(evidence(9), evidence(2)).evidence[0]?.confidence, 2);
  assert.equal(DOMAINS_CODEC.merge(evidence(2), evidence(9)).evidence[0]?.confidence, 2);
  assert.equal(DOMAINS_CODEC.merge(evidence(0), evidence(9)).evidence[0]?.confidence, 9);
  const row = (confidence: number): FeedRecord => ({ key: "com.a", flags: 0, firstSeen: 1, sources: [3], basis: 8, confidence, feedFlags: 0 });
  for (const codec of [FEED_CODEC, NEW_NAME_CODEC]) {
    assert.equal(codec.merge(row(10), row(1)).confidence, 1, codec.name);
    assert.equal(codec.merge(row(1), row(10)).confidence, 1, codec.name);
    assert.equal(codec.merge(row(4), row(0)).confidence, 4, codec.name);
    assert.equal(codec.merge(row(0), row(4)).confidence, 4, codec.name);
  }
});

test("pack codec: a merged feed row is provisional only when both rows are", () => {
  const row = (feedFlags: number, firstSeen: number): FeedRecord => ({ key: "com.a", flags: 0, firstSeen, sources: [1], basis: 16, confidence: 2, feedFlags });
  const exact = FEED_CODEC.merge(row(FEED_PROVISIONAL, 100), row(FEED_SUSPECT, 90));
  assert.equal(exact.feedFlags, FEED_SUSPECT);
  assert.equal(exact.firstSeen, 90);
  assert.equal(FEED_CODEC.merge(row(FEED_PROVISIONAL, 1), row(FEED_PROVISIONAL | FEED_SUSPECT, 2)).feedFlags, FEED_PROVISIONAL | FEED_SUSPECT);
});

test("pack codec: every merge is idempotent, commutative and associative on random records of one key", () => {
  const next = rng(99);
  const sameKey = <R extends { key: string }>(records: R[]): R[] => records.map((r) => ({ ...r, key: "com.same" }));
  const laws = <R extends { key: string }>(codec: DatasetCodec<R>, records: R[]) => {
    for (let i = 0; i < 200; i += 1) {
      const [a, b, c] = [0, 1, 2].map(() => records[Math.floor(next() * records.length)]);
      assert.deepEqual(codec.merge(a, a), a, `${codec.name} merge(a, a)`);
      assert.deepEqual(codec.merge(a, b), codec.merge(b, a), `${codec.name} merge(a, b)`);
      assert.deepEqual(codec.merge(codec.merge(a, b), c), codec.merge(a, codec.merge(b, c)), `${codec.name} associative`);
    }
  };
  laws(NAMES_CODEC, sameKey(randomNames(50, 5)));
  laws(DOMAINS_CODEC, sameKey(randomDomains(50, 6)));
  laws(FEED_CODEC, sameKey(randomFeed(50, 7)));
  laws(NEW_NAME_CODEC, sameKey(randomFeed(50, 8)));
});

test("pack codec: dataset 5, new-name, is the record of dataset 3, feed, under its own id and name", () => {
  assert.equal(NEW_NAME_CODEC.id, 5);
  assert.equal(NEW_NAME_CODEC.name, "new-name");
  assert.equal(BUILTIN_CODECS.get(5), NEW_NAME_CODEC);
  assert.equal(BUILTIN_CODECS.get(3), FEED_CODEC);
  const rows = randomFeed(500, 9);
  const bytes = block(NEW_NAME_CODEC, rows);
  assert.deepEqual(bytes, block(FEED_CODEC, rows));
  assert.deepEqual(unblock(NEW_NAME_CODEC, bytes), rows);
  const row: FeedRecord = { key: "com.example.www", flags: 1, firstSeen: 1, sources: [0], basis: 1, confidence: 0, feedFlags: 16 };
  refused(() => NEW_NAME_CODEC.encodeRecord(null, row, new ByteWriter()), "record", /the new-name row "com\.example\.www" has feed flags 16/);
});

test("pack codec: a key of a name dataset is at most 253 bytes, written or read", () => {
  const long = "a".repeat(254);
  const feedRow = (key: string): FeedRecord => ({ key, flags: 0, firstSeen: 1, sources: [0], basis: 1, confidence: 0, feedFlags: 0 });
  const records: [DatasetCodec<NameRecord> | DatasetCodec<DomainRecord> | DatasetCodec<FeedRecord>, (key: string) => NameRecord | DomainRecord | FeedRecord][] = [
    [NAMES_CODEC, (key) => name(key)],
    [DOMAINS_CODEC, (key) => ({ ...name(key), evidence: [] })],
    [FEED_CODEC, feedRow],
    [NEW_NAME_CODEC, feedRow],
  ];
  for (const [codec, make] of records) {
    assert.equal(codec.maxKeyBytes, 253, codec.name);
    const encode = codec.encodeRecord as (prev: null, r: NameRecord | DomainRecord | FeedRecord, out: ByteWriter) => void;
    encode(null, make(long.slice(1)), new ByteWriter());
    refused(() => encode(null, make(long), new ByteWriter()), "record", /is 254 bytes, above the 253 of its dataset/);
    // shared 00 · word f907 = 254 << 2 | 1: refused from the lengths, before
    // the 254 key bytes are read (none follow).
    refused(() => codec.decodeRecord(null, new ByteReader(fromHex("00f907"), "record", "test")), "record", /a key of 254 bytes, above the 253 of its dataset/);
  }
  // The length counts the shared bytes too: 200 of a key of 253, then 54 more.
  const prev = name("a".repeat(253));
  refused(() => NAMES_CODEC.decodeRecord(prev, new ByteReader(fromHex("c801d901"), "record", "test")), "record", /a key of 254 bytes, above the 253 of its dataset/);
  // 253 bytes read: shared 00 · word f507 = 253 << 2 | 1 · the key · mask 01 · 00 · 00.
  assert.equal(NAMES_CODEC.decodeRecord(null, new ByteReader(fromHex(`00f507${"61".repeat(253)}010000`), "record", "test")).key.length, 253);
});
