// packages/pack/src/writer.ts and src/reader.ts end to end, in Node, with the
// production compressor (node:zlib at level 9, packages/pack/node).
//
// Each refusal plants the fault that its own check alone catches:
//   - the CRC: a byte of a stored (level 0) block changed so that the block
//     still decompresses to its length and its records still decode;
//   - the count, the order in a block, the index key and the order across
//     blocks: packs built by hand (handPack) whose blocks are whole and whose
//     CRCs match, so each reaches the check under test;
//   - inflate: a raw length one above or one below the truth, with the index
//     CRCs computed again (test/plant.ts);
//   - span: a part limit no block fits in, one byte either side of a limit
//     that blocks fill exactly, and keys of a block past 16 MiB;
//   - the decode budget: a block of about 1 KB compressed whose front coding
//     names 8,000 keys of 65,002 bytes (520 MB), refused by the key length of
//     its dataset and, for a codec that allows such keys, by the budget of
//     16 MiB of keys a block.
// All names and times are synthetic (test/helpers.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 as zlibCrc32, deflateRawSync } from "node:zlib";
import { nodeCompress, writerId } from "../node/index.ts";
import {
  ANNOTATIONS,
  type ByteReader,
  ByteWriter,
  CODEC_GZIP,
  type DatasetCodec,
  DOMAINS_CODEC,
  encodeIdx,
  encodePartHeader,
  FEED_CODEC,
  MAX_KEY_BYTES,
  MAX_RAW_BLOCK_BYTES,
  MemorySink,
  NAMES_CODEC,
  type NameRecord,
  PackError,
  PackIndex,
  PackReader,
  PackWriter,
  packAnnotations,
  partsSource,
  readKey,
  readPartHeader,
  sha256Hex,
  writeKey,
  writePack,
} from "../src/index.ts";
import { NEW_NAME_CODEC } from "../src/codec.ts";
import { MAX_BLOCK_KEY_BYTES, packedLimit } from "../src/format.ts";
import { collect, randomDomains, randomFeed, randomKeys, randomNames, readerOf, writeMem } from "./helpers.ts";
import { FIELD, fixCrcs, fixHead, layout, refusedWith, view } from "./plant.ts";

const name = (key: string, first = 298): NameRecord => ({ key, flags: 1, sources: [{ bit: 0, first, last: first }] });

// A pack of one part built by hand from raw blocks, each compressed at level 9,
// with its entry from the block as given: the test states each count and key.
function handPack(blocks: { raw: Uint8Array; key: string; records: number }[], opts: { recordsPerBlock: number; records: number; keyMin: string; keyMax: string; dataset?: number }) {
  const dataset = opts.dataset ?? 1;
  const chunks: Uint8Array[] = [encodePartHeader({ dataset, recordsPerBlock: opts.recordsPerBlock, part: 0, codec: 1 })];
  let offset = 16;
  const entries = blocks.map((b, index) => {
    const packed = deflateRawSync(b.raw, { level: 9 });
    chunks.push(packed);
    const entry = { index, key: b.key, part: 0, offset, packed: packed.length, raw: b.raw.length, records: b.records, crc: zlibCrc32(b.raw) };
    offset += packed.length;
    return entry;
  });
  const part = new Uint8Array(Buffer.concat(chunks));
  const idx = encodeIdx({
    dataset,
    codec: 1,
    recordsPerBlock: opts.recordsPerBlock,
    records: opts.records,
    parts: [{ bytes: part.length, firstBlock: 0, blocks: blocks.length }],
    keyMin: opts.keyMin,
    keyMax: opts.keyMax,
    entries,
  });
  return { idx, parts: [part] };
}

const namesRaw = (keys: string[]): Uint8Array => {
  const out = new ByteWriter();
  let prev: NameRecord | null = null;
  for (const k of keys) {
    const r = name(k);
    NAMES_CODEC.encodeRecord(prev, r, out);
    prev = r;
  }
  return out.take();
};

