// packages/pack/src/writer.ts — the one writer of packs.
//
//   const writer = new PackWriter({ codec: NAMES_CODEC, compress, sink });
//   for (const record of records) await writer.add(record);
//   const summary = await writer.finish();   // the index bytes, the parts, the SHA-256
//
// Records arrive in ascending key order; a key that is not above the one
// before it is refused ("order"), and so is a key longer than the codec's
// maxKeyBytes ("record"). The writer fills a block of
// `recordsPerBlock` records, hashes the raw block into the decoded digest,
// computes its CRC-32, compresses it with `compress`, and hands the bytes to
// the sink with their part number. A part ends before the block that would
// carry it past `partLimit`; a block that does not fit in an empty part is
// refused ("span"), so a block never spans parts. A block whose raw bytes or
// whose keys, each counted whole, pass 16 MiB is refused ("span"): the reader
// refuses both. finish() writes the last block and returns the index, which it
// parses back before it returns.
//
// `compress` is the codec of the blocks, given by the caller. This module
// imports nothing from `node:`; packages/pack/node gives the production one,
// node:zlib at level 9 (docs/format.md section 8). After a refusal the writer
// refuses every later call, so a caller cannot go on and finish a pack with a
// hole in it.
import { ByteWriter, checkKey, MAX_KEY_BYTES, MAX_SAFE } from "./bytes.ts";
import type { DatasetCodec } from "./codec.ts";
import { crc32 } from "./crc32.ts";
import { PackError } from "./errors.ts";
import {
  ANNOTATIONS,
  CODEC_FORMATS,
  DATASET_FEED_TIME,
  DATASET_LABELS,
  DATASET_NEW_NAME_TIME,
  DEFAULT_CODEC,
  DEFAULT_PAGE_ENTRIES,
  DEFAULT_PART_LIMIT,
  DEFAULT_RECORDS_PER_BLOCK,
  encodePartHeader,
  MAX_BLOCK_KEY_BYTES,
  MAX_PAGE_ENTRIES,
  MAX_PARTS,
  MAX_RAW_BLOCK_BYTES,
  MAX_RECORDS_PER_BLOCK,
  PART_HEADER_BYTES,
  packedLimit,
} from "./format.ts";
import { type BlockEntry, encodeIdx, type PartEntry } from "./idx.ts";
import { Sha256 } from "./sha256.ts";

// Compresses one raw block with the codec byte `codec`.
export type Compress = (codec: number, raw: Uint8Array) => Uint8Array | Promise<Uint8Array>;

// Receives the bytes of the parts in order: the header of part 0, its blocks,
// then the header of part 1, and so on. A write to a new part number ends the
// part before it.
export interface PackSink {
  write(part: number, bytes: Uint8Array): void | Promise<void>;
}

export interface WriterOptions<R> {
  readonly codec: DatasetCodec<R>;
  readonly compress: Compress;
  readonly sink: PackSink;
  readonly recordsPerBlock?: number;
  // The codec byte of the blocks: 1 deflate-raw, 2 gzip.
  readonly blockCodec?: number;
  readonly partLimit?: number;
  readonly pageEntries?: number;
}

export interface PackSummary {
  readonly dataset: number;
  readonly codec: number;
  readonly recordsPerBlock: number;
  readonly pageEntries: number;
  readonly records: number;
  readonly blocks: number;
  readonly parts: readonly PartEntry[];
  readonly entries: readonly BlockEntry[];
  readonly idx: Uint8Array<ArrayBuffer>;
  // The SHA-256 of the raw blocks concatenated in order, as hex.
  readonly sha256: string;
  readonly rawBytes: number;
  // The bytes of every part, headers included.
  readonly partBytes: number;
  // The bytes of every part and the index.
  readonly bytes: number;
  readonly keyMin: string | null;
  readonly keyMax: string | null;
}

const usage = (message: string): PackError => new PackError("usage", message);

function wholeIn(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw usage(`${name} must be a whole number of ${min} to ${max}, not ${String(value)}`);
  return value;
}

export class PackWriter<R> {
  readonly #codec: DatasetCodec<R>;
  readonly #compress: Compress;
  readonly #sink: PackSink;
  readonly #perBlock: number;
  readonly #blockCodec: number;
  readonly #partLimit: number;
  readonly #pageEntries: number;
  readonly #raw = new ByteWriter(64 * 1024);
  readonly #sha = new Sha256();
  readonly #entries: BlockEntry[] = [];
  readonly #parts: { bytes: number; firstBlock: number; blocks: number }[] = [];
  #inBlock = 0;
  #blockKeyBytes = 0;
  #blockKey = "";
  #prev: R | null = null;
  #prevKey: string | null = null;
  #records = 0;
  #rawBytes = 0;
  #keyMin: string | null = null;
  #state: "open" | "busy" | "failed" | "finished" = "open";

