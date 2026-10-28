// probes/worker/src/decode.ts — DOM-008's /decode route (TODO/storage.md): the
// work in workerd of reading blocks of names, each inflated with
// DecompressionStream("deflate-raw"), checked against its CRC-32 and scanned
// record by record, as a reader of the pack format does.
//
//   GET /decode?blocks=N[&per=P][&tag=T]   blocks 0 to N-1 of the sample pack of
//       P names a block: the names they hold, the CRC-32 of their inflated
//       bytes, and the first and last key
//   GET /decode?rows=R[&per=P][&tag=T]     the first R names of that pack as JSON
//       rows; it reads the ceil(R / P) blocks that hold them
//
// N is 1 to MAX_BLOCKS and at most the blocks the pack holds; R is 1 to MAX_ROWS,
// the rows of one JSON page (docs/architecture.md section 7.6); P is 1,024, 4,096
// (the default) or 16,384. T is a caller's label of 1 to 64 characters of
// [A-Za-z0-9._-], echoed in the answer: scripts/measure/decode-cpu.mjs finds each
// invocation's trace event by it. Any other parameter is a 400. An answer is
// never cached (cache-control: no-store), because each request is the work
// being measured. A request makes two ranged gets of R2 and holds one inflated
// block at a time, so its cost is bounded by these caps and never by refusing
// a caller (AGENTS.md absolute 8).
//
// CPU time is not in the answer. Deployed, Date.now() advances only across I/O
// (Cloudflare's documentation; locally workerd's clock advances regardless),
// so a timer around a decode can read 0: the answer's wall_ms are wall time
// and never CPU time. The platform reports each
// invocation's CPU time (cpuTime of a trace event, $workers.cpuTimeMs of
// Workers Logs), and decode-cpu.mjs reads it there.
//
// The sample pack. scripts/measure/make-sample-pack.mjs writes one object per
// block size, SAMPLE_PREFIX + "per-<P>.pack", in this measurement layout (not
// DPK1, the format of DOM-017), little-endian:
//   0   4  magic "DSP1"
//   4   1  version 1
//   5   1  codec 1, deflate-raw (the codec byte of DOM-017's part header)
//   6   2  zero
//   8   4  records a block, P; only the last block may hold fewer
//   12  4  blocks
//   16  4  records
//   20  4  bytes of the whole object
//   24  8  zero
//   32     the table, ENTRY_BYTES a block: u32 offset of the block in the
//          object, u32 packed bytes, u32 raw bytes, u32 records, u32 the CRC-32
//          of the raw bytes of blocks 0 to this one read as one stream (zlib's
//          crc32 continued from block to block)
//   then   the blocks, back to back in table order, each compressed with
//          deflate-raw at level 9
// A raw block is the records of scripts/measure/blockenc.mjs: varint(shared),
// varint(suffix_len << 2 | flags), the suffix bytes. `shared` counts the bytes
// shared with the previous key of the block (0 for the first), flags bit 0 is
// "seen plain" and bit 1 "seen as a wildcard", and keys ascend bytewise across
// the whole pack. blockenc.mjs's decodeBlock is the Node reader of the same
// records; src/decode.test.ts holds the two equal.
//
// Pure apart from the R2 reads: the caller passes the bucket and the clock.
import { ProbeError } from "./gaps.ts";
import type { Route } from "./index.ts";
import type { Env, ProbeBucket } from "./types.ts";

export const DECODE_ENTRY = "DOM-008";
export const SAMPLE_PREFIX = "sample/v1/";
export const SAMPLE_MAGIC = "DSP1";
export const SAMPLE_VERSION = 1;
export const CODEC_DEFLATE_RAW = 1;
export const HEAD_BYTES = 32;
export const ENTRY_BYTES = 20;
export const BLOCK_SIZES: readonly number[] = Object.freeze([1024, 4096, 16384]);
export const DEFAULT_PER = 4096;
// The largest N the Approach of DOM-008 asks for.
export const MAX_BLOCKS = 16;
export const MAX_ROWS = 10_000;
export const MAX_KEY = 253;
// varint(shared) and varint(suffix_len << 2 | flags) take 2 bytes each for a
// key of at most 253 bytes, then the suffix: a record is at most 257 bytes.
export const MAX_RECORD = MAX_KEY + 4;
const TAG = /^[A-Za-z0-9._-]{1,64}$/;
const PARAMS: readonly string[] = ["blocks", "rows", "per", "tag"];
const JSON_TYPE = "application/json; charset=utf-8";
const U32_MAX = 0xffff_ffff;

