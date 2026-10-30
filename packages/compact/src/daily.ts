// packages/compact/src/daily.ts — the exact feed of a day and the daily
// rebuild of the provisional filter (DOM-023, docs/architecture.md sections
// 4.5 and 5.8 step 5, TODO/storage.md the Found lines of DOM-021 and DOM-023).
//
//   const day = dayOf("2026-10-27");                       the span, its seconds since 2026-01-01, its tags
//   const base = basePacks(root, day);                     the live domains packs that end by the day's start
//   const ledger = checkLedger(old, day);                  the live filter and delta, paired, older than the day's end
//   const built = await buildDay({ day, records, base, carry, registry, compress, sink, time: { sink } });
//   const next = await rebuildLedger([...baseReaders, dayReader], day, ledger);   ledger-filter-DATE and ledger-delta
//   const manifest = packManifest({ ..., extra: [{ title: SUMMARY_TITLE, mediaType: SUMMARY_MEDIA_TYPE, bytes: built.summaryBytes }] });
//
// The day pack of `feed` is the exact join, not a merge of the hour packs
// (docs/architecture.md section 4.5): exactNew of @domains/ledger merge-joins
// the day's domain records with every earlier `domains` pack, with `since` the
// day's start in seconds and the precision of each source, so a domain that
// its own source dates before the day is not new (the Found of DOM-021,
// 2026-10-29T05:20Z). buildFeedDay of @domains/feed makes the rows of the
// domains the join kept, and carries the suspect verdicts of the day's hour
// packs into them, which a domain record cannot hold. writeFeedPack writes
// the pack and its time copy.
//
// The day's records are read twice, once for the join and once for the rows,
// so `records` is a function that opens a new scan each call. A pack of the
// day that the root marks quarantined (ruling 23) is no input of the join: its
// names are served, never as new.
//
// The layer summary.json of the day pack (docs/format.md section 16): new
// registrable domains a suffix, and a source, as GET /v1/suffixes of DOM-033
// sums them over the days of a window.
//
// The ledger. The filter is rebuilt from every `domains` pack through the
// day's end (buildFilter), with as_of that end. The live delta moves to it
// with rebase, which keeps the hashes the new filter lacks: the domains first
// seen after the day's end, which the hour jobs since added. An empty delta
// would lose them and the next hours would judge them new again. The live
// filter and delta are held to each other before anything is built, and a
// live filter as of the day's end or later is not moved back: equal is a
// re-run of this day (`present`), later is a day compacted out of order
// (refused, plan).
//
// It imports nothing from `node:` and is type-checked as Worker code
// (tsconfig.worker.json); no test runs it in workerd.
import { buildFeedDay, type CarryStats, type FeedPack, newCarryStats, type SourceRowLike, sourceTable, writeFeedPack } from "@domains/feed";
import { ledgerFilterTag, tierTag } from "@domains/ghcr";
import { BloomFilter, buildFilter, type ExactStats, exactNew, HashDelta, newExactStats, ProvisionalFilter } from "@domains/ledger";
import { fromKey } from "@domains/names";
import { type Compress, DATASET_DOMAINS, type DomainRecord, FEED_CODEC, FEED_SUSPECT, type FeedRecord, type PackReader, type PackSink } from "@domains/pack";
import { isoOf, msOf, type PackEntry } from "@domains/root";
import { CompactError } from "./errors.ts";
import { isQuarantined } from "./plan.ts";

const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(2026, 0, 1);
const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

export const SUMMARY_FORMAT = "domains.feed-summary.v1";
export const SUMMARY_TITLE = "summary.json";
export const SUMMARY_MEDIA_TYPE = "application/json";
// The titles of the ledger's two files, which a workflow pushes as the one
// layer of `ledger-filter-DATE` and of `ledger-delta` (docs/format.md section 15).
export const FILTER_TITLE = "filter.dlbf";
export const DELTA_TITLE = "delta.dlbd";

export interface Day {
  // YYYY-MM-DD, its start YYYY-MM-DDT00:00:00Z and the next day's start.
  readonly date: string;
  readonly start: string;
  readonly end: string;
  // Seconds since 2026-01-01T00:00:00Z: the window [t0, t1) of the day pack.
  readonly t0: number;
  readonly t1: number;
  // The tags the span gives (tierTag): domains-d-YYYYMMDD and feed-d-YYYYMMDD,
  // and the tag of the filter built through the day's end, ledger-filter-YYYYMMDD
  // (ledgerFilterTag of @domains/ghcr).
  readonly domainsTag: string;
  readonly feedTag: string;
  readonly filterTag: string;
}

