// packages/pack/src/idx.ts — the index layer of a pack (docs/format.md section 6).
//
//   encodeIdx(content)        the bytes of an index; it parses them back before it returns
//   parseHead(bytes, size)    the head: the header, the parts table, the key bounds, the top level
//   parsePage(head, p, bytes) the block entries of one page of the second level
//   readIdx(bytes)            the whole index held in memory, every page and the tiling checked
//   PackIndex                 the index read by range: the head once, then one page a lookup
//
// The head carries a CRC-32 of itself, and each top-level entry the CRC-32 of
// its page, so a reader that reads one page by range from a signed URL checks
// it before it trusts an offset in it. Every field is checked against its
// range and against the fields it must agree with; a check that fails throws
// PackError with the code of docs/format.md section 6.6.
import { ByteReader, ByteWriter, MAX_SAFE } from "./bytes.ts";
import { crc32 } from "./crc32.ts";
import { PackError } from "./errors.ts";
import {
  checkCodecByte,
  checkMagic,
  DEFAULT_PAGE_ENTRIES,
  IDX_MAGIC,
  MAX_PAGE_ENTRIES,
  MAX_PARTS,
  MAX_RAW_BLOCK_BYTES,
  MAX_RECORDS_PER_BLOCK,
  PART_HEADER_BYTES,
  packedLimit,
  VERSION,
} from "./format.ts";
import { type ByteSource, bytesSource, readExact } from "./source.ts";

export const IDX_HEADER_BYTES = 64;
export const PART_ENTRY_BYTES = 16;
const HEAD_CRC_AT = 60;
// The smallest second-level entry: a 1-byte key and the fixed fields.
const MIN_ENTRY_BYTES = 2 + 1 + 2 + 8 + 4 + 4 + 2 + 4;
// The bytes open() reads first: one read holds the head of a pack of about
// 1,400 pages (90,000 blocks); a larger head costs one more read.
export const DEFAULT_HEAD_READ = 65_536;
const ZERO4 = new Uint8Array(4);

export interface IdxHeader {
  readonly dataset: number;
  readonly codec: number;
  readonly recordsPerBlock: number;
  readonly parts: number;
  readonly pageEntries: number;
  readonly records: number;
  readonly blocks: number;
  readonly pages: number;
  // The bytes of the head, which is the offset of the second level.
  readonly headBytes: number;
  readonly secondBytes: number;
}

export interface PartEntry {
  // The bytes of the part, its 16-byte header included.
  readonly bytes: number;
  readonly firstBlock: number;
  readonly blocks: number;
}

export interface PageRef {
  readonly key: string;
  // From the start of the second level.
  readonly offset: number;
  readonly bytes: number;
  readonly crc: number;
}

export interface BlockEntry {
  // The block's ordinal in the pack, from 0.
  readonly index: number;
  readonly key: string;
  readonly part: number;
  // From the start of the part, its header included.
  readonly offset: number;
  readonly packed: number;
  readonly raw: number;
  readonly records: number;
  readonly crc: number;
}

export interface IdxHead {
  readonly header: IdxHeader;
  readonly parts: readonly PartEntry[];
  // null for a pack of zero records.
  readonly keyMin: string | null;
  readonly keyMax: string | null;
  readonly pages: readonly PageRef[];
}

// What encodeIdx writes. `entries` holds every block in order, each with its
// `index` equal to its position.
export interface IdxContent {
  readonly dataset: number;
  readonly codec: number;
  readonly recordsPerBlock: number;
  readonly pageEntries?: number;
  readonly records: number;
  readonly parts: readonly PartEntry[];
  readonly keyMin: string | null;
  readonly keyMax: string | null;
  readonly entries: readonly BlockEntry[];
}

const fail = (code: "header" | "head" | "page" | "tiling", message: string): PackError => new PackError(code, message);

// The CRC-32 of a head, with its own four CRC bytes read as zero.
export function headCrc(head: Uint8Array, headBytes: number): number {
  let crc = crc32(head.subarray(0, HEAD_CRC_AT));
  crc = crc32(ZERO4, crc);
  return crc32(head.subarray(HEAD_CRC_AT + 4, headBytes), crc);
}