export const samplePackKey = (per: number): string => `${SAMPLE_PREFIX}per-${per}.pack`;

export interface SampleHead {
  readonly per: number;
  readonly blocks: number;
  readonly records: number;
  readonly bytes: number;
}

export interface SampleEntry {
  readonly offset: number;
  readonly packed: number;
  readonly raw: number;
  readonly records: number;
  readonly crcThrough: number;
}

// The most packed bytes a table entry may name for `raw` bytes. Deflate can
// always store bytes as they are, in stored blocks of at most 65,535 bytes with
// 5 bytes of header each (RFC 1951 section 3.2.4); this bound leaves room above
// that. It refuses a corrupt length before the read, never a real block.
const packedBound = (raw: number): number => raw + Math.floor(raw / 256) + 64;

const fault = (message: string): ProbeError => new ProbeError(500, message);

export const hex32 = (value: number): string => (value >>> 0).toString(16).padStart(8, "0");

// ---- the CRC-32 of zlib (polynomial 0xedb88320), continued as zlib's crc32(data, value) continues it

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ---- the head and the table

function putU32(view: DataView, at: number, value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) throw new RangeError(`${name} ${value} does not fit in 32 bits`);
  view.setUint32(at, value, true);
}

// The head and the table of a sample pack. The writer's side of the layout:
// make-sample-pack.mjs calls it, and readSampleHead and readSampleEntries are
// its reader.
export function writeSampleHead(head: SampleHead, entries: readonly SampleEntry[]): Uint8Array<ArrayBuffer> {
  if (entries.length !== head.blocks) throw new RangeError(`the head names ${head.blocks} blocks and the table holds ${entries.length}`);
  const out = new Uint8Array(HEAD_BYTES + ENTRY_BYTES * entries.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < SAMPLE_MAGIC.length; i += 1) out[i] = SAMPLE_MAGIC.charCodeAt(i);
  out[4] = SAMPLE_VERSION;
  out[5] = CODEC_DEFLATE_RAW;
  putU32(view, 8, head.per, "per");
  putU32(view, 12, head.blocks, "blocks");
  putU32(view, 16, head.records, "records");
  putU32(view, 20, head.bytes, "bytes");
  entries.forEach((entry, i) => {
    const at = HEAD_BYTES + i * ENTRY_BYTES;
    putU32(view, at, entry.offset, `block ${i} offset`);
    putU32(view, at + 4, entry.packed, `block ${i} packed bytes`);
    putU32(view, at + 8, entry.raw, `block ${i} raw bytes`);
    putU32(view, at + 12, entry.records, `block ${i} records`);
    putU32(view, at + 16, entry.crcThrough, `block ${i} crc`);
  });
  return out;
}

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// The head of a sample pack, every field checked. A fault is a 500: the
// sample is the probe's own data.
export function readSampleHead(bytes: Uint8Array, name: string): SampleHead {
  if (bytes.byteLength < HEAD_BYTES) throw fault(`${name}: ${bytes.byteLength} B is shorter than the ${HEAD_BYTES} B head`);
  for (let i = 0; i < SAMPLE_MAGIC.length; i += 1) if (bytes[i] !== SAMPLE_MAGIC.charCodeAt(i)) throw fault(`${name} does not start with ${SAMPLE_MAGIC}`);
  if (bytes[4] !== SAMPLE_VERSION) throw fault(`${name} is version ${bytes[4]}, not ${SAMPLE_VERSION}`);
  if (bytes[5] !== CODEC_DEFLATE_RAW) throw fault(`${name} names codec ${bytes[5]}, not ${CODEC_DEFLATE_RAW} (deflate-raw)`);
  for (const at of [6, 7, 24, 25, 26, 27, 28, 29, 30, 31]) if (bytes[at] !== 0) throw fault(`${name}: head byte ${at} is ${bytes[at]}, not 0`);
  const view = viewOf(bytes);
  const head: SampleHead = { per: view.getUint32(8, true), blocks: view.getUint32(12, true), records: view.getUint32(16, true), bytes: view.getUint32(20, true) };
  if (!BLOCK_SIZES.includes(head.per)) throw fault(`${name} holds blocks of ${head.per} records, not one of ${BLOCK_SIZES.join(", ")}`);
  if (head.blocks < 1) throw fault(`${name} holds no block`);
  if (head.records <= (head.blocks - 1) * head.per || head.records > head.blocks * head.per)
    throw fault(`${name}: ${head.records} records do not fill ${head.blocks} blocks of ${head.per} with only the last one short`);
  if (head.bytes < HEAD_BYTES + ENTRY_BYTES * head.blocks + head.blocks) throw fault(`${name}: ${head.bytes} B cannot hold the head, the table and ${head.blocks} blocks`);
  return head;
}