test("pack write and read: get, blockOf and scan answer every key of 5,000 names over several parts and pages", async () => {
  const records = randomNames(5000, 21);
  const pack = await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 64, pageEntries: 4, partLimit: 20_000 });
  assert.ok(pack.parts.length >= 3, `${pack.parts.length} parts`);
  assert.ok(pack.summary.blocks / pack.summary.pageEntries >= 10, `${pack.summary.blocks} blocks`);
  assert.equal(pack.summary.records, 5000);
  assert.deepEqual(
    pack.parts.map((p) => p.length),
    pack.summary.parts.map((p) => p.bytes),
  );
  const reader = await readerOf(pack, NAMES_CODEC);
  assert.deepEqual(await collect(reader.scan()), records);
  for (const r of records.filter((_, i) => i % 7 === 0)) {
    assert.deepEqual(await reader.get(r.key), r);
    const entry = await reader.blockOf(r.key);
    assert.ok(entry !== null && (await reader.records(entry)).some((x) => x.key === r.key));
    // A key just above a record and below the next one is absent.
    assert.equal(await reader.get(`${r.key}\u0000`), null);
  }
  assert.equal(await reader.get("\u0000"), null);
  assert.equal(await reader.blockOf("\u0000"), null);
  assert.equal(await reader.get(`${records[records.length - 1].key}x`), null);
  // Ranges, each against a filter of the records.
  const keys = records.map((r) => r.key);
  for (const [lo, hi] of [
    [keys[100], keys[900]],
    [`${keys[63]}`, `${keys[64]}`],
    ["com.", "com/"],
    ["np.com.", "np.com/"],
    ["a", "b"],
    [keys[4999], "ÿ"],
  ]) {
    assert.deepEqual(
      (await collect(reader.scan(lo, hi))).map((r) => r.key),
      keys.filter((k) => k >= lo && k < hi),
      `${lo} to ${hi}`,
    );
  }
  assert.deepEqual(await collect(reader.scan(keys[10], keys[10])), []);
  assert.deepEqual((await collect(reader.scan(undefined, keys[3]))).length, 3);
});

test("pack write: the same input twice gives the same bytes and the same SHA-256 of the raw blocks", async () => {
  const records = randomNames(3000, 22);
  const a = await writeMem(records, { codec: NAMES_CODEC });
  const b = await writeMem(records, { codec: NAMES_CODEC });
  assert.deepEqual(a.parts, b.parts);
  assert.deepEqual(a.summary.idx, b.summary.idx);
  assert.equal(a.summary.sha256, b.summary.sha256);
  // The SHA-256 is of the raw blocks in order.
  const reader = await readerOf(a, NAMES_CODEC);
  const raws = [];
  for await (const e of reader.index.entries()) raws.push(await reader.readBlock(e));
  assert.equal(a.summary.sha256, sha256Hex(new Uint8Array(Buffer.concat(raws))));
});

