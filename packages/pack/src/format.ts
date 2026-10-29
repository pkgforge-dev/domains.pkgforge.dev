// packages/pack/src/format.ts — the constants of DPK1 and the part header
// (docs/format.md sections 3 and 9).
//
// DEFAULT_RECORDS_PER_BLOCK and DEFAULT_CODEC are defaults of the writer, not of
// the format: the header of every part and of the index states the values a pack
// uses. DOM-008's verdict may change them; a pack written before still reads.
// vectors.test.ts holds the defaults table of docs/format.md equal to these.
import { ByteReader, ByteWriter } from "./bytes.ts";
import { PackError } from "./errors.ts";

export const PART_MAGIC = "DPK1";
export const IDX_MAGIC = "DPKI";
export const VERSION = 1;
export const PART_HEADER_BYTES = 16;

export const DATASET_NAMES = 1;
export const DATASET_DOMAINS = 2;
export const DATASET_FEED = 3;
export const DATASET_REV = 4;
export const DATASET_NEW_NAME = 5;
// The annotation value of each dataset id.
export const DATASET_LABELS: Readonly<Record<number, string>> = Object.freeze({ 1: "names", 2: "domains", 3: "feed", 4: "rev", 5: "new-name" });
// The longest key of the datasets whose key is a reversed name (1, 2, 3 and
// 5): a name is at most 253 bytes (docs/architecture.md section 3.1).
export const NAME_KEY_BYTES = 253;

export const CODEC_DEFLATE_RAW = 1;
export const CODEC_GZIP = 2;
// The DecompressionStream and CompressionStream format of each codec byte.
export const CODEC_FORMATS: Readonly<Record<number, "deflate-raw" | "gzip">> = Object.freeze({ 1: "deflate-raw", 2: "gzip" });

export const DEFAULT_RECORDS_PER_BLOCK = 4096;
export const DEFAULT_CODEC = CODEC_DEFLATE_RAW;
// A part is one GHCR layer: at most 1 GiB (docs/architecture.md section 4.4).
export const DEFAULT_PART_LIMIT = 2 ** 30;
export const DEFAULT_PAGE_ENTRIES = 64;
// A reader holds one raw block at a time; a Worker holds 128 MB.
export const MAX_RAW_BLOCK_BYTES = 16 * 1024 * 1024;
// The keys of one block, each counted whole, add up to at most this. Front
// coding stores a shared prefix once and a reader holds every key whole, so a
// small raw block can name far more key bytes than it holds.
export const MAX_BLOCK_KEY_BYTES = 16 * 1024 * 1024;
export const MAX_RECORDS_PER_BLOCK = 0xffff;
export const MAX_PAGE_ENTRIES = 0xffff;
// The parts field of the index is a u16, so part numbers run 0 to 65,534.
export const MAX_PARTS = 0xffff;

// The most compressed bytes a block of `raw` raw bytes may take: an encoder
// that cannot shrink a block stores it, and DEFLATE's fixed codes spend at most
// 9 bits a byte, so a sane encoder stays under raw + raw / 8, plus 1,024 bytes
// for the block and gzip headers. A reader refuses a larger claim before it
// reads, so an index cannot make it allocate gigabytes for a block.
export const packedLimit = (raw: number): number => raw + Math.floor(raw / 8) + 1024;

// The OCI annotations a pack's manifest carries for its content
// (docs/format.md section 8). packAnnotations builds them; a caller passes
// each to DOM-019's push tool with --annotation.
export const ANNOTATIONS = Object.freeze({
  dataset: "dev.pkgforge.domains.dataset",
  count: "dev.pkgforge.domains.count",
  bytes: "dev.pkgforge.domains.bytes",
  sha256: "dev.pkgforge.domains.sha256",
  writer: "dev.pkgforge.domains.writer",
});

// The layer title of part n: part.000, part.001, and up.
export const partTitle = (n: number): string => `part.${String(n).padStart(3, "0")}`;
export const IDX_TITLE = "idx";

export interface PartHeader {
  readonly dataset: number;
  readonly recordsPerBlock: number;
  readonly part: number;
  readonly codec: number;
}

export function checkMagic(bytes: Uint8Array, magic: string, what: string): void {
  for (let i = 0; i < magic.length; i += 1) if (bytes[i] !== magic.charCodeAt(i)) throw new PackError("magic", `${what} does not start with ${magic}`);
}

export function checkCodecByte(codec: number, what: string): void {
  if (CODEC_FORMATS[codec] === undefined) throw new PackError("codec", `${what} names codec ${codec}; this reader knows 1 (deflate-raw) and 2 (gzip)`);
}

export function encodePartHeader(header: PartHeader): Uint8Array<ArrayBuffer> {
  const out = new ByteWriter(PART_HEADER_BYTES);
  out.latin1(PART_MAGIC);
  out.u8(VERSION);
  out.u8(header.dataset);
  out.u16(header.recordsPerBlock);
  out.u16(header.part);
  out.u8(header.codec);
  for (let i = 0; i < 5; i += 1) out.u8(0);
  return out.take();
}

// The header of a part, every field checked. `bytes` holds at least its first
// PART_HEADER_BYTES bytes.
export function readPartHeader(bytes: Uint8Array, what = "a part"): PartHeader {
  if (bytes.length < PART_HEADER_BYTES) throw new PackError("header", `${what}: ${bytes.length} B is shorter than its ${PART_HEADER_BYTES} B header`);
  checkMagic(bytes, PART_MAGIC, what);
  const input = new ByteReader(bytes, "header", what, 4, PART_HEADER_BYTES);
  const version = input.u8();
  if (version !== VERSION) throw new PackError("version", `${what} is version ${version}; this reader knows ${VERSION}`);
  const dataset = input.u8();
  if (dataset === 0) throw new PackError("dataset", `${what} names dataset 0`);
  const recordsPerBlock = input.u16();
  if (recordsPerBlock === 0) throw new PackError("header", `${what} holds 0 records a block`);
  const part = input.u16();
  const codec = input.u8();
  checkCodecByte(codec, what);
  for (let at = 11; at < PART_HEADER_BYTES; at += 1) if (bytes[at] !== 0) throw new PackError("header", `${what}: reserved byte ${at} is ${bytes[at]}, not 0`);
  return { dataset, recordsPerBlock, part, codec };
}
