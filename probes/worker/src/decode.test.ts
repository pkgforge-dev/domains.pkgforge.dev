// probes/worker/src/decode.test.ts — DOM-008's /decode route under Node, against
// a fake R2 bucket that answers ranged gets as R2 does (the whole object's size
// beside the bytes of the range, a range past the end cut at the end). The
// sample packs are built by scripts/measure/make-sample-pack.mjs from synthetic
// names made here; each refusal is a planted fault that its own guard alone
// catches. The mock tier: src/../test/decode-workerd.test.ts runs the route in
// workerd, and the deployed probe is the acceptance test.
//
//   node scripts/test.mjs probes/worker --name decode
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { inflateRawSync, crc32 as zlibCrc32 } from "node:zlib";
import { createBlockEncoder, decodeBlock } from "../../../scripts/measure/blockenc.mjs";
import { buildPack } from "../../../scripts/measure/make-sample-pack.mjs";
import {
  BLOCK_SIZES,
  crc32,
  DEFAULT_PER,
  decodeRoute,
  dnsOrder,
  ENTRY_BYTES,
  HEAD_BYTES,
  hex32,
  latin1,
  MAX_BLOCKS,
  MAX_KEY,
  MAX_RECORD,
  MAX_ROWS,
  parseDecodeQuery,
  readSampleEntries,
  readSampleHead,
  type SampleEntry,
  samplePackKey,
  scanBlock,
  writeSampleHead,
} from "./decode.ts";
import { ProbeError } from "./gaps.ts";
import type { Env, ProbeBucket, ProbeGetOptions, ProbeObject, ProbeObjectBody, ProbeObjects } from "./types.ts";

type Rec = [key: string, flags: number];

// n distinct synthetic keys in ascending order, each with flags 1, 2 or 3.
function syntheticRecords(n: number): Rec[] {
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) keys.push(`com.zone${String(i % 97).padStart(2, "0")}.h${String(i).padStart(6, "0")}${i % 5 === 0 ? ".www" : ""}`);
  keys.sort();
  return keys.map((key, i) => [key, 1 + (i % 3)]);
}

interface Pack {
  bytes: Uint8Array;
  entries: SampleEntry[];
}

const packOf = (records: Rec[], per: number): Pack => {
  const built = buildPack(records, per) as { bytes: Buffer; entries: SampleEntry[] };
  return { bytes: new Uint8Array(built.bytes), entries: built.entries };
};

class ReadBucket implements ProbeBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly gets: { key: string; offset: number; length: number }[] = [];
  // Bytes to drop from the end of an answer (a planted short read): of every
  // answer, or only of a range that does not start at offset 0.
  short = 0;
  shortPastHead = false;

  async put(): Promise<ProbeObject | null> {
    throw new Error("the decode route never writes");
  }

  async list(): Promise<ProbeObjects> {
    throw new Error("the decode route never lists");
  }

  async get(key: string, options?: ProbeGetOptions): Promise<ProbeObjectBody | null> {
    const bytes = this.objects.get(key);
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? (bytes === undefined ? 0 : bytes.length - offset);
    this.gets.push({ key, offset, length });
    if (bytes === undefined) return null;
    if (offset > bytes.length || length <= 0) throw new Error("InvalidRange (planted by the fake: R2 refuses it)");
    const drop = this.shortPastHead && offset === 0 ? 0 : this.short;
    const slice = bytes.slice(offset, Math.min(bytes.length, offset + length) - drop);
    return { key, size: bytes.length, uploaded: new Date(0), arrayBuffer: async () => slice.buffer };
  }
}

const envOf = (bucket: ProbeBucket): Env => ({ PROBE: bucket });

async function call(env: Env, query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`https://probe.example.test/decode?${query}`);
  const response = await decodeRoute.handle(new Request(url), env, url, () => 0);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// Asserts that the route refuses the query with this status and a message matching re.
async function refused(env: Env, query: string, status: number, re: RegExp): Promise<void> {
  await assert.rejects(
    () => call(env, query),
    (err: unknown) => {
      assert.ok(err instanceof ProbeError, `a ProbeError, not ${String(err)}`);
      assert.equal(err.status, status, err.message);
      assert.match(err.message, re);
      return true;
    },
  );
}

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const entryAt = (i: number, field: number): number => HEAD_BYTES + i * ENTRY_BYTES + field * 4;

