// adapters/oi-nrd/src/index.ts — the adapter of OpenINTEL's three newly
// registered topics on the Zonestream broker (DOM-026; docs/architecture.md
// section 5.6), one partition each:
//   oi-nrd            newly_registered_domain            bit 1, domains, facts.json
//   oi-nrd-fqdn       newly_registered_fqdn              bit 2, names
//   oi-nrd-confirmed  confirmed_newly_registered_domain  bit 3, domains
//
//   export const run = makeRun(LIMITS, ZONESTREAM);   // run(cursor, ctx)
//
// One run reads over one KafkaConnection of ctx.connect (@domains/adapter/kafka),
// in this order:
//   1. the cursor: null, or { topics: { T: { "0": offset } }, through: { T: ISO } },
//      else ContractError `cursor`. topics[T]["0"] is the next offset to read,
//      the first of T's open window; through[T] that window's start. A topic
//      with an offset and no through opens a fresh window at its first
//      record's second;
//   2. open, Metadata of the three topics, ListOffsets earliest and latest. A
//      failure of any is the fault `broker` of each source: no segment, the
//      cursor as given. A topic of other than the one partition 0 is the fault
//      `partitions` and is not read, so no part of a topic is read as the whole;
//   3. per topic, the start: the cursor's offset, or the earliest with none.
//      Below the earliest is `retention-gap`: the read resumes at the earliest
//      with a fresh window, no earlier than the old through. Above the latest
//      is `offset-ahead`: the read relocates to ListOffsets(through), the first
//      offset whose record time is at or after through, keeping through; -1
//      there (no such record) reads nothing, and the cursor becomes
//      { latest, through }. `stop` is the latest: a record at or after it is
//      left for the next run, so an answer that holds later records replays
//      the same;
//   4. Fetch of every topic not done, in TOPICS order, until each is done:
//      each whole batch in offset order, decoded (decodeBatch checks its
//      CRC-32C). A KafkaDecodeError is `decode`, and the topic stops before
//      the batch; a partition error code is `fetch-error`; MAX_IDLE_FETCHES
//      answers in a row that move a topic nothing are `read`. The first record
//      read from a cursor, if more than MISMATCH_S before through, is
//      `cursor-mismatch`, and the read relocates as offset-ahead does (settled
//      S7). A record time more than CLOCK_SLACK_S after ctx.now is `clock`,
//      and the topic stops before that record, with no window past it closed
//      (S5); it clears once the clock passes it. A record time before
//      2026-01-01, which no record stores, stops nothing: the record joins the
//      open window at its start, counted late and `clock_low`, with one fault
//      `clock-low` a source a run; with no window open yet (a fresh topic) it
//      waits for the first window, and a fresh topic whose first
//      maxSegmentMessages records are all such is `clock` and stops before them
//      (the review of DOM-026: such a record must not stall its topic until the
//      retention deletes it);
//   5. each record joins its window (window.ts, the rule; events.ts, the
//      records). A record at or after the window's end closes it (it is
//      written), writes each window wholly between as an empty segment (the
//      offsets prove the topic was quiet then, and an hour pack needs a
//      source's segments to cover its hour), and opens the record's window. A
//      record before the window's start joins at the start and counts `late`.
//      Once a window holds maxSegmentMessages, it closes at the first record
//      whose second is above every second it holds, which starts the next
//      window; a late record, or one of a second it holds, joins it, so a
//      close never makes start >= end (S4);
//   6. a socket or protocol failure in the loop is `read` for each topic not
//      done; each keeps the windows it closed and the cursor of its open one;
//   7. the connection closed; the segments in write order, the cursor, the
//      stats and the faults, with one `malformed` a source whose messages
//      were not JSON or held no name (they are counted, and their windows
//      written).
// A topic stops at the close that brings its closed windows of the run to
// maxWindowsPerRun, or their messages to maxMessagesPerRun; the record that
// closed it starts the next run. The caps are read only at a close, so a run
// reads at most maxMessagesPerRun + maxSegmentMessages messages a topic, plus
// those that join a full window before its early close: the messages of the
// second it closes at (6,597 in the busiest second of the largest minute
// measured, DOM-026) and any late ones (none measured).
//
// A topic's cursor at its end: the open window's first offset and its start;
// or, when the window holds no record, the offset where the read stopped. A
// segment's cursorBefore and cursorAfter are its topic's slice of the cursor,
// { through: { T }, topics: { T } }, when its window opened and after it
// closed (settled S11), so the cursorAfter of a window is the cursorBefore of
// the next, and the last one's is the run's cursor of T. The slice keeps a
// segment's identity free of the other topics' interleaving.
//
// The raw bytes of a window are the whole batches that hold its records, in
// offset order, as received (one record a batch, codec none, in every read of
// these topics: DOM-004), and a control batch after one of them. A batch whose
// records fall in two windows goes into both. Its members.json member names
// topic, partition, base_offset, last_offset and batches (rawMember). An empty
// window has no raw bytes and no member.
//
// It reads no clock and no environment: what it writes depends only on the
// broker's bytes, the list and ctx.now, so two runs from one cursor write the
// same segments, which the harness's replay of a recording rests on.
import { type AdapterContext, type AdapterFault, ContractError, type Cursor, isIsoUtc, type RunResult, type Segment, type SegmentDraft, type SocketAddress } from "@domains/adapter";
import {
  type DecodedBatch,
  decodeBatch,
  EARLIEST,
  errorName,
  type FetchedPartition,
  KafkaConnection,
  KafkaDecodeError,
  type KafkaRecord,
  LATEST,
  partitionKey,
  type SplitBatch,
  ZONESTREAM,
} from "@domains/adapter/kafka";
import { eventOf, OLD_CERT_S, type TopicKind, WindowEvents } from "./events.ts";
import { clockProblem, EPOCH_2026_S, isoOf, secondsOf, type WindowLimits, windowEnd } from "./window.ts";

