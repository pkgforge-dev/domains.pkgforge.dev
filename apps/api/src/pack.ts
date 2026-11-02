// apps/api/src/pack.ts — a pack the root names, opened for reading from GHCR
// (docs/format.md; the Found of 2026-10-29T04:54Z in TODO/serve.md DOM-030).
//
// Every pack opens with the two reader options of packages/pack:
// - `partSizes`: the sizes of the pack's part layers as its manifest gives them
//   (the root's pack entry copies them, packFromManifest of packages/root).
//   PackReader.open holds the index's parts table to them before any block is
//   read, and refuses another count or size with PackError `tiling`.
// - `maxRawBlockBytes`: MAX_RAW_BLOCK_BYTES below. A block above it is refused
//   with PackError `page` from its index entry, before its bytes are read.
// and with the Worker's own bounds, each refused with PackError `page`:
// - the index is read whole, in one read held to its digest from the cache and
//   from GHCR alike, and is at most MAX_IDX_BYTES; the reader then takes its
//   head and its pages from those bytes, with no read of their own;
// - `recordsPerBlock` at most MAX_RECORDS_PER_BLOCK and `pageEntries` at most
//   MAX_PAGE_ENTRIES, checked at open, before any block is read.
//
// A block's bytes go into their `body` entry only once the reader's checks hold
// them (length, inflate, CRC-32), so bytes that fail are never kept. A block
// whose bytes came from its entry and fail inflate or the CRC-32 is a miss: the
// entry is logged, the block is read again from GHCR, which overwrites the
// entry once the bytes hold, and a block that fails at GHCR too fails the read.
// Each read names its tier in the request's reads, so the provenance says what
// served the bytes.
import type { PackRead, ReadTier } from "@domains/core";
import type { GhcrReader } from "@domains/ghcr";
import { type BlockEntry, PackError, type PackRecord, PackReader, type RangeSource } from "@domains/pack";
import type { ApiCache } from "./cache.ts";
import { bodyName, readImmutable } from "./ghcr.ts";

// The largest raw block a pack read by this Worker may hold: 1 MiB. The largest
// raw block of the 613 live pack copies was 164,536 B (domains-d-20261030;
// MEASURED 2026-11-02T00:35Z, TODO/serve.md DOM-030).
export const MAX_RAW_BLOCK_BYTES = 1024 * 1024;
// The raw bound alone does not bound the heap of a decoded block: front coding
// lets a few raw bytes name a long key, and a names block of 65,535 keys that
// share a prefix, half the bound raw, held 27.6 MiB (the door sweep of
// 2026-11-02). At 8,192 records a block, twice the 4,096 of every live pack,
// the worst block measured held 13.0 MiB: a domains block of 958,942 raw bytes
// (MEASURED 2026-11-02T03:45Z, Node v26.7.0, TODO/serve.md DOM-030).
export const MAX_RECORDS_PER_BLOCK = 8192;
// Every live pack has 64; the reader keeps PAGE_CACHE parsed pages.
export const MAX_PAGE_ENTRIES = 256;
const PAGE_CACHE = 4;
// The largest index read whole: every live index is at most 4,457 B.
export const MAX_IDX_BYTES = 1024 * 1024;
// The checks a block fails when its entry holds the wrong bytes of the right
// length (packages/pack reader.ts readBlock).
const BYTE_FAULTS: ReadonlySet<string> = new Set(["inflate", "crc"]);

export interface BlobRef {
  readonly digest: string;
  readonly size: number;
}

// The fields of a root pack entry (packages/root PackEntry) that a read needs.
export interface PackBlobs {
  readonly repo: string;
  readonly tag: string;
  readonly idx: BlobRef;
  readonly parts: readonly BlobRef[];
  readonly sources: readonly string[];
}

export interface OpenOptions {
  // Below MAX_RAW_BLOCK_BYTES only: a read that wants a tighter bound.
  readonly maxRawBlockBytes?: number;
}

// The block reads of one pack, held until the reader's checks pass on them.
interface BlockReads {
  readonly cache: ApiCache;
  // By blockAt: the tier, the bytes and the `body` entry of the last read.
  readonly got: Map<string, { tier: ReadTier; bytes: Uint8Array; name: string }>;
  // Blocks whose entry failed a check: their next read skips it.
  readonly fresh: Set<string>;
}