// ---- writing

function encodeEntry(out: ByteWriter, e: BlockEntry): void {
  out.key16(e.key);
  out.u16(e.part);
  out.u64(e.offset);
  out.u32(e.packed);
  out.u32(e.raw);
  out.u16(e.records);
  out.u32(e.crc);
}

export function encodeIdx(content: IdxContent): Uint8Array<ArrayBuffer> {
  const pageEntries = content.pageEntries ?? DEFAULT_PAGE_ENTRIES;
  const blocks = content.entries.length;
  const pages = Math.ceil(blocks / pageEntries);
  const second = new ByteWriter(blocks * 48 + 16);
  const top = new ByteWriter(pages * 48 + 16);
  for (let p = 0; p < pages; p += 1) {
    const page = new ByteWriter(pageEntries * 48);
    const slice = content.entries.slice(p * pageEntries, (p + 1) * pageEntries);
    for (const e of slice) encodeEntry(page, e);
    const bytes = page.take();
    top.key16(slice[0].key);
    top.u64(second.length);
    top.u32(bytes.length);
    top.u32(crc32(bytes));
    second.bytes(bytes);
  }
  const head = new ByteWriter(IDX_HEADER_BYTES + PART_ENTRY_BYTES * content.parts.length + top.length + 8);
  head.latin1(IDX_MAGIC);
  head.u8(VERSION);
  head.u8(content.dataset);
  head.u16(content.recordsPerBlock);
  head.u8(content.codec);
  head.u8(0);
  head.u16(content.parts.length);
  head.u16(pageEntries);
  head.u16(0);
  head.u64(content.records);
  head.u32(blocks);
  head.u32(pages);
  const headBytesAt = head.length;
  head.u32(0);
  head.u32(0);
  head.u64(second.length);
  for (let i = 0; i < 12; i += 1) head.u8(0);
  head.u32(0);
  for (const part of content.parts) {
    head.u64(part.bytes);
    head.u32(part.firstBlock);
    head.u32(part.blocks);
  }
  for (const bound of [content.keyMin, content.keyMax]) {
    if (bound === null) head.u16(0);
    else head.key16(bound);
  }
  head.bytes(top.take());
  head.patchU32(headBytesAt, head.length);
  const headLength = head.length;
  const withoutCrc = head.take();
  head.patchU32(HEAD_CRC_AT, headCrc(withoutCrc, headLength));
  head.bytes(second.take());
  const idx = head.take();
  // The reader's own checks, run on what was written: an index this writer
  // emits is one the reader accepts, or the write fails here.
  const read = readIdx(idx);
  if (read.entries.length !== blocks) throw new PackError("usage", `encodeIdx: ${blocks} entries written, ${read.entries.length} read back`);
  return idx;
}

// ---- reading

// The header's fixed 64 bytes, checked. Magic and version come first, so a pack
// of another version is refused as that and never as a bad CRC.
function readHeader(bytes: Uint8Array): IdxHeader {
  if (bytes.length < IDX_HEADER_BYTES) throw fail("head", `the index: ${bytes.length} B is shorter than its ${IDX_HEADER_BYTES} B header`);
  checkMagic(bytes, IDX_MAGIC, "the index");
  const input = new ByteReader(bytes, "header", "the index header", 4, IDX_HEADER_BYTES);
  const version = input.u8();
  if (version !== VERSION) throw new PackError("version", `the index is version ${version}; this reader knows ${VERSION}`);
  const dataset = input.u8();
  const recordsPerBlock = input.u16();
  const codec = input.u8();
  input.u8();
  const parts = input.u16();
  const pageEntries = input.u16();
  input.u16();
  const records = input.u64();
  const blocks = input.u32();
  const pages = input.u32();
  const headBytes = input.u32();
  input.u32();
  const secondBytes = input.u64();
  return { dataset, codec, recordsPerBlock, parts, pageEntries, records, blocks, pages, headBytes, secondBytes };
}

