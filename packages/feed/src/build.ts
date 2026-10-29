// packages/feed/src/build.ts — the rows of the feed, and the pack that holds
// them with its time copy.
//
//   for await (const row of buildFeedDay(dayDomains, exactNewKeys, { table, window: day })) ...
//   for await (const row of buildFeedHour(hourDomains, provisionalFilter, { table, window: hour })) ...
//   const { summary, time } = await writeFeedPack(rows, { compress, sink, time: { sink: timeSink } });
//
// A feed row is one registrable domain whose global first_seen falls in the
// span of its pack (docs/architecture.md sections 2 and 3.3): first_seen from
// firstSeen of @domains/ledger (a day counts as its start), the source bits of
// the record, and the basis bits, the confidence byte and the flags of
// confidenceOf (corroborated, suspect and its reasons: bit 4 suspect-cert and
// bit 5 suspect-rdap). A row whose first_seen falls outside the span is refused
// ("window"): the reader orders rows across packs by their spans, so a row
// outside its span would come out of order.
//
// buildFeedDay keeps the day's domain records that the exact join of DOM-021
// (exactNew) yielded; their rows are not provisional. buildFeedHour asks the
// hourly membership of DOM-021 (provisionalNew, the one rule of the hourly
// verdict) about each record and keeps the ones it did not hold, each
// `provisional`. Both take records in ascending key order, one a key, as a merge
// of the segments by key gives them (mergeRecords of @domains/pack), with the
// facts that a domain record does not hold (EventFacts) beside each.
//
// writeFeedPack writes the rows with the pack writer of @domains/pack: the key
// copy, and, when `time` is given, the time copy of docs/format.md section 14,
// the same rows in (first_seen, key) order as a pack of dataset 6 (feed) or 7
// (new-name), to a sink of its own. The time copy needs every row in memory to
// sort them, and its key holds first_seen in 4 bytes: writeFeedPack reads every
// row and checks each first_seen before it writes a byte to either sink, so a
// first_seen above 2^32 - 1 leaves both sinks empty. A row the key copy's
// writer refuses (a key out of order, a field out of range) is refused when it
// is written, and the key sink then holds the parts written before it, as
// after any refusal of the writer (docs/format.md section 6.6); the time sink
// holds nothing. Without `time` the rows stream to the key copy and none is
// held.
import { DAY_SECONDS, firstSeen, type MembershipFilter, provisionalNew } from "@domains/ledger";
import {
  type Compress,
  type DatasetCodec,
  type DomainRecord,
  FEED_CODEC,
  FEED_PROVISIONAL,
  type FeedRecord,
  MAX_TIME_FIRST_SEEN,
  type PackSink,
  type PackSummary,
  timeCodecOf,
  writePack,
} from "@domains/pack";
import { type ConfidenceContext, confidenceOf, type EventFacts } from "./confidence.ts";
import { FeedError } from "./errors.ts";
import type { SourceTable } from "./sources.ts";
import { checkWindow, HOUR_SECONDS, type Window } from "./time.ts";

// A domain record with the facts of its events that the record does not hold.
export interface DomainEvent extends DomainRecord {
  readonly facts?: EventFacts;
}

export interface BuildContext {
  readonly table: SourceTable;
  // The span of the pack: one UTC day for buildFeedDay, one UTC hour for buildFeedHour.
  readonly window: Window;
}

// The feed row of one domain record.
export function feedRowOf(event: DomainEvent, context: BuildContext, provisional: boolean): FeedRecord {
  const window = checkWindow(context.window, "the span of the pack");
  const first = firstSeen(event, context.table.precision);
  if (first.at < window.t0 || first.at >= window.t1)
    throw new FeedError("window", `the domain ${JSON.stringify(event.key.slice(0, 80))} has first_seen ${first.at}, outside the span [${window.t0}, ${window.t1}) of its pack`);
  const ctx: ConfidenceContext = { table: context.table, window, facts: event.facts };
  const c = confidenceOf(event.sources, event.evidence, ctx);
  return {
    key: event.key,
    flags: event.flags,
    firstSeen: first.at,
    sources: event.sources.map((s) => s.bit),
    basis: c.basis,
    confidence: c.oiLevel,
    feedFlags: (provisional ? FEED_PROVISIONAL : 0) | c.feedFlags,
  };
}

function checkAligned(window: Window, length: number, what: string): Window {
  const w = checkWindow(window, `the span of ${what}`);
  if (w.t0 % length !== 0 || w.t1 - w.t0 !== length) throw new FeedError("window", `the span of ${what} [${w.t0}, ${w.t1}) is not one whole UTC ${length === DAY_SECONDS ? "day" : "hour"}`);
  return w;
}