export interface TopicSpec {
  readonly topic: string;
  readonly source: string;
  readonly bit: number;
  readonly dataset: "domains" | "names";
  readonly kind: TopicKind;
  // Its segments carry facts.json: oi-nrd alone, whose ages reach the feed.
  readonly facts: boolean;
}

// The topics, in the order a run reads and writes them. Each source's id, bit
// and dataset are its source.json row's; test/oi-nrd.test.ts holds them equal.
export const TOPICS: readonly TopicSpec[] = Object.freeze([
  Object.freeze({ topic: "newly_registered_domain", source: "oi-nrd", bit: 1, dataset: "domains", kind: "domain", facts: true } as const),
  Object.freeze({ topic: "newly_registered_fqdn", source: "oi-nrd-fqdn", bit: 2, dataset: "names", kind: "fqdn", facts: false } as const),
  Object.freeze({ topic: "confirmed_newly_registered_domain", source: "oi-nrd-confirmed", bit: 3, dataset: "domains", kind: "confirmed", facts: false } as const),
]);

export interface Limits extends WindowLimits {
  // Closed windows a topic a run, empty ones among them.
  readonly maxWindowsPerRun: number;
  // Messages of the closed windows a topic a run.
  readonly maxMessagesPerRun: number;
  // The messages after which a window closes early, at a second.
  readonly maxSegmentMessages: number;
  // A Fetch's bytes of one partition, and of the whole answer.
  readonly fetchPartitionBytes: number;
  readonly fetchMaxBytes: number;
  // How long the broker may hold a Fetch for its first byte.
  readonly maxWaitMs: number;
}

// windowS: the entry's 10 minutes. maxWindowsPerRun: 12 windows of three
// topics push 72 objects, about 3.0 to 3.6 minutes at 2.5 to 3 s a push [E].
// maxMessagesPerRun (settled S6): the caps' worst case, 3 x (300,000 +
// 200,000) messages, is about 0.33 GB, 5.4 to 9 minutes to read at DOM-004's
// 0.6 to 1.0 MB/s, and about 17 minutes to verify at the dry run's 0.67 ms a
// message (MEASURED on the operator's workstation, DOM-026): with the pushes,
// 25 to 29 minutes, past the leg's 25-minute step. The retained span's largest
// 12-hour sum, 400,326 messages for one topic, keeps a real run near 16
// minutes [E]; the first runs on GitHub measure it, and a run that nears the
// step lowers this cap. maxSegmentMessages: the entry's cap of a segment. The
// Fetch sizes: 4 MiB a topic, 12 MiB an answer, and a wait of 500 ms for a
// quiet topic.
export const LIMITS: Limits = Object.freeze({
  windowS: 600,
  catchUpAfterS: 3600,
  maxWindowsPerRun: 12,
  maxMessagesPerRun: 300_000,
  maxSegmentMessages: 200_000,
  fetchPartitionBytes: 4 << 20,
  fetchMaxBytes: 12 << 20,
  maxWaitMs: 500,
});