// The first `count` entries of the table, each checked against the head and
// the entry before it: the blocks tile the object from the end of the table,
// every block but the last holds `per` records, and no length passes its bound.
export function readSampleEntries(bytes: Uint8Array, head: SampleHead, count: number, name: string): SampleEntry[] {
  if (count < 1 || count > head.blocks) throw fault(`${name}: ${count} entries asked of a table of ${head.blocks}`);
  if (bytes.byteLength < HEAD_BYTES + ENTRY_BYTES * count) throw fault(`${name}: ${bytes.byteLength} B hold fewer than ${count} table entries`);
  const view = viewOf(bytes);
  const entries: SampleEntry[] = [];
  let expect = HEAD_BYTES + ENTRY_BYTES * head.blocks;
  for (let i = 0; i < count; i += 1) {
    const at = HEAD_BYTES + i * ENTRY_BYTES;
    const entry: SampleEntry = {
      offset: view.getUint32(at, true),
      packed: view.getUint32(at + 4, true),
      raw: view.getUint32(at + 8, true),
      records: view.getUint32(at + 12, true),
      crcThrough: view.getUint32(at + 16, true),
    };
    const label = `${name} block ${i}`;
    if (entry.offset !== expect) throw fault(`${label} starts at ${entry.offset}, not at ${expect} where the block before it ends`);
    const last = i === head.blocks - 1;
    if (entry.records < 1 || entry.records > head.per || (!last && entry.records !== head.per)) throw fault(`${label} holds ${entry.records} records in blocks of ${head.per}`);
    if (entry.raw < 3 * entry.records || entry.raw > MAX_RECORD * entry.records) throw fault(`${label}: ${entry.raw} raw bytes cannot hold ${entry.records} records`);
    if (entry.packed < 1 || entry.packed > packedBound(entry.raw)) throw fault(`${label}: ${entry.packed} packed bytes for ${entry.raw} raw bytes`);
    expect = entry.offset + entry.packed;
    if (expect > head.bytes || (last && expect !== head.bytes)) throw fault(`${label} ends at ${expect} in an object of ${head.bytes} B`);
    entries.push(entry);
  }
  return entries;
}

// ---- one block

