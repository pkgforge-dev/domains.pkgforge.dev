// Synthetic packs for the tests of packages/compact. Every key, time and
// source here is made up for the test, from a seeded generator, so a run
// repeats byte for byte.
import {
  type DatasetCodec,
  type FeedRecord,
  MemorySink,
  type NameRecord,
  NAMES_CODEC,
  type PackReader,
  PackReader as Reader,
  type PackSink,
  type PackSummary,
  partsSource,
  writePack,
} from "@domains/pack";
import { nodeCompress } from "@domains/pack/node";
import { writeFeedPack } from "@domains/feed";

export interface MemPack<R> {
  readonly summary: PackSummary;
  readonly parts: Uint8Array<ArrayBuffer>[];
  readonly reader: PackReader<R>;
}

// A pack in memory of `records`, which must ascend by key.
export async function memPack<R>(records: readonly R[], codec: DatasetCodec<R>, recordsPerBlock = 4, pageEntries = 2): Promise<MemPack<R>> {
  const sink = new MemorySink();
  const summary = await writePack(records, { codec, compress: nodeCompress, sink, recordsPerBlock, pageEntries });
  const parts = sink.parts();
  return { summary, parts, reader: await Reader.open(summary.idx, partsSource(parts), codec) };
}

// A reader over parts and an index held in memory.
export const readerOf = <R>(idx: Uint8Array, parts: readonly Uint8Array[], codec: DatasetCodec<R>): Promise<PackReader<R>> =>
  Reader.open(idx, partsSource(parts), codec, { partSizes: parts.map((p) => p.length) });

// A seeded generator of whole numbers below n (mulberry32).
export function rng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n;
  };
}

// `n` distinct reversed names from `seed`, ascending: a few labels under a few
// suffixes, so two seeds share some keys.
export function keys(seed: number, n: number, space = 400): string[] {
  const r = rng(seed);
  const out = new Set<string>();
  const tlds = ["com", "net", "org", "np", "de"];
  while (out.size < n) {
    const i = Math.floor(r(space));
    out.add(`${tlds[i % tlds.length]}.example${i}${i % 3 === 0 ? ".www" : ""}`);
  }
  return [...out].sort();
}

// names records of `keys`, all of source `bit` on day `day`.
export const nameRecords = (ks: readonly string[], bit: number, day: number): NameRecord[] => ks.map((key) => ({ key, flags: 1, sources: [{ bit, first: day, last: day }] }));

// The inputs of a merge of names: `n` packs whose keys overlap.
export async function namesInputs(n: number, perInput: number, recordsPerBlock = 4, space = 400): Promise<MemPack<NameRecord>[]> {
  const out: MemPack<NameRecord>[] = [];
  for (let i = 0; i < n; i += 1) out.push(await memPack(nameRecords(keys(100 + i, perInput, space), i % 3, 298 + i), NAMES_CODEC, recordsPerBlock));
  return out;
}

// A sink that keeps each part by its number, in any order: the sink of one
// range, whose one part may be any number.
export class PartsByNumber implements PackSink {
  readonly #parts = new Map<number, Uint8Array[]>();

  write(part: number, bytes: Uint8Array): void {
    const chunks = this.#parts.get(part) ?? [];
    chunks.push(bytes.slice());
    this.#parts.set(part, chunks);
  }

  numbers(): number[] {
    return [...this.#parts.keys()];
  }

  part(n: number): Uint8Array {
    return concat(this.#parts.get(n) ?? []);
  }
}

// Feed rows of `keys`, first_seen inside the day `day0` (seconds since
// 2026-01-01), from `seed`: some at the day's first second, from a day source
// (bit 2), and the rest at a second of the day, from a second source (bit 1).
export function feedRows(ks: readonly string[], day0: number, seed: number): FeedRecord[] {
  const r = rng(seed);
  return ks.map((key) => {
    const atStart = r(1) < 0.4;
    return { key, flags: 0, firstSeen: atStart ? day0 : day0 + Math.floor(r(86_400)), sources: [atStart ? 2 : 1], basis: 4, confidence: 0, feedFlags: 0 };
  });
}

export interface FeedMem {
  readonly key: MemPack<FeedRecord>;
  readonly time: MemPack<FeedRecord>;
}

// A feed pack with its time copy, written by writeFeedPack of @domains/feed.
export async function feedPack(rows: readonly FeedRecord[], codec: DatasetCodec<FeedRecord>, timeCodec: DatasetCodec<FeedRecord>, recordsPerBlock = 4): Promise<FeedMem> {
  const sink = new MemorySink();
  const timeSink = new MemorySink();
  const pack = await writeFeedPack(rows, { codec, compress: nodeCompress, sink, recordsPerBlock, pageEntries: 2, time: { sink: timeSink, recordsPerBlock, pageEntries: 2 } });
  const time = pack.time as PackSummary;
  const keyParts = sink.parts();
  const timeParts = timeSink.parts();
  return {
    key: { summary: pack.summary, parts: keyParts, reader: await Reader.open(pack.summary.idx, partsSource(keyParts), codec) },
    time: { summary: time, parts: timeParts, reader: await Reader.open(time.idx, partsSource(timeParts), timeCodec) },
  };
}

// The bytes of a list of arrays, joined.
export function concat(arrays: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

export async function collect<R>(records: AsyncIterable<R>): Promise<R[]> {
  const out: R[] = [];
  for await (const r of records) out.push(r);
  return out;
}