test("pack write: blocks compressed by another deflate read the same records and keep the SHA-256", async () => {
  const records = randomNames(3000, 23);
  // CompressionStream at its own default level: other compressed bytes.
  const streamCompress = async (_codec: number, raw: Uint8Array) =>
    new Uint8Array(await new Response(new Blob([new Uint8Array(raw)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const other = await writeMem(records, { codec: NAMES_CODEC, compress: streamCompress });
  const level9 = await writeMem(records, { codec: NAMES_CODEC });
  assert.notDeepEqual(other.parts, level9.parts);
  assert.equal(other.summary.sha256, level9.summary.sha256);
  assert.deepEqual(await collect((await readerOf(other, NAMES_CODEC)).scan()), records);
});

test("pack write: the gzip codec and the domains and feed datasets read back", async () => {
  const names = randomNames(1500, 24);
  const gz = await writeMem(names, { codec: NAMES_CODEC, blockCodec: CODEC_GZIP, recordsPerBlock: 100 });
  assert.equal(readPartHeader(gz.parts[0]).codec, CODEC_GZIP);
  assert.deepEqual(await collect((await readerOf(gz, NAMES_CODEC)).scan()), names);
  const domains = randomDomains(1500, 25);
  assert.deepEqual(await collect((await readerOf(await writeMem(domains, { codec: DOMAINS_CODEC, recordsPerBlock: 100 }), DOMAINS_CODEC)).scan()), domains);
  const feed = randomFeed(1500, 26);
  const feedPack = await writeMem(feed, { codec: FEED_CODEC, recordsPerBlock: 100 });
  // Without a codec the reader takes the one of the index's dataset.
  const reader = await PackReader.open(feedPack.summary.idx, partsSource(feedPack.parts));
  assert.equal(reader.codec, FEED_CODEC);
  assert.deepEqual(await collect(reader.scan()), feed);
});

test("pack write: a pack of no record is one part of 16 bytes and an index of no block", async () => {
  const pack = await writeMem([], { codec: NAMES_CODEC });
  assert.deepEqual(
    pack.parts.map((p) => p.length),
    [16],
  );
  assert.equal(pack.summary.blocks, 0);
  assert.equal(pack.summary.keyMin, null);
  assert.equal(pack.summary.sha256, sha256Hex(new Uint8Array(0)));
  const reader = await readerOf(pack, NAMES_CODEC);
  assert.equal(await reader.get("com.example"), null);
  assert.deepEqual(await collect(reader.scan()), []);
});

test("pack write: every part holds whole blocks within the part limit, and a block no part can hold is refused", async () => {
  const records = randomNames(2000, 27);
  const limit = 5000;
  const pack = await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 50, partLimit: limit });
  assert.ok(pack.parts.length > 3);
  for (const p of pack.parts) assert.ok(p.length <= limit, `a part of ${p.length} B`);
  for (let i = 0; i < pack.summary.parts.length; i += 1) assert.equal(readPartHeader(pack.parts[i]).part, i, `part ${i}`);
  // A limit below the header and the smallest block: the first block is refused.
  const sink = new MemorySink();
  const writer = new PackWriter({ codec: NAMES_CODEC, compress: nodeCompress, sink, recordsPerBlock: 50, partLimit: 40 });
  await refusedWith(
    async () => {
      for (const r of records.slice(0, 50)) await writer.add(r);
    },
    "span",
    /does not fit in a part of at most 40 B/,
  );
  // A writer that refused once refuses every later call.
  await refusedWith(() => writer.finish(), "usage", /failed/);
  assert.ok(sink.parts().every((p) => p.length <= 40));
});

test("pack write: keys that do not ascend are refused, and so is a call before the last one settled", async () => {
  const writer = new PackWriter({ codec: NAMES_CODEC, compress: nodeCompress, sink: new MemorySink() });
  await writer.add(name("com.b"));
  await refusedWith(() => writer.add(name("com.a")), "order", /record 2: its key is not above/);
  await refusedWith(() => writer.add(name("com.c")), "usage", /failed/);
  const second = new PackWriter({ codec: NAMES_CODEC, compress: nodeCompress, sink: new MemorySink(), recordsPerBlock: 1 });
  const first = second.add(name("com.a"));
  await refusedWith(() => second.add(name("com.b")), "usage", /before its last call settled/);
  await first;
  // A key equal to the one before it in another block is refused too.
  await refusedWith(() => second.add(name("com.a")), "order", /not above/);
});

test("pack write: options out of range are refused before any write", () => {
  const base = { codec: NAMES_CODEC, compress: nodeCompress, sink: new MemorySink() };
  assert.throws(() => new PackWriter({ ...base, recordsPerBlock: 0 }), /recordsPerBlock/);
  assert.throws(() => new PackWriter({ ...base, recordsPerBlock: 65_536 }), /recordsPerBlock/);
  assert.throws(
    () => new PackWriter({ ...base, blockCodec: 3 }),
    (e: unknown) => e instanceof PackError && e.code === "codec",
  );
  assert.throws(() => new PackWriter({ ...base, partLimit: 16 }), /partLimit/);
  assert.throws(() => new PackWriter({ ...base, pageEntries: 0 }), /pageEntries/);
});

// A codec of dataset 1 that takes keys of up to 65,535 bytes, with the record
// bytes of names: what a pack of dataset 1 written by a bug, or by anyone who
// can push, may hold.
const WIDE: DatasetCodec<NameRecord> = {
  ...NAMES_CODEC,
  maxKeyBytes: MAX_KEY_BYTES,
  encodeRecord: (prev, r, out) => {
    writeKey(prev === null ? null : prev.key, r.key, r.flags, out, MAX_KEY_BYTES);
    out.mask(r.sources.map((s) => s.bit));
    for (const s of r.sources) {
      out.varint(s.first);
      out.varint(s.last - s.first);
    }
  },
  decodeRecord: (prev, input) => {
    const { key, flags } = readKey(prev === null ? null : prev.key, input, MAX_KEY_BYTES);
    const sources = input.mask().map((bit) => {
      const first = input.varint();
      return { bit, first, last: first + input.varint() };
    });
    return { key, flags, sources };
  },
};

// n synthetic keys of 65,002 bytes that share their first 65,000 or 65,001:
// after the first, each costs a few bytes of front coding.
const LONG_BASE = "x".repeat(65_000);
const longTail = (i: number): string => String.fromCharCode(0x21 + Math.floor(i / 200), 0x21 + (i % 200));
const longKeys = (n: number): string[] => Array.from({ length: n }, (_, i) => LONG_BASE + longTail(i));

// The record at which keys of 65,002 bytes pass the budget of a block.
const PAST_BUDGET = Math.floor(MAX_BLOCK_KEY_BYTES / 65_002) + 1;

test("pack write: a raw block above 16 MiB is refused", async () => {
  // 300 keys of 60,002 bytes that share at most their first byte: 18 MB of
  // raw block, in a codec whose keys may be that long. The raw bytes pass
  // 16 MiB at the same record as the keys or before, and are checked first.
  const tail = "x".repeat(60_000);
  const key = (i: number) => String.fromCharCode(0x41 + Math.floor(i / 26), 0x61 + (i % 26)) + tail;
  const writer = new PackWriter({ codec: WIDE, compress: nodeCompress, sink: new MemorySink(), recordsPerBlock: 1000 });
  await refusedWith(
    async () => {
      for (let i = 0; i < 300; i += 1) await writer.add(name(key(i)));
    },
    "span",
    new RegExp(`passes ${MAX_RAW_BLOCK_BYTES} raw bytes`),
  );
});

test("pack read: a byte changed in a stored block fails the CRC and nothing else", async () => {
  const records = randomNames(40, 28);
  const stored = (_codec: number, raw: Uint8Array) => new Uint8Array(deflateRawSync(raw, { level: 0 }));
  const pack = await writeMem(records, { codec: NAMES_CODEC, compress: stored, recordsPerBlock: 20 });
  const entry = pack.summary.entries[0];
  // The last byte of a stored block is the last raw byte: the span of the last
  // source of record 20. 0x00 becomes 0x01, a valid varint, so the block still
  // decompresses to its length and every record still decodes.
  const parts = pack.parts.map((p) => p.slice());
  const at = entry.offset + entry.packed - 1;
  assert.equal(parts[0][at] < 0x7f, true);
  parts[0][at] += 1;
  const reader = await PackReader.open(pack.summary.idx, partsSource(parts), NAMES_CODEC);
  await refusedWith(() => reader.readBlock(entry), "crc", /CRC-32 of its raw bytes/);
  await refusedWith(() => reader.get(records[3].key), "crc", /block 0/);
  // Block 1 is untouched and reads.
  assert.deepEqual(await reader.get(records[25].key), records[25]);
});

test("pack read: a block that decompresses past or short of its raw length fails inflate", async () => {
  const pack = await writeMem(randomNames(40, 29), { codec: NAMES_CODEC, recordsPerBlock: 20 });
  const l = layout(pack.summary.idx);
  for (const [delta, pattern] of [
    [1, /decompresses to \d+ bytes, its index entry says/],
    [-1, /decompresses past the \d+ raw bytes/],
  ] as const) {
    const idx = pack.summary.idx.slice();
    const at = l.entries[0].fields + FIELD.raw;
    view(idx).setUint32(at, view(idx).getUint32(at, true) + delta, true);
    const reader = await PackReader.open(fixCrcs(idx), partsSource(pack.parts), NAMES_CODEC);
    await refusedWith(async () => reader.readBlock(await reader.index.entry(0)), "inflate", pattern);
  }
  // Bytes that are no deflate stream: 0xff starts a block of the reserved type.
  const parts = pack.parts.map((p) => p.slice());
  const e = pack.summary.entries[1];
  parts[0].fill(0xff, e.offset, e.offset + e.packed);
  const reader = await PackReader.open(pack.summary.idx, partsSource(parts), NAMES_CODEC);
  await refusedWith(() => reader.readBlock(e), "inflate", /does not decompress as deflate-raw/);
});

test("pack read: a part source that answers short is refused", async () => {
  const pack = await writeMem(randomNames(40, 30), { codec: NAMES_CODEC, recordsPerBlock: 20 });
  const short = { read: async (part: number, offset: number, length: number) => pack.parts[part].subarray(offset, offset + length - 1) };
  const reader = await PackReader.open(pack.summary.idx, short, NAMES_CODEC);
  await refusedWith(() => reader.readBlock(pack.summary.entries[0]), "short-read", /answered/);
});

test("pack read: a block whose records outnumber or fall short of its index entry fails count", async () => {
  const more = handPack([{ raw: namesRaw(["com.a", "com.b", "com.c", "com.d"]), key: "com.a", records: 3 }], { recordsPerBlock: 3, records: 3, keyMin: "com.a", keyMax: "com.c" });
  const r1 = await PackReader.open(more.idx, partsSource(more.parts), NAMES_CODEC);
  await refusedWith(async () => r1.records(await r1.index.entry(0)), "count", /more than the 3 records/);
  const fewer = handPack([{ raw: namesRaw(["com.a", "com.b"]), key: "com.a", records: 3 }], { recordsPerBlock: 3, records: 3, keyMin: "com.a", keyMax: "com.c" });
  const r2 = await PackReader.open(fewer.idx, partsSource(fewer.parts), NAMES_CODEC);
  await refusedWith(async () => r2.records(await r2.index.entry(0)), "count", /holds 2 records, its index entry says 3/);
});

// A codec that writes a key as a u8 length and its bytes, and reads it with no
// check of order: the reader's own check is the only one left.
const LOOSE: DatasetCodec<{ key: string }> = {
  id: 1,
  name: "loose",
  maxKeyBytes: 255,
  key: (r) => r.key,
  idxKey: (r) => r.key,
  encodeRecord: (_prev, r, out) => {
    out.u8(r.key.length);
    out.latin1(r.key);
  },
  decodeRecord: (_prev, input: ByteReader) => ({ key: input.latin1(input.u8()) }),
  merge: (a) => a,
};

test("pack read: keys that do not ascend within a block fail order, whatever the codec", async () => {
  const raw = new ByteWriter();
  LOOSE.encodeRecord(null, { key: "b" }, raw);
  LOOSE.encodeRecord(null, { key: "a" }, raw);
  const pack = handPack([{ raw: raw.take(), key: "b", records: 2 }], { recordsPerBlock: 2, records: 2, keyMin: "a", keyMax: "b" });
  const reader = await PackReader.open(pack.idx, partsSource(pack.parts), LOOSE);
  await refusedWith(async () => reader.records(await reader.index.entry(0)), "order", /record 2 is not above/);
});

test("pack read: a block that does not start with its index key fails order", async () => {
  const pack = handPack([{ raw: namesRaw(["com.b", "com.c"]), key: "com.a", records: 2 }], { recordsPerBlock: 2, records: 2, keyMin: "com.a", keyMax: "com.c" });
  const reader = await PackReader.open(pack.idx, partsSource(pack.parts), NAMES_CODEC);
  await refusedWith(() => reader.get("com.b"), "order", /does not start with its index key/);
});

test("pack read: a scan refuses a block that starts below the last key of the block before it", async () => {
  const pack = handPack(
    [
      { raw: namesRaw(["com.a", "com.c"]), key: "com.a", records: 2 },
      { raw: namesRaw(["com.b", "com.d"]), key: "com.b", records: 2 },
    ],
    { recordsPerBlock: 2, records: 4, keyMin: "com.a", keyMax: "com.d" },
  );
  const reader = await PackReader.open(pack.idx, partsSource(pack.parts), NAMES_CODEC);
  await refusedWith(() => collect(reader.scan()), "order", /block 1 does not start above/);
});

test("pack read: a reader refuses a dataset it has no codec for, and a codec of another dataset", async () => {
  const pack = await writeMem(randomNames(10, 31), { codec: NAMES_CODEC });
  const rev = pack.summary.idx.slice();
  rev[5] = 4;
  await refusedWith(() => PackReader.open(fixHead(rev), partsSource(pack.parts)), "dataset", /dataset 4 \(rev\)/);
  await refusedWith(() => PackReader.open(pack.summary.idx, partsSource(pack.parts), DOMAINS_CODEC), "dataset", /dataset 1 and the codec domains is dataset 2/);
});

test("pack read: a part header names its fields, and a bad one is refused by its own check", async () => {
  const pack = await writeMem(randomNames(10, 32), { codec: NAMES_CODEC, recordsPerBlock: 300 });
  assert.deepEqual(readPartHeader(pack.parts[0]), { dataset: 1, recordsPerBlock: 300, part: 0, codec: 1 });
  const planted = (at: number, value: number) => {
    const p = pack.parts[0].slice(0, 16);
    p[at] = value;
    return p;
  };
  assert.throws(
    () => readPartHeader(planted(3, 0x32)),
    (e: unknown) => e instanceof PackError && e.code === "magic",
  );
  assert.throws(
    () => readPartHeader(planted(4, 2)),
    (e: unknown) => e instanceof PackError && e.code === "version",
  );
  assert.throws(
    () => readPartHeader(planted(5, 0)),
    (e: unknown) => e instanceof PackError && e.code === "dataset",
  );
  assert.throws(
    () => readPartHeader(planted(10, 7)),
    (e: unknown) => e instanceof PackError && e.code === "codec",
  );
  assert.throws(
    () => readPartHeader(planted(15, 1)),
    (e: unknown) => e instanceof PackError && e.code === "header" && /reserved byte 15/.test(e.message),
  );
  assert.throws(
    () => readPartHeader(pack.parts[0].subarray(0, 15)),
    (e: unknown) => e instanceof PackError && e.code === "header",
  );
});

test("pack read: a lookup with the head held reads one index page and one block", async () => {
  const records = randomNames(20_000, 33);
  const pack = await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 64 });
  const reads = { idx: 0, parts: 0 };
  const idx = { size: pack.summary.idx.length, read: async (o: number, n: number) => (reads.idx++, pack.summary.idx.subarray(o, o + n)) };
  const parts = { read: async (p: number, o: number, n: number) => (reads.parts++, pack.parts[p].subarray(o, o + n)) };
  const index = await PackIndex.open(idx, { pageCache: 0 });
  assert.equal(reads.idx, 1);
  const reader = new PackReader(index, parts, NAMES_CODEC);
  for (const r of records.filter((_, i) => i % 97 === 0)) {
    reads.idx = 0;
    reads.parts = 0;
    assert.deepEqual(await reader.get(r.key), r);
    assert.deepEqual(reads, { idx: 1, parts: 1 }, r.key);
  }
});

