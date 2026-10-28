// probes/worker/src/gaps.ts — the tick records of the probe's cron triggers, and
// the arithmetic that turns a window of ticks into the result schema of DOM-002.
//
// The schema is DOM-001's (TODO/ops.md) with clock "worker", plus put_ms,
// class_a_ops and class_b_ops, and the 5-minute cron's numbers beside the minute
// cron's in `beside`. The arithmetic is this file's own copy of DOM-001's, in
// scripts/measure/clock-gaps.mjs, to the same definitions (DEFINITIONS below):
// the gaps between consecutive ticks plus the closing gap past the window's end,
// the median and the p90 as the value at index floor(n * q) of the ascending list
// (quantile below, the same function as clock-gaps.mjs's), the verdict judged on
// the unrounded gaps, gaps rounded to 2 places, and INCOMPLETE before the window
// ends.
// The copy differs where a Worker tick carries more than an Actions run:
// - the window and the slots are read on scheduledTime, the slot the cron fired
//   for, which a run does not carry; the gaps are read on startedAt;
// - start_lag_s keeps 3 places, because a Worker's lag is a matter of milliseconds;
// - in a window that has not ended, a slot counts as missed only once its whole
//   interval has passed, so a reading taken early counts no future slot.
// The probe's /gaps route and scripts/measure/worker-clock-gaps.mjs both import
// this file, so the probe's side has one copy.
//
// Pure: no I/O and no clock. The caller passes `now`.

export const WORKER = "domains-probe";
export const RESULT_VERSION = 1;
export const TICK_VERSION = 1;

export interface CronSpec {
  // The trigger exactly as wrangler.toml writes it, and as controller.cron carries it.
  readonly cron: string;
  // The key segment of its ticks: ticks/<slug>/<scheduledTime>.json.
  readonly slug: string;
  // Must divide 60, so that a whole number of hours holds a whole number of slots.
  readonly intervalMin: number;
  // A hot tick also writes one hot object of HOT_BYTES and times the put.
  readonly hot: boolean;
}

// One row per cron trigger of wrangler.toml. The scheduled handler refuses a cron
// with no row, and src/index.test.ts holds wrangler.toml's crons to this table.
export const CRONS: readonly CronSpec[] = Object.freeze([
  Object.freeze({ cron: "* * * * *", slug: "m1", intervalMin: 1, hot: false }),
  Object.freeze({ cron: "*/5 * * * *", slug: "m5", intervalMin: 5, hot: true }),
]);

// DOM-002 judges the clock by the minute cron, the finer sample. Every other cron
// of CRONS is summarised beside it.
export const VERDICT_CRON = "* * * * *";

// The decision rule of architecture section 5.2 (DOM-003, ruling 17). Each result
// carries the rule it was judged by.
export const RULE = Object.freeze({ p90_max_min: 15, max_max_min: 60 });
export const BREAK_MIN = 30;

export const DEFAULT_HOURS = 48;
// Two weeks: the minute cron then holds 20,160 ticks, which the listing bound of
// src/index.ts covers.
export const MAX_HOURS = 336;

// One hot-tier pack stands in as 1 MiB of random bytes (DOM-061).
export const HOT_BYTES = 1_048_576;
// crypto.getRandomValues refuses more than 65,536 bytes a call.
export const RANDOM_CHUNK = 65_536;

export const TICK_PREFIX = "ticks/";
export const HOT_PREFIX = "hot/";
export const HEARTBEAT_KEY = "heartbeat.json";

// The R2 operations of the cron path, by construction of recordTick in
// src/index.ts: a tick puts its record and the heartbeat and reads nothing; a hot
// tick also puts its hot object. src/index.test.ts counts them on a fake bucket.
export const OPS_PER_TICK = Object.freeze({ a: 2, b: 0 });
export const OPS_PER_HOT_PUT = Object.freeze({ a: 1, b: 0 });

