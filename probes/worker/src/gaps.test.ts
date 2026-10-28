// probes/worker/src/gaps.test.ts — the probe's tick records and the arithmetic of
// DOM-002's result, on synthetic tick lists whose gaps are known.
//
//   node scripts/test.mjs probes/worker --name gaps
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CRONS,
  checkHours,
  DEFINITIONS,
  defaultFrom,
  gapsResult,
  keyTime,
  makeTick,
  OPS_PER_HOT_PUT,
  OPS_PER_TICK,
  ProbeError,
  quantile,
  RULE,
  requireCron,
  type CronSpec,
  type Tick,
  tickFromJson,
  tickFromListing,
  tickKey,
  tickMetadata,
  tickToJson,
  VERDICT_CRON,
} from "./gaps.ts";

const M1 = requireCron("* * * * *");
const M5 = requireCron("*/5 * * * *");
const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const LAG = 40;

interface Plan {
  drop?: (slot: number) => boolean;
  putMs?: number;
}

// The ticks of one cron at every slot of [from, from + hours), each started LAG ms
// late, without the slots that `drop` names.
function ticksOf(spec: CronSpec, fromMs: number, hours: number, plan: Plan = {}): Tick[] {
  const out: Tick[] = [];
  const slots = (hours * 60) / spec.intervalMin;
  for (let slot = 0; slot < slots; slot += 1) {
    if (plan.drop?.(slot)) continue;
    const scheduled = fromMs + slot * spec.intervalMin * MIN;
    out.push(makeTick(spec, scheduled, scheduled + LAG, spec.hot ? (plan.putMs ?? 120) : null, null));
  }
  return out;
}

// Both crons from T0 for `hours`; the minute cron loses the slots `drop` names.
function both(hours: number, drop?: (slot: number) => boolean): Tick[] {
  return [...ticksOf(M1, T0, hours, { drop }), ...ticksOf(M5, T0, hours)];
}

const after48 = T0 + 50 * HOUR;

test("gaps: a quantile is the value at index floor(n * q), as in DOM-001's clock-gaps.mjs", () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([4, 1, 3, 2], 0.5), 3, "the upper middle value of an even count");
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 0.9), 11);
  assert.equal(quantile([5, 1, 4, 2, 3], 0.9), 5);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(quantile([], 0.9), null);
});

test("gaps: 48 hours of on-time ticks give 1 minute gaps, no missed slot and PASS", () => {
  // The crons run on past the window, as the probe does until DOM-002 stops them.
  const r = gapsResult({ ticks: both(49), hours: 48, fromMs: T0, nowMs: after48 });
  assert.equal(r.version, 1);
  assert.equal(r.clock, "worker");
  assert.equal(r.workflow, "domains-probe");
  assert.equal(r.event, VERDICT_CRON);
  assert.equal(r.from, "2026-10-01T12:00:00.000Z");
  assert.equal(r.to, "2026-10-03T12:00:00.000Z");
  assert.equal(r.complete, true);
  assert.equal(r.hours_seen, 48);
  assert.equal(r.runs, 2880);
  assert.equal(r.expected, 2880);
  assert.equal(r.gaps, 2880);
  assert.deepEqual(r.gaps_min, { median: 1, p90: 1, max: 1 });
  assert.deepEqual(r.start_lag_s, { median: 0.04, p90: 0.04, max: 0.04 });
  assert.deepEqual(r.slots, { expected: 2880, hit: 2880, missed: 0 });
  assert.equal(r.breaks_over_30min, 0);
  assert.equal(r.verdict, "PASS");
  assert.deepEqual(r.rule, { p90_max_min: 15, max_max_min: 60 });
  assert.equal(r.interval_min, 1);
  assert.deepEqual(r.put_ms, { median: 120, p90: 120, max: 120 });
  assert.equal(r.hot_puts, 576);
  assert.equal(r.put_errors, 0);
  assert.equal(r.class_a_ops, (2880 + 576) * OPS_PER_TICK.a + 576 * OPS_PER_HOT_PUT.a);
  assert.equal(r.class_a_ops, 7488);
  assert.equal(r.class_b_ops, 0);
  assert.deepEqual(r.definitions, DEFINITIONS);
  assert.equal(r.beside.length, 1);
  const five = r.beside[0]!;
  assert.equal(five.event, "*/5 * * * *");
  assert.equal(five.interval_min, 5);
  assert.equal(five.runs, 576);
  assert.equal(five.expected, 576);
  assert.deepEqual(five.gaps_min, { median: 5, p90: 5, max: 5 });
  assert.deepEqual(five.slots, { expected: 576, hit: 576, missed: 0 });
  assert.equal(five.verdict, "PASS");
});

