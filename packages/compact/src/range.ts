// packages/compact/src/range.ts — one merge cut into key ranges, so that an
// Actions matrix writes its parts in parallel, and the parts of all ranges
// assembled into one pack (docs/architecture.md section 4.5).
//
//   const plan = planRanges([idxA, idxB], { targetBytes: DEFAULT_RANGE_BYTES });   cuts at index page keys
//   const count = await countRange(readers, codec, plan.cuts, r);                     stage 1, one job a range
//   const window = windowOf(counts, r, recordsPerBlock);                              from every range's count
//   const out = await writeRange(readers, codec, plan.cuts, window, sink, options);    stage 2, one job a range
//   const pack = assembleRanges(outs.map(factsOf), format);                           the index of all parts
//   const summary = await mergeSpan(readers, codec, sink, { compress, cuts });         the same, in one process
//
// The ranged layout. The output's records are the merge of the inputs, in key
// order, in blocks of `records a block`: block b holds the records b*R up to
// (b+1)*R - 1, as one writer writes them, because the format allows a short
// block only at the end of the pack (docs/format.md sections 2 and 6.5). A
// range r is the keys [cut r-1, cut r). It owns the blocks whose first record
// falls in it, and writes them as one part: the ranges that own a block take
// the part numbers 0, 1, 2 in key order. So the blocks of all parts are the
// blocks of one writer, byte for byte, and the parts are cut at the first block
// that starts in each range. A range's part may end with records of the
// ranges after it, to fill its last block, and starts with the first record
// whose ordinal is a multiple of R.
//
// A range cannot know where its first block starts without the count of every
// range before it: the merge folds the keys that two inputs share, so the
// count of a range is known only by merging it. Stage 1 counts each range's
// distinct keys; stage 2 takes every count (windowOf) and writes. One range
// alone needs no count. The plan cuts at index page keys, weighted by the
// compressed bytes of each page's blocks, so the ranges hold about the same
// input bytes: the shard of mirror-archlinux docs/design.md ("Shards"), which
// splits by bytes.
//
// What holds the ranges to one another, in assembleRanges: every range of the
// plan once, the parts in range order with no number skipped, and each part's
// first key the key after the last record of the part before it (`next`, which
// each range reads one record past its end), with the last part followed by
// nothing. A range whose count was wrong breaks that chain or its own window
// (writeRange refuses inputs that end early or run on), never silently.
//
// Runs in Node and in workerd alike: it imports nothing from `node:`.
import {
  type BlockEntry,
  type Compress,
  type DatasetCodec,
  DEFAULT_CODEC,
  DEFAULT_PAGE_ENTRIES,
  DEFAULT_PART_LIMIT,
  DEFAULT_RECORDS_PER_BLOCK,
  encodeIdx,
  encodePartHeader,
  type Idx,
  mergePacks,
  mergeRecords,
  PART_HEADER_BYTES,
  PackReader,
  type PackSink,
  type PackSummary,
  PackWriter,
  type PartEntry,
  type RangeSource,
  readPart,
  readPartHeader,
  Sha256,
  writePack,
} from "@domains/pack";
import { CompactError } from "./errors.ts";

// The most ranges of one merge: a GitHub Actions matrix runs at most 256 jobs
// (READ docs/architecture.md section 5.1). rangeCeiling of files.ts holds a
// plan to fewer, so that its parts and indexes fit one manifest (MAX_LAYERS).
export const MAX_RANGES = 256;
// The input bytes a range aims at: mirror-archlinux's SHARD_BYTES (READ
// TODO/storage.md DOM-023, Premise). A range writes one part of at most
// DEFAULT_PART_LIMIT (1 GiB), so this leaves the merge room to write more
// bytes than it reads.
export const DEFAULT_RANGE_BYTES = 536_870_912;

export interface RangePlan {
  // The N - 1 keys that cut the key space, ascending and distinct.
  readonly cuts: readonly string[];
  readonly ranges: number;
  // The compressed input bytes each range is planned to read, from the index pages.
  readonly bytes: readonly number[];
  readonly total: number;
}