export const DEFINITIONS = Object.freeze({
  tick: "one invocation of a cron trigger, as its R2 record: scheduledTime, the slot it fired for, and startedAt, Date.now() at the top of the handler",
  window: "[from, from + hours) of scheduledTime, from being the scheduledTime of the minute cron's first tick (of the first tick of any cron when the minute cron has none)",
  gaps_min:
    "minutes between the startedAt of consecutive ticks of one cron in the window, plus the closing gap from its last tick in the window to its first tick after the window (or to the window's end when none came and the window has ended); a cron with no tick in an ended window has one gap, from the window's start to its first tick after the window or to the window's end",
  start_lag_s: "seconds from scheduledTime to startedAt, for the ticks in the window",
  slots:
    "the slots of a cron are the multiples of its interval in the window; hit counts those that hold a tick, by scheduledTime; missed counts those that hold none and whose whole interval has passed",
  quantiles: "the value at index floor(n * q) of the ascending list: the median is the upper middle value of an even count, the p90 is index floor(0.9 n)",
  verdict: `PASS when the minute cron's p90 gap is at most ${RULE.p90_max_min} min and its max gap at most ${RULE.max_max_min} min, else FAIL; INCOMPLETE before the window has ended`,
  class_ops:
    "class A: every tick in the window puts its record and the heartbeat, and every tick of a hot cron puts one hot object (attempts, a failed put counted); class B: the cron path reads nothing. The listing that answers /gaps is not counted here (list_calls)",
});

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const ERROR_CHARS = 256;

// An error with the HTTP status the fetch handler answers it with.
export class ProbeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProbeError";
    this.status = status;
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// The milliseconds of a time written exactly as toISOString writes it, or null.
// Keys sort by this text, so a second spelling of one instant would sort apart.
export function parseIso(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toISOString() === text ? ms : null;
}

// An integer given as a number or as the decimal text of R2 custom metadata, or null.
function asInt(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d{1,15}$/.test(value)) return Number(value);
  return null;
}

export function cronSpec(cron: string): CronSpec | null {
  return CRONS.find((spec) => spec.cron === cron) ?? null;
}

export function requireCron(cron: string): CronSpec {
  const spec = cronSpec(cron);
  if (spec === null) throw new ProbeError(500, `the cron ${JSON.stringify(cron)} has no row in the CRONS table of src/gaps.ts: wrangler.toml and the table disagree`);
  return spec;
}

export function checkHours(hours: number): number {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) throw new ProbeError(400, `hours must be a whole number from 1 to ${MAX_HOURS}`);
  return hours;
}

export function tickPrefix(spec: CronSpec): string {
  return `${TICK_PREFIX}${spec.slug}/`;
}

export function tickKey(spec: CronSpec, scheduledMs: number): string {
  return `${tickPrefix(spec)}${iso(scheduledMs)}.json`;
}

export function hotKey(scheduledMs: number): string {
  return `${HOT_PREFIX}${iso(scheduledMs)}.bin`;
}

// The scheduled time a key names, or null when it is not a tick key of this cron.
export function keyTime(spec: CronSpec, key: string): number | null {
  const prefix = tickPrefix(spec);
  if (!key.startsWith(prefix) || !key.endsWith(".json")) return null;
  return parseIso(key.slice(prefix.length, -".json".length));
}

export interface Tick {
  readonly cron: string;
  readonly scheduledMs: number;
  // Date.now() at the top of the scheduled handler.
  readonly startedMs: number;
  // startedMs - scheduledMs.
  readonly lagMs: number;
  // The wall time of the hot put, on a hot tick whose put succeeded.
  readonly putMs: number | null;
  // Why a hot tick's put failed, at most ERROR_CHARS characters.
  readonly putError: string | null;
}

// The record of one tick: the body of its R2 object, a row of /gaps?ticks=1, and
// the input of scripts/measure/worker-clock-gaps.mjs.
export interface TickJson {
  v: number;
  cron: string;
  scheduledTime: string;
  startedAt: string;
  lag_ms: number;
  put_ms?: number;
  put_error?: string;
}

export function makeTick(spec: CronSpec, scheduledMs: number, startedMs: number, putMs: number | null, putError: string | null): Tick {
  return { cron: spec.cron, scheduledMs, startedMs, lagMs: startedMs - scheduledMs, putMs, putError: putError === null ? null : putError.slice(0, ERROR_CHARS) };
}

export function tickToJson(tick: Tick): TickJson {
  const out: TickJson = { v: TICK_VERSION, cron: tick.cron, scheduledTime: iso(tick.scheduledMs), startedAt: iso(tick.startedMs), lag_ms: tick.lagMs };
  if (tick.putMs !== null) out.put_ms = tick.putMs;
  if (tick.putError !== null) out.put_error = tick.putError;
  return out;
}