test("pack write: the annotations name the dataset, count, bytes, SHA-256 and writer", async () => {
  const pack = await writeMem(randomNames(100, 34), { codec: NAMES_CODEC });
  const a = packAnnotations(pack.summary, writerId());
  assert.deepEqual(a, {
    [ANNOTATIONS.dataset]: "names",
    [ANNOTATIONS.count]: "100",
    [ANNOTATIONS.bytes]: String(pack.parts.reduce((s, p) => s + p.length, 0) + pack.summary.idx.length),
    [ANNOTATIONS.sha256]: pack.summary.sha256,
    [ANNOTATIONS.writer]: `node ${process.version}, zlib ${process.versions.zlib}`,
  });
  assert.throws(() => packAnnotations({ ...pack.summary, dataset: 9 }, "w"), /no annotation name/);
});

test("pack write: writePack takes an async iterable, and writeKey refuses a key equal to the one before it", async () => {
  async function* gen() {
    for (const key of randomKeys(500, 35)) yield name(key);
  }
  const sink = new MemorySink();
  const summary = await writePack(gen(), { codec: NAMES_CODEC, compress: nodeCompress, sink });
  assert.equal(summary.records, 500);
  assert.throws(
    () => writeKey("com.a", "com.a", 1, new ByteWriter(), 253),
    (e: unknown) => e instanceof PackError && e.code === "order",
  );
});

