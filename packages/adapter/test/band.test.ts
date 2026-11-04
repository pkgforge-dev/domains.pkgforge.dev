// packages/adapter/src/band.ts. The replay reads THC's daily sizes from the
// measured file docs/research/measure/DOM-009/result.json: `per_day[].gz_bytes`,
// the gzip size of each day's dump in the Hugging Face bucket, 54 days from
// 2026-09-01 to 2026-10-26, and LATE below for 10-27 to 10-31. The other tests
// use synthetic histories.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type BandDay, BandError, type BandResult, checkBand, median } from "../src/band.ts";
import type { Band } from "../src/types.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DOM_009 = JSON.parse(readFileSync(join(ROOT, "docs", "research", "measure", "DOM-009", "result.json"), "utf8")) as {
  span: { first: string; last: string; days: number; gaps: string[] };
  per_day: { day: string; gz_bytes: number }[];
};
const THC: { day: string; count: number }[] = DOM_009.per_day.map((d) => ({ day: d.day, count: d.gz_bytes }));
// docs/architecture.md section 5.8: 40% and 250% of the median, the band
// before DOM-029. THC's own (adapters/thc-ct/source.json, D6 of DOM-029) is
// 40% and 400%.
const RELATIVE: Band = { metric: "bytes", min: 0.4, max: 2.5, relative: true };
const THC_BAND: Band = { metric: "bytes", min: 0.4, max: 4, relative: true };
// The five days after DOM-009's, from the bucket's listing (MEASURED
// 2026-11-01T07:45:37Z, DOM-029's design M2): 59 days in all.
const LATE: readonly { day: string; count: number }[] = [
  { day: "2026-10-27", count: 348_643_615 },
  { day: "2026-10-28", count: 360_799_046 },
  { day: "2026-10-29", count: 341_588_311 },
  { day: "2026-10-30", count: 331_290_206 },
  { day: "2026-10-31", count: 324_537_041 },
];
const MB = (n: number | null): number => Math.round((n ?? Number.NaN) / 1e6);

// The backfill in date order: each day checked against the verdicts before it.
function replay(resetAfter?: number, band: Band = RELATIVE, sizes: readonly { day: string; count: number }[] = THC): Map<string, BandResult> {
  const history: BandDay[] = [];
  const out = new Map<string, BandResult>();
  for (const d of sizes) {
    const r = checkBand(d.count, history, band, { precision: "day", ...(resetAfter === undefined ? {} : { resetAfter }) });
    out.set(d.day, r);
    // A day source never holds (D26 of DOM-029).
    assert.notEqual(r.verdict, "hold", d.day);
    history.push({ day: d.day, count: d.count, quarantined: r.verdict === "quarantine" });
  }
  return out;
}

test("adapter band: the THC sizes are DOM-009's 54 days, 2026-09-01 to 2026-10-26 without 10-04 and 10-09", () => {
  assert.equal(THC.length, 54);
  assert.equal(DOM_009.span.days, 54);
  assert.equal(THC[0]!.day, "2026-09-01");
  assert.equal(THC.at(-1)!.day, "2026-10-26");
  assert.deepEqual(DOM_009.span.gaps, ["2026-10-04", "2026-10-09"]);
  assert.ok(!THC.some((d) => DOM_009.span.gaps.includes(d.day)));
  // The bucket's total of docs/architecture.md section 5.5 (MEASURED 2026-10-27T08:25:12Z).
  assert.equal(
    THC.reduce((s, d) => s + d.count, 0),
    35_765_972_194,
  );
});

test("adapter band: the THC backfill quarantines 10-05 and 10-06, accepts 10-07 with a baseline of 294 MB, and quarantines 10-15", () => {
  const r = replay();
  const d05 = r.get("2026-10-05")!;
  assert.equal(d05.verdict, "quarantine");
  // docs/architecture.md section 5.8: the floor of 379 MB is 40% of 947 MB.
  assert.equal(MB(d05.median), 947);
  assert.equal(MB(d05.floor), 379);
  assert.equal(r.get("2026-10-06")!.verdict, "quarantine");
  const d07 = r.get("2026-10-07")!;
  assert.deepEqual([d07.verdict, d07.reason], ["ok", "step-change"]);
  // The median of 10-05, 10-06 and 10-07 is 10-06's size.
  assert.equal(d07.reset, 294_318_949);
  assert.equal(MB(d07.reset), 294);
  const d15 = r.get("2026-10-15")!;
  assert.deepEqual([d15.verdict, d15.reason], ["quarantine", "below"]);
  assert.equal(MB(THC.find((d) => d.day === "2026-10-15")!.count), 77);
  // 10-11's size, the median of 10-07, 10-08, 10-10, 10-11, 10-12, 10-13 and 10-14.
  assert.equal(d15.median, 275_540_184);
  assert.equal(MB(d15.median), 276);
  // Every other day is accepted, and 10-07 is the only reset.
  assert.deepEqual(
    [...r].filter(([, v]) => v.verdict !== "ok").map(([day]) => day),
    ["2026-10-05", "2026-10-06", "2026-10-15"],
  );
  assert.deepEqual(
    [...r].filter(([, v]) => v.reset !== null).map(([day]) => day),
    ["2026-10-07"],
  );
});

