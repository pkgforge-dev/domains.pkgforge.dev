// packages/pack/test/helpers.ts — what the tests of packages/pack share: a
// seeded generator, synthetic records, and a pack written to memory with the
// production compressor (node:zlib at level 9, packages/pack/node).
//
// Every name and time made here is synthetic. A failure names its seed, and the
// same seed makes the same records.
import { nodeCompress } from "../node/index.ts";
import {
  type DatasetCodec,
  type DomainRecord,
  type FeedRecord,
  MemorySink,
  NAMES_CODEC,
  type NameRecord,
  PackReader,
  type PackSummary,
  partsSource,
  type Seen,
  type WriterOptions,
  writePack,
} from "../src/index.ts";

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

const LABELS = ["www", "api", "mail", "cdn", "shop", "_dmarc", "a-b", "x0", "dev", "m"];
const TLDS = ["com", "net", "org", "de", "np", "com.np", "co.uk"];

// n distinct synthetic keys, ascending.
export function randomKeys(n: number, seed: number): string[] {
  const next = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  const keys = new Set<string>();
  while (keys.size < n) {
    const reg = `${pick(TLDS).split(".").reverse().join(".")}.${pick(["example", "test", "site", "shop"])}${Math.floor(next() * 1000)}`;
    const depth = Math.floor(next() * 3);
    let key = reg;
    for (let d = 0; d < depth; d += 1) key += `.${pick(LABELS)}`;
    keys.add(key);
  }
  return [...keys].sort();
}

export function randomSeen(next: () => number): Seen[] {
  const out: Seen[] = [];
  for (let bit = 0; bit < 64; bit += 1) {
    if (next() < (bit === 0 ? 0.7 : 0.05)) {
      const first = Math.floor(next() * 400);
      out.push({ bit, first, last: first + Math.floor(next() * 30) });
    }
  }
  if (out.length === 0) out.push({ bit: Math.floor(next() * 64), first: 298, last: 298 });
  return out;
}

export function randomNames(n: number, seed: number): NameRecord[] {
  const next = rng(seed + 1);
  return randomKeys(n, seed).map((key) => ({ key, flags: 1 + Math.floor(next() * 3), sources: randomSeen(next) }));
}

export function randomDomains(n: number, seed: number): DomainRecord[] {
  const next = rng(seed + 2);
  return randomNames(n, seed).map((r) => {
    const evidence = [];
    for (let basis = 0; basis < 5; basis += 1) {
      if (next() < 0.3) evidence.push({ tier: [1, 1, 2, 2, 3][basis], basis, source: Math.floor(next() * 64), at: Math.floor(next() * 400), confidence: Math.floor(next() * 11) });
    }
    evidence.sort((x, y) => x.tier - y.tier || x.basis - y.basis || x.source - y.source);
    return { ...r, flags: Math.floor(next() * 4), evidence };
  });
}

export function randomFeed(n: number, seed: number): FeedRecord[] {
  const next = rng(seed + 3);
  return randomKeys(n, seed).map((key) => {
    const sources = randomSeen(next).map((s) => s.bit);
    return {
      key,
      flags: Math.floor(next() * 4),
      firstSeen: Math.floor(next() * 3e7),
      sources,
      basis: Math.floor(next() * 32),
      confidence: Math.floor(next() * 11),
      feedFlags: Math.floor(next() * 16),
    };
  });
}

export interface MemPack {
  readonly summary: PackSummary;
  readonly parts: Uint8Array<ArrayBuffer>[];
}

export async function writeMem<R>(records: Iterable<R> | AsyncIterable<R>, options: Partial<Omit<WriterOptions<R>, "sink">> & { codec: DatasetCodec<R> }): Promise<MemPack> {
  const sink = new MemorySink();
  const summary = await writePack(records, { compress: nodeCompress, ...options, sink });
  return { summary, parts: sink.parts() };
}

export async function readerOf<R>(pack: MemPack, codec: DatasetCodec<R>): Promise<PackReader<R>> {
  return PackReader.open(pack.summary.idx, partsSource(pack.parts), codec);
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

export const names = (records: readonly NameRecord[]): NameRecord[] => [...records];
export { NAMES_CODEC };
