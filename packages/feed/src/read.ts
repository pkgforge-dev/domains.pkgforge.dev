// packages/feed/src/read.ts — one page of feed rows in first_seen order.
//
//   const plan = planWindow(root.datasets, { t0, t1, suffix: "com.np" });
//   const page = await readFeed(plan, { open, table, order: "first_seen.desc", limit: 1000, after: cursor, filter });
//   page.rows       FeedRecord[], in order
//   page.next       the cursor of the next page, or null
//   page.partial    true when the block budget stopped the page early
//   page.stats      the packs opened, the copy each was read from, the blocks read, the rows decoded
//
// The order is (first_seen, key), ascending for first_seen.asc and the reverse
// for first_seen.desc. The spans of the live packs are disjoint and every row's
// first_seen lies in the span of its pack (build.ts refuses another), so the
// packs are read one after another in span order, and the rows of each pack
// come out in order. Each pack is read from one of its two copies
// (docs/format.md section 14):
//   - the time copy, the rows in (first_seen, key) order, when the pack has
//     one and either no key range applies or the key range is wide (below):
//     the window's bounds, and the cursor, are time keys, so the index finds
//     the first block of the page, and the page reads blocks in order until it
//     holds its rows. Each row is checked against the key range and the
//     filters after its block is read, so a row they drop costs its block too.
//     No sort.
//   - the key copy, when the pack has no time copy (an hour pack, a segment),
//     or the key range is narrow: every block of the range is read, the rows
//     kept, and sorted in memory. A pack of tier d, w, m or y (TIME_COPY_TIERS)
//     that has no time copy is refused ("time") before a block is read, so no
//     page sorts one whole; that a writer gives each such pack its time copy is
//     DOM-023's.
// The key range rule. The key copy reads the R blocks of the range, all of
// them. The time copy reads blocks until the page holds the `want` rows it
// still takes; if the rows of the range are spread over the day as over the
// key copy, the range holds R/B of the rows of a block of the time copy (B the
// blocks of the pack), so the page reads about want * B / (R * r) blocks of r
// records. The reader takes the key copy when R <= want * B / (R * r), that is
// R * R * r <= want * B, and when R fits the budget left: for 1,000 rows of a
// pack of 123 blocks of 4,096, a range of 5 blocks or fewer. A filter that
// drops most rows (suspect=only, basis=rdap) makes the time copy read more than
// the estimate, which does not know the filter; the budget bounds that page.
//
// A cursor is the (first_seen, key) of the last row of a page; the next page
// starts strictly after it, so no row comes twice and none is skipped.
//
// The block budget (docs/architecture.md section 7.6: at most 2,000 blocks a
// request) bounds the work, over both copies. When the next block would pass
// it, the page ends with `partial: true` and a cursor at its last row. A page
// that cannot give one row inside the budget is refused ("budget"): a cursor
// that does not move would hand the caller the same page forever.
//
// The bind. Before it reads a block of a time copy, readFeed holds the two
// index heads to each other (timeBindFault of @domains/pack): the time copy is
// the time dataset of the key copy, holds as many records, and its first and
// last first_seen lie inside the pack's span. A copy that does not bind is
// refused ("time"). That it holds exactly the rows of the key copy is the
// `time` check of verifyPack, which reads every row of both before the pack is
// promoted.
import { type FeedRecord, MAX_TIME_FIRST_SEEN, type PackReader, timeBindFault, timeKey } from "@domains/pack";
import { FeedError } from "./errors.ts";
import { checkFilter, type FeedFilter, rowMatches } from "./filter.ts";
import { DATASET_OF_KIND, inRange, type LivePack, type PlannedPack, type WindowPlan } from "./plan.ts";
import type { SourceTable } from "./sources.ts";
import { dayStart, inWindow } from "./time.ts";