// The day of `text`, YYYY-MM-DD, a day that exists, from 2026-01-01.
export function dayOf(text: string): Day {
  const m = typeof text === "string" ? DAY_TEXT.exec(text) : null;
  const ms = m === null ? Number.NaN : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (m === null || Number.isNaN(ms) || isoOf(ms).slice(0, 10) !== text) throw new CompactError("usage", `the day ${JSON.stringify(text)} is not YYYY-MM-DD of a day that exists`);
  if (ms < EPOCH_MS) throw new CompactError("usage", `the day ${text} is before 2026-01-01, the epoch of every stored time`);
  const start = isoOf(ms);
  return {
    date: text,
    start,
    end: isoOf(ms + DAY_MS),
    t0: (ms - EPOCH_MS) / 1000,
    t1: (ms + DAY_MS - EPOCH_MS) / 1000,
    domainsTag: tierTag("domains", "d", start),
    feedTag: tierTag("feed", "d", start),
    filterTag: ledgerFilterTag(start),
  };
}

// The inputs of the day whose records the exact join reads: those the root
// does not mark quarantined (isQuarantined of plan.ts, planTier's reading).
// `left` names the others. `sources` are the sources of the inputs read,
// sorted: a quarantined input gives the feed no row, so the feed pack does not
// name its source (AGENTS.md absolute 11). When none is left, the day pack
// itself is the join's records.
export function joinInputs<R>(entries: readonly PackEntry[], readers: readonly R[]): { readonly readers: readonly R[]; readonly left: readonly PackEntry[]; readonly sources: readonly string[] } {
  if (entries.length !== readers.length) throw new CompactError("usage", `joinInputs: ${entries.length} pack entries and ${readers.length} readers`);
  const kept: R[] = [];
  const left: PackEntry[] = [];
  const sources = new Set<string>();
  for (const [i, p] of entries.entries()) {
    if (isQuarantined(p)) left.push(p);
    else {
      kept.push(readers[i]);
      for (const s of p.sources) sources.add(s);
    }
  }
  return { readers: kept, left, sources: [...sources].sort() };
}

// The live domains packs that end by the day's start: the earlier tiers of
// the exact join, and, with the day pack, the table of the filter. A pack
// that starts before the day and ends after its start is refused (straddle):
// planTier refuses it for the day too.
export function basePacks(live: { readonly datasets: Readonly<Record<string, readonly PackEntry[]>> }, day: Day): PackEntry[] {
  const t0 = msOf(day.start, "the day");
  const out: PackEntry[] = [];
  for (const p of live.datasets.domains ?? []) {
    const a = msOf(p.span.start, `${p.tag} span.start`);
    const b = msOf(p.span.end, `${p.tag} span.end`);
    if (b <= t0) out.push(p);
    else if (a < t0) throw new CompactError("straddle", `${p.tag} (tier ${p.tier}, ${p.span.start} to ${p.span.end}) crosses the start of the day ${day.start}`);
  }
  return out;
}

// ---------------------------------------------------------------- summary.json

export interface SuffixCount {
  // The rows of the day pack under the suffix: one a registrable domain.
  new_registrable: number;
  // Those of them flagged suspect, which the default feed hides.
  suspect: number;
  // The rows a source carries: a row of two sources counts once under each.
  by_source: Record<string, number>;
}

export interface DaySummary {
  readonly format: typeof SUMMARY_FORMAT;
  readonly day: string;
  readonly rows: number;
  readonly suffixes: Readonly<Record<string, SuffixCount>>;
}

// The counts of summary.json, row by row. A row's suffix is its registrable
// domain less its first label: the key less its last label, as a name
// (`np.com.example` is example.com.np, under com.np). No list is read: a feed
// key is a registrable domain, the suffix and one label, under the PSL of the
// pack.
export class SummaryCounter {
  readonly #day: string;
  readonly #id: (bit: number) => string;
  readonly #suffixes = new Map<string, { n: number; suspect: number; by: Map<string, number> }>();
  #rows = 0;

  constructor(day: Day, id: (bit: number) => string) {
    this.#day = day.date;
    this.#id = id;
  }

  add(row: FeedRecord): void {
    const cut = row.key.lastIndexOf(".");
    if (cut <= 0) throw new CompactError("usage", `the feed row ${JSON.stringify(row.key.slice(0, 80))} is not a registrable domain: it has no suffix`);
    const suffix = fromKey(row.key.slice(0, cut));
    let c = this.#suffixes.get(suffix);
    if (c === undefined) {
      c = { n: 0, suspect: 0, by: new Map() };
      this.#suffixes.set(suffix, c);
    }
    c.n += 1;
    if ((row.feedFlags & FEED_SUSPECT) !== 0) c.suspect += 1;
    for (const bit of row.sources) {
      const id = this.#id(bit);
      c.by.set(id, (c.by.get(id) ?? 0) + 1);
    }
    this.#rows += 1;
  }

