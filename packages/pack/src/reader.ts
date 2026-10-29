// packages/pack/src/reader.ts — the one reader of packs, in Node and in workerd.
//
//   const reader = await PackReader.open(idxSource, partsSource);   // the codec of the index's dataset
//   await reader.get("com.example.www");                            // a record, or null
//   for await (const r of reader.scan("com.example.", "com.example/")) ...
//
// A lookup reads one index page and one block by range (docs/format.md
// section 7). Each block read is checked before a record leaves it: the source
// answered exactly the compressed length ("short-read"); it decompresses to
// exactly its raw length ("inflate"); its CRC-32 matches the index ("crc");
// its records decode and fill it, and their keys add up to at most
// MAX_BLOCK_KEY_BYTES ("record"); their count matches ("count"); and the keys
// ascend and the block starts with its index key ("order").
//
// Decompression is DecompressionStream("deflate-raw") or ("gzip"), a Web API
// that Node and workerd both have, so this module imports nothing from `node:`.
// It holds one block at a time; the bytes a block inflates to are counted as
// they arrive and the stream is cancelled past the raw length. Front coding
// lets a few raw bytes name a long key, so the keys a block decodes to are
// counted too, and a block whose keys pass the budget is refused.
//
// get, scan and blockOf search the index by comparing index keys bytewise,
// which finds the right block when the index key of a block is the key of its
// first record: the datasets 1, 2, 3, 5, 6 and 7. A codec whose index key is not its
// record key (dataset 4) searches with PackIndex and readBlock itself.
import { BUILTIN_CODECS, type DatasetCodec, type PackRecord } from "./codec.ts";
import { ByteReader } from "./bytes.ts";
import { crc32, hex32 } from "./crc32.ts";
import { errorText, PackError } from "./errors.ts";
import { CODEC_FORMATS, DATASET_LABELS, MAX_BLOCK_KEY_BYTES, MAX_RAW_BLOCK_BYTES } from "./format.ts";
import { type BlockEntry, checkPartSizes, type IndexOptions, PackIndex } from "./idx.ts";
import { type ByteSource, type RangeSource, readPart } from "./source.ts";

// The shape both type sets (Node's and the Workers runtime's) give
// DecompressionStream.
interface ByteTransform {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<ArrayBuffer | ArrayBufferView>;
}

// One compressed block decompressed into exactly `raw` bytes.
export async function inflate(codec: number, packed: Uint8Array, raw: number, label = "a block"): Promise<Uint8Array<ArrayBuffer>> {
  const format = CODEC_FORMATS[codec];
  if (format === undefined) throw new PackError("codec", `${label}: codec ${codec} is not 1 (deflate-raw) or 2 (gzip)`);
  const out = new Uint8Array(raw);
  const transform: ByteTransform = new DecompressionStream(format);
  // A Blob takes an ArrayBuffer-backed view; the copy is one block.
  const reader = new Blob([new Uint8Array(packed)]).stream().pipeThrough(transform).getReader();
  let at = 0;
  for (;;) {
    const chunk = await reader.read().catch((error: unknown) => {
      throw new PackError("inflate", `${label} does not decompress as ${format}: ${errorText(error)}`);
    });
    if (chunk.done) break;
    if (at + chunk.value.byteLength > raw) {
      // The refusal below is the outcome; a failed cancel adds nothing to it.
      await reader.cancel().catch(() => undefined);
      throw new PackError("inflate", `${label} decompresses past the ${raw} raw bytes of its index entry`);
    }
    out.set(chunk.value, at);
    at += chunk.value.byteLength;
  }
  if (at !== raw) throw new PackError("inflate", `${label} decompresses to ${at} bytes, its index entry says ${raw}`);
  return out;
}

export class PackReader<R> {
  readonly index: PackIndex;
  readonly source: RangeSource;
  readonly codec: DatasetCodec<R>;
  readonly maxRawBlockBytes: number;

  constructor(index: PackIndex, source: RangeSource, codec: DatasetCodec<R>, maxRawBlockBytes: number = MAX_RAW_BLOCK_BYTES) {
    if (codec.id !== index.header.dataset) throw new PackError("dataset", `the index is dataset ${index.header.dataset} and the codec ${codec.name} is dataset ${codec.id}`);
    if (!Number.isSafeInteger(maxRawBlockBytes) || maxRawBlockBytes < 1 || maxRawBlockBytes > MAX_RAW_BLOCK_BYTES)
      throw new PackError("usage", `maxRawBlockBytes is ${maxRawBlockBytes}, not 1 to ${MAX_RAW_BLOCK_BYTES}`);
    this.index = index;
    this.source = source;
    this.codec = codec;
    this.maxRawBlockBytes = maxRawBlockBytes;
  }