test("gaps: a 45 minute hole passes the rule and counts one break over 30 minutes", () => {
  // Slots 100 to 143 are lost: the tick of slot 144 starts 45 minutes after slot 99's.
  const r = gapsResult({ ticks: both(49, (s) => s >= 100 && s < 144), hours: 48, fromMs: T0, nowMs: after48 });
  assert.equal(r.runs, 2880 - 44);
  assert.deepEqual(r.gaps_min, { median: 1, p90: 1, max: 45 });
  assert.deepEqual(r.slots, { expected: 2880, hit: 2836, missed: 44 });
  assert.equal(r.breaks_over_30min, 1);
  assert.equal(r.verdict, "PASS");
});

test("gaps: a 61 minute hole fails the rule", () => {
  const r = gapsResult({ ticks: both(49, (s) => s >= 100 && s < 160), hours: 48, fromMs: T0, nowMs: after48 });
  assert.equal(r.gaps_min.max, 61);
  assert.equal(r.slots.missed, 60);
  assert.equal(r.verdict, "FAIL");
});

test("gaps: a p90 gap over 15 minutes fails the rule when no gap passes 60", () => {
  const r = gapsResult({ ticks: both(49, (s) => s % 20 !== 0), hours: 48, fromMs: T0, nowMs: after48 });
  assert.deepEqual(r.gaps_min, { median: 20, p90: 20, max: 20 });
  assert.ok(r.gaps_min.p90! > RULE.p90_max_min);
  assert.equal(r.verdict, "FAIL");
});

// Minute ticks from T0 for `hours`, slot s scheduled at T0 + s min and started
// LAG ms plus delay(s) later: the gaps are read on startedAt, never on
// scheduledTime, so a clock that is late shows in them.
function lateTicks(hours: number, delay: (slot: number) => number): Tick[] {
  const out: Tick[] = [];
  for (let slot = 0; slot < hours * 60; slot += 1) {
    const scheduled = T0 + slot * MIN;
    out.push(makeTick(M1, scheduled, scheduled + LAG + delay(slot), null, null));
  }
  return out;
}

test("gaps: a clock that stalls once and stays late fails on the startedAt gap, though every slot is hit", () => {
  // From slot 20 on, every invocation starts 70 minutes late: one gap of 71
  // minutes between slots 19 and 20, then 1 minute gaps on the late clock.
  const r = gapsResult({ ticks: [...lateTicks(3, (s) => (s >= 20 ? 70 * MIN : 0)), ...ticksOf(M5, T0, 3)], hours: 2, fromMs: T0, nowMs: T0 + 5 * HOUR });
  assert.equal(r.runs, 120);
  assert.deepEqual(r.slots, { expected: 120, hit: 120, missed: 0 });
  assert.equal(r.gaps, 120);
  assert.deepEqual(r.gaps_min, { median: 1, p90: 1, max: 71 });
  assert.equal(r.breaks_over_30min, 1);
  assert.deepEqual(r.start_lag_s, { median: 4200.04, p90: 4200.04, max: 4200.04 });
  assert.equal(r.verdict, "FAIL");
});