// The R2 custom metadata of a tick object: the same fields as its body, as text.
// /gaps reads ticks from a listing that includes custom metadata, so 48 hours of
// ticks cost a few list calls and no read of an object.
export function tickMetadata(tick: Tick): Record<string, string> {
  const json = tickToJson(tick);
  const out: Record<string, string> = { v: String(json.v), cron: json.cron, startedAt: json.startedAt, lag_ms: String(json.lag_ms) };
  if (json.put_ms !== undefined) out.put_ms = String(json.put_ms);
  if (json.put_error !== undefined) out.put_error = json.put_error;
  return out;
}

// One validation for every way a tick is read back. A record that breaks a rule
// is refused with its place named: a measurement read from a bad record is worse
// than none.
function checkTick(where: string, fields: Record<string, unknown>): Tick {
  const fail = (why: string): never => {
    throw new ProbeError(500, `tick ${where}: ${why}`);
  };
  if (asInt(fields.v) !== TICK_VERSION) fail(`version ${String(fields.v)}, and this code reads version ${TICK_VERSION}`);
  const spec = typeof fields.cron === "string" ? cronSpec(fields.cron) : null;
  if (spec === null) return fail(`the cron ${JSON.stringify(fields.cron)} has no row in CRONS`);
  const scheduledMs = parseIso(fields.scheduledTime);
  if (scheduledMs === null) return fail("scheduledTime is not a toISOString time");
  const startedMs = parseIso(fields.startedAt);
  if (startedMs === null) return fail("startedAt is not a toISOString time");
  const lagMs = asInt(fields.lag_ms);
  if (lagMs === null || lagMs !== startedMs - scheduledMs) fail(`lag_ms ${String(fields.lag_ms)} is not startedAt minus scheduledTime (${startedMs - scheduledMs})`);
  const putMs = fields.put_ms === undefined ? null : asInt(fields.put_ms);
  if (fields.put_ms !== undefined && (putMs === null || putMs < 0)) fail(`put_ms ${String(fields.put_ms)} is not a whole number of milliseconds`);
  if (fields.put_error !== undefined && typeof fields.put_error !== "string") fail("put_error is not text");
  const putError = typeof fields.put_error === "string" ? fields.put_error : null;
  if (spec.hot && (putMs === null) === (putError === null)) fail("a hot tick carries exactly one of put_ms and put_error");
  if (!spec.hot && (putMs !== null || putError !== null)) fail("a tick of a cron that is not hot carries no put");
  return makeTick(spec, scheduledMs, startedMs, putMs, putError);
}

export function tickFromJson(value: unknown, where: string): Tick {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProbeError(500, `tick ${where}: not an object`);
  return checkTick(where, value as Record<string, unknown>);
}

// A tick from one object of a listing of tickPrefix(spec), read from its key and
// its custom metadata.
export function tickFromListing(spec: CronSpec, key: string, metadata: Record<string, string> | undefined): Tick {
  const prefix = tickPrefix(spec);
  if (!key.startsWith(prefix) || !key.endsWith(".json")) throw new ProbeError(500, `${key} is not a tick key of the cron ${spec.cron}`);
  if (metadata === undefined) throw new ProbeError(500, `tick ${key}: listed without its custom metadata`);
  if (metadata.cron !== spec.cron) throw new ProbeError(500, `tick ${key}: its metadata names the cron ${JSON.stringify(metadata.cron)}, and its key names ${spec.cron}`);
  return checkTick(key, { ...metadata, scheduledTime: key.slice(prefix.length, -".json".length) });
}

export interface Window {
  readonly fromMs: number;
  readonly toMs: number;
  readonly nowMs: number;
  readonly complete: boolean;
}

export function windowOf(fromMs: number, hours: number, nowMs: number): Window {
  const toMs = fromMs + checkHours(hours) * HOUR_MS;
  return { fromMs, toMs, nowMs, complete: nowMs >= toMs };
}

// The window starts at the first tick of the verdict cron, or, when it has none,
// at the first tick of any cron. Null when no cron has a tick.
export function defaultFrom(firsts: ReadonlyMap<string, number>): number | null {
  const own = firsts.get(VERDICT_CRON);
  if (own !== undefined) return own;
  let min: number | null = null;
  for (const ms of firsts.values()) if (min === null || ms < min) min = ms;
  return min;
}