// A record time may pass ctx.now by this much (settled S5): a producer's
// clock a little ahead is read, and one far ahead stops its topic.
export const CLOCK_SLACK_S = 300;
// The first record read from a cursor may lie this far before its through
// (late, it joins at the start); further is cursor-mismatch (settled S7).
export const MISMATCH_S = 3600;
// Fetch answers in a row that move a topic nothing before it is `read`.
export const MAX_IDLE_FETCHES = 5;

const HOUR_S = 3600;
const SECOND_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isOffset = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// A time in ms as text, whatever the producer stamped.
const msText = (ms: number): string => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : `${ms} ms`);

function checkLimits(limits: Limits): void {
  for (const k of ["windowS", "catchUpAfterS", "maxWindowsPerRun", "maxMessagesPerRun", "maxSegmentMessages", "fetchPartitionBytes", "fetchMaxBytes", "maxWaitMs"] as const) {
    const v = limits?.[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new TypeError(`oi-nrd: the limit ${k} ${v} is not a whole number from 1`);
  }
  // A window near now ends on a multiple of windowS, which must fall on every hour edge.
  if (HOUR_S % limits.windowS !== 0) throw new TypeError(`oi-nrd: windowS ${limits.windowS} does not divide an hour`);
}

interface Start {
  readonly offset: number;
  readonly through: number | null;
}

// The cursor of step 1, by topic.
function parseCursor(cursor: Cursor): Map<string, Start> {
  const out = new Map<string, Start>();
  if (cursor === null) return out;
  const bad = (detail: string): ContractError => new ContractError("cursor", `oi-nrd: the cursor ${detail}`);
  if (!isObj(cursor) || Object.keys(cursor).sort().join(",") !== "through,topics" || !isObj(cursor.topics) || !isObj(cursor.through)) throw bad("is not null or { topics, through }");
  const offsets = new Map<string, number>();
  for (const [topic, parts] of Object.entries(cursor.topics)) {
    if (!TOPICS.some((t) => t.topic === topic)) throw bad(`names the topic ${JSON.stringify(topic)}, which this adapter does not read`);
    if (!isObj(parts) || Object.keys(parts).join(",") !== "0" || !isOffset(parts["0"])) throw bad(`topics.${topic} is not { "0": offset }, offset a whole number from 0`);
    offsets.set(topic, parts["0"]);
  }
  for (const [topic, iso] of Object.entries(cursor.through)) {
    if (!offsets.has(topic)) throw bad(`through names ${JSON.stringify(topic)}, which topics does not`);
    if (typeof iso !== "string" || !SECOND_ISO.test(iso) || !isIsoUtc(iso)) throw bad(`through.${topic} ${JSON.stringify(iso)} is not ISO 8601 UTC to the second`);
  }
  for (const [topic, offset] of offsets) {
    const iso = cursor.through[topic];
    out.set(topic, { offset, through: typeof iso === "string" ? secondsOf(iso) : null });
  }
  return out;
}

// One topic's slice of the cursor (settled S11).
const sliceOf = (topic: string, offset: number, startS: number): Cursor => ({ through: { [topic]: isoOf(startS) }, topics: { [topic]: { "0": offset } } });

interface Counts {
  messages: number;
  late: number;
  malformed: number;
  refused: number;
  zone_rows: number;
  reg_differs: number;
  cert_age_known: number;
  cert_age_over_7d: number;
  wire_bytes: number;
  empty_windows: number;
  // Records stamped before 2026-01-01, each joined at its window's start.
  clock_low: number;
}

// One readable topic of a run: its offsets, its open window, its counts.
interface TopicRun {
  readonly spec: TopicSpec;
  readonly key: string;
  readonly earliest: number;
  readonly latest: number;
  // Records at or after it are the next run's.
  readonly stop: number;
  next: number;
  done: boolean;
  // Where the read stopped, when it stopped with the open window empty.
  pending: number;
  // The read moves to ListOffsets(start) before the next Fetch (cursor-mismatch).
  relocate: boolean;
  // The through the first record read from the cursor is held to, or null.
  check: number | null;
  idle: number;
  // The open window: its start (null until a fresh window's first record),
  // end, first offset, Kafka records, latest second, events, raw batches.
  start: number | null;
  floor: number | null;
  end: number;
  before: number;
  count: number;
  maxT: number;
  events: WindowEvents;
  raw: SplitBatch[];
  lastRaw: SplitBatch | null;
  // The run's closed windows and their messages.
  windows: number;
  closed: number;
  readonly counts: Counts;
  readonly refusals: Map<string, number>;
  firstMalformed: string | null;
  firstClockLow: string | null;
  // Records stamped before 2026-01-01 read while no window is open (a fresh
  // topic), in offset order: they join the first window opened, at its start.
  early: { readonly r: KafkaRecord; readonly b: SplitBatch }[];
  // The retention-gap fault, whose detail names the first time read once it is.
  gap: OpenFault | null;
}

// A fault of the run, whose detail a relocation or the first record read
// after a retention gap completes before the run returns it.
interface OpenFault extends Omit<AdapterFault, "detail"> {
  detail: string;
}

// A failure of the connection, of the broker or of what it answered: the
// faults broker and read. A writer's ContractError never reaches here.
class Lost {
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
  get message(): string {
    return (this.cause as Error)?.message ?? String(this.cause);
  }
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new Lost(err);
  }
}