// The shape both type sets (Node's and the Workers runtime's) give DecompressionStream.
interface ByteTransform {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<ArrayBuffer | ArrayBufferView>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// One block inflated with DecompressionStream("deflate-raw") into exactly `raw`
// bytes. The bytes that arrive are counted: a block that inflates past `raw`
// is cancelled there, and one that ends short is refused.
export async function inflateBlock(packed: Uint8Array<ArrayBuffer>, raw: number, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(raw);
  const transform: ByteTransform = new DecompressionStream("deflate-raw");
  const reader = new Blob([packed]).stream().pipeThrough(transform).getReader();
  let at = 0;
  for (;;) {
    const chunk = await reader.read().catch((err: unknown) => {
      throw fault(`${label} does not inflate: ${errorText(err)}`);
    });
    if (chunk.done) break;
    if (at + chunk.value.byteLength > raw) {
      // The refusal below is the outcome: a failed cancel adds nothing to it.
      await reader.cancel().catch(() => undefined);
      throw fault(`${label} inflates past the ${raw} raw bytes of its table entry`);
    }
    out.set(chunk.value, at);
    at += chunk.value.byteLength;
  }
  if (at !== raw) throw fault(`${label} inflates to ${at} bytes, its table entry says ${raw}`);
  return out;
}

// Called once a record, with the key's bytes in key[0, length). The array is
// reused: a visitor that keeps a key copies it.
export type RecordVisitor = (key: Uint8Array, length: number, flags: number) => void;

export interface BlockScan {
  readonly records: number;
  readonly first: string;
  readonly last: string;
}

export const latin1 = (bytes: Uint8Array, length: number): string => String.fromCharCode(...bytes.subarray(0, length));

// Walks the records of one raw block, rebuilding each key in place. Every
// record is checked: a varint ends inside the block and within 5 bytes, the
// first record shares nothing, no record shares more than the key before it
// holds, flags is 1, 2 or 3, the suffix lies inside the block, a key is at most
// MAX_KEY bytes, and each key is above the one before it.
export function scanBlock(raw: Uint8Array, label: string, visit: RecordVisitor | null = null): BlockScan {
  const key = new Uint8Array(MAX_KEY);
  let length = 0;
  let pos = 0;
  let records = 0;
  let first = "";
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      if (pos >= raw.length) throw fault(`${label}: record ${records + 1} ends inside a varint`);
      const byte = raw[pos++];
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw fault(`${label}: record ${records + 1} has a varint longer than 5 bytes`);
  };
  while (pos < raw.length) {
    const shared = varint();
    const word = varint();
    const suffix = Math.floor(word / 4);
    const flags = word % 4;
    const n = records + 1;
    if (records === 0 && shared !== 0) throw fault(`${label}: its first record shares ${shared} bytes`);
    if (shared > length) throw fault(`${label}: record ${n} shares ${shared} bytes of a ${length} B key`);
    if (flags === 0) throw fault(`${label}: record ${n} has flags 0`);
    if (suffix === 0) throw fault(`${label}: record ${n} adds no byte to the key before it`);
    if (shared + suffix > MAX_KEY) throw fault(`${label}: record ${n} is a ${shared + suffix} B key`);
    if (pos + suffix > raw.length) throw fault(`${label}: record ${n} runs past the block`);
    if (records > 0 && shared < length && raw[pos] <= key[shared]) throw fault(`${label}: record ${n} is not above the key before it`);
    key.set(raw.subarray(pos, pos + suffix), shared);
    length = shared + suffix;
    pos += suffix;
    if (records === 0) first = latin1(key, length);
    records = n;
    if (visit !== null) visit(key, length, flags);
  }
  if (records === 0) throw fault(`${label} holds no record`);
  return { records, first, last: latin1(key, length) };
}

// ---- the route

export interface DecodeQuery {
  readonly mode: "blocks" | "rows";
  readonly per: number;
  // The blocks read: N, or the ceil(R / P) that hold R rows.
  readonly blocks: number;
  readonly rows: number | null;
  readonly tag: string | null;
}

function wholeNumber(text: string, name: string, min: number, max: number): number {
  if (!/^\d{1,6}$/.test(text)) throw new ProbeError(400, `${name} must be a whole number`);
  const value = Number(text);
  if (value < min || value > max) throw new ProbeError(400, `${name} must be ${min} to ${max}`);
  return value;
}

