// packages/ledger/test/helpers.ts — what the tests of packages/ledger share: a
// seeded generator, the pinned PSL fixture, synthetic records, and packs written
// to memory with the production compressor (node:zlib at level 9).
//
// Every name and time made here is synthetic. A failure names its seed, and the
// same seed makes the same records. The one measured input is the THC slice of
// test/fixtures/thc-slice.json, which replay.test.ts reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPsl, type Psl } from "@domains/names";
import { nodeCompress } from "@domains/pack/node";
import {
  bytesSource,
  type DatasetCodec,
  DOMAINS_CODEC,
  type DomainRecord,
  MemorySink,
  NAMES_CODEC,
  type NameRecord,
  PackReader,
  type PackSummary,
  partsSource,
  type Seen,
  writePack,
} from "@domains/pack";

export const ROOT = join(import.meta.dirname, "..", "..", "..");
export const PSL_PATH = join(ROOT, "packages", "names", "test", "fixtures", "psl-2026-10-27.dat");

let pslPromise: Promise<Psl> | null = null;
export const pinnedPsl = (): Promise<Psl> => (pslPromise ??= loadPsl(readFileSync(PSL_PATH)));

// mulberry32: a small seeded generator.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A synthetic registrable-domain key under one of a few suffixes, from n.
export const domainKey = (n: number): string => `${["com", "net", "org", "np.com", "uk.co"][n % 5]}.syn${n.toString(36)}`;

export interface MemPack {
  readonly summary: PackSummary;
  readonly parts: Uint8Array<ArrayBuffer>[];
}

export async function writeMem<R>(records: Iterable<R> | AsyncIterable<R>, codec: DatasetCodec<R>, recordsPerBlock = 64): Promise<MemPack> {
  const sink = new MemorySink();
  const summary = await writePack(records, { codec, compress: nodeCompress, sink, recordsPerBlock, pageEntries: 4 });
  return { summary, parts: sink.parts() };
}

export type CountedReader<R> = PackReader<R> & { readonly reads: number; readonly idxReads: number };

// A reader of a pack in memory that counts the range reads it makes: `reads`
// of the parts (one a block), `idxReads` of the index (the head, then pages).
// `pageCache` is the index's page cache; 0 reads a page on every use.
export async function readerOf<R>(pack: MemPack, codec: DatasetCodec<R>, pageCache = 16): Promise<CountedReader<R>> {
  const parts = partsSource(pack.parts);
  const idx = bytesSource(pack.summary.idx);
  const count = { reads: 0, idxReads: 0 };
  const partsCounted = {
    read(part: number, offset: number, length: number): Promise<Uint8Array> {
      count.reads += 1;
      return parts.read(part, offset, length);
    },
  };
  const idxCounted = {
    size: idx.size,
    read(offset: number, length: number): Promise<Uint8Array> {
      count.idxReads += 1;
      return idx.read(offset, length);
    },
  };
  const reader = await PackReader.open(idxCounted, partsCounted, codec, { pageCache });
  Object.defineProperty(reader, "reads", { get: () => count.reads });
  Object.defineProperty(reader, "idxReads", { get: () => count.idxReads });
  return reader as CountedReader<R>;
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

export const seen = (bit: number, first: number, last = first): Seen => ({ bit, first, last });

export const nameRecord = (key: string, sources: Seen[], flags = 1): NameRecord => ({ key, flags, sources });

export const domainRecord = (key: string, sources: Seen[], flags = 0): DomainRecord => ({ key, flags, sources, evidence: [] });

export { DOMAINS_CODEC, NAMES_CODEC };