function concat(batches: readonly SplitBatch[]): Uint8Array {
  const out = new Uint8Array(batches.reduce((n, b) => n + b.size, 0));
  let at = 0;
  for (const b of batches) {
    out.set(b.bytes, at);
    at += b.size;
  }
  return out;
}

class Reader {
  readonly segments: Segment[] = [];
  readonly faults: OpenFault[] = [];
  fetches = 0;
  frameBytes = 0;
  private readonly ctx: AdapterContext;
  private readonly limits: Limits;
  private readonly nowS: number;

  constructor(ctx: AdapterContext, limits: Limits) {
    this.ctx = ctx;
    this.limits = limits;
    this.nowS = Math.floor(Date.parse(ctx.now) / 1000);
  }

  fault(spec: TopicSpec, code: string, detail: string): OpenFault {
    const f = { source: spec.source, code, detail };
    this.faults.push(f);
    return f;
  }

  // Steps 2 and 3: the readable topics, each at its start; the faults
  // partitions, retention-gap and offset-ahead. Throws Lost.
  async setup(conn: KafkaConnection, starts: ReadonlyMap<string, Start>): Promise<TopicRun[]> {
    const parts = await guarded(() => conn.metadata(TOPICS.map((t) => t.topic)));
    const readable: TopicSpec[] = [];
    const later: [TopicSpec, string, string][] = [];
    for (const spec of TOPICS) {
      const ids = parts.get(spec.topic)!;
      if (ids.length === 1 && ids[0] === 0) readable.push(spec);
      else
        later.push([spec, "partitions", `${spec.topic} has ${ids.length} partition(s) (${ids.join(", ") || "none"}); only a topic of the one partition 0 is read, and this one is not read this run`]);
    }
    const runs: TopicRun[] = [];
    if (readable.length > 0) {
      const asks = readable.map((s) => ({ topic: s.topic, partition: 0 }));
      const earliest = await guarded(() => conn.listOffsets(asks, EARLIEST));
      const latest = await guarded(() => conn.listOffsets(asks, LATEST));
      for (const spec of readable) {
        const key = partitionKey(spec.topic, 0);
        const t = this.topicRun(spec, key, earliest.get(key)!, latest.get(key)!, starts.get(spec.topic) ?? null);
        runs.push(t);
        const from = starts.get(spec.topic);
        if (from === undefined) continue;
        if (from.offset < t.earliest) {
          const was = from.through === null ? "" : `, after through ${isoOf(from.through)},`;
          t.gap = this.fault(
            spec,
            "retention-gap",
            `the cursor's offset ${from.offset} is below the earliest retained offset ${t.earliest}: the ${t.earliest - from.offset} message(s) from ${from.offset} to ${t.earliest - 1}${was} are deleted, and the read resumes at ${t.earliest} with a fresh window`,
          );
        } else if (from.offset > t.latest) {
          const f = this.fault(spec, "offset-ahead", `the cursor's offset ${from.offset} is above the latest offset ${t.latest}: the log under the cursor changed`);
          await this.relocate(conn, t, f);
        }
      }
    }
    // The partitions faults follow the others' order of TOPICS, after setup holds.
    for (const [spec, code, detail] of later) this.fault(spec, code, detail);
    return runs;
  }