test("gaps: one invocation 45 minutes late, with the clock on time around it, is a lag and no gap", () => {
  // Slot 30 starts at 75 min + LAG, together with slot 75: sorted by startedAt
  // the gaps are 2 min (29 to 31), then 1 min, and 0 min (30 beside 75).
  const r = gapsResult({ ticks: [...lateTicks(3, (s) => (s === 30 ? 45 * MIN : 0)), ...ticksOf(M5, T0, 3)], hours: 2, fromMs: T0, nowMs: T0 + 5 * HOUR });
  assert.equal(r.runs, 120);
  assert.deepEqual(r.gaps_min, { median: 1, p90: 1, max: 2 });
  assert.equal(r.breaks_over_30min, 0);
  assert.equal(r.start_lag_s.max, 2700.04);
  assert.equal(r.verdict, "PASS");
});

test("gaps: two invocations that start out of order give no negative gap", () => {
  // Slot 10 starts 90 s late, after slot 11: by startedAt 9, 11, 10, 12 give
  // gaps of 2, 0.5 and 0.5 minutes.
  const r = gapsResult({ ticks: [...lateTicks(2, (s) => (s === 10 ? 90_000 : 0)), ...ticksOf(M5, T0, 2)], hours: 1, fromMs: T0, nowMs: T0 + 3 * HOUR });
  assert.equal(r.gaps, 60);
  assert.deepEqual(r.gaps_min, { median: 1, p90: 1, max: 2 });
  assert.equal(r.verdict, "PASS");
});

test("gaps: the verdict is PASS at the bounds of the rule, and FAIL one second past them", () => {
  // Minute ticks at the given [minute, extra seconds] of their start, over a
  // window of 2 hours; the tick at minute 120 closes the last gap.
  const verdictOf = (starts: [number, number?][]) => {
    const ticks = starts.map(([m, s = 0]) => makeTick(M1, T0 + m * MIN, T0 + m * MIN + LAG + s * 1000, null, null));
    return gapsResult({ ticks, hours: 2, fromMs: T0, nowMs: T0 + 3 * HOUR });
  };
  const every = (step: number, skip: (m: number) => boolean = () => false) => {
    const out: [number, number?][] = [];
    for (let m = 0; m <= 120; m += step) if (!skip(m)) out.push([m]);
    return out;
  };
  // Eight gaps of 15 min: the p90 is the max, 15.
  const even = every(15);
  assert.deepEqual(verdictOf(even).gaps_min, { median: 15, p90: RULE.p90_max_min, max: 15 });
  assert.equal(verdictOf(even).verdict, "PASS");
  even[4] = [60, 1];
  assert.equal(verdictOf(even).verdict, "FAIL", "a p90 gap of 15 min 1 s is over the rule");
  // Twelve gaps of 5 min and one of 60 (minutes 35 to 85 missing): the p90 is 5.
  const holed = every(5, (m) => m >= 35 && m <= 85);
  assert.deepEqual(verdictOf(holed).gaps_min, { median: 5, p90: 5, max: RULE.max_max_min });
  assert.equal(verdictOf(holed).verdict, "PASS");
  holed[7] = [90, 1];
  assert.equal(verdictOf(holed).verdict, "FAIL", "a max gap of 60 min 1 s is over the rule");
  // A break is a gap over 30 minutes: 30 min is none, 30 min 1 s is one.
  const thirty = every(30);
  assert.equal(verdictOf(thirty).breaks_over_30min, 0);
  thirty[2] = [60, 1];
  assert.equal(verdictOf(thirty).breaks_over_30min, 1);
});