export type FeedOrder = "first_seen.desc" | "first_seen.asc";
export const FEED_ORDERS: readonly FeedOrder[] = Object.freeze(["first_seen.desc", "first_seen.asc"]);
export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 10_000;
export const DEFAULT_MAX_BLOCKS = 2000;
// Which copy a pack is read from: by the rule above, or one copy forced (a
// test, the bench). "time" reads the key copy of a pack that has no time copy.
export type CopyChoice = "auto" | "key" | "time";
export const COPY_CHOICES: readonly CopyChoice[] = Object.freeze(["auto", "key", "time"]);
export type FeedCopy = "key" | "time";
// The tiers whose packs are read through their time copy: a live pack of one
// of them that has none is refused ("time"). An hour pack and a segment (`h`,
// `seg`) may have none, and are read from their key copy and a sort.
export const TIME_COPY_TIERS: readonly string[] = Object.freeze(["d", "w", "m", "y"]);

export interface FeedCursor {
  readonly firstSeen: number;
  readonly key: string;
}

export interface OpenedPack {
  // The key copy: the layers idx and part.NNN.
  readonly reader: PackReader<FeedRecord>;
  // The time copy, opened with FEED_TIME_CODEC or NEW_NAME_TIME_CODEC over the
  // layers time.idx and time.part.NNN; null when the pack has none.
  readonly time: PackReader<FeedRecord> | null;
}

export interface ReadOptions<P extends LivePack> {
  // Opens a pack of the plan: the Worker reads GHCR through packages/ghcr, a
  // test reads memory. It is called once a page for each pack the page reads,
  // and opens the time copy exactly when the pack lists one.
  open(pack: P): Promise<OpenedPack>;
  readonly table: SourceTable;
  readonly order?: FeedOrder;
  readonly limit?: number;
  readonly after?: FeedCursor | null;
  readonly filter?: FeedFilter;
  readonly maxBlocks?: number;
  readonly copy?: CopyChoice;
}

export interface FeedStats {
  // The tags of the packs the page opened, in the order it read them, and the
  // copy each was read from.
  readonly packsRead: string[];
  readonly copiesRead: FeedCopy[];
  // The blocks read, of both copies, and of the time copies alone.
  blocksRead: number;
  timeBlocksRead: number;
  rowsDecoded: number;
}

export interface FeedPage {
  readonly rows: FeedRecord[];
  readonly next: FeedCursor | null;
  readonly partial: boolean;
  readonly stats: FeedStats;
}

// (first_seen, key), ascending.
export const compareRows = (a: FeedCursor, b: FeedCursor): number => a.firstSeen - b.firstSeen || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// The key copy and a sort, for a key range of `rangeBlocks` of the key copy's
// `blocks` blocks, when the time copy holds `recordsPerBlock` records a block
// and the page still takes `want` rows: the rule of the header.
export function keyCopyFirst(rangeBlocks: number, blocks: number, recordsPerBlock: number, want: number): boolean {
  return rangeBlocks * rangeBlocks * recordsPerBlock <= want * blocks;
}

interface PackRead {
  readonly rows: FeedRecord[];
  readonly stopped: boolean;
}

class Budget {
  left: number;
  constructor(max: number) {
    this.left = max;
  }
}

function wholeIn(value: number | undefined, fallback: number, min: number, max: number, what: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max) throw new FeedError("usage", `${what} ${v} is not a whole number of ${min} to ${max}`);
  return v;
}