  private topicRun(spec: TopicSpec, key: string, earliest: number, latest: number, from: Start | null): TopicRun {
    const below = from !== null && from.offset < earliest;
    const offset = from === null || below ? earliest : from.offset;
    const through = from === null || below ? null : from.through;
    const t: TopicRun = {
      spec,
      key,
      earliest,
      latest,
      stop: latest,
      next: offset,
      done: false,
      pending: offset,
      relocate: false,
      check: through,
      idle: 0,
      start: null,
      floor: below ? from.through : null,
      end: 0,
      before: offset,
      count: 0,
      maxT: 0,
      events: new WindowEvents(spec.kind, spec.bit),
      raw: [],
      lastRaw: null,
      windows: 0,
      closed: 0,
      counts: { messages: 0, late: 0, malformed: 0, refused: 0, zone_rows: 0, reg_differs: 0, cert_age_known: 0, cert_age_over_7d: 0, wire_bytes: 0, empty_windows: 0, clock_low: 0 },
      refusals: new Map(),
      firstMalformed: null,
      firstClockLow: null,
      early: [],
      gap: null,
    };
    if (through !== null) this.openAt(t, through, offset);
    if (t.next >= t.stop) this.finish(t, t.next);
    return t;
  }

  // The read of t moves to the first offset whose record time is at or after
  // its window's start, keeping the start (offset-ahead, cursor-mismatch); with
  // no start, to the earliest with a fresh window. Throws Lost.
  async relocate(conn: KafkaConnection, t: TopicRun, f: OpenFault): Promise<void> {
    t.check = null;
    if (t.start === null) {
      f.detail += `; the cursor names no through, so the read resumes at the earliest offset ${t.earliest} with a fresh window`;
      this.moveTo(t, t.earliest);
      return;
    }
    const startS = t.start;
    const at = (await guarded(() => conn.listOffsets([{ topic: t.spec.topic, partition: 0 }], startS * 1000))).get(t.key)!;
    if (at === -1) {
      f.detail += `; no record is at or after through ${isoOf(startS)}, so the topic reads nothing this run, and its cursor is the latest offset ${t.stop}`;
      t.before = t.stop;
      this.finish(t, t.stop);
      return;
    }
    f.detail += `; the read relocates to ${at}, the first offset at or after through ${isoOf(startS)}`;
    t.before = at;
    this.moveTo(t, at);
  }

  // A topic whose cursor lay at or past `stop` was finished when it was set
  // up; a relocation below `stop` reads it again this run.
  private moveTo(t: TopicRun, offset: number): void {
    t.next = offset;
    t.pending = offset;
    t.done = false;
    if (t.start === null) t.before = offset;
    if (offset >= t.stop) this.finish(t, offset);
  }

  // Steps 4 to 6.
  async readAll(conn: KafkaConnection, runs: readonly TopicRun[]): Promise<void> {
    for (;;) {
      const active = runs.filter((t) => !t.done);
      if (active.length === 0) return;
      let partitions: ReadonlyMap<string, FetchedPartition>;
      try {
        const answer = await guarded(() =>
          conn.fetch(
            active.map((t) => ({ topic: t.spec.topic, partition: 0, offset: t.next, maxBytes: this.limits.fetchPartitionBytes })),
            { maxWaitMs: this.limits.maxWaitMs, maxBytes: this.limits.fetchMaxBytes },
          ),
        );
        this.fetches += 1;
        this.frameBytes += answer.frameBytes;
        partitions = answer.partitions;
      } catch (err) {
        if (!(err instanceof Lost)) throw err;
        this.lost(active, err);
        return;
      }
      for (const t of active) await this.consume(t, partitions.get(t.key)!);
      for (const t of active.filter((x) => x.relocate)) {
        t.relocate = false;
        try {
          await this.relocate(conn, t, this.faults.findLast((f) => f.source === t.spec.source && f.code === "cursor-mismatch")!);
        } catch (err) {
          if (!(err instanceof Lost)) throw err;
          this.lost(
            runs.filter((x) => !x.done),
            err,
          );
          return;
        }
      }
    }
  }