test("gaps: a window that starts off a 5 minute boundary holds the slots that start in it", () => {
  // The window is 12:03 to 13:03: minute slots 12:03 to 13:02, and the
  // 5-minute slots 12:05 to 13:00. The 12:00 tick of each cron is before it.
  const fromMs = T0 + 3 * MIN;
  const r = gapsResult({ ticks: both(2), hours: 1, fromMs, nowMs: T0 + 3 * HOUR });
  assert.equal(r.from, "2026-10-01T12:03:00.000Z");
  assert.equal(r.runs, 60);
  assert.deepEqual(r.slots, { expected: 60, hit: 60, missed: 0 });
  const five = r.beside[0]!;
  assert.equal(five.runs, 12);
  assert.deepEqual(five.slots, { expected: 12, hit: 12, missed: 0 });
  // Read early, at 12:17:30: the minute slots 12:03 to 12:16 and the 5-minute
  // slots 12:05 and 12:10 have passed.
  const early = gapsResult({ ticks: both(2, (s) => s === 8), hours: 1, fromMs, nowMs: T0 + 17.5 * MIN });
  assert.equal(early.slots.missed, 1);
  assert.equal(early.beside[0]!.slots.missed, 0);
});

test("gaps: a cron that stops inside the window fails on its closing gap to the window's end", () => {
  // The minute cron's last tick is slot 2399 (hour 40); nothing comes after it.
  const r = gapsResult({ ticks: both(48, (s) => s >= 2400), hours: 48, fromMs: T0, nowMs: after48 });
  assert.equal(r.gaps_min.max, 481);
  assert.equal(r.gaps_min.p90, 1);
  assert.equal(r.slots.missed, 480);
  assert.equal(r.breaks_over_30min, 1);
  assert.equal(r.verdict, "FAIL");
});

test("gaps: the closing gap runs to the first tick after the window when one came", () => {
  // Silent from hour 40 until a tick at hour 50.
  const ticks = [...both(48, (s) => s >= 2400), makeTick(M1, T0 + 50 * HOUR, T0 + 50 * HOUR + LAG, null, null)];
  const r = gapsResult({ ticks, hours: 48, fromMs: T0, nowMs: T0 + 51 * HOUR });
  assert.equal(r.gaps_min.max, 601);
  assert.equal(r.verdict, "FAIL");
});

test("gaps: a reading before the window ends is INCOMPLETE and counts no future slot", () => {
  const nowMs = T0 + 10.5 * MIN;
  const ticks = ticksOf(M1, T0, 1, { drop: (s) => s > 10 || s === 5 });
  const r = gapsResult({ ticks, hours: 1, fromMs: T0, nowMs });
  assert.equal(r.complete, false);
  assert.equal(r.verdict, "INCOMPLETE");
  assert.equal(r.hours_seen, 0.18);
  assert.equal(r.runs, 10);
  assert.equal(r.expected, 60);
  // No closing gap yet: the gaps are the 9 between the 10 ticks.
  assert.equal(r.gaps, 9);
  // Slots 0 to 9 have passed and slot 5 holds no tick; slot 10 has a tick and has not passed.
  assert.deepEqual(r.slots, { expected: 60, hit: 10, missed: 1 });
});

test("gaps: no tick gives no window, no slot counted and INCOMPLETE", () => {
  const r = gapsResult({ ticks: [], hours: 1, fromMs: null, nowMs: T0 });
  assert.equal(r.from, null);
  assert.equal(r.to, null);
  assert.equal(r.complete, false);
  assert.equal(r.hours_seen, 0);
  assert.equal(r.runs, 0);
  assert.equal(r.gaps, 0);
  assert.deepEqual(r.gaps_min, { median: null, p90: null, max: null });
  assert.deepEqual(r.slots, { expected: 60, hit: 0, missed: 0 });
  assert.equal(r.verdict, "INCOMPLETE");
});

test("gaps: an ended window with no tick of the verdict cron is one gap, the whole window, and FAILs", () => {
  const r = gapsResult({ ticks: ticksOf(M5, T0, 2), hours: 2, fromMs: T0, nowMs: T0 + 3 * HOUR });
  assert.equal(r.runs, 0);
  assert.equal(r.gaps, 1);
  assert.equal(r.gaps_min.max, 120);
  assert.equal(r.slots.missed, 120);
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.beside[0]!.verdict, "PASS");
});