async function* ascending(records: Iterable<DomainEvent> | AsyncIterable<DomainEvent>, what: string): AsyncGenerator<DomainEvent> {
  let prev: string | null = null;
  for await (const record of records) {
    if (prev !== null && !(record.key > prev)) throw new FeedError("order", `${what}: the key ${JSON.stringify(record.key.slice(0, 80))} is not above the key before it`);
    prev = record.key;
    yield record;
  }
}

// The rows of a day pack: the day's domain records that the exact join kept.
// Every key of `exactNewKeys` must be among the records, or the join and the
// records are of two different days, and the build is refused.
export async function* buildFeedDay(day: Iterable<DomainEvent> | AsyncIterable<DomainEvent>, exactNewKeys: Iterable<string>, context: BuildContext): AsyncGenerator<FeedRecord> {
  checkAligned(context.window, DAY_SECONDS, "a day pack");
  const wanted = new Set(exactNewKeys);
  let met = 0;
  for await (const record of ascending(day, "buildFeedDay")) {
    if (!wanted.has(record.key)) continue;
    met += 1;
    yield feedRowOf(record, context, false);
  }
  if (met !== wanted.size) throw new FeedError("usage", `buildFeedDay: the exact join names ${wanted.size - met} key(s) that the day's records do not hold`);
}

// The rows of an hour pack: the hour's domain records that the membership did
// not hold, each added to it before the next record is asked.
export async function* buildFeedHour(hour: Iterable<DomainEvent> | AsyncIterable<DomainEvent>, membership: MembershipFilter, context: BuildContext): AsyncGenerator<FeedRecord> {
  checkAligned(context.window, HOUR_SECONDS, "an hour pack");
  for await (const record of ascending(hour, "buildFeedHour")) {
    if (provisionalNew([record.key], membership).length === 0) continue;
    yield feedRowOf(record, context, true);
  }
}

export interface TimeCopyOptions {
  // The sink of the time copy's parts: the layers time.part.NNN.
  readonly sink: PackSink;
  readonly recordsPerBlock?: number;
  readonly partLimit?: number;
  readonly pageEntries?: number;
}

export interface FeedPackOptions {
  // FEED_CODEC (the default) or NEW_NAME_CODEC.
  readonly codec?: DatasetCodec<FeedRecord>;
  readonly compress: Compress;
  readonly sink: PackSink;
  readonly recordsPerBlock?: number;
  readonly partLimit?: number;
  readonly pageEntries?: number;
  // The time copy: written when given (docs/format.md section 14). DOM-023 is
  // to write one for every d, w, m and y pack of feed and new-name, which
  // readFeed refuses without one (TIME_COPY_TIERS); whether an hour pack is
  // small enough to sort in a Worker is not measured.
  readonly time?: TimeCopyOptions;
}

export interface FeedPack {
  // The key copy: its index is the layer idx, its parts part.NNN.
  readonly summary: PackSummary;
  // The time copy, or null when none was asked for: its index is the layer
  // time.idx, its parts time.part.NNN.
  readonly time: PackSummary | null;
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_TIME_FIRST_SEEN;

// Writes the rows, in ascending key order, as a pack, and its time copy when
// `time` is given.
export async function writeFeedPack(rows: Iterable<FeedRecord> | AsyncIterable<FeedRecord>, options: FeedPackOptions): Promise<FeedPack> {
  const codec = options.codec ?? FEED_CODEC;
  const keyOptions = { codec, compress: options.compress, sink: options.sink, recordsPerBlock: options.recordsPerBlock, partLimit: options.partLimit, pageEntries: options.pageEntries };
  if (options.time === undefined) return { summary: await writePack(rows, keyOptions), time: null };
  const timeCodec = timeCodecOf(codec.id);
  if (timeCodec === null) throw new FeedError("usage", `writeFeedPack: dataset ${codec.id} (${codec.name}) has no time copy`);
  const held: FeedRecord[] = [];
  for await (const row of rows) {
    if (!isTime(row.firstSeen))
      throw new FeedError(
        "time",
        `the row ${JSON.stringify(String(row.key).slice(0, 80))} has first_seen ${String(row.firstSeen)}, not 0 to ${MAX_TIME_FIRST_SEEN}, which the time copy's key holds; nothing is written`,
      );
    held.push(row);
  }
  const summary = await writePack(held, keyOptions);
  // The key copy's writer took the rows in ascending key order, one a key, so
  // (first_seen, key) orders them with no tie.
  held.sort((a, b) => a.firstSeen - b.firstSeen || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // The time copy is written from the rows the key copy took, with the time
  // codec of the key copy's dataset, so the two heads bind by construction: no
  // bind check here could refuse. The reader and the verifier hold the bind.
  const time = await writePack(held, {
    codec: timeCodec,
    compress: options.compress,
    sink: options.time.sink,
    recordsPerBlock: options.time.recordsPerBlock,
    partLimit: options.time.partLimit,
    pageEntries: options.time.pageEntries,
  });
  return { summary, time };
}