  // The summary, every map in ascending key order, so one day gives one byte string.
  toJSON(): DaySummary {
    const sorted = <V>(m: Map<string, V>): [string, V][] => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const suffixes: Record<string, SuffixCount> = {};
    for (const [s, c] of sorted(this.#suffixes)) suffixes[s] = { new_registrable: c.n, suspect: c.suspect, by_source: Object.fromEntries(sorted(c.by)) };
    return { format: SUMMARY_FORMAT, day: this.#day, rows: this.#rows, suffixes };
  }

  // The bytes of the layer: compact JSON and one final newline.
  bytes(): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(this.toJSON())}\n`);
  }
}

// ---------------------------------------------------------------- the day pack

export interface DayInput {
  readonly day: Day;
  // A new scan of the day's domain records in key order, each call: the
  // domains day pack, or the merge of its unquarantined inputs.
  readonly records: () => AsyncIterable<DomainRecord>;
  // The earlier domains packs (basePacks), opened.
  readonly base: readonly PackReader<DomainRecord>[];
  // The rows of the day's hour packs of feed, merged by key (mergePacks with FEED_CODEC).
  readonly carry?: AsyncIterable<FeedRecord> | Iterable<FeedRecord>;
  readonly registry: readonly SourceRowLike[];
  readonly compress: Compress;
  readonly sink: PackSink;
  readonly time: { readonly sink: PackSink };
  readonly recordsPerBlock?: number;
  readonly pageEntries?: number;
}

export interface BuiltDay extends FeedPack {
  readonly exact: ExactStats;
  // What the carry of the hour rows did (CarryStats of @domains/feed).
  readonly carry: CarryStats;
  readonly rows: number;
  readonly daySummary: DaySummary;
  readonly summaryBytes: Uint8Array;
}

export async function buildDay(input: DayInput): Promise<BuiltDay> {
  for (const [i, r] of input.base.entries()) {
    if (r.index.header.dataset !== DATASET_DOMAINS) throw new CompactError("usage", `buildDay: earlier pack ${i} is dataset ${r.index.header.dataset}, not ${DATASET_DOMAINS} (domains)`);
  }
  const table = sourceTable(input.registry);
  const window = { t0: input.day.t0, t1: input.day.t1 };
  const exact = newExactStats();
  const keys: string[] = [];
  for await (const r of exactNew(input.records(), input.base, { since: input.day.t0, precision: table.precision, stats: exact })) keys.push(r.key);
  const carry = newCarryStats();
  const counter = new SummaryCounter(input.day, table.id);
  let rows = 0;
  async function* counted(): AsyncGenerator<FeedRecord> {
    const built = buildFeedDay(input.records(), keys, { table, window, ...(input.carry === undefined ? {} : { carry: input.carry }), carryStats: carry });
    for await (const row of built) {
      counter.add(row);
      rows += 1;
      yield row;
    }
  }
  const pack = await writeFeedPack(counted(), {
    codec: FEED_CODEC,
    compress: input.compress,
    sink: input.sink,
    recordsPerBlock: input.recordsPerBlock,
    pageEntries: input.pageEntries,
    time: { sink: input.time.sink, recordsPerBlock: input.recordsPerBlock, pageEntries: input.pageEntries },
  });
  return { ...pack, exact, carry, rows, daySummary: counter.toJSON(), summaryBytes: counter.bytes() };
}

// ---------------------------------------------------------------- the ledger

export interface LiveLedger {
  readonly filter: BloomFilter;
  readonly delta: HashDelta;
}

export interface LedgerCheck {
  // `write`: the day moves the ledger forward; `present`: the live filter is
  // the one through this day's end, a re-run.
  readonly action: "write" | "present";
  // The live ledger, or null for the first build.
  readonly live: LiveLedger | null;
}

// The live ledger, decoded and held to itself and to the day: the delta
// paired with the filter (ProvisionalFilter refuses another, LedgerError
// pair), and the filter not newer than the day's end. `old` is null for the
// first build of the ledger, which then starts with an empty delta.
export function checkLedger(old: { readonly filter: Uint8Array; readonly delta: Uint8Array } | null, day: Day): LedgerCheck {
  if (old === null) return { action: "write", live: null };
  const filter = BloomFilter.decode(old.filter);
  const delta = HashDelta.decode(old.delta);
  const live = new ProvisionalFilter(filter, delta);
  if (filter.asOf === day.t1) return { action: "present", live };
  if (filter.asOf > day.t1)
    throw new CompactError(
      "plan",
      `the live filter holds the domains table through ${isoOf(EPOCH_MS + filter.asOf * 1000)}, after the day ends at ${day.end}: the day job of an earlier day does not move the filter back`,
    );
  return { action: "write", live };
}

export interface RebuiltLedger {
  readonly filter: Uint8Array<ArrayBuffer>;
  readonly delta: Uint8Array<ArrayBuffer>;
  readonly keys: number;
  // The hashes of the live delta, those the new delta keeps and those the new filter holds.
  readonly before: number;
  readonly kept: number;
}

// The filter of every domains pack through the day's end, as of that end,
// and the live delta rebased onto it.
export async function rebuildLedger(packs: readonly PackReader<DomainRecord>[], day: Day, check: LedgerCheck): Promise<RebuiltLedger> {
  if (check.action !== "write") throw new CompactError("usage", "rebuildLedger: the live filter is this day's already");
  const filter = await buildFilter(packs, { asOf: day.t1 });
  const next = check.live === null ? HashDelta.empty(filter) : check.live.delta.rebase(filter);
  return { filter: filter.encode(), delta: next.encode(), keys: filter.keys, before: check.live?.delta.size ?? 0, kept: next.size };
}