export interface RangeOptions {
  // The ranges asked for; else the input bytes over targetBytes, rounded up.
  readonly ranges?: number;
  readonly targetBytes?: number;
  // The most ranges, 1 to MAX_RANGES (the default): fewer when the pack's
  // layers must fit one manifest (rangeCeiling of files.ts). A count asked for
  // above it is refused; a count from targetBytes is held to it.
  readonly maxRanges?: number;
}

const whole = (v: unknown, min: number, max: number, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new CompactError("usage", `${what} is ${String(v)}, not a whole number of ${min} to ${max}`);
  return v;
};

// The cuts of a merge of the packs whose whole indexes are `indexes`: each
// candidate cut is the key of an index page, and the bytes before it are the
// compressed bytes of every block of every input whose first key is below
// it. A block weighs at its first key, so the weight before a cut is off by
// at most one block an input. The smallest page key of all is no cut, so
// range 0 is never empty.
export function planRanges(indexes: readonly Idx[], options: RangeOptions = {}): RangePlan {
  const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const blocks: { key: string; packed: number }[] = [];
  const pageKeys = new Set<string>();
  for (const idx of indexes) {
    for (const e of idx.entries) blocks.push({ key: e.key, packed: e.packed });
    for (const page of idx.head.pages) pageKeys.add(page.key);
  }
  blocks.sort((a, b) => byKey(a.key, b.key));
  const keys = [...pageKeys].sort(byKey);
  const cands: { key: string; before: number }[] = [];
  let before = 0;
  let b = 0;
  for (const [i, key] of keys.entries()) {
    for (; b < blocks.length && blocks[b].key < key; b += 1) before += blocks[b].packed;
    if (i > 0) cands.push({ key, before });
  }
  for (; b < blocks.length; b += 1) before += blocks[b].packed;
  const total = before;
  const target = whole(options.targetBytes ?? DEFAULT_RANGE_BYTES, 1, Number.MAX_SAFE_INTEGER, "targetBytes");
  const most = whole(options.maxRanges ?? MAX_RANGES, 1, MAX_RANGES, "maxRanges");
  let n = options.ranges === undefined ? Math.max(1, Math.min(most, Math.ceil(total / target))) : whole(options.ranges, 1, most, "ranges");
  n = Math.min(n, cands.length + 1);
  const cuts: string[] = [];
  const at: number[] = [0];
  let next = 0;
  for (let j = 1; j < n; j += 1) {
    const want = (total * j) / n;
    const last = cands.length - (n - j);
    let i = next;
    while (i < last && cands[i].before < want) i += 1;
    if (i > next && want - cands[i - 1].before < cands[i].before - want) i -= 1;
    cuts.push(cands[i].key);
    at.push(cands[i].before);
    next = i + 1;
  }
  at.push(total);
  return { cuts, ranges: n, bytes: at.slice(1).map((b, r) => b - at[r]), total };
}

// The keys [lo, hi) of range r; an absent bound is open.
export function rangeBounds(cuts: readonly string[], r: number): { readonly lo?: string; readonly hi?: string } {
  whole(r, 0, cuts.length, "the range");
  return { ...(r > 0 ? { lo: cuts[r - 1] } : {}), ...(r < cuts.length ? { hi: cuts[r] } : {}) };
}