test("gaps: ticks outside the window are not counted, and the first after it closes the last gap", () => {
  const ticks = [...ticksOf(M1, T0 - HOUR, 1), ...ticksOf(M1, T0, 1), ...ticksOf(M1, T0 + HOUR, 1)];
  const r = gapsResult({ ticks, hours: 1, fromMs: T0, nowMs: T0 + 3 * HOUR });
  assert.equal(r.runs, 60);
  assert.equal(r.gaps, 60);
  assert.deepEqual(r.gaps_min, { median: 1, p90: 1, max: 1 });
  assert.equal(r.class_a_ops, 60 * OPS_PER_TICK.a);
});

test("gaps: a failed hot put counts in put_errors and class_a_ops and not in put_ms", () => {
  const ticks = ticksOf(M1, T0, 1);
  ticks.push(makeTick(M5, T0, T0 + LAG, 80, null), makeTick(M5, T0 + 5 * MIN, T0 + 5 * MIN + LAG, null, "R2 answered 503"), makeTick(M5, T0 + 10 * MIN, T0 + 10 * MIN + LAG, 200, null));
  const r = gapsResult({ ticks, hours: 1, fromMs: T0, nowMs: T0 + 2 * HOUR });
  assert.equal(r.hot_puts, 3);
  assert.equal(r.put_errors, 1);
  // put_ms holds 80 and 200: the median of an even count is the upper middle value.
  assert.deepEqual(r.put_ms, { median: 200, p90: 200, max: 200 });
  assert.equal(r.class_a_ops, 63 * OPS_PER_TICK.a + 3 * OPS_PER_HOT_PUT.a);
});

test("gaps: the window starts at the minute cron's first tick, else at the earliest tick of any cron", () => {
  assert.equal(
    defaultFrom(
      new Map([
        ["*/5 * * * *", T0 - MIN],
        [VERDICT_CRON, T0],
      ]),
    ),
    T0,
  );
  assert.equal(defaultFrom(new Map([["*/5 * * * *", T0 - MIN]])), T0 - MIN);
  assert.equal(defaultFrom(new Map()), null);
});

test("gaps: hours outside 1 to 336 are refused with status 400", () => {
  for (const bad of [0, 337, 1.5, -1, Number.NaN]) {
    assert.throws(
      () => checkHours(bad),
      (err: unknown) => err instanceof ProbeError && err.status === 400,
    );
  }
  assert.equal(checkHours(336), 336);
});

test("gaps: tick keys sort in time order and name their scheduled time", () => {
  const times = [T0 + 9 * MIN, T0 - 2 * HOUR, T0 + 59 * 1000, T0, T0 + 10 * HOUR];
  const keys = times.map((t) => tickKey(M1, t));
  assert.deepEqual(
    [...keys].sort(),
    [...times].sort((a, b) => a - b).map((t) => tickKey(M1, t)),
  );
  assert.equal(keys[0], "ticks/m1/2026-10-01T12:09:00.000Z.json");
  for (const [i, key] of keys.entries()) assert.equal(keyTime(M1, key), times[i]);
  assert.equal(keyTime(M5, keys[0]!), null);
  assert.equal(keyTime(M1, "ticks/m1/2026-10-01T12:09:00Z.json"), null);
});

test("gaps: a tick round-trips through its JSON and through its key and R2 metadata", () => {
  for (const tick of [makeTick(M1, T0, T0 + 37, null, null), makeTick(M5, T0, T0 - 3, 145, null), makeTick(M5, T0, T0 + 9, null, "x".repeat(400))]) {
    assert.deepEqual(tickFromJson(JSON.parse(JSON.stringify(tickToJson(tick))), "t"), tick);
    const spec = requireCron(tick.cron);
    assert.deepEqual(tickFromListing(spec, tickKey(spec, tick.scheduledMs), tickMetadata(tick)), tick);
  }
  assert.equal(makeTick(M5, T0, T0, null, "x".repeat(400)).putError!.length, 256);
});