test("pack write: a pack of dataset 5, new-name, reads back with the feed record, and is named new-name", async () => {
  const rows = randomFeed(800, 37);
  const pack = await writeMem(rows, { codec: NEW_NAME_CODEC, recordsPerBlock: 100 });
  assert.equal(readPartHeader(pack.parts[0]).dataset, 5);
  // Without a codec the reader takes the one this package ships for dataset 5.
  const reader = await PackReader.open(pack.summary.idx, partsSource(pack.parts));
  assert.equal(reader.codec, NEW_NAME_CODEC);
  assert.deepEqual(await collect(reader.scan()), rows);
  assert.equal(packAnnotations(pack.summary, "w")[ANNOTATIONS.dataset], "new-name");
  // The raw blocks are those of dataset 3 for the same rows: one record.
  assert.equal(pack.summary.sha256, (await writeMem(rows, { codec: FEED_CODEC, recordsPerBlock: 100 })).summary.sha256);
});

test("pack write: the part limit holds blocks that fill it exactly, and one byte less moves or refuses a block", async () => {
  const records = randomNames(40, 36);
  const free = await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 10, partLimit: 2 ** 30 });
  const packed = free.summary.entries.map((e) => e.packed);
  assert.equal(packed.length, 4);
  const exact = 16 + packed[0] + packed[1];
  const fit = await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 10, partLimit: exact });
  assert.equal(fit.summary.parts[0].blocks, 2);
  assert.equal(fit.summary.parts[0].bytes, exact);
  // One byte less and the second block starts part 1.
  const less = await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 10, partLimit: exact - 1 });
  assert.equal(less.summary.parts[0].blocks, 1);
  // A limit of the header and the largest block takes every block; one byte
  // less refuses the largest.
  const largest = 16 + Math.max(...packed);
  assert.equal((await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 10, partLimit: largest })).summary.blocks, 4);
  await refusedWith(() => writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 10, partLimit: largest - 1 }), "span", new RegExp(`does not fit in a part of at most ${largest - 1} B`));
});