// A copy of a pack with one planted change.
function planted(pack: Uint8Array, change: (bytes: Uint8Array, v: DataView) => void): Uint8Array {
  const copy = new Uint8Array(pack);
  change(copy, view(copy));
  return copy;
}

// A pack assembled from raw blocks, each deflated by node:zlib, with zlib's CRC
// chain: the way to plant a block whose records are wrong and whose CRC is right.
function assemble(per: number, raws: Uint8Array[], records: number[]): Uint8Array {
  const { deflateRawSync } = process.getBuiltinModule("node:zlib");
  const packed = raws.map((raw) => new Uint8Array(deflateRawSync(raw, { level: 9 })));
  let offset = HEAD_BYTES + ENTRY_BYTES * raws.length;
  let crc = 0;
  const entries = raws.map((raw, i) => {
    crc = zlibCrc32(raw, crc);
    const entry: SampleEntry = { offset, packed: packed[i]!.length, raw: raw.length, records: records[i]!, crcThrough: crc };
    offset += packed[i]!.length;
    return entry;
  });
  const head = writeSampleHead({ per, blocks: raws.length, records: records.reduce((a, b) => a + b, 0), bytes: offset }, entries);
  return new Uint8Array(Buffer.concat([head, ...packed]));
}

// The raw records of keys in order, front coded as blockenc.mjs writes them.
function rawOf(records: Rec[], per: number): Uint8Array[] {
  const raws: Uint8Array[] = [];
  const encoder = createBlockEncoder({
    perBlock: per,
    onBlock: (_packed: Buffer, info: { raw: Buffer }) => {
      raws.push(new Uint8Array(info.raw));
      return null;
    },
  });
  for (const [key, flags] of records) encoder.add(key, flags);
  encoder.finish();
  return raws;
}

const bytesOf = (...parts: (number | string)[]): Uint8Array => new Uint8Array(parts.flatMap((p) => (typeof p === "number" ? [p] : [...p].map((c) => c.charCodeAt(0)))));

test("probe decode: crc32 is zlib's, and continues from one piece to the next as zlib's does", () => {
  for (const size of [0, 1, 7, 4096, 70_001]) {
    const bytes = new Uint8Array(randomBytes(size));
    assert.equal(crc32(bytes), zlibCrc32(bytes), `${size} bytes`);
    const cut = Math.floor(size / 3);
    assert.equal(crc32(bytes.subarray(cut), crc32(bytes.subarray(0, cut))), zlibCrc32(bytes), `${size} bytes in two pieces`);
  }
  assert.equal(hex32(crc32(new TextEncoder().encode("123456789"))), "cbf43926");
});

test("probe decode: the head and table writeSampleHead writes read back field for field", () => {
  const records = syntheticRecords(3000);
  for (const per of BLOCK_SIZES) {
    const pack = packOf(records, per);
    const head = readSampleHead(pack.bytes, `per-${per}`);
    const blocks = Math.ceil(3000 / per);
    assert.deepEqual(head, { per, blocks, records: 3000, bytes: pack.bytes.length });
    assert.deepEqual(readSampleEntries(pack.bytes, head, blocks, `per-${per}`), pack.entries);
  }
  assert.equal(samplePackKey(4096), "sample/v1/per-4096.pack");
  assert.throws(() => writeSampleHead({ per: 1024, blocks: 2, records: 1, bytes: 1 }, []), /names 2 blocks and the table holds 0/);
});