export function parseDecodeQuery(url: URL): DecodeQuery {
  const params = url.searchParams;
  for (const name of params.keys()) if (!PARAMS.includes(name)) throw new ProbeError(400, `/decode takes blocks or rows, per and tag, not ${name}`);
  for (const name of PARAMS) if (params.getAll(name).length > 1) throw new ProbeError(400, `${name} is given more than once`);
  const blocksText = params.get("blocks");
  const rowsText = params.get("rows");
  if ((blocksText === null) === (rowsText === null)) throw new ProbeError(400, "give exactly one of blocks and rows");
  const perText = params.get("per");
  const per = perText === null ? DEFAULT_PER : wholeNumber(perText, "per", 1, 65_536);
  if (!BLOCK_SIZES.includes(per)) throw new ProbeError(400, `per must be one of ${BLOCK_SIZES.join(", ")}`);
  const tag = params.get("tag");
  if (tag !== null && !TAG.test(tag)) throw new ProbeError(400, "tag must be 1 to 64 characters of A-Z, a-z, 0-9, dot, underscore and hyphen");
  if (blocksText !== null) return { mode: "blocks", per, blocks: wholeNumber(blocksText, "blocks", 1, MAX_BLOCKS), rows: null, tag };
  const rows = wholeNumber(rowsText as string, "rows", 1, MAX_ROWS);
  return { mode: "rows", per, blocks: Math.ceil(rows / per), rows, tag };
}

interface Range {
  readonly bytes: Uint8Array<ArrayBuffer>;
  // The whole object's size, as R2 reports it.
  readonly size: number;
}

async function readRange(bucket: ProbeBucket, key: string, offset: number, length: number): Promise<Range> {
  if (bucket.get === undefined) throw fault("the PROBE binding has no get(): it is not an R2 bucket");
  const object = await bucket.get(key, { range: { offset, length } });
  if (object === null) throw new ProbeError(503, `${key} is not in the bucket: upload the sample pack that scripts/measure/make-sample-pack.mjs writes (DOM-008)`);
  return { bytes: new Uint8Array(await object.arrayBuffer()), size: object.size };
}

interface Sample {
  readonly head: SampleHead;
  readonly entries: readonly SampleEntry[];
  // Blocks 0 to count-1, back to back, from entries[0].offset.
  readonly packed: Uint8Array<ArrayBuffer>;
}

// Blocks 0 to count-1 of a pack, in two ranged gets: the head with the first
// `count` table entries, then the blocks. Each range is counted as it arrives.
async function readSample(bucket: ProbeBucket, key: string, per: number, count: number): Promise<Sample> {
  const tableEnd = HEAD_BYTES + ENTRY_BYTES * count;
  const first = await readRange(bucket, key, 0, tableEnd);
  const head = readSampleHead(first.bytes, key);
  if (head.per !== per) throw fault(`${key} holds blocks of ${head.per} records, not ${per}`);
  if (head.bytes !== first.size) throw fault(`${key}: its head says ${head.bytes} B and R2 holds ${first.size} B`);
  if (count > head.blocks) throw new ProbeError(400, `${key} holds ${head.blocks} blocks, fewer than the ${count} asked for`);
  if (first.bytes.byteLength !== tableEnd) throw new ProbeError(502, `R2 answered ${first.bytes.byteLength} B for the first ${tableEnd} B of ${key}`);
  const entries = readSampleEntries(first.bytes, head, count, key);
  const base = entries[0].offset;
  const lastEntry = entries[entries.length - 1];
  const length = lastEntry.offset + lastEntry.packed - base;
  const second = await readRange(bucket, key, base, length);
  if (second.bytes.byteLength !== length) throw new ProbeError(502, `R2 answered ${second.bytes.byteLength} B for the ${length} B of blocks 0 to ${count - 1} of ${key}`);
  if (second.size !== head.bytes) throw fault(`${key} changed size between two reads: ${head.bytes} B, then ${second.size} B`);
  return { head, entries, packed: second.bytes };
}

interface Decoded {
  readonly names: number;
  readonly packedBytes: number;
  readonly rawBytes: number;
  readonly crc: number;
  readonly first: string;
  readonly last: string;
}