function checkHeader(h: IdxHeader, bytes: Uint8Array): void {
  if (h.dataset === 0) throw new PackError("dataset", "the index names dataset 0");
  checkCodecByte(h.codec, "the index");
  for (const at of [9, 14, 15, 36, 37, 38, 39, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59]) if (bytes[at] !== 0) throw fail("header", `the index: reserved byte ${at} is ${bytes[at]}, not 0`);
  if (h.recordsPerBlock < 1 || h.recordsPerBlock > MAX_RECORDS_PER_BLOCK) throw fail("header", `the index holds ${h.recordsPerBlock} records a block`);
  if (h.parts < 1 || h.parts > MAX_PARTS) throw fail("header", `the index names ${h.parts} parts`);
  if (h.pageEntries < 1 || h.pageEntries > MAX_PAGE_ENTRIES) throw fail("header", `the index holds ${h.pageEntries} entries a page`);
  if (h.blocks === 0 ? h.records !== 0 : h.records <= (h.blocks - 1) * h.recordsPerBlock || h.records > h.blocks * h.recordsPerBlock)
    throw fail("header", `${h.records} records do not fill ${h.blocks} blocks of ${h.recordsPerBlock} with only the last one short`);
  if (h.pages !== Math.ceil(h.blocks / h.pageEntries)) throw fail("header", `${h.blocks} blocks at ${h.pageEntries} a page make ${Math.ceil(h.blocks / h.pageEntries)} pages, not ${h.pages}`);
  if (h.blocks > 0 && h.secondBytes < h.blocks * MIN_ENTRY_BYTES) throw fail("header", `a second level of ${h.secondBytes} B cannot hold ${h.blocks} entries`);
  if (h.blocks === 0 && h.secondBytes !== 0) throw fail("header", `an index of no block has a second level of ${h.secondBytes} B`);
}

// The head of an index. `bytes` holds at least the head; `size` is the bytes
// of the whole index when the caller knows it, and must then equal the head
// and the second level.
export function parseHead(bytes: Uint8Array, size: number | null = null): IdxHead {
  const header = readHeader(bytes);
  const least = IDX_HEADER_BYTES + PART_ENTRY_BYTES * header.parts + 4;
  if (header.headBytes < least) throw fail("head", `a head of ${header.headBytes} B cannot hold ${header.parts} parts and the key bounds`);
  if (bytes.length < header.headBytes) throw fail("head", `the head is ${header.headBytes} B and ${bytes.length} B were given`);
  if (size !== null && header.headBytes + header.secondBytes !== size)
    throw fail("head", `the head (${header.headBytes} B) and the second level (${header.secondBytes} B) do not make the ${size} B of the index`);
  if (header.headBytes + header.secondBytes > MAX_SAFE) throw fail("head", "the index is larger than 2^53 - 1 bytes");
  const stated = new ByteReader(bytes, "head", "the index head", HEAD_CRC_AT, HEAD_CRC_AT + 4).u32();
  const actual = headCrc(bytes, header.headBytes);
  if (stated !== actual) throw fail("head", `the head CRC-32 is ${actual.toString(16).padStart(8, "0")}, the head says ${stated.toString(16).padStart(8, "0")}`);
  checkHeader(header, bytes);

  const input = new ByteReader(bytes, "head", "the index head", IDX_HEADER_BYTES, header.headBytes);
  if (header.blocks === 0 && header.parts !== 1) throw fail("head", `a pack of no block has ${header.parts} parts, not 1`);
  const parts: PartEntry[] = [];
  let next = 0;
  for (let i = 0; i < header.parts; i += 1) {
    const part = { bytes: input.u64(), firstBlock: input.u32(), blocks: input.u32() };
    if (part.firstBlock !== next) throw fail("head", `part ${i} starts at block ${part.firstBlock}, not ${next}`);
    if (header.blocks > 0 && part.blocks < 1) throw fail("head", `part ${i} holds no block`);
    if (part.bytes < PART_HEADER_BYTES + part.blocks) throw fail("head", `part ${i}: ${part.bytes} B cannot hold its header and ${part.blocks} blocks`);
    if (part.blocks === 0 && part.bytes !== PART_HEADER_BYTES) throw fail("head", `part ${i} holds no block and ${part.bytes} B`);
    next += part.blocks;
    parts.push(part);
  }
  if (next !== header.blocks) throw fail("head", `the parts hold ${next} blocks, the header says ${header.blocks}`);
  const min = input.key16("the smallest key", true);
  const max = input.key16("the largest key", true);
  if (header.records === 0 ? min !== "" || max !== "" : min === "" || max === "" || min > max) throw fail("head", "the key bounds do not fit the records");
  const pages: PageRef[] = [];
  let offset = 0;
  for (let p = 0; p < header.pages; p += 1) {
    const page = { key: input.key16(`the key of page ${p}`), offset: input.u64(), bytes: input.u32(), crc: input.u32() };
    const entries = Math.min(header.pageEntries, header.blocks - p * header.pageEntries);
    if (page.offset !== offset) throw fail("head", `page ${p} starts at ${page.offset} of the second level, not ${offset}`);
    if (page.bytes < entries * MIN_ENTRY_BYTES) throw fail("head", `page ${p}: ${page.bytes} B cannot hold ${entries} entries`);
    if (p > 0 && page.key < pages[p - 1].key) throw fail("head", `the key of page ${p} is below the key of page ${p - 1}`);
    offset += page.bytes;
    pages.push(page);
  }
  if (offset !== header.secondBytes) throw fail("head", `the pages hold ${offset} B, the header says ${header.secondBytes} B`);
  if (input.pos !== header.headBytes) throw fail("head", `the head ends at ${input.pos}, the header says ${header.headBytes}`);
  return { header, parts, keyMin: header.records === 0 ? null : min, keyMax: header.records === 0 ? null : max, pages };
}