test("probe decode: readSampleHead refuses each planted fault of the head", () => {
  const good = packOf(syntheticRecords(3000), 1024).bytes;
  const cases: [string, (b: Uint8Array, v: DataView) => void, RegExp][] = [
    ["magic", (b) => (b[0] = 0x45), /does not start with DSP1/],
    ["version", (b) => (b[4] = 2), /is version 2, not 1/],
    ["codec", (b) => (b[5] = 2), /names codec 2/],
    ["reserved byte 6", (b) => (b[6] = 1), /head byte 6 is 1/],
    ["reserved byte 31", (b) => (b[31] = 1), /head byte 31 is 1/],
    ["per", (_b, v) => v.setUint32(8, 2048, true), /blocks of 2048 records, not one of/],
    ["no block", (_b, v) => v.setUint32(12, 0, true), /holds no block/],
    ["too many records", (_b, v) => v.setUint32(16, 3 * 1024 + 1, true), /do not fill 3 blocks/],
    ["too few records", (_b, v) => v.setUint32(16, 2 * 1024, true), /do not fill 3 blocks/],
    ["bytes too few", (_b, v) => v.setUint32(20, HEAD_BYTES + 3 * ENTRY_BYTES + 2, true), /cannot hold the head, the table and 3 blocks/],
  ];
  assert.doesNotThrow(() => readSampleHead(good, "good"));
  for (const [name, change, re] of cases)
    assert.throws(
      () => readSampleHead(planted(good, change), "p"),
      (err: unknown) => err instanceof ProbeError && err.status === 500 && re.test(err.message),
      name,
    );
  assert.throws(() => readSampleHead(good.subarray(0, HEAD_BYTES - 1), "p"), /shorter than the 32 B head/);
});

test("probe decode: readSampleEntries refuses each planted fault of the table", () => {
  const good = packOf(syntheticRecords(3000), 1024).bytes;
  const head = readSampleHead(good, "good");
  const raw1 = view(good).getUint32(entryAt(1, 2), true);
  const cases: [string, (b: Uint8Array, v: DataView) => void, RegExp][] = [
    ["a gap before block 1", (_b, v) => v.setUint32(entryAt(1, 0), v.getUint32(entryAt(1, 0), true) + 1, true), /block 1 starts at \d+, not at \d+/],
    ["a short middle block", (_b, v) => v.setUint32(entryAt(1, 3), 1023, true), /block 1 holds 1023 records in blocks of 1024/],
    ["raw too small", (_b, v) => v.setUint32(entryAt(1, 2), 3 * 1024 - 1, true), /block 1: 3071 raw bytes cannot hold 1024 records/],
    ["raw too large", (_b, v) => v.setUint32(entryAt(1, 2), MAX_RECORD * 1024 + 1, true), /raw bytes cannot hold 1024 records/],
    ["packed 0", (_b, v) => v.setUint32(entryAt(1, 1), 0, true), /block 1: 0 packed bytes/],
    ["packed past its bound", (_b, v) => v.setUint32(entryAt(1, 1), raw1 + Math.floor(raw1 / 256) + 65, true), /block 1: \d+ packed bytes for \d+ raw bytes/],
    ["the last block short of the object's end", (_b, v) => v.setUint32(20, v.getUint32(20, true) + 1, true), /block 2 ends at \d+ in an object of \d+ B/],
  ];
  assert.equal(readSampleEntries(good, head, 3, "good").length, 3);
  for (const [name, change, re] of cases) {
    const bytes = planted(good, change);
    assert.throws(
      () => readSampleEntries(bytes, readSampleHead(bytes, "p"), 3, "p"),
      (err: unknown) => err instanceof ProbeError && err.status === 500 && re.test(err.message),
      name,
    );
  }
  assert.throws(() => readSampleEntries(good, head, 4, "p"), /4 entries asked of a table of 3/);
  assert.throws(() => readSampleEntries(good.subarray(0, HEAD_BYTES + ENTRY_BYTES), head, 2, "p"), /hold fewer than 2 table entries/);
});

test("probe decode: scanBlock reads blockenc's blocks to the keys and flags blockenc's decodeBlock reads", () => {
  const records = syntheticRecords(2500);
  const packed: Buffer[] = [];
  const encoder = createBlockEncoder({
    perBlock: 1024,
    onBlock: (p: Buffer) => {
      packed.push(p);
      return null;
    },
  });
  for (const [key, flags] of records) encoder.add(key, flags);
  encoder.finish();
  assert.equal(packed.length, 3);
  const seen: Rec[] = [];
  for (const [i, block] of packed.entries()) {
    const keys: Rec[] = [];
    const scan = scanBlock(new Uint8Array(inflateRawSync(block)), `block ${i}`, (key, length, flags) => keys.push([latin1(key, length), flags]));
    const want = decodeBlock(block) as { keys: string[]; flags: number[] };
    assert.deepEqual(
      keys,
      want.keys.map((k, j) => [k, want.flags[j]]),
    );
    assert.deepEqual(scan, { records: want.keys.length, first: want.keys[0], last: want.keys[want.keys.length - 1] });
    seen.push(...keys);
  }
  assert.deepEqual(seen, records);
});