  // A reader of a pack. Without a codec it takes the codec this package ships
  // for the index's dataset, and refuses a dataset it has none for. With
  // options.partSizes (the layer sizes the store gives) it refuses an index
  // whose parts table states other sizes, before any block is read. With
  // options.maxRawBlockBytes it reads no block whose raw length is above it.
  static async open<R>(idx: PackIndex | ByteSource | Uint8Array, source: RangeSource, codec: DatasetCodec<R>, options?: IndexOptions): Promise<PackReader<R>>;
  static async open(idx: PackIndex | ByteSource | Uint8Array, source: RangeSource, codec?: undefined, options?: IndexOptions): Promise<PackReader<PackRecord>>;
  static async open<R>(idx: PackIndex | ByteSource | Uint8Array, source: RangeSource, codec?: DatasetCodec<R>, options?: IndexOptions): Promise<PackReader<R | PackRecord>> {
    const index = idx instanceof PackIndex ? idx : await PackIndex.open(idx, options);
    if (idx instanceof PackIndex && options?.partSizes !== undefined) checkPartSizes(index.head, options.partSizes);
    const maxRaw = options?.maxRawBlockBytes ?? MAX_RAW_BLOCK_BYTES;
    if (codec !== undefined) return new PackReader<R>(index, source, codec, maxRaw);
    const builtin = BUILTIN_CODECS.get(index.header.dataset);
    if (builtin === undefined)
      throw new PackError(
        "dataset",
        `the pack is dataset ${index.header.dataset} (${DATASET_LABELS[index.header.dataset] ?? "unknown"}); this reader ships codecs for 1, 2, 3, 5, 6 and 7 and was given none`,
      );
    // The reader only decodes: encodeRecord, the one member whose parameter
    // type differs between the three codecs, is never called through it.
    return new PackReader<PackRecord>(index, source, builtin as DatasetCodec<PackRecord>, maxRaw);
  }

  // The block that may hold `key`, or null when the key is below every block.
  async blockOf(key: string): Promise<BlockEntry | null> {
    return this.index.locateEntry(key);
  }

  // The raw bytes of one block, read by range and checked: length, inflate and
  // CRC-32. A block whose raw length is above maxRawBlockBytes is refused from
  // its index entry, before the read.
  async readBlock(entry: BlockEntry): Promise<Uint8Array<ArrayBuffer>> {
    const label = `block ${entry.index}`;
    if (entry.raw > this.maxRawBlockBytes) throw new PackError("page", `${label} has ${entry.raw} raw bytes, above the ${this.maxRawBlockBytes} this reader reads`);
    const packed = await readPart(this.source, entry.part, entry.offset, entry.packed, label);
    const raw = await inflate(this.index.header.codec, packed, entry.raw, label);
    const crc = crc32(raw);
    if (crc !== entry.crc) throw new PackError("crc", `${label}: the CRC-32 of its raw bytes is ${hex32(crc)}, the index says ${hex32(entry.crc)}`);
    return raw;
  }

  // The records of one raw block, checked: they decode, fill the block, match
  // its count, hold at most MAX_BLOCK_KEY_BYTES of keys, ascend, and start
  // with its index key.
  decodeBlock(raw: Uint8Array, entry: BlockEntry): R[] {
    const label = `block ${entry.index}`;
    const input = new ByteReader(raw, "record", label);
    const out: R[] = [];
    let prev: R | null = null;
    let prevKey = "";
    let keyBytes = 0;
    while (input.pos < input.end) {
      if (out.length === entry.records) throw new PackError("count", `${label} holds more than the ${entry.records} records of its index entry`);
      const record = this.codec.decodeRecord(prev, input);
      const key = this.codec.key(record);
      keyBytes += key.length;
      if (keyBytes > MAX_BLOCK_KEY_BYTES) throw new PackError("record", `${label}: its keys pass ${MAX_BLOCK_KEY_BYTES} bytes at record ${out.length + 1}`);
      if (prev !== null && !(key > prevKey)) throw new PackError("order", `${label}: record ${out.length + 1} is not above the record before it`);
      out.push(record);
      prev = record;
      prevKey = key;
    }
    if (out.length !== entry.records) throw new PackError("count", `${label} holds ${out.length} records, its index entry says ${entry.records}`);
    if (this.codec.idxKey(out[0]) !== entry.key) throw new PackError("order", `${label} does not start with its index key`);
    return out;
  }

  async records(entry: BlockEntry): Promise<R[]> {
    return this.decodeBlock(await this.readBlock(entry), entry);
  }

  // The record of `key`, or null. A key above the largest key of the pack
  // (the head's key bounds) is absent with no read.
  async get(key: string): Promise<R | null> {
    const max = this.index.head.keyMax;
    if (max === null || key > max) return null;
    const entry = await this.blockOf(key);
    if (entry === null) return null;
    const records = await this.records(entry);
    let lo = 0;
    let hi = records.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = this.codec.key(records[mid]);
      if (k === key) return records[mid];
      if (k < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  // The records with lo <= key < hi, ascending, one block held at a time. An
  // absent bound is open.
  async *scan(lo?: string, hi?: string): AsyncGenerator<R> {
    if (lo !== undefined && hi !== undefined && !(lo < hi)) return;
    const max = this.index.head.keyMax;
    if (max === null || (lo !== undefined && lo > max)) return;
    const blocks = this.index.header.blocks;
    let i = lo === undefined ? 0 : Math.max(0, await this.index.locate(lo));
    let lastKey: string | null = null;
    for (; i < blocks; i += 1) {
      const entry = await this.index.entry(i);
      if (hi !== undefined && entry.key >= hi) return;
      const records = await this.records(entry);
      if (lastKey !== null && !(this.codec.key(records[0]) > lastKey)) throw new PackError("order", `block ${entry.index} does not start above the last key of the block before it`);
      for (const record of records) {
        const key = this.codec.key(record);
        if (lo !== undefined && key < lo) continue;
        if (hi !== undefined && key >= hi) return;
        yield record;
      }
      lastKey = this.codec.key(records[records.length - 1]);
    }
  }
}