const lastBlockOf = (part: PartEntry): number => part.firstBlock + part.blocks - 1;

// The entries of page p, checked against the head. `bytes` is the page exactly.
export function parsePage(head: IdxHead, p: number, bytes: Uint8Array): BlockEntry[] {
  const { header, parts, pages } = head;
  const ref = pages[p];
  if (ref === undefined) throw new PackError("usage", `the index has no page ${p}`);
  if (bytes.length !== ref.bytes) throw new PackError("short-read", `index page ${p}: ${bytes.length} B given, the head says ${ref.bytes} B`);
  const crc = crc32(bytes);
  if (crc !== ref.crc) throw fail("page", `index page ${p}: its CRC-32 is ${crc.toString(16).padStart(8, "0")}, the head says ${ref.crc.toString(16).padStart(8, "0")}`);
  const input = new ByteReader(bytes, "page", `index page ${p}`);
  const first = p * header.pageEntries;
  const count = Math.min(header.pageEntries, header.blocks - first);
  const lastRecords = header.records - (header.blocks - 1) * header.recordsPerBlock;
  const out: BlockEntry[] = [];
  for (let k = 0; k < count; k += 1) {
    const index = first + k;
    const label = `index page ${p} block ${index}`;
    const e: BlockEntry = {
      index,
      key: input.key16(`the key of block ${index}`),
      part: input.u16(),
      offset: input.u64(),
      packed: input.u32(),
      raw: input.u32(),
      records: input.u16(),
      crc: input.u32(),
    };
    const part = parts[e.part];
    if (part === undefined) throw fail("page", `${label} names part ${e.part} of ${parts.length}`);
    if (index < part.firstBlock || index > lastBlockOf(part)) throw fail("page", `${label} is in part ${e.part}, which holds blocks ${part.firstBlock} to ${lastBlockOf(part)}`);
    if (e.packed < 1) throw fail("page", `${label} has no compressed byte`);
    if (e.raw < 1 || e.raw > MAX_RAW_BLOCK_BYTES) throw fail("page", `${label} has ${e.raw} raw bytes, not 1 to ${MAX_RAW_BLOCK_BYTES}`);
    if (e.packed > packedLimit(e.raw)) throw fail("page", `${label} has ${e.packed} compressed bytes for ${e.raw} raw bytes, above ${packedLimit(e.raw)}`);
    const records = index === header.blocks - 1 ? lastRecords : header.recordsPerBlock;
    if (e.records !== records) throw fail("page", `${label} holds ${e.records} records, the header makes it ${records}`);
    if (k === 0 && e.key !== ref.key) throw fail("page", `${label} starts with another key than the head names for page ${p}`);
    if (k > 0 && e.key < out[k - 1].key) throw fail("page", `${label} has a key below the key of the block before it`);
    if (e.offset < PART_HEADER_BYTES || e.offset + e.packed > part.bytes) throw fail("tiling", `${label} lies at ${e.offset} to ${e.offset + e.packed} of a part of ${part.bytes} B`);
    if (index === part.firstBlock && e.offset !== PART_HEADER_BYTES) throw fail("tiling", `${label} is the first block of part ${e.part} and starts at ${e.offset}, not ${PART_HEADER_BYTES}`);
    if (index === lastBlockOf(part) && e.offset + e.packed !== part.bytes) throw fail("tiling", `${label} is the last block of part ${e.part} and ends at ${e.offset + e.packed}, not ${part.bytes}`);
    if (k > 0) checkTiling(out[k - 1], e);
    out.push(e);
  }
  if (input.pos !== bytes.length) throw fail("page", `index page ${p}: ${bytes.length - input.pos} B after its last entry`);
  const after = pages[p + 1];
  if (after !== undefined && out[out.length - 1].key > after.key) throw fail("page", `index page ${p} ends above the key of page ${p + 1}`);
  return out;
}