test("probe decode: scanBlock refuses each planted fault of a record", () => {
  const long = "a".repeat(MAX_KEY + 1);
  const cases: [string, Uint8Array, RegExp][] = [
    ["a varint of 6 bytes", bytesOf(0x80, 0x80, 0x80, 0x80, 0x80, 0x01), /record 1 has a varint longer than 5 bytes/],
    ["a block that ends inside a varint", bytesOf(0, 0x85), /record 1 ends inside a varint/],
    ["a first record that shares", bytesOf(1, (1 << 2) | 1, "a"), /its first record shares 1 bytes/],
    ["a share past the key before", bytesOf(0, (2 << 2) | 1, "ab", 3, (1 << 2) | 1, "c"), /record 2 shares 3 bytes of a 2 B key/],
    ["flags 0", bytesOf(0, (2 << 2) | 0, "ab"), /record 1 has flags 0/],
    ["a record that adds nothing", bytesOf(0, (2 << 2) | 1, "ab", 2, (0 << 2) | 1), /record 2 adds no byte/],
    ["a key over 253 bytes", bytesOf(0, ((((MAX_KEY + 1) << 2) | 1) & 127) | 128, ((MAX_KEY + 1) << 2) >> 7, long), /record 1 is a 254 B key/],
    ["a suffix past the block", bytesOf(0, (5 << 2) | 1, "ab"), /record 1 runs past the block/],
    ["keys out of order", bytesOf(0, (1 << 2) | 1, "b", 0, (1 << 2) | 1, "a"), /record 2 is not above the key before it/],
    ["an empty block", bytesOf(), /holds no record/],
  ];
  assert.deepEqual(scanBlock(bytesOf(0, (2 << 2) | 1, "ab", 1, (1 << 2) | 2, "c"), "good"), { records: 2, first: "ab", last: "ac" });
  for (const [name, raw, re] of cases)
    assert.throws(
      () => scanBlock(raw, "block 0"),
      (err: unknown) => err instanceof ProbeError && err.status === 500 && re.test(err.message),
      name,
    );
});

test("probe decode: the query takes blocks or rows, per and tag, and answers anything else with a 400", () => {
  const q = (s: string) => parseDecodeQuery(new URL(`https://p.test/decode?${s}`));
  assert.deepEqual(q("blocks=4"), { mode: "blocks", per: DEFAULT_PER, blocks: 4, rows: null, tag: null });
  assert.deepEqual(q("blocks=16&per=16384&tag=ab12.3.199"), { mode: "blocks", per: 16384, blocks: 16, rows: null, tag: "ab12.3.199" });
  assert.deepEqual(q("rows=1000"), { mode: "rows", per: 4096, blocks: 1, rows: 1000, tag: null });
  assert.deepEqual(q(`rows=${MAX_ROWS}&per=1024`), { mode: "rows", per: 1024, blocks: 10, rows: MAX_ROWS, tag: null });
  const bad: [string, RegExp][] = [
    ["", /exactly one of blocks and rows/],
    ["blocks=1&rows=1", /exactly one of blocks and rows/],
    ["blocks=0", /blocks must be 1 to 16/],
    [`blocks=${MAX_BLOCKS + 1}`, /blocks must be 1 to 16/],
    ["blocks=1.5", /blocks must be a whole number/],
    ["blocks=-1", /blocks must be a whole number/],
    [`rows=${MAX_ROWS + 1}`, /rows must be 1 to 10000/],
    ["rows=0", /rows must be 1 to 10000/],
    ["blocks=1&per=2048", /per must be one of 1024, 4096, 16384/],
    ["blocks=1&per=x", /per must be a whole number/],
    ["blocks=1&tag=a%20b", /tag must be 1 to 64 characters/],
    [`blocks=1&tag=${"t".repeat(65)}`, /tag must be 1 to 64 characters/],
    ["blocks=1&blocks=2", /blocks is given more than once/],
    ["blocks=1&cache=1", /not cache/],
  ];
  for (const [query, re] of bad)
    assert.throws(
      () => q(query),
      (err: unknown) => err instanceof ProbeError && err.status === 400 && re.test(err.message),
      query,
    );
});