test("adapter band: THC's band of 0.4 and 4 over the 59 listed days gives the same three quarantines and one reset, and holds nothing (M12)", () => {
  const r = replay(undefined, THC_BAND, [...THC, ...LATE]);
  assert.equal(r.size, 59);
  assert.deepEqual(
    [...r].filter(([, v]) => v.verdict !== "ok").map(([day, v]) => `${day} ${v.verdict} ${v.reason}`),
    ["2026-10-05 quarantine below", "2026-10-06 quarantine below", "2026-10-15 quarantine below"],
  );
  assert.deepEqual(
    [...r].filter(([, v]) => v.reset !== null).map(([day, v]) => `${day} ${v.reset}`),
    ["2026-10-07 294318949"],
  );
  // The verdicts of DOM-009's 54 days are those of the band of 2.5: only the ceiling moves.
  const before = replay();
  const kept = (v: BandResult | undefined) => (v === undefined ? null : [v.verdict, v.reason, v.median, v.floor, v.reset]);
  for (const [day, v] of before) assert.deepEqual(kept(r.get(day)), kept(v), day);
  // A return to September's volume after 10-31 (986 MB over a median of 331 MB) is a normal day.
  const history = [...r].map(([day, v]) => ({ day, count: [...THC, ...LATE].find((d) => d.day === day)!.count, quarantined: v.verdict === "quarantine" }));
  const back = checkBand(986e6, history, THC_BAND, { precision: "day" });
  assert.deepEqual([back.verdict, back.reason, MB(back.median)], ["ok", "within", 331]);
  assert.deepEqual(checkBand(986e6, history, RELATIVE, { precision: "day" }).verdict, "quarantine");
});

test("adapter band: without the step change all 21 observed THC days from 10-05 are quarantined", () => {
  const r = replay(Number.POSITIVE_INFINITY);
  const from = [...r].filter(([day]) => day >= "2026-10-05");
  assert.equal(from.length, 21);
  assert.ok(from.every(([, v]) => v.verdict === "quarantine"));
  assert.ok(from.every(([, v]) => MB(v.median) === 947));
});

// Synthetic histories from here on.
const days = (...counts: [number, boolean][]): BandDay[] => counts.map(([count, quarantined], i) => ({ day: `2026-01-${String(i + 1).padStart(2, "0")}`, count, quarantined }));
const steady = days([100, false], [100, false], [100, false]);
const verdict = (count: number, history: BandDay[], precision: "day" | "second" = "day", band: Band = RELATIVE) => {
  const r = checkBand(count, history, band, { precision });
  return [r.verdict, r.reason];
};

test("adapter band: the first day has no baseline and is accepted", () => {
  assert.deepEqual(verdict(5, []), ["ok", "no-baseline"]);
});

test("adapter band: outside the band is quarantine for a day source and hold for a second source, below the floor and above the ceiling alike", () => {
  assert.deepEqual(verdict(39, steady), ["quarantine", "below"]);
  assert.deepEqual(verdict(40, steady), ["ok", "within"]);
  assert.deepEqual(verdict(39, steady, "second"), ["hold", "below"]);
  assert.deepEqual(verdict(250, steady), ["ok", "within"]);
  // D26 of DOM-029: a day above the ceiling of a day source is quarantined, not held.
  assert.deepEqual(verdict(251, steady), ["quarantine", "above"]);
  assert.deepEqual(verdict(251, steady, "second"), ["hold", "above"]);
});