// Inflates, checks and scans each block of the sample in turn. The CRC-32 runs
// on through the blocks, so block i is checked against the table's CRC through
// block i; keys ascend across blocks as within one.
export async function decodeSample(sample: Sample, key: string, visit: RecordVisitor | null): Promise<Decoded> {
  const base = sample.entries[0].offset;
  let crc = 0;
  let names = 0;
  let packedBytes = 0;
  let rawBytes = 0;
  let first = "";
  let last = "";
  for (const [i, entry] of sample.entries.entries()) {
    const label = `${key} block ${i}`;
    const raw = await inflateBlock(sample.packed.subarray(entry.offset - base, entry.offset - base + entry.packed), entry.raw, label);
    crc = crc32(raw, crc);
    if (crc !== entry.crcThrough) throw fault(`${label}: the CRC-32 through it is ${hex32(crc)}, the table says ${hex32(entry.crcThrough)}`);
    const scan = scanBlock(raw, label, visit);
    if (scan.records !== entry.records) throw fault(`${label} holds ${scan.records} records, its table entry says ${entry.records}`);
    if (i > 0 && !(scan.first > last)) throw fault(`${label} starts at a key that is not above the last key of the block before it`);
    if (i === 0) first = scan.first;
    last = scan.last;
    names += scan.records;
    packedBytes += entry.packed;
    rawBytes += raw.byteLength;
  }
  return { names, packedBytes, rawBytes, crc, first, last };
}

export interface Row {
  // The name with its labels in DNS order: the key np.com.example.api is api.example.com.np.
  readonly name: string;
  readonly exact: boolean;
  readonly wildcard: boolean;
}

export const dnsOrder = (key: string): string => key.split(".").reverse().join(".");

function answer(body: Record<string, unknown>): Response {
  return new Response(`${JSON.stringify(body)}\n`, { status: 200, headers: { "content-type": JSON_TYPE, "cache-control": "no-store" } });
}

async function decodeRouteHandle(_request: Request, env: Env, url: URL, now: () => number): Promise<Response> {
  const query = parseDecodeQuery(url);
  const key = samplePackKey(query.per);
  const started = now();
  const sample = await readSample(env.PROBE, key, query.per, query.blocks);
  const read = now();
  const limit = query.rows ?? 0;
  const rows: Row[] = [];
  const visit: RecordVisitor | null =
    query.rows === null
      ? null
      : (bytes, length, flags) => {
          if (rows.length < limit) rows.push({ name: dnsOrder(latin1(bytes, length)), exact: (flags & 1) !== 0, wildcard: (flags & 2) !== 0 });
        };
  const decoded = await decodeSample(sample, key, visit);
  const done = now();
  const body: Record<string, unknown> = {
    entry: DECODE_ENTRY,
    mode: query.mode,
    key,
    codec: "deflate-raw",
    per: query.per,
    blocks: query.blocks,
    names: decoded.names,
    packed_bytes: decoded.packedBytes,
    raw_bytes: decoded.rawBytes,
    crc32: hex32(decoded.crc),
    crc32_of: `the inflated bytes of blocks 0 to ${query.blocks - 1}, read as one stream`,
    first_key: decoded.first,
    last_key: decoded.last,
    read_from: `R2 binding PROBE: 2 ranged gets of ${key}`,
    wall_ms: { r2: read - started, decode: done - read },
    clock:
      "wall_ms are Date.now() differences: deployed, the clock moves only across I/O (Cloudflare's documentation), and locally it moves regardless; wall time, never CPU time. The platform reports CPU time per invocation.",
    tag: query.tag,
  };
  if (query.rows !== null) {
    body.rows_count = rows.length;
    body.row_fields = "name in DNS order, exact and wildcard: the sample's own fields";
    body.rows = rows;
  }
  return answer(body);
}

export const decodeRoute: Route = {
  method: "GET",
  path: "/decode",
  entry: DECODE_ENTRY,
  summary: `DOM-008's decode: blocks=N (1 to ${MAX_BLOCKS}) blocks of per=1024|4096|16384 names (default ${DEFAULT_PER}) of the sample pack under ${SAMPLE_PREFIX} in R2, each inflated with DecompressionStream deflate-raw, checked against its CRC-32 and scanned, answered as a count and a CRC-32; rows=R (1 to ${MAX_ROWS}) answers the first R names as JSON rows; tag=T is echoed. CPU time is the platform's, per invocation, and is not in the answer`,
  handle: decodeRouteHandle,
};