  private lost(runs: readonly TopicRun[], err: Lost): void {
    for (const t of runs) {
      if (t.done) continue;
      this.fault(t.spec, "read", `the connection failed at offset ${t.next}: ${err.message}; the windows closed this run are written, and the cursor is the open window's`);
      this.finish(t, t.next);
    }
  }

  private finish(t: TopicRun, pending: number): void {
    t.done = true;
    // Records that wait for a window (no window opened) are the next run's.
    t.pending = t.early.length > 0 ? t.early[0]!.r.offset : pending;
  }

  // One topic's part of a Fetch answer.
  private async consume(t: TopicRun, p: FetchedPartition): Promise<void> {
    if (p.errorCode !== 0) {
      this.fault(t.spec, "fetch-error", `the broker answered ${errorName(p.errorCode)} (${p.errorCode}) for offset ${t.next}; the topic stops there this run`);
      this.finish(t, t.next);
      return;
    }
    const from = t.next;
    for (const b of p.batches) {
      if (t.done || t.relocate) break;
      if (b.lastOffset < t.next) continue;
      // No batch lies in [next, stop): the offsets between are a gap of the log.
      if (b.baseOffset >= t.stop) {
        this.finish(t, t.stop);
        break;
      }
      t.counts.wire_bytes += b.size;
      let batch: DecodedBatch;
      try {
        batch = decodeBatch(b.bytes);
      } catch (err) {
        if (!(err instanceof KafkaDecodeError)) throw err;
        this.fault(
          t.spec,
          "decode",
          `the batch at offset ${b.baseOffset}: ${err.message}; the topic stops before it, and every run reads it again until a code change decodes it or the retention deletes it`,
        );
        this.finish(t, t.next);
        return;
      }
      if (batch.isControl) {
        t.next = Math.max(t.next, batch.lastOffset + 1);
        if (t.raw.length > 0) this.keepRaw(t, b);
        continue;
      }
      for (const r of batch.records) {
        if (r.offset < t.next) continue;
        if (r.offset >= t.stop) {
          this.finish(t, t.stop);
          break;
        }
        await this.place(t, r, b);
        if (t.done || t.relocate) break;
      }
      // A batch's last offset may hold no record (one removed from the log):
      // the read moves past it, or the next Fetch answers the same batch.
      if (!t.done && !t.relocate) t.next = Math.max(t.next, Math.min(batch.lastOffset + 1, t.stop));
    }
    if (t.done || t.relocate) return;
    if (t.next >= t.stop) {
      this.finish(t, t.next);
      return;
    }
    if (t.next !== from) {
      t.idle = 0;
      return;
    }
    t.idle += 1;
    if (t.idle >= MAX_IDLE_FETCHES) {
      this.fault(t.spec, "read", `${MAX_IDLE_FETCHES} Fetch answers in a row moved the topic nothing at offset ${t.next}, below the latest offset ${t.stop}; the topic stops there this run`);
      this.finish(t, t.next);
    }
  }

  private keepRaw(t: TopicRun, b: SplitBatch): void {
    if (t.lastRaw === b) return;
    t.raw.push(b);
    t.lastRaw = b;
  }

  private openAt(t: TopicRun, startS: number, before: number): void {
    t.start = startS;
    t.end = windowEnd(startS, this.nowS, this.limits);
    t.before = before;
    t.count = 0;
    t.maxT = startS;
    t.events = new WindowEvents(t.spec.kind, t.spec.bit);
    t.raw = [];
    t.lastRaw = null;
  }