export async function readFeed<P extends LivePack>(plan: WindowPlan<P>, options: ReadOptions<P>): Promise<FeedPage> {
  const order = options.order ?? "first_seen.desc";
  if (!FEED_ORDERS.includes(order)) throw new FeedError("usage", `the order ${JSON.stringify(order)} is not ${FEED_ORDERS.join(" or ")}`);
  const limit = wholeIn(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit");
  const maxBlocks = wholeIn(options.maxBlocks, DEFAULT_MAX_BLOCKS, 1, 1_000_000, "maxBlocks");
  const copy = options.copy ?? "auto";
  if (!COPY_CHOICES.includes(copy)) throw new FeedError("usage", `the copy ${JSON.stringify(copy)} is not ${COPY_CHOICES.join(", ")}`);
  const filter = checkFilter(options.filter);
  const after = options.after ?? null;
  if (after !== null && (!Number.isSafeInteger(after.firstSeen) || after.firstSeen < 0 || typeof after.key !== "string" || after.key.length === 0))
    throw new FeedError("usage", "the cursor is not a first_seen and a key");
  if (DATASET_OF_KIND[plan.kind] !== plan.dataset) throw new FeedError("usage", `the plan is of kind ${plan.kind} and dataset ${plan.dataset}`);
  const desc = order === "first_seen.desc";
  const stats: FeedStats = { packsRead: [], copiesRead: [], blocksRead: 0, timeBlocksRead: 0, rowsDecoded: 0 };
  const budget = new Budget(maxBlocks);
  const rows: FeedRecord[] = [];
  let partial = false;
  const packs = desc ? [...plan.packs].reverse() : plan.packs;
  for (const planned of packs) {
    if (rows.length >= limit) break;
    // A pack whose every row is on the side of the cursor already given.
    if (after !== null && (desc ? planned.span.t0 > after.firstSeen : planned.span.t1 <= after.firstSeen)) continue;
    const opened = await options.open(planned.pack);
    checkOpened(plan, planned, opened);
    const ctx: PackContext = { plan, planned, opened, table: options.table, filter, after, desc, want: limit - rows.length, budget, stats, copy };
    const got = await readPack(ctx);
    rows.push(...got.rows);
    if (got.stopped) {
      partial = true;
      break;
    }
  }
  if (partial && rows.length === 0) throw new FeedError("budget", `the page reads more than ${maxBlocks} blocks before its first row`);
  const last = rows[rows.length - 1];
  const next = partial || rows.length === limit ? { firstSeen: last.firstSeen, key: last.key } : null;
  return { rows, next, partial, stats };
}

// The opened pack is of the plan's dataset, has a time copy exactly when the
// live set lists one, has one when its tier is d, w, m or y, and that copy
// binds to its key copy.
function checkOpened(plan: WindowPlan<LivePack>, planned: PlannedPack<LivePack>, opened: OpenedPack): void {
  const { reader, time } = opened;
  const tag = planned.pack.tag;
  if (reader.index.header.dataset !== reader.codec.id || reader.codec.name !== plan.dataset)
    throw new FeedError("usage", `the pack ${tag} opened as dataset ${reader.codec.name}, the plan reads ${plan.dataset}`);
  const listed = planned.pack.time !== undefined && planned.pack.time !== null;
  if (listed !== (time !== null)) throw new FeedError("usage", `the live set lists ${listed ? "a" : "no"} time copy of the pack ${tag}, and open gave ${time === null ? "none" : "one"}`);
  if (time === null && TIME_COPY_TIERS.includes(planned.pack.tier))
    throw new FeedError(
      "time",
      `the pack ${tag} of tier ${planned.pack.tier} holds ${reader.index.header.records} rows and no time copy: a pack of tier d, w, m or y is read through its time copy, never sorted whole`,
    );
  if (time === null) return;
  const fault = timeBindFault(reader.index.head, time.index.head, planned.span);
  if (fault !== null) throw new FeedError("time", `the pack ${tag}: ${fault}`);
}

interface PackContext {
  readonly plan: WindowPlan<LivePack>;
  readonly planned: PlannedPack<LivePack>;
  readonly opened: OpenedPack;
  readonly table: SourceTable;
  readonly filter: FeedFilter;
  readonly after: FeedCursor | null;
  readonly desc: boolean;
  // Rows the page still takes.
  readonly want: number;
  readonly budget: Budget;
  readonly stats: FeedStats;
  readonly copy: CopyChoice;
}

// The blocks of one copy, read once each, counted against the budget.
class Blocks {
  readonly #ctx: PackContext;
  readonly #reader: PackReader<FeedRecord>;
  readonly #time: boolean;
  readonly #held = new Map<number, FeedRecord[]>();

  constructor(ctx: PackContext, reader: PackReader<FeedRecord>, time: boolean) {
    this.#ctx = ctx;
    this.#reader = reader;
    this.#time = time;
  }

  // The rows of block b, or null when the budget has no block left.
  async rows(b: number): Promise<FeedRecord[] | null> {
    const kept = this.#held.get(b);
    if (kept !== undefined) return kept;
    const { budget, stats } = this.#ctx;
    if (budget.left === 0) return null;
    budget.left -= 1;
    const records = await this.#reader.records(await this.#reader.index.entry(b));
    stats.blocksRead += 1;
    if (this.#time) stats.timeBlocksRead += 1;
    stats.rowsDecoded += records.length;
    this.#held.set(b, records);
    return records;
  }
}

function keeps(ctx: PackContext, row: FeedRecord): boolean {
  return inRange(ctx.plan.range, row.key) && inWindow(row, ctx.plan.window, ctx.table.precision) && rowMatches(row, ctx.filter);
}

const afterCursor = (ctx: PackContext, row: FeedRecord): boolean => {
  if (ctx.after === null) return true;
  const c = compareRows(row, ctx.after);
  return ctx.desc ? c < 0 : c > 0;
};

async function readPack(ctx: PackContext): Promise<PackRead> {
  const { reader, time } = ctx.opened;
  const { blocks } = reader.index.header;
  const { lo, hi } = ctx.plan.range;
  const read = (copy: FeedCopy, run: () => Promise<PackRead>): Promise<PackRead> => {
    ctx.stats.packsRead.push(ctx.planned.pack.tag);
    ctx.stats.copiesRead.push(copy);
    return run();
  };
  if (blocks === 0) return read("key", async () => ({ rows: [], stopped: false }));
  const first = lo === null ? 0 : Math.max(0, await reader.index.locate(lo));
  const last = hi === null ? blocks - 1 : await reader.index.locate(hi);
  if (last < first) return read("key", async () => ({ rows: [], stopped: false }));
  const rangeBlocks = last - first + 1;
  const byKey =
    time === null ||
    ctx.copy === "key" ||
    (ctx.copy === "auto" && (lo !== null || hi !== null) && rangeBlocks <= ctx.budget.left && keyCopyFirst(rangeBlocks, blocks, time.index.header.recordsPerBlock, ctx.want));
  if (byKey) return read("key", () => scanAndSort(ctx, first, last));
  return read("time", () => readByTime(ctx, time));
}

// Every block of the range, then a sort in memory. All or nothing: a pack
// whose range does not fit the budget left gives no row, because rows of a part
// of it would not be the first rows of the order.
async function scanAndSort(ctx: PackContext, first: number, last: number): Promise<PackRead> {
  if (last - first + 1 > ctx.budget.left) return { rows: [], stopped: true };
  const blocks = new Blocks(ctx, ctx.opened.reader, false);
  const kept: FeedRecord[] = [];
  for (let b = first; b <= last; b += 1) {
    const records = await blocks.rows(b);
    if (records === null) return { rows: [], stopped: true };
    for (const row of records) if (keeps(ctx, row) && afterCursor(ctx, row)) kept.push(row);
  }
  kept.sort(ctx.desc ? (a, b) => compareRows(b, a) : compareRows);
  return { rows: kept.slice(0, ctx.want), stopped: false };
}

// A bound of a run of the time copy: a (first_seen, key) pair, compared with
// compareRows; the key "" is the first pair of its second. null is open.
type Bound = FeedCursor | null;

const boundAt = (t: number): Bound => (t > MAX_TIME_FIRST_SEEN ? null : { firstSeen: t, key: "" });

// The smallest pair above a cursor: the cursor's key followed by the byte 0.
const justAfter = (c: FeedCursor): FeedCursor => ({ firstSeen: c.firstSeen, key: `${c.key}\u0000` });

const below = (row: FeedCursor, bound: Bound): boolean => bound === null || compareRows(row, bound) < 0;
const atOrAbove = (row: FeedCursor, bound: FeedCursor): boolean => compareRows(row, bound) >= 0;

// The runs of the time copy a page reads, ascending: [lo, hi) each. The rows
// at the start of the day that holds t0 stand for that whole day (a day-
// precision row, docs/architecture.md section 7.4), so a window that starts
// inside a day reads that first second too, then [t0, t1). Both are cut to the
// span of the pack, which holds every row of it.
function timeRuns(ctx: PackContext): { lo: FeedCursor; hi: Bound }[] {
  const { t0, t1 } = ctx.plan.window;
  const span = ctx.planned.span;
  const runs: { lo: FeedCursor; hi: Bound }[] = [];
  const ds = dayStart(t0);
  if (ds < t0 && ds >= span.t0) runs.push({ lo: { firstSeen: ds, key: "" }, hi: boundAt(ds + 1) });
  const from = Math.max(t0, span.t0);
  const to = Math.min(t1, span.t1);
  if (from < to && from <= MAX_TIME_FIRST_SEEN) runs.push({ lo: { firstSeen: from, key: "" }, hi: boundAt(to) });
  return runs;
}

// The rows of the time copy in [lo, hi), in order (descending for desc),
// handed to `take` until it answers true. The answer: "full" when `take`
// answered true, "budget" when the budget ended the run, "done" otherwise.
async function scanTime(time: PackReader<FeedRecord>, blocks: Blocks, lo: FeedCursor, hi: Bound, desc: boolean, take: (row: FeedRecord) => boolean): Promise<"full" | "budget" | "done"> {
  const count = time.index.header.blocks;
  if (!desc) {
    for (let b = Math.max(0, await time.index.locate(timeKey(lo.firstSeen, lo.key))); b < count; b += 1) {
      const entry = await time.index.entry(b);
      if (hi !== null && entry.key >= timeKey(hi.firstSeen, hi.key)) return "done";
      const rows = await blocks.rows(b);
      if (rows === null) return "budget";
      for (const row of rows) {
        if (!atOrAbove(row, lo)) continue;
        if (!below(row, hi)) return "done";
        if (take(row)) return "full";
      }
    }
    return "done";
  }
  let b = count - 1;
  if (hi !== null) {
    const top = timeKey(hi.firstSeen, hi.key);
    const entry = await time.index.locateEntry(top);
    if (entry === null) return "done";
    // A block that starts at hi holds no row below it.
    b = entry.key >= top ? entry.index - 1 : entry.index;
  }
  for (; b >= 0; b -= 1) {
    const rows = await blocks.rows(b);
    if (rows === null) return "budget";
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (!below(row, hi)) continue;
      if (!atOrAbove(row, lo)) return "done";
      if (take(row)) return "full";
    }
  }
  return "done";
}

async function readByTime(ctx: PackContext, time: PackReader<FeedRecord>): Promise<PackRead> {
  const blocks = new Blocks(ctx, time, true);
  const out: FeedRecord[] = [];
  // A cursor past the last second a time key holds: every row is below it.
  if (ctx.after !== null && ctx.after.firstSeen > MAX_TIME_FIRST_SEEN && !ctx.desc) return { rows: out, stopped: false };
  const after = ctx.after !== null && ctx.after.firstSeen <= MAX_TIME_FIRST_SEEN ? ctx.after : null;
  // The cursor cuts the runs: asc keeps the rows above it, desc the rows below.
  const runs = timeRuns(ctx).map(({ lo, hi }) => {
    if (after === null) return { lo, hi };
    if (ctx.desc) return { lo, hi: hi === null || compareRows(after, hi) < 0 ? after : hi };
    const above = justAfter(after);
    return { lo: compareRows(above, lo) > 0 ? above : lo, hi };
  });
  const take = (row: FeedRecord): boolean => {
    if (!keeps(ctx, row)) return false;
    out.push(row);
    return out.length === ctx.want;
  };
  for (const run of ctx.desc ? [...runs].reverse() : runs) {
    if (run.hi !== null && compareRows(run.lo, run.hi) >= 0) continue;
    const end = await scanTime(time, blocks, run.lo, run.hi, ctx.desc, take);
    if (end === "full") break;
    if (end === "budget") return { rows: out, stopped: true };
  }
  return { rows: out, stopped: false };
}