const blockAt = (part: number, offset: number, length: number): string => `${part}:${offset}:${length}`;

// A pack reader whose block reads keep only checked bytes and heal a bad entry.
class WorkerPackReader<R> extends PackReader<R> {
  readonly #blocks: BlockReads;

  constructor(base: PackReader<R>, blocks: BlockReads) {
    super(base.index, base.source, base.codec, base.maxRawBlockBytes);
    this.#blocks = blocks;
  }

  // The checked bytes of GHCR go into their entry; an entry's own bytes stay.
  #held(at: string, raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    const got = this.#blocks.got.get(at);
    this.#blocks.got.delete(at);
    if (got?.tier === "ghcr") this.#blocks.cache.putBytes(got.name, got.bytes);
    return raw;
  }

  override async readBlock(entry: BlockEntry): Promise<Uint8Array<ArrayBuffer>> {
    const at = blockAt(entry.part, entry.offset, entry.packed);
    const b = this.#blocks;
    try {
      return this.#held(at, await super.readBlock(entry));
    } catch (err) {
      const first = b.got.get(at);
      b.got.delete(at);
      if (first?.tier !== "cache" || !(err instanceof PackError) || !BYTE_FAULTS.has(err.code)) throw err;
      b.cache.refused(first.name, `block ${entry.index} fails its check: ${err.message}`);
      b.fresh.add(at);
      try {
        return this.#held(at, await super.readBlock(entry));
      } finally {
        b.fresh.delete(at);
        b.got.delete(at);
      }
    }
  }
}

export async function openPack(g: GhcrReader, cache: ApiCache, pack: PackBlobs, reads: PackRead[], options: OpenOptions = {}): Promise<PackReader<PackRecord>> {
  const bound = options.maxRawBlockBytes ?? MAX_RAW_BLOCK_BYTES;
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > MAX_RAW_BLOCK_BYTES) throw new PackError("usage", `maxRawBlockBytes ${bound} is not 1 to ${MAX_RAW_BLOCK_BYTES}`);
  const size = pack.idx.size;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IDX_BYTES) throw new PackError("page", `the index of ${pack.tag} is ${size} B; this Worker reads an index of 1 to ${MAX_IDX_BYTES} B`);
  const idx = await readImmutable(g, cache, pack.repo, pack.idx.digest, 0, size, { whole: size });
  reads.push({ tier: idx.tier, pack: pack.tag, sources: pack.sources });
  const blocks: BlockReads = { cache, got: new Map(), fresh: new Set() };
  const parts: RangeSource = {
    read: async (part, offset, length) => {
      const blob = pack.parts[part];
      if (blob === undefined) throw new PackError("short-read", `${pack.tag} has no part ${part}`);
      const at = blockAt(part, offset, length);
      const r = await readImmutable(g, cache, pack.repo, blob.digest, offset, offset + length, { whole: blob.size, fresh: blocks.fresh.has(at), keep: false });
      reads.push({ tier: r.tier, pack: pack.tag, sources: pack.sources });
      blocks.got.set(at, { tier: r.tier, bytes: r.bytes, name: bodyName(pack.repo, blob.digest, offset, offset + length) });
      return r.bytes;
    },
  };
  const base = await PackReader.open(idx.bytes, parts, undefined, { partSizes: pack.parts.map((p) => p.size), maxRawBlockBytes: bound, pageCache: PAGE_CACHE });
  const h = base.index.header;
  if (h.recordsPerBlock > MAX_RECORDS_PER_BLOCK) throw new PackError("page", `the index of ${pack.tag} holds ${h.recordsPerBlock} records a block; this Worker reads at most ${MAX_RECORDS_PER_BLOCK}`);
  if (h.pageEntries > MAX_PAGE_ENTRIES) throw new PackError("page", `the index of ${pack.tag} holds ${h.pageEntries} entries a page; this Worker reads at most ${MAX_PAGE_ENTRIES}`);
  return new WorkerPackReader(base, blocks);
}