test("adapter band: three consecutive days above the ceiling reset the baseline upward, and the third is ok step-change", () => {
  const two = [...steady, { day: "2026-01-04", count: 300, quarantined: true }, { day: "2026-01-05", count: 400, quarantined: true }];
  const r = checkBand(500, two, RELATIVE, { precision: "day" });
  assert.deepEqual([r.verdict, r.reason, r.reset, r.median], ["ok", "step-change", 400, 100]);
  // One day above is not a run.
  assert.deepEqual(verdict(500, two.slice(0, 4)), ["quarantine", "above"]);
  // After the reset the baseline is 300, 400 and 500: 1000 is within, 1300 above.
  const after = [...two, { day: "2026-01-06", count: 500, quarantined: false }];
  assert.deepEqual(checkBand(1000, after, RELATIVE, { precision: "day" }).median, 400);
  assert.deepEqual(verdict(1000, after), ["ok", "within"]);
  assert.deepEqual(verdict(1001, after), ["quarantine", "above"]);
  // A second source never resets, upward either.
  assert.deepEqual(verdict(500, two, "second"), ["hold", "above"]);
  // Two days below and then one above is no reset: the run is of one side, and the day above starts its own.
  const twoBelow = [...steady, { day: "2026-01-04", count: 30, quarantined: true }, { day: "2026-01-05", count: 25, quarantined: true }];
  assert.deepEqual(verdict(10, twoBelow), ["ok", "step-change"]);
  assert.deepEqual(verdict(500, twoBelow), ["quarantine", "above"]);
  assert.deepEqual(verdict(10, two), ["quarantine", "below"]);
  // A day above breaks a run below, and a day below one above: the run is of one side.
  assert.deepEqual(verdict(10, [...steady, { day: "2026-01-04", count: 30, quarantined: true }, { day: "2026-01-05", count: 300, quarantined: true }]), ["quarantine", "below"]);
  assert.deepEqual(verdict(500, [...steady, { day: "2026-01-04", count: 30, quarantined: true }, { day: "2026-01-05", count: 300, quarantined: true }]), ["quarantine", "above"]);
});

// The door lens of DOM-029's design (M20), under THC's band: a short outage,
// then the old volume. Under the rule before D26 the recovered day held, and a
// held day writes no history, so it held for good.
function outageThenRecovery(level: number, low: number, back: number): BandResult[] {
  const history: BandDay[] = [];
  let n = 1;
  const push = (count: number): BandResult => {
    const r = checkBand(count, history, THC_BAND, { precision: "day" });
    assert.notEqual(r.verdict, "hold");
    history.push({ day: `2026-03-${String(n++).padStart(2, "0")}`, count, quarantined: r.verdict === "quarantine" });
    return r;
  };
  for (let i = 0; i < 7; i++) push(level + i * 5e6);
  for (let i = 0; i < 3; i++) push(low);
  return [push(back), push(back), push(back), push(back)];
}

test("adapter band: after three 77 MB days the 340 MB day is quarantined, and the source resumes on the third such day", () => {
  const r = outageThenRecovery(300e6, 77e6, 340e6);
  assert.deepEqual(
    r.map((x) => `${x.verdict} ${x.reason}`),
    ["quarantine above", "quarantine above", "ok step-change", "ok within"],
  );
  assert.equal(MB(r[0]!.median), 77);
  assert.equal(MB(r[0]!.ceiling), 308);
  assert.equal(MB(r[2]!.reset), 340);
});

test("adapter band: after three 5 MB days a 300 MB day resumes the same way", () => {
  const r = outageThenRecovery(300e6, 5e6, 300e6);
  assert.deepEqual(
    r.map((x) => `${x.verdict} ${x.reason}`),
    ["quarantine above", "quarantine above", "ok step-change", "ok within"],
  );
  assert.equal(MB(r[2]!.reset), 300);
});

test("adapter band: a missing day neither counts nor breaks the run of low days", () => {
  // Days 4 and 5 low and quarantined; day 6 missing; day 7 low ends the run.
  const history: BandDay[] = [...steady, { day: "2026-01-04", count: 30, quarantined: true }, { day: "2026-01-05", count: 20, quarantined: true }];
  const r = checkBand(10, history, RELATIVE, { precision: "day" });
  assert.deepEqual([r.verdict, r.reason, r.reset], ["ok", "step-change", 20]);
  // A second source never resets.
  assert.deepEqual(verdict(10, history, "second"), ["hold", "below"]);
});

test("adapter band: an accepted day between two low days breaks the run", () => {
  assert.deepEqual(verdict(10, days([100, false], [100, false], [30, true], [100, false], [30, true])), ["quarantine", "below"]);
});

test("adapter band: a day quarantined above the floor, for another reason, does not count toward a run", () => {
  assert.deepEqual(verdict(10, days([100, false], [100, false], [30, true], [90, true])), ["quarantine", "below"]);
  // Exactly at the floor of 40 is not below it.
  assert.deepEqual(verdict(10, days([100, false], [100, false], [100, false], [40, true], [40, true])), ["quarantine", "below"]);
});