  // Step 5 for one record of batch b.
  private async place(t: TopicRun, r: KafkaRecord, b: SplitBatch): Promise<void> {
    const ts = Math.floor(r.timestamp / 1000);
    // Before the cursor's check: a producer's clock fault is no log change.
    if (ts < EPOCH_2026_S) {
      this.beforeEpoch(t, r, b);
      return;
    }
    const problem = clockProblem(ts, this.nowS, CLOCK_SLACK_S);
    if (problem !== null) {
      this.fault(t.spec, "clock", `the record at offset ${r.offset} has the time ${msText(r.timestamp)}, ${problem}; the topic stops before it this run`);
      this.finish(t, r.offset);
      return;
    }
    if (t.check !== null) {
      const through = t.check;
      t.check = null;
      if (ts < through - MISMATCH_S) {
        this.fault(
          t.spec,
          "cursor-mismatch",
          `the first record read from the cursor, at offset ${r.offset}, has the time ${isoOf(ts)}, more than ${MISMATCH_S} s before through ${isoOf(through)}: the log under the cursor changed`,
        );
        t.relocate = true;
        return;
      }
    }
    if (t.start === null) {
      const startS = t.floor === null ? ts : Math.max(ts, t.floor);
      this.openAt(t, startS, t.before);
      if (t.gap !== null) t.gap.detail += `; the first record read is at offset ${r.offset}, time ${isoOf(ts)}`;
      for (const e of t.early.splice(0)) {
        t.counts.late += 1;
        this.join(t, e.r, e.b, startS);
      }
    }
    let at = ts;
    if (ts < t.start!) {
      at = t.start!;
      t.counts.late += 1;
    } else if (ts >= t.end) {
      // The open window, then each empty one before the record's window.
      do {
        if (!(await this.close(t, t.end, r.offset))) return;
      } while (ts >= t.end);
    } else if (t.count >= this.limits.maxSegmentMessages && ts > t.maxT) {
      if (!(await this.close(t, ts, r.offset))) return;
    }
    this.join(t, r, b, at);
  }

  // A record stamped before 2026-01-01, which no record stores: it joins the
  // open window at its start, counted late, so a producer's clock fault costs
  // one fault and no data (the review of DOM-026, which corrects settled S5).
  // With no window open (a fresh topic), it waits in `early` for the first
  // window, and the cursor stays at the first that waits; a fresh topic whose
  // first maxSegmentMessages records are all such stops before them, so what
  // waits stays bounded.
  private beforeEpoch(t: TopicRun, r: KafkaRecord, b: SplitBatch): void {
    t.counts.clock_low += 1;
    t.firstClockLow ??= `the first at offset ${r.offset}, time ${msText(r.timestamp)}`;
    if (t.start !== null) {
      t.counts.late += 1;
      this.join(t, r, b, t.start);
      return;
    }
    if (t.early.length >= this.limits.maxSegmentMessages) {
      const from = t.early[0]!.r.offset;
      this.fault(
        t.spec,
        "clock",
        `the ${t.early.length} records from offset ${from} are all stamped before 2026-01-01T00:00:00Z, which no record stores, and no window is open to take them; the topic stops before them this run`,
      );
      this.finish(t, from);
      return;
    }
    t.early.push({ r, b });
  }

  private join(t: TopicRun, r: KafkaRecord, b: SplitBatch, at: number): void {
    t.count += 1;
    t.maxT = Math.max(t.maxT, at);
    t.next = r.offset + 1;
    t.counts.messages += 1;
    this.keepRaw(t, b);
    const parsed = eventOf(t.spec.kind, r.value, this.ctx.psl);
    if ("malformed" in parsed) {
      t.counts.malformed += 1;
      t.firstMalformed ??= `the first at offset ${r.offset}, ${parsed.malformed}`;
      return;
    }
    if ("refused" in parsed) {
      t.counts.refused += 1;
      t.refusals.set(parsed.refused, (t.refusals.get(parsed.refused) ?? 0) + 1);
      return;
    }
    const e = parsed.event;
    if (e.zone) t.counts.zone_rows += 1;
    if (e.regDiffers) t.counts.reg_differs += 1;
    if (e.certAge !== null) {
      t.counts.cert_age_known += 1;
      if (e.certAge > OLD_CERT_S) t.counts.cert_age_over_7d += 1;
    }
    t.events.add(e, at);
  }

  // Writes the open window [start, end), its cursorAfter at `offset`, and
  // opens the next at end. False when a cap of the run is reached: the topic
  // stops, and the record at `offset` starts the next run.
  private async close(t: TopicRun, end: number, offset: number): Promise<boolean> {
    const startS = t.start!;
    const { records, facts } = t.events.build();
    const raw = t.raw.length === 0 ? undefined : concat(t.raw);
    const draft: SegmentDraft = {
      source: t.spec.source,
      dataset: t.spec.dataset,
      window: { start: isoOf(startS), end: isoOf(end) },
      cursorBefore: sliceOf(t.spec.topic, t.before, startS),
      cursorAfter: sliceOf(t.spec.topic, offset, end),
      precision: "second",
      ...(raw === undefined ? {} : { rawMember: { topic: t.spec.topic, partition: 0, base_offset: t.raw[0]!.baseOffset, last_offset: t.raw.at(-1)!.lastOffset, batches: t.raw.length } }),
      ...(t.spec.facts && facts.length > 0 ? { facts } : {}),
    };
    this.segments.push(await this.ctx.writer.write(draft, records, raw));
    t.windows += 1;
    t.closed += t.count;
    if (t.count === 0) t.counts.empty_windows += 1;
    this.openAt(t, end, offset);
    if (t.windows < this.limits.maxWindowsPerRun && t.closed < this.limits.maxMessagesPerRun) return true;
    this.finish(t, offset);
    return false;
  }

