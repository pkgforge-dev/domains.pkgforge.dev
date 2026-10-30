// packages/compact/src/time.ts — the time copy of a feed or new-name tier pack
// (docs/format.md section 14): the same rows as its key copy, in
// (first_seen, key) order.
//
//   timeMode(keyRecords, inputRecords, timeInputs)       "merge" or "sort"
//   await mergeSpan(timeReaders, timeCodecOf(3), sink, options)   the merge: a k-way merge of the inputs' time copies by time key
//   await sortTimeCopy(rows, FEED_CODEC, sink, options)          the sort: every row held, sorted, written
//   bindFault(keyIdx, timeIdx, span)                     timeBindFault of @domains/pack, with the span in ISO form
//
// A merge of packs with no key in two inputs moves no row: each output row is
// one input row, so its first_seen and its time key are the input's, and the
// output's time copy is the k-way merge of the inputs' time copies by time
// key. That needs no row in memory. When a key is in two inputs, the merged
// row takes the least first_seen and the other row's time key goes, so the
// time copy is sorted from the merged rows instead, and every row is held.
// Which of the two holds is read from counts the merge already has: the
// merge's records equal the inputs' records exactly when no key is in two
// inputs. The sort is the one writeFeedPack of @domains/feed does (a test
// holds the two equal byte for byte), and it refuses more than `maxRows` rows
// before it writes a byte (CompactError sort).
//
// It imports nothing from `node:` and is type-checked as Worker code
// (tsconfig.worker.json); no test runs it in workerd.
import { msOf } from "@domains/root";
import { type DatasetCodec, type FeedRecord, MAX_TIME_FIRST_SEEN, type PackSink, type PackSummary, parseHead, timeBindFault, timeCodecOf, writePack } from "@domains/pack";
import { CompactError } from "./errors.ts";
import type { PartOptions } from "./range.ts";

// The rows a sort holds at most: about 2 GB of heap at about 200 B a row [E];
// a runner has 16 GB (docs/architecture.md section 5.1). Not measured.
export const DEFAULT_SORT_ROWS = 10_000_000;
const EPOCH_MS = Date.UTC(2026, 0, 1);

export type TimeMode = "merge" | "sort";

// "merge" when no key of the merge was in two inputs and every input has a
// time copy to merge; "sort" otherwise.
export function timeMode(keyRecords: number, inputRecords: number, everyInputHasTime: boolean): TimeMode {
  if (!Number.isSafeInteger(keyRecords) || !Number.isSafeInteger(inputRecords) || keyRecords < 0 || keyRecords > inputRecords)
    throw new CompactError("usage", `a merge of ${inputRecords} input records cannot give ${keyRecords} records`);
  return keyRecords === inputRecords && everyInputHasTime ? "merge" : "sort";
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_TIME_FIRST_SEEN;

export interface SortOptions extends PartOptions {
  readonly maxRows?: number;
}

// The time copy of `rows` (a key copy's rows, in any order) by a sort in memory.
export async function sortTimeCopy(rows: AsyncIterable<FeedRecord> | Iterable<FeedRecord>, keyCodec: DatasetCodec<FeedRecord>, sink: PackSink, options: SortOptions): Promise<PackSummary> {
  const timeCodec = timeCodecOf(keyCodec.id);
  if (timeCodec === null) throw new CompactError("usage", `dataset ${keyCodec.id} (${keyCodec.name}) has no time copy`);
  const max = options.maxRows ?? DEFAULT_SORT_ROWS;
  if (!Number.isSafeInteger(max) || max < 1) throw new CompactError("usage", `maxRows is ${String(max)}, not a whole number of at least 1`);
  const held: FeedRecord[] = [];
  for await (const row of rows) {
    if (held.length === max) throw new CompactError("sort", `the time copy holds more than the ${max} rows a sort in memory holds; nothing is written`);
    if (!isTime(row.firstSeen))
      throw new CompactError("time", `the row ${JSON.stringify(String(row.key).slice(0, 80))} has first_seen ${String(row.firstSeen)}, which a time key cannot hold; nothing is written`);
    held.push(row);
  }
  // The order of writeFeedPack: (first_seen, key), no tie when one row a key.
  held.sort((a, b) => a.firstSeen - b.firstSeen || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return writePack(held, {
    codec: timeCodec,
    compress: options.compress,
    sink,
    recordsPerBlock: options.recordsPerBlock,
    blockCodec: options.blockCodec,
    partLimit: options.partLimit,
    pageEntries: options.pageEntries,
  });
}

// Why the time copy `timeIdx` is not the copy of `keyIdx` for the span, read
// from the two index heads; null when it binds.
export function bindFault(keyIdx: Uint8Array, timeIdx: Uint8Array, span: { readonly start: string; readonly end: string }): string | null {
  const t0 = (msOf(span.start, "span.start") - EPOCH_MS) / 1000;
  const t1 = (msOf(span.end, "span.end") - EPOCH_MS) / 1000;
  return timeBindFault(parseHead(keyIdx, keyIdx.length), parseHead(timeIdx, timeIdx.length), { t0, t1 });
}