test("pack write: a compressor that gives more than the bound of a block is refused", async () => {
  const records = randomNames(20, 38);
  // Bytes that are no stream: the writer does not inflate a block it is
  // given, so only the bound refuses them. At the bound the pack is written.
  const sized = (extra: number) => (_codec: number, raw: Uint8Array) => new Uint8Array(packedLimit(raw.length) + extra);
  assert.equal((await writeMem(records, { codec: NAMES_CODEC, compress: sized(0) })).summary.blocks, 1);
  await refusedWith(() => writeMem(records, { codec: NAMES_CODEC, compress: sized(1) }), "usage", /compress gave \d+ B for block 0 of \d+ raw bytes, not 1 to \d+/);
});

test("pack write: a key longer than its dataset's is refused, and a codec must state its longest key", async () => {
  const writer = new PackWriter({ codec: NAMES_CODEC, compress: nodeCompress, sink: new MemorySink() });
  await writer.add(name("a".repeat(253)));
  await refusedWith(() => writer.add(name("b".repeat(254))), "record", /record 2: its key is 254 bytes, above the 253 of dataset names/);
  const base = { compress: nodeCompress, sink: new MemorySink() };
  assert.throws(() => new PackWriter({ ...base, codec: { ...NAMES_CODEC, maxKeyBytes: undefined as unknown as number } }), /maxKeyBytes/);
  assert.throws(() => new PackWriter({ ...base, codec: { ...NAMES_CODEC, maxKeyBytes: MAX_KEY_BYTES + 1 } }), /maxKeyBytes/);
});