test("probe decode: blocks=N answers the names, the CRC-32 through block N-1 and the first and last key, in two ranged gets", async () => {
  const records = syntheticRecords(5000);
  const pack = packOf(records, 1024);
  const bucket = new ReadBucket();
  bucket.objects.set(samplePackKey(1024), pack.bytes);
  const { status, body } = await call(envOf(bucket), "blocks=3&per=1024&tag=t.1");
  assert.equal(status, 200);
  assert.equal(body.names, 3072);
  assert.equal(body.crc32, hex32(pack.entries[2]!.crcThrough));
  assert.equal(body.first_key, records[0]![0]);
  assert.equal(body.last_key, records[3071]![0]);
  assert.equal(
    body.packed_bytes,
    pack.entries.slice(0, 3).reduce((a, e) => a + e.packed, 0),
  );
  assert.equal(
    body.raw_bytes,
    pack.entries.slice(0, 3).reduce((a, e) => a + e.raw, 0),
  );
  assert.equal(body.tag, "t.1");
  assert.equal(body.read_from, "R2 binding PROBE: 2 ranged gets of sample/v1/per-1024.pack");
  assert.deepEqual(body.wall_ms, { r2: 0, decode: 0 });
  assert.equal(body.rows, undefined);
  const base = pack.entries[0]!.offset;
  assert.deepEqual(bucket.gets, [
    { key: "sample/v1/per-1024.pack", offset: 0, length: HEAD_BYTES + 3 * ENTRY_BYTES },
    { key: "sample/v1/per-1024.pack", offset: base, length: pack.entries[2]!.offset + pack.entries[2]!.packed - base },
  ]);
  // The whole pack, its short last block included.
  const all = await call(envOf(bucket), "blocks=5&per=1024");
  assert.equal(all.body.names, 5000);
  assert.equal(all.body.last_key, records[4999]![0]);
  assert.equal(all.body.crc32, hex32(pack.entries[4]!.crcThrough));
});