// The range of `key`: the cuts at or below it.
export function rangeOf(cuts: readonly string[], key: string): number {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cuts[mid] <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function checkCuts(cuts: readonly string[]): void {
  if (!Array.isArray(cuts) || cuts.length > MAX_RANGES - 1) throw new CompactError("usage", `the cuts are not a list of at most ${MAX_RANGES - 1} keys`);
  for (const [i, c] of cuts.entries()) {
    if (typeof c !== "string" || c.length === 0) throw new CompactError("usage", `cut ${i} is not a key`);
    if (i > 0 && !(c > cuts[i - 1])) throw new CompactError("usage", `cut ${i} is not above cut ${i - 1}`);
  }
}

function checkDatasets<R>(inputs: readonly PackReader<R>[], codec: DatasetCodec<R>): void {
  for (const [i, reader] of inputs.entries()) {
    if (reader.index.header.dataset !== codec.id) throw new CompactError("usage", `input ${i} is dataset ${reader.index.header.dataset}, the codec ${codec.name} is dataset ${codec.id}`);
  }
}

// ---------------------------------------------------------------- stage 1: the count

export interface RangeCount {
  readonly range: number;
  readonly of: number;
  // The distinct keys of the inputs in the range: the records the merge gives it.
  readonly count: number;
  // The inputs' records in the range, summed: equal to count when no key is in two inputs.
  readonly inputRecords: number;
  readonly first: string | null;
  readonly last: string | null;
}

async function* counted<R>(records: AsyncIterable<R>, tally: { n: number }): AsyncGenerator<R> {
  for await (const r of records) {
    tally.n += 1;
    yield r;
  }
}

export async function countRange<R>(inputs: readonly PackReader<R>[], codec: DatasetCodec<R>, cuts: readonly string[], range: number): Promise<RangeCount> {
  checkCuts(cuts);
  const { lo, hi } = rangeBounds(cuts, range);
  checkDatasets(inputs, codec);
  const tallies = inputs.map(() => ({ n: 0 }));
  let count = 0;
  let first: string | null = null;
  let last: string | null = null;
  for await (const record of mergeRecords(
    inputs.map((reader, i) => counted(reader.scan(lo, hi), tallies[i])),
    codec,
  )) {
    const key = codec.key(record);
    first ??= key;
    last = key;
    count += 1;
  }
  return { range, of: cuts.length + 1, count, inputRecords: tallies.reduce((n, t) => n + t.n, 0), first, last };
}

// ---------------------------------------------------------------- stage 2: the window and the part

export interface RangeWindow {
  readonly range: number;
  readonly of: number;
  // The part the range writes, or null when no block starts in it.
  readonly part: number | null;
  // The ordinal of the range's first key in the merged output.
  readonly offset: number;
  // The records at the range's start that fill the last block of the range before it.
  readonly skip: number;
  // The records the range writes, or null for all: one range alone.
  readonly take: number | null;
  // The records of the whole output, or null when one range alone is not counted.
  readonly total: number | null;
}

// The window of the one range of a merge that is not cut: every record, part 0.
export const WHOLE_WINDOW: RangeWindow = Object.freeze({ range: 0, of: 1, part: 0, offset: 0, skip: 0, take: null, total: null });

// The window of range r from the count of every range (stage 1).
export function windowOf(counts: readonly RangeCount[], range: number, recordsPerBlock: number): RangeWindow {
  const R = whole(recordsPerBlock, 1, 0xffff, "recordsPerBlock");
  if (!Array.isArray(counts) || counts.length === 0) throw new CompactError("plan", "no range count was given");
  const n = counts[0].of;
  whole(n, 1, MAX_RANGES, "the ranges of the counts");
  whole(range, 0, n - 1, "the range");
  const byRange: RangeCount[] = [];
  for (const c of counts) {
    if (c.of !== n) throw new CompactError("plan", `the count of range ${c.range} is of ${c.of} ranges, the others of ${n}`);
    whole(c.range, 0, n - 1, "a counted range");
    whole(c.count, 0, Number.MAX_SAFE_INTEGER, `the count of range ${c.range}`);
    if (byRange[c.range] !== undefined) throw new CompactError("plan", `range ${c.range} is counted twice`);
    byRange[c.range] = c;
  }
  for (let r = 0; r < n; r += 1) if (byRange[r] === undefined) throw new CompactError("plan", `range ${r} of ${n} has no count`);
  const total = byRange.reduce((t, c) => t + c.count, 0);
  let offset = 0;
  let part = 0;
  for (let r = 0; r < n; r += 1) {
    const c = byRange[r].count;
    const start = Math.ceil(offset / R) * R;
    const owns = start < offset + c;
    if (r === range) {
      if (!owns) return { range, of: n, part: null, offset, skip: 0, take: 0, total };
      const end = Math.min(Math.ceil((offset + c) / R) * R, total);
      return { range, of: n, part, offset, skip: start - offset, take: end - start, total };
    }
    if (owns) part += 1;
    offset += c;
  }
  throw new CompactError("usage", `range ${range} is not one of ${n}`);
}

export interface PartOptions {
  readonly compress: Compress;
  readonly recordsPerBlock?: number;
  readonly blockCodec?: number;
  readonly pageEntries?: number;
  readonly partLimit?: number;
}

// The output of one range: its part, and the keys that join it to the ranges beside it.
export interface RangeOutput {
  readonly range: number;
  readonly of: number;
  readonly part: number | null;
  readonly records: number;
  readonly first: string | null;
  readonly last: string | null;
  // The key of the record after the range's last, or null when none follows.
  readonly next: string | null;
  // The summary of the range's own writer: its blocks as part 0, its index,
  // the SHA-256 of its raw blocks. null for a range that owns no block.
  readonly summary: PackSummary | null;
}

// A sink that takes one part of a writer and passes it on as part `part`: its
// header says that number. A writer that starts a second part has more blocks
// than one part holds, which a range refuses (span).
class PartSink implements PackSink {
  readonly #part: number;
  readonly #down: PackSink;
  readonly #label: string;
  #headed = false;

  constructor(part: number, down: PackSink, label: string) {
    this.#part = whole(part, 0, 0xffff, "the part number");
    this.#down = down;
    this.#label = label;
  }

  async write(part: number, bytes: Uint8Array): Promise<void> {
    if (part !== 0) throw new CompactError("span", `${this.#label}: its blocks pass one part; plan more ranges`);
    if (this.#headed) {
      await this.#down.write(this.#part, bytes);
      return;
    }
    // The writer's first bytes of a part are its header (PackSink of @domains/pack).
    if (bytes.length < PART_HEADER_BYTES) throw new CompactError("usage", `${this.#label}: the writer's first write is ${bytes.length} B, shorter than a part header`);
    const header = readPartHeader(bytes.subarray(0, PART_HEADER_BYTES), `${this.#label}, the writer's part header`);
    if (header.part !== 0) throw new CompactError("usage", `${this.#label}: the writer's first part header names part ${header.part}`);
    this.#headed = true;
    await this.#down.write(this.#part, encodePartHeader({ ...header, part: this.#part }));
    if (bytes.length > PART_HEADER_BYTES) await this.#down.write(this.#part, bytes.subarray(PART_HEADER_BYTES));
  }
}

const writerFor = <R>(codec: DatasetCodec<R>, part: number, sink: PackSink, options: PartOptions, label: string): PackWriter<R> =>
  new PackWriter<R>({
    codec,
    compress: options.compress,
    sink: new PartSink(part, sink, label),
    recordsPerBlock: options.recordsPerBlock,
    blockCodec: options.blockCodec,
    pageEntries: options.pageEntries,
    partLimit: options.partLimit,
  });

// Writes range `window.range` of the merge: from the inputs' first key at or
// above the range's cut, it passes over `skip` records, writes `take` (all,
// for one range alone), and reads one record more for `next`. Inputs that end
// before the window does, or that hold a record past the output's last, are
// refused (range): the counts were not of these inputs.
export async function writeRange<R>(
  inputs: readonly PackReader<R>[],
  codec: DatasetCodec<R>,
  cuts: readonly string[],
  window: RangeWindow,
  sink: PackSink,
  options: PartOptions,
): Promise<RangeOutput> {
  checkCuts(cuts);
  if (window.of !== cuts.length + 1) throw new CompactError("plan", `the window is of ${window.of} ranges and the plan cuts ${cuts.length + 1}`);
  const label = `range ${window.range} of ${window.of}`;
  const base = { range: window.range, of: window.of };
  if (window.part === null) return { ...base, part: null, records: 0, first: null, last: null, next: null, summary: null };
  const { lo } = rangeBounds(cuts, window.range);
  checkDatasets(inputs, codec);
  const it = mergeRecords(
    inputs.map((reader) => reader.scan(lo)),
    codec,
  )[Symbol.asyncIterator]();
  try {
    for (let i = 0; i < window.skip; i += 1) {
      if ((await it.next()).done) throw new CompactError("range", `${label}: the inputs end after ${i} of the ${window.skip} records it passes over`);
    }
    const writer = writerFor(codec, window.part, sink, options, label);
    let records = 0;
    let first: string | null = null;
    let last: string | null = null;
    while (window.take === null || records < window.take) {
      const n = await it.next();
      if (n.done) {
        if (window.take !== null) throw new CompactError("range", `${label}: the inputs end after ${records} of the ${window.take} records its window holds`);
        break;
      }
      const key = codec.key(n.value);
      await writer.add(n.value);
      first ??= key;
      last = key;
      records += 1;
    }
    let next: string | null = null;
    if (window.take !== null) {
      const after = await it.next();
      next = after.done ? null : codec.key(after.value);
      const end = window.offset + window.skip + records;
      if (window.total !== null && (end === window.total) !== (next === null))
        throw new CompactError(
          "range",
          `${label}: its window ends at record ${end} of ${window.total}, and ${next === null ? "the inputs end there" : `the inputs go on at ${JSON.stringify(next.slice(0, 80))}`}`,
        );
    }
    const summary = await writer.finish();
    return { ...base, part: window.part, records, first, last, next, summary };
  } finally {
    await it.return?.(undefined);
  }
}

// ---------------------------------------------------------------- one process

// The ranged layout in one pass: the merged records go to one writer per range
// that owns a block, a new part starting at the first block that starts in a
// later range. Every range gets an output, empty for one that owns no block.
export async function mergeRanged<R>(inputs: readonly PackReader<R>[], codec: DatasetCodec<R>, cuts: readonly string[], sink: PackSink, options: PartOptions): Promise<RangeOutput[]> {
  checkCuts(cuts);
  const R = whole(options.recordsPerBlock ?? DEFAULT_RECORDS_PER_BLOCK, 1, 0xffff, "recordsPerBlock");
  const of = cuts.length + 1;
  const outputs: RangeOutput[] = [];
  const empty = (r: number): RangeOutput => ({ range: r, of, part: null, records: 0, first: null, last: null, next: null, summary: null });
  // The range being written: its writer and what it has taken.
  let open: { range: number; part: number; writer: PackWriter<R>; records: number; first: string | null; last: string | null } | null = null;
  const close = async (next: string | null): Promise<void> => {
    if (open === null) return;
    const summary = await open.writer.finish();
    outputs.push({ range: open.range, of, part: open.part, records: open.records, first: open.first, last: open.last, next, summary });
  };
  const start = (r: number, part: number): typeof open => {
    for (let skipped = outputs.length; skipped < r; skipped += 1) outputs.push(empty(skipped));
    return { range: r, part, writer: writerFor(codec, part, sink, options, `range ${r} of ${of}`), records: 0, first: null, last: null };
  };
  let written = 0;
  for await (const record of mergePacks(inputs, codec)) {
    const key = codec.key(record);
    if (written % R === 0) {
      const r = rangeOf(cuts, key);
      if (open === null || r !== open.range) {
        const part = open === null ? 0 : open.part + 1;
        await close(key);
        open = start(r, part);
      }
    }
    const at = open as NonNullable<typeof open>;
    await at.writer.add(record);
    at.first ??= key;
    at.last = key;
    at.records += 1;
    written += 1;
  }
  // A merge of no record writes one pack of no record: part 0, header alone.
  open ??= start(0, 0);
  await close(null);
  for (let r = outputs.length; r < of; r += 1) outputs.push(empty(r));
  return outputs;
}

// ---------------------------------------------------------------- assembly

// What assembleRanges takes of one range: its output, and its own index's
// block entries (part 0, offsets in its part) with the bytes of its part.
export interface RangeFacts {
  readonly range: number;
  readonly of: number;
  readonly part: number | null;
  readonly records: number;
  readonly first: string | null;
  readonly last: string | null;
  readonly next: string | null;
  readonly partBytes: number;
  readonly entries: readonly BlockEntry[];
}

export const factsOf = (out: RangeOutput): RangeFacts => ({
  range: out.range,
  of: out.of,
  part: out.part,
  records: out.records,
  first: out.first,
  last: out.last,
  next: out.next,
  partBytes: out.summary === null ? 0 : out.summary.parts.reduce((n, p) => n + p.bytes, 0),
  entries: out.summary === null ? [] : out.summary.entries,
});

export interface PackFormat {
  readonly dataset: number;
  readonly codec?: number;
  readonly recordsPerBlock?: number;
  readonly pageEntries?: number;
}

export interface Assembled {
  readonly idx: Uint8Array<ArrayBuffer>;
  readonly parts: readonly PartEntry[];
  readonly entries: readonly BlockEntry[];
  readonly records: number;
  readonly keyMin: string | null;
  readonly keyMax: string | null;
}

const shown = (key: string | null): string => (key === null ? "nothing" : JSON.stringify(key.length > 80 ? `${key.slice(0, 80)}...` : key));

// The index of the pack whose parts are the ranges' parts, in part order.
export function assembleRanges(ranges: readonly RangeFacts[], format: PackFormat): Assembled {
  if (!Array.isArray(ranges) || ranges.length === 0) throw new CompactError("plan", "no range output was given");
  const n = ranges[0].of;
  whole(n, 1, MAX_RANGES, "the ranges of the outputs");
  const byRange: RangeFacts[] = [];
  for (const f of ranges) {
    if (f.of !== n) throw new CompactError("plan", `range ${f.range} is of ${f.of} ranges, the others of ${n}`);
    whole(f.range, 0, n - 1, "a range");
    if (byRange[f.range] !== undefined) throw new CompactError("plan", `range ${f.range} is given twice`);
    byRange[f.range] = f;
  }
  for (let r = 0; r < n; r += 1) if (byRange[r] === undefined) throw new CompactError("plan", `range ${r} of ${n} is missing`);
  const owning = byRange.filter((f) => f.part !== null);
  if (owning.length === 0) throw new CompactError("plan", "no range wrote a part");
  const entries: BlockEntry[] = [];
  const parts: PartEntry[] = [];
  let records = 0;
  for (const [i, f] of owning.entries()) {
    if (f.part !== i) throw new CompactError("plan", `range ${f.range} wrote part ${f.part}, where part ${i} belongs: the parts are numbered in range order`);
    const before = owning[i - 1];
    if (before !== undefined && before.next !== f.first)
      throw new CompactError("range", `range ${before.range} ends before ${shown(before.next)} and range ${f.range} starts at ${shown(f.first)}: a record is lost or written twice between them`);
    let held = 0;
    let bytes = PART_HEADER_BYTES;
    for (const e of f.entries) {
      if (e.part !== 0) throw new CompactError("range", `range ${f.range}: its index names part ${e.part}; a range writes one part`);
      held += e.records;
      bytes += e.packed;
      entries.push({ ...e, index: entries.length, part: i });
    }
    if (held !== f.records) throw new CompactError("range", `range ${f.range}: its index holds ${held} records and its output says ${f.records}`);
    if (bytes !== f.partBytes) throw new CompactError("range", `range ${f.range}: its blocks fill ${bytes} B and its part is ${f.partBytes} B`);
    parts.push({ bytes: f.partBytes, firstBlock: entries.length - f.entries.length, blocks: f.entries.length });
    records += f.records;
  }
  const lastRange = owning[owning.length - 1];
  if (lastRange.next !== null) throw new CompactError("range", `range ${lastRange.range} writes the last part and the inputs go on at ${shown(lastRange.next)}`);
  const idx = encodeIdx({
    dataset: format.dataset,
    codec: format.codec ?? DEFAULT_CODEC,
    recordsPerBlock: format.recordsPerBlock ?? DEFAULT_RECORDS_PER_BLOCK,
    pageEntries: format.pageEntries ?? DEFAULT_PAGE_ENTRIES,
    records,
    parts,
    keyMin: owning[0].first,
    keyMax: lastRange.last,
    entries,
  });
  return { idx, parts, entries, records, keyMin: owning[0].first, keyMax: lastRange.last };
}

export interface BlockDigest {
  readonly sha256: string;
  readonly rawBytes: number;
}

// The identity of an assembled pack (docs/format.md section 8): the SHA-256 of
// its raw blocks in order, each read from its part, inflated and held to its
// CRC-32 and raw length. Each part's header is held to the index first: its
// part number, dataset, records a block and codec.
export async function hashParts<R>(idx: Uint8Array, parts: RangeSource, partSizes: readonly number[], codec: DatasetCodec<R>): Promise<BlockDigest> {
  const reader = await PackReader.open(idx, parts, codec, { partSizes });
  const h = reader.index.header;
  for (let p = 0; p < h.parts; p += 1) {
    const header = readPartHeader(await readPart(parts, p, 0, PART_HEADER_BYTES, `the header of part ${p}`), `part ${p}`);
    if (header.part !== p || header.dataset !== h.dataset || header.recordsPerBlock !== h.recordsPerBlock || header.codec !== h.codec)
      throw new CompactError(
        "range",
        `part ${p}: its header names part ${header.part}, dataset ${header.dataset}, ${header.recordsPerBlock} records a block and codec ${header.codec}; the index ${p}, ${h.dataset}, ${h.recordsPerBlock} and ${h.codec}`,
      );
  }
  const sha = new Sha256();
  let rawBytes = 0;
  for await (const e of reader.index.entries()) {
    const raw = await reader.readBlock(e);
    sha.update(raw);
    rawBytes += raw.length;
  }
  return { sha256: sha.hex(), rawBytes };
}

// ---------------------------------------------------------------- the merge of a span

export interface MergeOptions extends PartOptions {
  // The cuts of a range plan: the output takes the ranged layout. Without
  // them the parts are cut at partLimit, as writePack cuts them.
  readonly cuts?: readonly string[];
}

// The merge of the inputs into one pack, in one process: a streaming k-way
// merge that holds one block of each input and one output block. Its summary
// is writePack's, or, with cuts, the ranged layout's, its SHA-256 taken from
// the raw blocks as they are compressed.
export async function mergeSpan<R>(inputs: readonly PackReader<R>[], codec: DatasetCodec<R>, sink: PackSink, options: MergeOptions): Promise<PackSummary> {
  const cuts = options.cuts ?? [];
  if (cuts.length === 0) {
    return writePack(mergePacks(inputs, codec), {
      codec,
      compress: options.compress,
      sink,
      recordsPerBlock: options.recordsPerBlock,
      blockCodec: options.blockCodec,
      partLimit: options.partLimit ?? DEFAULT_PART_LIMIT,
      pageEntries: options.pageEntries,
    });
  }
  const sha = new Sha256();
  let rawBytes = 0;
  const compress: Compress = (c, raw) => {
    sha.update(raw);
    rawBytes += raw.length;
    return options.compress(c, raw);
  };
  const outputs = await mergeRanged(inputs, codec, cuts, sink, { ...options, compress });
  const format = {
    dataset: codec.id,
    codec: options.blockCodec ?? DEFAULT_CODEC,
    recordsPerBlock: options.recordsPerBlock ?? DEFAULT_RECORDS_PER_BLOCK,
    pageEntries: options.pageEntries ?? DEFAULT_PAGE_ENTRIES,
  };
  const asm = assembleRanges(outputs.map(factsOf), format);
  const partBytes = asm.parts.reduce((n, p) => n + p.bytes, 0);
  return {
    dataset: codec.id,
    codec: format.codec,
    recordsPerBlock: format.recordsPerBlock,
    pageEntries: format.pageEntries,
    records: asm.records,
    blocks: asm.entries.length,
    parts: asm.parts,
    entries: asm.entries,
    idx: asm.idx,
    sha256: sha.hex(),
    rawBytes,
    partBytes,
    bytes: partBytes + asm.idx.length,
    keyMin: asm.keyMin,
    keyMax: asm.keyMax,
  };
}