  // The cursor of step 7, and each topic's stats.
  cursorOf(runs: readonly TopicRun[], starts: ReadonlyMap<string, Start>): { cursor: Cursor; stats: Record<string, number> } {
    const entries = new Map<string, Start>();
    for (const [topic, s] of starts) entries.set(topic, s);
    const stats: Record<string, number> = { fetches: this.fetches, frame_bytes: this.frameBytes };
    for (const t of runs) {
      const offset = t.count > 0 ? t.before : t.pending;
      entries.set(t.spec.topic, { offset, through: t.start });
      const p = `${t.spec.source}.`;
      for (const [k, v] of Object.entries(t.counts)) stats[p + k] = v;
      for (const [why, n] of [...t.refusals].sort(([a], [b]) => (a < b ? -1 : 1))) stats[`${p}refused.${why}`] = n;
      stats[`${p}windows`] = t.windows;
      stats[`${p}retained`] = t.latest - t.earliest;
      stats[`${p}lag`] = t.latest - offset;
      if (t.start !== null) stats[`${p}behind_s`] = this.nowS - t.start;
      if (t.counts.malformed > 0)
        this.fault(t.spec, "malformed", `${t.counts.malformed} message(s) are not JSON or hold no name, ${t.firstMalformed}; the windows are written, and the raw lane keeps their bytes`);
      if (t.counts.clock_low > 0)
        this.fault(
          t.spec,
          "clock-low",
          `${t.counts.clock_low} record(s) are stamped before 2026-01-01T00:00:00Z, which no record stores, ${t.firstClockLow}; each joins a window at the window's start, counted late (one read before a fresh topic's first window waits for it), and the raw lane keeps its bytes`,
        );
    }
    if (entries.size === 0) return { cursor: null, stats };
    const topics = [...entries.keys()].sort();
    const through: Record<string, string> = {};
    const offsets: Record<string, { "0": number }> = {};
    for (const topic of topics) {
      const e = entries.get(topic)!;
      if (e.through !== null) through[topic] = isoOf(e.through);
      offsets[topic] = { "0": e.offset };
    }
    return { cursor: { through, topics: offsets }, stats };
  }
}

export function makeRun(limits: Limits, address: SocketAddress): (cursor: Cursor, ctx: AdapterContext) => Promise<RunResult> {
  checkLimits(limits);
  return async (cursor, ctx) => {
    const starts = parseCursor(cursor);
    const reader = new Reader(ctx, limits);
    const brokerFault = (err: unknown): RunResult => {
      const detail = `${address.hostname}:${address.port}: ${(err as Error)?.message ?? String(err)}; nothing is read this run, and the cursor holds`;
      return { segments: [], cursor, stats: { fetches: 0, frame_bytes: 0 }, errors: TOPICS.map((t) => ({ source: t.source, code: "broker", detail })) };
    };
    let conn: KafkaConnection;
    try {
      conn = await KafkaConnection.open(ctx.connect, address, ctx.userAgent);
    } catch (err) {
      return brokerFault(err);
    }
    try {
      let runs: TopicRun[];
      try {
        runs = await reader.setup(conn, starts);
      } catch (err) {
        if (!(err instanceof Lost)) throw err;
        return brokerFault(err.cause);
      }
      await reader.readAll(conn, runs);
      const { cursor: after, stats } = reader.cursorOf(runs, starts);
      return { segments: reader.segments, cursor: after, stats, errors: reader.faults };
    } finally {
      await closeQuietly(conn);
    }
  };
}

// The run's result is whole once the read ends; a close that fails after it
// leaves nothing to undo, and a failure before it is the one reported.
async function closeQuietly(conn: KafkaConnection): Promise<void> {
  try {
    await conn.close();
  } catch {
    // Deliberately empty: see above.
  }
}

export const run = makeRun(LIMITS, ZONESTREAM);