// Two blocks in a row: the second starts where the first ends, or starts its
// own part.
export function checkTiling(before: BlockEntry, e: BlockEntry): void {
  if (e.index !== before.index + 1) throw new PackError("usage", `blocks ${before.index} and ${e.index} are not in a row`);
  if (e.part === before.part) {
    if (e.offset !== before.offset + before.packed)
      throw fail("tiling", `block ${e.index} starts at ${e.offset} of part ${e.part}, not at ${before.offset + before.packed} where block ${before.index} ends`);
  } else if (e.part !== before.part + 1 || e.offset !== PART_HEADER_BYTES)
    throw fail("tiling", `block ${e.index} starts part ${e.part} at ${e.offset}, after block ${before.index} in part ${before.part}`);
}

export interface Idx {
  readonly head: IdxHead;
  readonly entries: readonly BlockEntry[];
}

// A whole index held in memory: the head and every page, checked, with the
// tiling across pages.
export function readIdx(bytes: Uint8Array): Idx {
  const head = parseHead(bytes, bytes.length);
  const entries: BlockEntry[] = [];
  for (let p = 0; p < head.pages.length; p += 1) {
    const start = head.header.headBytes + head.pages[p].offset;
    for (const e of parsePage(head, p, bytes.subarray(start, start + head.pages[p].bytes))) {
      if (entries.length > 0) checkTiling(entries[entries.length - 1], e);
      entries.push(e);
    }
  }
  return { head, entries };
}

export interface IndexOptions {
  // The bytes the first read of the head asks for.
  readonly headRead?: number;
  // Pages kept after they are read; 0 reads a page again on every use.
  readonly pageCache?: number;
  // The bytes of each part as the store holds it (the manifest's layer sizes,
  // or the files' sizes), in part order. When given, open refuses an index
  // whose parts table states other sizes, so no read trusts a part length
  // that only the index claims.
  readonly partSizes?: readonly number[];
  // The largest raw block a PackReader reads, 1 to MAX_RAW_BLOCK_BYTES (the
  // default). A block within the format's 16 MiB can still decode to more heap
  // than a Worker holds, so a Worker sets a lower bound and a block above it is
  // refused from its index entry before any read.
  readonly maxRawBlockBytes?: number;
}

// The parts table against the sizes the store gives.
export function checkPartSizes(head: IdxHead, sizes: readonly number[]): void {
  if (sizes.length !== head.parts.length) throw fail("tiling", `the index names ${head.parts.length} part(s) and the store holds ${sizes.length}`);
  head.parts.forEach((part, i) => {
    if (sizes[i] !== part.bytes) throw fail("tiling", `part ${i}: the index gives it ${part.bytes} B and the store holds ${sizes[i]} B`);
  });
}