// The cron's first tick at or after `to`, which closes the window's last gap.
function firstAfter(ticks: readonly Tick[], spec: CronSpec, toMs: number): Tick | null {
  let first: Tick | null = null;
  for (const tick of ticks) if (tick.cron === spec.cron && tick.scheduledMs >= toMs && (first === null || tick.scheduledMs < first.scheduledMs)) first = tick;
  return first;
}

export function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// The value at index floor(n * q) of the ascending list, as quantile() in
// scripts/measure/clock-gaps.mjs computes it, so that DOM-003 compares the Worker
// clock with the Actions clocks under one definition. The median of an even count
// is the upper of the two middle values.
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

function maxOf(values: readonly number[]): number | null {
  let max: number | null = null;
  for (const value of values) if (max === null || value > max) max = value;
  return max;
}

export interface Spread {
  readonly median: number | null;
  readonly p90: number | null;
  readonly max: number | null;
}

export function spread(values: readonly number[], digits: number): Spread {
  return { median: round(quantile(values, 0.5), digits), p90: round(quantile(values, 0.9), digits), max: round(maxOf(values), digits) };
}

export type Verdict = "PASS" | "FAIL" | "INCOMPLETE";

// The rule applies to the unrounded gaps, as DOM-001's does.
export function judge(gapsMin: readonly number[], complete: boolean): Verdict {
  if (!complete) return "INCOMPLETE";
  const p90 = quantile(gapsMin, 0.9);
  const max = maxOf(gapsMin);
  return p90 !== null && max !== null && p90 <= RULE.p90_max_min && max <= RULE.max_max_min ? "PASS" : "FAIL";
}

export interface Slots {
  readonly expected: number;
  readonly hit: number;
  readonly missed: number;
}

export interface CronSummary {
  readonly event: string;
  readonly interval_min: number;
  readonly runs: number;
  readonly expected: number;
  readonly gaps: number;
  readonly gaps_min: Spread;
  readonly start_lag_s: Spread;
  readonly slots: Slots;
  readonly breaks_over_30min: number;
  readonly verdict: Verdict;
}

// A slot is the interval that starts at a multiple of the cron's interval. The
// slots of a window are those that start in [from, to): ceil(to / I) - ceil(from / I)
// of them, which is hours * 60 / interval for a whole number of hours.
function slotCount(spec: CronSpec, own: readonly Tick[], win: Window | null, expected: number): Slots {
  if (win === null) return { expected, hit: 0, missed: 0 };
  const intervalMs = spec.intervalMin * MINUTE_MS;
  const first = Math.ceil(win.fromMs / intervalMs);
  const last = Math.ceil(win.toMs / intervalMs) - 1;
  if (last - first + 1 !== expected) throw new ProbeError(500, `the window ${iso(win.fromMs)} to ${iso(win.toMs)} holds ${last - first + 1} slots of ${spec.cron}, not ${expected}`);
  // A slot has passed once its whole interval has; in an ended window, every slot has.
  const passedLast = win.complete ? last : Math.min(last, Math.floor(win.nowMs / intervalMs) - 1);
  const held = new Set<number>();
  for (const tick of own) {
    const slot = Math.floor(tick.scheduledMs / intervalMs);
    if (slot >= first && slot <= last) held.add(slot);
  }
  let heldPassed = 0;
  for (const slot of held) if (slot <= passedLast) heldPassed += 1;
  return { expected, hit: held.size, missed: Math.max(0, passedLast - first + 1) - heldPassed };
}

// One cron's numbers over a window. `ticks` may hold any cron's ticks at any time:
// the window and the cron are applied here.
export function summarizeCron(spec: CronSpec, ticks: readonly Tick[], win: Window | null, hours: number): CronSummary {
  const expected = (checkHours(hours) * 60) / spec.intervalMin;
  if (!Number.isInteger(expected)) throw new ProbeError(500, `the interval of ${spec.cron} does not divide an hour`);
  const own =
    win === null
      ? []
      : ticks.filter((tick) => tick.cron === spec.cron && tick.scheduledMs >= win.fromMs && tick.scheduledMs < win.toMs).sort((a, b) => a.startedMs - b.startedMs || a.scheduledMs - b.scheduledMs);
  const gapsMs: number[] = [];
  let previous: Tick | null = null;
  for (const tick of own) {
    if (previous !== null) gapsMs.push(tick.startedMs - previous.startedMs);
    previous = tick;
  }
  if (win !== null) {
    const after = firstAfter(ticks, spec, win.toMs);
    const opened = previous === null ? win.fromMs : previous.startedMs;
    // The closing gap: to the first tick past the window, or to the window's end once it has ended.
    if (after !== null) gapsMs.push(after.startedMs - opened);
    else if (win.complete) gapsMs.push(win.toMs - opened);
  }
  const gapsMin = gapsMs.map((ms) => ms / MINUTE_MS);
  const complete = win !== null && win.complete;
  return {
    event: spec.cron,
    interval_min: spec.intervalMin,
    runs: own.length,
    expected,
    gaps: gapsMin.length,
    gaps_min: spread(gapsMin, 2),
    start_lag_s: spread(
      own.map((tick) => tick.lagMs / 1000),
      3,
    ),
    slots: slotCount(spec, own, win, expected),
    breaks_over_30min: gapsMin.filter((gap) => gap > BREAK_MIN).length,
    verdict: judge(gapsMin, complete),
  };
}