test("pack read: a small block whose front coding names 520 MB of keys is refused before it is held", async () => {
  // The records of longKeys(8000) in the bytes WIDE writes, built from the
  // lengths so that the test never holds the 520,016,000 bytes of keys: the
  // first key whole, then 65,000 bytes shared when the 65,001st byte changes
  // (every 200 keys) and 65,001 otherwise, each name seen on day 298.
  const keys = longKeys(8000);
  const raw = new ByteWriter();
  for (let i = 0; i < keys.length; i += 1) {
    const shared = i === 0 ? 0 : i % 200 === 0 ? 65_000 : 65_001;
    const suffix = i === 0 ? keys[0] : longTail(i).slice(shared - 65_000);
    raw.varint(shared);
    raw.varint(suffix.length * 4 + 1);
    raw.latin1(suffix);
    raw.mask([0]);
    raw.varint(298);
    raw.varint(0);
  }
  assert.equal(keys.length * keys[0].length, 520_016_000);
  assert.equal(raw.length, 137_040);
  // The same bytes as WIDE writes, for the first 401 records.
  const byCodec = new ByteWriter();
  let prev: NameRecord | null = null;
  for (const k of keys.slice(0, 401)) {
    const r = name(k);
    WIDE.encodeRecord(prev, r, byCodec);
    prev = r;
  }
  assert.deepEqual(byCodec.take(), raw.take().subarray(0, byCodec.length));
  const pack = handPack([{ raw: raw.take(), key: keys[0], records: 8000 }], { recordsPerBlock: 8000, records: 8000, keyMin: keys[0], keyMax: keys[7999] });
  assert.ok(pack.parts[0].length < 4096, `a part of ${pack.parts[0].length} B`);
  // Names are at most 253 bytes: the first key is refused from its lengths.
  const names = await PackReader.open(pack.idx, partsSource(pack.parts), NAMES_CODEC);
  await refusedWith(() => names.get(keys[5]), "record", /block 0: a key of 65002 bytes, above the 253 of its dataset/);
  // A codec that allows such keys: the budget of the block refuses at the
  // record whose key passes 16 MiB of keys.
  const wide = await PackReader.open(pack.idx, partsSource(pack.parts), WIDE);
  const entry = await wide.index.entry(0);
  await refusedWith(async () => wide.decodeBlock(await wide.readBlock(entry), entry), "record", new RegExp(`block 0: its keys pass ${MAX_BLOCK_KEY_BYTES} bytes at record ${PAST_BUDGET}$`));
});

test("pack write: a block whose keys pass 16 MiB is refused, whatever the codec allows", async () => {
  const writer = new PackWriter({ codec: WIDE, compress: nodeCompress, sink: new MemorySink(), recordsPerBlock: 300 });
  await refusedWith(
    async () => {
      for (const k of longKeys(300)) await writer.add(name(k));
    },
    "span",
    new RegExp(`the keys of block 0 pass ${MAX_BLOCK_KEY_BYTES} bytes at record ${PAST_BUDGET}:`),
  );
  // The budget starts again in each block: 200 keys a block stay under it,
  // and the 300 keys of two blocks pass it together.
  const keys = longKeys(300);
  const two = await writeMem(
    keys.map((k) => name(k)),
    { codec: WIDE, recordsPerBlock: 200 },
  );
  assert.equal(two.summary.blocks, 2);
  assert.ok(keys.length * keys[0].length > MAX_BLOCK_KEY_BYTES);
  assert.deepEqual(
    (await collect((await readerOf(two, WIDE)).scan())).map((r) => r.key),
    keys,
  );
});