// An index read by range: open() reads the head (one read, or two for a head
// above `headRead`), checks the parts table against `partSizes` when given,
// and each page is read when a lookup needs it. A lookup with the head held
// costs one page read.
export class PackIndex {
  readonly head: IdxHead;
  readonly source: ByteSource;
  readonly #cache = new Map<number, readonly BlockEntry[]>();
  readonly #cacheLimit: number;

  private constructor(head: IdxHead, source: ByteSource, cacheLimit: number) {
    this.head = head;
    this.source = source;
    this.#cacheLimit = cacheLimit;
  }

  static async open(source: ByteSource | Uint8Array, options: IndexOptions = {}): Promise<PackIndex> {
    const src = source instanceof Uint8Array ? bytesSource(source) : source;
    if (!Number.isSafeInteger(src.size) || src.size < IDX_HEADER_BYTES) throw fail("head", `the index is ${src.size} B, shorter than its ${IDX_HEADER_BYTES} B header`);
    const want = Math.min(src.size, Math.max(IDX_HEADER_BYTES, options.headRead ?? DEFAULT_HEAD_READ));
    let bytes = await readExact(src, 0, want, "the index head");
    const header = readHeader(bytes);
    if (header.headBytes > src.size) throw fail("head", `the head is ${header.headBytes} B and the index ${src.size} B`);
    if (header.headBytes > bytes.length) {
      const rest = await readExact(src, bytes.length, header.headBytes - bytes.length, "the index head");
      const whole = new Uint8Array(header.headBytes);
      whole.set(bytes);
      whole.set(rest, bytes.length);
      bytes = whole;
    }
    const head = parseHead(bytes.subarray(0, header.headBytes), src.size);
    if (options.partSizes !== undefined) checkPartSizes(head, options.partSizes);
    return new PackIndex(head, src, Math.max(0, options.pageCache ?? 16));
  }

  get header(): IdxHeader {
    return this.head.header;
  }

  async page(p: number): Promise<readonly BlockEntry[]> {
    if (!Number.isInteger(p) || p < 0 || p >= this.head.pages.length) throw new PackError("usage", `the index has no page ${p}`);
    const kept = this.#cache.get(p);
    if (kept !== undefined) return kept;
    const ref = this.head.pages[p];
    const bytes = await readExact(this.source, this.header.headBytes + ref.offset, ref.bytes, `index page ${p}`);
    const entries = parsePage(this.head, p, bytes);
    if (this.#cacheLimit > 0) {
      if (this.#cache.size >= this.#cacheLimit) this.#cache.delete(this.#cache.keys().next().value as number);
      this.#cache.set(p, entries);
    }
    return entries;
  }

  async entry(i: number): Promise<BlockEntry> {
    if (!Number.isInteger(i) || i < 0 || i >= this.header.blocks) throw new PackError("usage", `the pack has no block ${i}`);
    const page = await this.page(Math.floor(i / this.header.pageEntries));
    return page[i % this.header.pageEntries];
  }

  // The ordinal of the block that may hold `key`, or -1 when the key is below
  // every block.
  async locate(key: string): Promise<number> {
    const entry = await this.locateEntry(key);
    return entry === null ? -1 : entry.index;
  }

  // The entry of the block that may hold `key`: the last block whose index key
  // is not above it, or null when the key is below every block. One page read
  // at most.
  async locateEntry(key: string): Promise<BlockEntry | null> {
    const pages = this.head.pages;
    let lo = 0;
    let hi = pages.length - 1;
    let p = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (pages[mid].key <= key) {
        p = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (p < 0) return null;
    const entries = await this.page(p);
    lo = 0;
    hi = entries.length - 1;
    let k = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid].key <= key) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return entries[k];
  }

  // Every block entry from `from` on, in order, with the tiling checked across
  // pages.
  async *entries(from = 0): AsyncGenerator<BlockEntry> {
    let before: BlockEntry | null = null;
    for (let i = from; i < this.header.blocks; i += 1) {
      const e = await this.entry(i);
      if (before !== null) checkTiling(before, e);
      before = e;
      yield e;
    }
  }
}