test("gaps: a tick record that breaks a rule is refused", () => {
  const good = tickToJson(makeTick(M5, T0, T0 + 40, 100, null));
  const bad: Record<string, unknown>[] = [
    { ...good, lag_ms: 41 },
    { ...good, v: 2 },
    { ...good, cron: "*/7 * * * *" },
    { ...good, scheduledTime: "2026-10-01T12:00:00Z" },
    { ...good, startedAt: "yesterday" },
    { ...good, put_ms: undefined },
    { ...good, put_error: "both" },
    { ...good, put_ms: -1 },
    { ...tickToJson(makeTick(M1, T0, T0 + 40, null, null)), put_ms: 5 },
  ];
  for (const record of bad) assert.throws(() => tickFromJson(JSON.parse(JSON.stringify(record)), "bad"), ProbeError, JSON.stringify(record));
  // Each rule refuses on its own, with its own words.
  const named: [Record<string, unknown>, RegExp][] = [
    [{ ...good, v: "1.0" }, /version 1\.0/],
    [{ ...good, scheduledTime: T0 }, /scheduledTime is not a toISOString time/],
    [{ ...good, startedAt: "2026-10-01T12:00:00.040+00:00" }, /startedAt is not a toISOString time/],
    [{ ...good, lag_ms: 40.5 }, /lag_ms 40\.5 is not startedAt minus scheduledTime/],
    [{ ...good, lag_ms: "40.0" }, /lag_ms 40\.0 is not/],
    [{ ...good, lag_ms: "4".repeat(16) }, /lag_ms 4{16} is not/],
    [{ ...good, put_ms: 1.5 }, /put_ms 1\.5 is not a whole number/],
    [{ ...good, put_ms: "12a" }, /put_ms 12a is not a whole number/],
    [{ ...good, put_ms: 2 ** 53 }, /put_ms 9007199254740992 is not a whole number/],
    [{ ...good, put_ms: undefined, put_error: 503 }, /put_error is not text/],
    [{ ...good, put_ms: undefined }, /exactly one of put_ms and put_error/],
    [{ ...tickToJson(makeTick(M1, T0, T0 + 40, null, null)), put_error: "x" }, /not hot carries no put/],
  ];
  for (const [record, message] of named)
    assert.throws(
      () => tickFromJson(JSON.parse(JSON.stringify(record)), "bad"),
      (err: unknown) => err instanceof ProbeError && err.status === 500 && message.test(err.message),
      JSON.stringify(record),
    );
  // Metadata is text: a lag as decimal digits is read, and a sign is allowed.
  assert.equal(tickFromJson({ ...good, v: "1", lag_ms: "40", put_ms: "100" }, "text").lagMs, 40);
  assert.equal(tickFromJson({ ...tickToJson(makeTick(M1, T0, T0 - 3, null, null)), lag_ms: "-3" }, "early").lagMs, -3);
  assert.throws(() => tickFromJson([], "array"), ProbeError);
  const md = tickMetadata(makeTick(M1, T0, T0 + 40, null, null));
  assert.throws(() => tickFromListing(M1, tickKey(M1, T0), undefined), /without its custom metadata/);
  assert.throws(() => tickFromListing(M5, tickKey(M5, T0), md), /names the cron/);
  assert.throws(() => tickFromListing(M1, "ticks/m1/2026-10-01T12:00:00.000Z.bin", md), /not a tick key/);
});

test("gaps: every cron's interval divides an hour, slugs are unique and the verdict cron has a row", () => {
  assert.ok(CRONS.some((spec) => spec.cron === VERDICT_CRON));
  assert.equal(new Set(CRONS.map((spec) => spec.slug)).size, CRONS.length);
  for (const spec of CRONS) assert.equal(60 % spec.intervalMin, 0, spec.cron);
  assert.throws(() => requireCron("0 * * * *"), ProbeError);
});