test("adapter band: after a reset the run's days are the baseline, until accepted days replace them", () => {
  // Reset on day 6 to the median of 30, 20 and 10; day 7 compares with it. The
  // reset day's 10 alone would give a median of 10.
  const history = days([100, false], [100, false], [100, false], [30, true], [20, true], [10, false]);
  const r = checkBand(25, history, RELATIVE, { precision: "day" });
  assert.deepEqual([r.verdict, r.median], ["ok", 20]);
  assert.deepEqual(verdict(7, history), ["quarantine", "below"]);
  assert.deepEqual(verdict(8, history), ["ok", "within"]);
});

test("adapter band: the baseline is the median of the last 7 accepted days, the mean of the middle two when even", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]), BandError);
  // Ten accepted days; the oldest three (1000 each) are out of the window.
  const history = days([1000, false], [1000, false], [1000, false], [10, false], [10, false], [10, false], [10, false], [10, false], [10, false], [10, false]);
  assert.equal(checkBand(10, history, RELATIVE, { precision: "day" }).median, 10);
});

test("adapter band: history order does not matter: the replay runs in day order", () => {
  // In day order the last 7 are one 10 and six 1000, median 1000. Read newest
  // first, the last 7 would be three 1000 and four 10, median 10.
  const history = days([10, false], [10, false], [10, false], [10, false], [1000, false], [1000, false], [1000, false], [1000, false], [1000, false], [1000, false]);
  const sorted = checkBand(500, history, RELATIVE, { precision: "day" });
  assert.deepEqual([sorted.verdict, sorted.reason, sorted.median], ["ok", "within", 1000]);
  const shuffled = [history[3]!, history[8]!, history[0]!, history[9]!, history[5]!, history[1]!, history[7]!, history[2]!, history[6]!, history[4]!];
  assert.deepEqual(checkBand(500, [...history].reverse(), RELATIVE, { precision: "day" }), sorted);
  assert.deepEqual(checkBand(500, shuffled, RELATIVE, { precision: "day" }), sorted);
});

test("adapter band: a median of zero puts every non-zero day above: a day source quarantines it, a second source holds it", () => {
  const zero = days([0, false], [0, false]);
  assert.deepEqual(verdict(0, zero), ["ok", "within"]);
  assert.deepEqual(verdict(1, zero), ["quarantine", "above"]);
  assert.deepEqual(verdict(1, zero, "second"), ["hold", "above"]);
  // The third non-zero day resets the baseline.
  assert.deepEqual(verdict(1, days([0, false], [0, false], [1, true], [1, true])), ["ok", "step-change"]);
});

test("adapter band: an absolute band compares with min and max themselves and never resets", () => {
  const band: Band = { metric: "count", min: 100, max: 1000, relative: false };
  const low = days([10, true], [10, true]);
  const r = checkBand(10, low, band, { precision: "day" });
  assert.deepEqual([r.verdict, r.floor, r.ceiling, r.median], ["quarantine", 100, 1000, null]);
  // A day source quarantines above an absolute band too (D26 of DOM-029), and never resets it.
  assert.deepEqual(verdict(1001, [], "day", band), ["quarantine", "above"]);
  assert.deepEqual(verdict(1001, days([2000, true], [2000, true]), "day", band), ["quarantine", "above"]);
  assert.deepEqual(verdict(1001, [], "second", band), ["hold", "above"]);
  assert.deepEqual(verdict(1000, [], "day", band), ["ok", "within"]);
  assert.deepEqual(verdict(100, [], "second", band), ["ok", "within"]);
  assert.deepEqual(verdict(99, [], "second", band), ["hold", "below"]);
});

test("adapter band: a malformed count, history, band or option is refused", () => {
  const bad: [string, () => unknown][] = [
    ["negative count", () => checkBand(-1, steady, RELATIVE, { precision: "day" })],
    ["NaN count", () => checkBand(Number.NaN, steady, RELATIVE, { precision: "day" })],
    ["a day twice", () => checkBand(1, [...steady, steady[0]!], RELATIVE, { precision: "day" })],
    ["a bad day", () => checkBand(1, [{ day: "2026-02-30", count: 1, quarantined: false }], RELATIVE, { precision: "day" })],
    ["no quarantined flag", () => checkBand(1, [{ day: "2026-01-01", count: 1 } as BandDay], RELATIVE, { precision: "day" })],
    ["a band that does not hold the median", () => checkBand(1, steady, { ...RELATIVE, min: 1.5, max: 3 }, { precision: "day" })],
    ["an unknown precision", () => checkBand(1, steady, RELATIVE, { precision: "hour" as "day" })],
    ["resetAfter 1", () => checkBand(1, steady, RELATIVE, { precision: "day", resetAfter: 1 })],
  ];
  for (const [what, fn] of bad) assert.throws(fn, BandError, what);
});