export interface GapsInput {
  readonly ticks: readonly Tick[];
  readonly hours: number;
  // Null when no tick exists: then there is no window.
  readonly fromMs: number | null;
  readonly nowMs: number;
}

export interface GapsResult {
  readonly version: number;
  readonly clock: "worker";
  readonly workflow: string;
  readonly event: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly hours: number;
  readonly runs: number;
  readonly expected: number;
  readonly gaps_min: Spread;
  readonly start_lag_s: Spread;
  readonly slots: Slots;
  readonly breaks_over_30min: number;
  readonly verdict: Verdict;
  readonly rule: { readonly p90_max_min: number; readonly max_max_min: number };
  readonly complete: boolean;
  readonly now: string;
  readonly hours_seen: number;
  readonly interval_min: number;
  readonly gaps: number;
  readonly put_ms: Spread;
  readonly hot_puts: number;
  readonly put_errors: number;
  readonly class_a_ops: number;
  readonly class_b_ops: number;
  readonly beside: CronSummary[];
  readonly definitions: typeof DEFINITIONS;
}

// The result of DOM-002 for one window: the verdict cron's numbers at the top,
// in DOM-001's schema and order, and every other cron's beside them.
export function gapsResult(input: GapsInput): GapsResult {
  const hours = checkHours(input.hours);
  const win = input.fromMs === null ? null : windowOf(input.fromMs, hours, input.nowMs);
  const summaries = CRONS.map((spec) => summarizeCron(spec, input.ticks, win, hours));
  const main = summaries.find((summary) => summary.event === VERDICT_CRON);
  if (main === undefined) throw new ProbeError(500, `the verdict cron ${VERDICT_CRON} has no row in CRONS`);
  const inside = win === null ? [] : input.ticks.filter((tick) => tick.scheduledMs >= win.fromMs && tick.scheduledMs < win.toMs);
  const hot = inside.filter((tick) => requireCron(tick.cron).hot);
  const puts = hot.flatMap((tick) => (tick.putMs === null ? [] : [tick.putMs]));
  return {
    version: RESULT_VERSION,
    clock: "worker",
    workflow: WORKER,
    event: main.event,
    from: win === null ? null : iso(win.fromMs),
    to: win === null ? null : iso(win.toMs),
    hours,
    runs: main.runs,
    expected: main.expected,
    gaps_min: main.gaps_min,
    start_lag_s: main.start_lag_s,
    slots: main.slots,
    breaks_over_30min: main.breaks_over_30min,
    verdict: main.verdict,
    rule: { p90_max_min: RULE.p90_max_min, max_max_min: RULE.max_max_min },
    complete: win !== null && win.complete,
    now: iso(input.nowMs),
    hours_seen: win === null ? 0 : (round(Math.max(0, Math.min(input.nowMs, win.toMs) - win.fromMs) / HOUR_MS, 2) ?? 0),
    interval_min: main.interval_min,
    gaps: main.gaps,
    put_ms: spread(puts, 0),
    hot_puts: hot.length,
    put_errors: hot.filter((tick) => tick.putError !== null).length,
    class_a_ops: inside.length * OPS_PER_TICK.a + hot.length * OPS_PER_HOT_PUT.a,
    class_b_ops: inside.length * OPS_PER_TICK.b + hot.length * OPS_PER_HOT_PUT.b,
    beside: summaries.filter((summary) => summary.event !== VERDICT_CRON),
    definitions: DEFINITIONS,
  };
}