test("probe decode: rows=R answers the first R names in DNS order with their flags, and the answer is never cached", async () => {
  const records = syntheticRecords(3000);
  const bucket = new ReadBucket();
  bucket.objects.set(samplePackKey(1024), packOf(records, 1024).bytes);
  const url = new URL("https://probe.example.test/decode?rows=1500&per=1024");
  const response = await decodeRoute.handle(new Request(url), envOf(bucket), url, () => 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as { rows: { name: string; exact: boolean; wildcard: boolean }[]; rows_count: number; blocks: number; names: number };
  assert.equal(body.blocks, 2);
  assert.equal(body.names, 2048);
  assert.equal(body.rows_count, 1500);
  assert.deepEqual(
    body.rows,
    records.slice(0, 1500).map(([key, flags]) => ({ name: dnsOrder(key), exact: (flags & 1) !== 0, wildcard: (flags & 2) !== 0 })),
  );
  assert.equal(dnsOrder("np.com.example.api"), "api.example.com.np");
});

test("probe decode: a missing sample is a 503, a binding without get a 500, a short R2 answer a 502, and asking past the pack a 400", async () => {
  const records = syntheticRecords(3000);
  const pack = packOf(records, 1024);
  const bucket = new ReadBucket();
  await refused(envOf(bucket), "blocks=1&per=4096", 503, /sample\/v1\/per-4096\.pack is not in the bucket/);
  const noGet: ProbeBucket = { put: bucket.put, list: bucket.list };
  await refused(envOf(noGet), "blocks=1", 500, /the PROBE binding has no get/);
  bucket.objects.set(samplePackKey(1024), pack.bytes);
  await refused(envOf(bucket), "blocks=4&per=1024", 400, /holds 3 blocks, fewer than the 4 asked for/);
  await refused(envOf(bucket), `rows=${MAX_ROWS}&per=1024`, 400, /holds 3 blocks, fewer than the 10 asked for/);
  bucket.short = 1;
  await refused(envOf(bucket), "blocks=1&per=1024", 502, /R2 answered 51 B for the first 52 B/);
  // The head and table whole, the blocks one byte short.
  bucket.shortPastHead = true;
  await refused(envOf(bucket), "blocks=2&per=1024", 502, /R2 answered \d+ B for the \d+ B of blocks 0 to 1 of sample\/v1\/per-1024\.pack/);
  bucket.short = 0;
  bucket.shortPastHead = false;
  // A pack of 1,024 under the key of 4,096, and a pack longer than its head says.
  bucket.objects.set(samplePackKey(4096), pack.bytes);
  await refused(envOf(bucket), "blocks=1&per=4096", 500, /holds blocks of 1024 records, not 4096/);
  bucket.objects.set(samplePackKey(1024), new Uint8Array([...pack.bytes, 0]));
  await refused(envOf(bucket), "blocks=1&per=1024", 500, /its head says \d+ B and R2 holds \d+ B/);
});

test("probe decode: a block whose bytes differ from its table entry is a 500 that names the block", async () => {
  const records = syntheticRecords(3000);
  const good = packOf(records, 1024);
  const raws = rawOf(records, 1024);
  const bucket = new ReadBucket();
  const env = envOf(bucket);
  const key = samplePackKey(1024);
  const put = (bytes: Uint8Array) => bucket.objects.set(key, bytes);
  put(good.bytes);
  assert.equal((await call(env, "blocks=3&per=1024")).status, 200);

  // The CRC-32 through block 1 off by one; the table is otherwise whole.
  put(planted(good.bytes, (_b, v) => v.setUint32(entryAt(1, 4), (v.getUint32(entryAt(1, 4), true) ^ 1) >>> 0, true)));
  await refused(env, "blocks=3&per=1024", 500, /per-1024\.pack block 1: the CRC-32 through it is [0-9a-f]{8}, the table says [0-9a-f]{8}/);

  // Raw lengths one short and one long of what block 1 inflates to.
  put(planted(good.bytes, (_b, v) => v.setUint32(entryAt(1, 2), raws[1]!.length - 1, true)));
  await refused(env, "blocks=2&per=1024", 500, /block 1 inflates past the \d+ raw bytes of its table entry/);
  put(planted(good.bytes, (_b, v) => v.setUint32(entryAt(1, 2), raws[1]!.length + 1, true)));
  await refused(env, "blocks=2&per=1024", 500, /block 1 inflates to \d+ bytes, its table entry says \d+/);

  // Bytes that are not deflate where block 0 is: 0xff opens a block of the reserved type.
  put(planted(good.bytes, (b) => b.fill(0xff, good.entries[0]!.offset, good.entries[0]!.offset + good.entries[0]!.packed)));
  await refused(env, "blocks=1&per=1024", 500, /block 0 does not inflate/);

  // One block whose records and CRC are right and whose table count is one short.
  const one = syntheticRecords(10);
  const counted = assemble(1024, rawOf(one, 1024), [9]);
  put(counted);
  await refused(env, "blocks=1&per=1024", 500, /block 0 holds 10 records, its table entry says 9/);

  // Two blocks, each sorted and with a right CRC, the second starting below the first's last key.
  const high = syntheticRecords(1024).map(([k, f]): Rec => [`net.${k}`, f]);
  const low = syntheticRecords(5).map(([k, f]): Rec => [`com.${k}`, f]);
  put(assemble(1024, [...rawOf(high, 1024), ...rawOf(low, 1024)], [1024, 5]));
  await refused(env, "blocks=2&per=1024", 500, /block 1 starts at a key that is not above the last key of the block before it/);
});

test("probe decode: the route is GET /decode of DOM-008, and its summary states its caps", () => {
  assert.equal(decodeRoute.method, "GET");
  assert.equal(decodeRoute.path, "/decode");
  assert.equal(decodeRoute.entry, "DOM-008");
  assert.match(decodeRoute.summary, /blocks=N \(1 to 16\)/);
  assert.match(decodeRoute.summary, /rows=R \(1 to 10000\)/);
  assert.match(decodeRoute.summary, /not in the answer/);
});