  constructor(options: WriterOptions<R>) {
    if (options.codec === undefined || typeof options.codec.encodeRecord !== "function") throw usage("a PackWriter needs a dataset codec");
    if (typeof options.compress !== "function") throw usage("a PackWriter needs a compress function");
    if (options.sink === undefined || typeof options.sink.write !== "function") throw usage("a PackWriter needs a sink");
    wholeIn(options.codec.id, 1, 255, "the dataset id");
    wholeIn(options.codec.maxKeyBytes, 1, MAX_KEY_BYTES, "the codec's maxKeyBytes");
    this.#codec = options.codec;
    this.#compress = options.compress;
    this.#sink = options.sink;
    this.#perBlock = wholeIn(options.recordsPerBlock ?? DEFAULT_RECORDS_PER_BLOCK, 1, MAX_RECORDS_PER_BLOCK, "recordsPerBlock");
    this.#blockCodec = options.blockCodec ?? DEFAULT_CODEC;
    if (CODEC_FORMATS[this.#blockCodec] === undefined) throw new PackError("codec", `blockCodec ${this.#blockCodec} is not 1 (deflate-raw) or 2 (gzip)`);
    this.#partLimit = wholeIn(options.partLimit ?? DEFAULT_PART_LIMIT, PART_HEADER_BYTES + 1, MAX_SAFE, "partLimit");
    this.#pageEntries = wholeIn(options.pageEntries ?? DEFAULT_PAGE_ENTRIES, 1, MAX_PAGE_ENTRIES, "pageEntries");
  }

  // Runs one step, then leaves the writer in `after`; a throw leaves it failed
  // for good.
  async #step<T>(fn: () => Promise<T>, after: "open" | "finished" = "open"): Promise<T> {
    if (this.#state !== "open") throw usage(this.#state === "busy" ? "the writer is called again before its last call settled" : `the writer is ${this.#state}`);
    this.#state = "busy";
    try {
      const value = await fn();
      this.#state = after;
      return value;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  add(record: R): Promise<void> {
    return this.#step(async () => {
      const key = this.#codec.key(record);
      checkKey(key, "a record key");
      if (key.length > this.#codec.maxKeyBytes)
        throw new PackError("record", `record ${this.#records + 1}: its key is ${key.length} bytes, above the ${this.#codec.maxKeyBytes} of dataset ${this.#codec.name}`);
      if (this.#prevKey !== null && !(key > this.#prevKey)) throw new PackError("order", `record ${this.#records + 1}: its key is not above the key before it`);
      if (this.#inBlock === 0) {
        const idxKey = this.#codec.idxKey(record);
        checkKey(idxKey, "an index key");
        const last = this.#entries[this.#entries.length - 1];
        if (last !== undefined && idxKey < last.key) throw new PackError("order", `record ${this.#records + 1}: its index key is below the index key of the block before it`);
        this.#blockKey = idxKey;
      }
      this.#codec.encodeRecord(this.#inBlock === 0 ? null : this.#prev, record, this.#raw);
      if (this.#raw.length > MAX_RAW_BLOCK_BYTES)
        throw new PackError("span", `block ${this.#entries.length} passes ${MAX_RAW_BLOCK_BYTES} raw bytes at record ${this.#records + 1}: write fewer records a block`);
      this.#blockKeyBytes += key.length;
      if (this.#blockKeyBytes > MAX_BLOCK_KEY_BYTES)
        throw new PackError("span", `the keys of block ${this.#entries.length} pass ${MAX_BLOCK_KEY_BYTES} bytes at record ${this.#records + 1}: write fewer records a block`);
      this.#prev = record;
      this.#prevKey = key;
      this.#keyMin ??= key;
      this.#inBlock += 1;
      this.#records += 1;
      if (this.#inBlock === this.#perBlock) await this.#flush();
    });
  }

  async #startPart(): Promise<void> {
    const part = this.#parts.length;
    if (part >= MAX_PARTS) throw new PackError("span", `a pack holds at most ${MAX_PARTS} parts`);
    const firstBlock = this.#entries.length;
    this.#parts.push({ bytes: PART_HEADER_BYTES, firstBlock, blocks: 0 });
    await this.#sink.write(part, encodePartHeader({ dataset: this.#codec.id, recordsPerBlock: this.#perBlock, part, codec: this.#blockCodec }));
  }

  async #flush(): Promise<void> {
    const raw = this.#raw.take();
    const crc = crc32(raw);
    this.#sha.update(raw);
    const packed = await this.#compress(this.#blockCodec, raw);
    if (!(packed instanceof Uint8Array) || packed.length < 1 || packed.length > packedLimit(raw.length))
      throw usage(`compress gave ${packed instanceof Uint8Array ? packed.length : "no"} B for block ${this.#entries.length} of ${raw.length} raw bytes, not 1 to ${packedLimit(raw.length)}`);
    if (this.#parts.length === 0) await this.#startPart();
    let part = this.#parts[this.#parts.length - 1];
    if (part.bytes + packed.length > this.#partLimit && part.blocks > 0) {
      await this.#startPart();
      part = this.#parts[this.#parts.length - 1];
    }
    // The one guard of the part limit: an empty part that cannot take the block.
    if (part.bytes + packed.length > this.#partLimit)
      throw new PackError("span", `block ${this.#entries.length} is ${packed.length} B and does not fit in a part of at most ${this.#partLimit} B with its ${PART_HEADER_BYTES} B header`);
    const entry: BlockEntry = {
      index: this.#entries.length,
      key: this.#blockKey,
      part: this.#parts.length - 1,
      offset: part.bytes,
      packed: packed.length,
      raw: raw.length,
      records: this.#inBlock,
      crc,
    };
    await this.#sink.write(entry.part, packed);
    part.bytes += packed.length;
    part.blocks += 1;
    this.#entries.push(entry);
    this.#rawBytes += raw.length;
    this.#raw.reset();
    this.#inBlock = 0;
    this.#blockKeyBytes = 0;
    this.#prev = null;
  }

  finish(): Promise<PackSummary> {
    return this.#step(async () => {
      if (this.#inBlock > 0) await this.#flush();
      if (this.#parts.length === 0) await this.#startPart();
      const parts = this.#parts.map((p) => ({ ...p }));
      const idx = encodeIdx({
        dataset: this.#codec.id,
        codec: this.#blockCodec,
        recordsPerBlock: this.#perBlock,
        pageEntries: this.#pageEntries,
        records: this.#records,
        parts,
        keyMin: this.#keyMin,
        keyMax: this.#prevKey,
        entries: this.#entries,
      });
      const partBytes = parts.reduce((sum, p) => sum + p.bytes, 0);
      const summary: PackSummary = {
        dataset: this.#codec.id,
        codec: this.#blockCodec,
        recordsPerBlock: this.#perBlock,
        pageEntries: this.#pageEntries,
        records: this.#records,
        blocks: this.#entries.length,
        parts,
        entries: [...this.#entries],
        idx,
        sha256: this.#sha.hex(),
        rawBytes: this.#rawBytes,
        partBytes,
        bytes: partBytes + idx.length,
        keyMin: this.#keyMin,
        keyMax: this.#prevKey,
      };
      return summary;
    }, "finished");
  }
}

// Every record of an iterable into one pack.
export async function writePack<R>(records: Iterable<R> | AsyncIterable<R>, options: WriterOptions<R>): Promise<PackSummary> {
  const writer = new PackWriter(options);
  for await (const record of records) await writer.add(record);
  return writer.finish();
}

// A sink that keeps the parts in memory, for tests and small packs.
export class MemorySink implements PackSink {
  readonly #parts: Uint8Array[][] = [];

  write(part: number, bytes: Uint8Array): void {
    if (part !== this.#parts.length - 1 && part !== this.#parts.length) throw usage(`part ${part} written after part ${this.#parts.length - 1}`);
    if (part === this.#parts.length) this.#parts.push([]);
    this.#parts[part].push(bytes.slice());
  }

  // Each part as one array.
  parts(): Uint8Array<ArrayBuffer>[] {
    return this.#parts.map((chunks) => {
      const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    });
  }
}

// The OCI annotations of docs/format.md section 8 for a written pack.
// `writer` names the runtime that compressed it (packages/pack/node writerId).
export function packAnnotations(summary: PackSummary, writer: string): Record<string, string> {
  const dataset = DATASET_LABELS[summary.dataset];
  if (dataset === undefined) throw usage(`dataset ${summary.dataset} has no annotation name`);
  // A time copy rides in the manifest of its key copy, whose annotations
  // describe the key copy alone (docs/format.md section 14).
  if (summary.dataset === DATASET_FEED_TIME || summary.dataset === DATASET_NEW_NAME_TIME) throw usage(`dataset ${summary.dataset} (${dataset}) is a time copy, which has no manifest of its own`);
  if (writer.length === 0) throw usage("the writer annotation is empty");
  return {
    [ANNOTATIONS.dataset]: dataset,
    [ANNOTATIONS.count]: String(summary.records),
    [ANNOTATIONS.bytes]: String(summary.bytes),
    [ANNOTATIONS.sha256]: summary.sha256,
    [ANNOTATIONS.writer]: writer,
  };
}
