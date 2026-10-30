// packages/adapter/src/band.ts — the volume check of one day of one source
// (docs/architecture.md section 5.8, step 3). DOM-018's verifier calls it.
//
//   checkBand(count, history, band, { precision })  →  { verdict, reason, median, floor, ceiling, reset }
//   checkHistory(history)                            →  the days, sorted, or BandError
//
// `history` lists the source's earlier observed days, `{ day, count, quarantined }`,
// in any order; a day with no file is absent from it. `count` is the day being
// checked, in the band's metric.
//
// A relative band compares `count` with the median of the baseline: the last
// BASELINE_DAYS accepted days. Above `max` times the median is `hold`. Below
// `min` times it is `quarantine` for a `day` source and `hold` for any other.
// An absolute band compares with `min` and `max` themselves.
//
// The step change. For a `day` source, RESET_AFTER consecutive observed days
// below the floor reset the baseline to the median of those days, and the last
// of them is `ok`. The baseline is then those days, the quarantined ones among
// them included: they are the new level. A missing day neither counts nor breaks
// the run. THC's volume fell to about a third in early October 2026; without the
// reset all 21 observed days from 10-05 sit below the floor (band.test.ts
// replays them from docs/research/measure/DOM-009/result.json).
//
// The history carries the verdicts already stored, not the baselines, so the
// baseline is rebuilt by replaying the history in day order. A stored verdict
// is kept as stored: a quarantined day never enters the baseline except as part
// of a reset run, and an accepted day always does. A quarantined day counts
// toward a run only when it is below the floor of its own time, so a day
// quarantined for another reason does not trigger a reset.
//
// A median of an even number of days is the mean of the middle two. A median of
// zero makes every non-zero day `hold`: the operator decides.
import type { Band, Precision } from "./types.ts";
import { bandProblems, isIsoUtc } from "./validate.ts";

export const BASELINE_DAYS = 7;
export const RESET_AFTER = 3;

export interface BandDay {
  readonly day: string;
  readonly count: number;
  readonly quarantined: boolean;
}

export type Verdict = "ok" | "quarantine" | "hold";
// no-baseline: no accepted day yet; within: inside the band; above, below: outside
// it; step-change: below the floor, and the last day of a run that resets.
export type BandReason = "no-baseline" | "within" | "above" | "below" | "step-change";

export interface BandResult {
  readonly verdict: Verdict;
  readonly reason: BandReason;
  // The median the count was compared with; null for an absolute band or before
  // any accepted day.
  readonly median: number | null;
  readonly floor: number | null;
  readonly ceiling: number | null;
  // The new baseline when the step change fired, else null.
  readonly reset: number | null;
}

export interface BandOptions {
  readonly precision: Precision;
  // The run length of the step change: an integer of at least 2, or Infinity
  // for no reset. Tests pass Infinity to show what the rule prevents.
  readonly resetAfter?: number;
}

export class BandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BandError";
  }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new BandError("the median of no values");
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const isAmount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

// `history` as days, sorted by day, or BandError: each item `{ day, count,
// quarantined }`, day `YYYY-MM-DD`, no day twice. checkBand reads its history
// through it, and packages/state holds each source's volume history to it.
export function checkHistory(history: unknown): BandDay[] {
  if (!Array.isArray(history)) throw new BandError("history is not a list");
  const seen = new Set<string>();
  const days: BandDay[] = history.map((h: unknown, i: number) => {
    if (typeof h !== "object" || h === null) throw new BandError(`history[${i}] is not an object`);
    const { day, count, quarantined } = h as Record<string, unknown>;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !isIsoUtc(`${day}T00:00:00Z`)) throw new BandError(`history[${i}].day ${JSON.stringify(day)} is not YYYY-MM-DD`);
    if (!isAmount(count)) throw new BandError(`history[${i}].count ${JSON.stringify(count)} is not a finite number of at least 0`);
    if (typeof quarantined !== "boolean") throw new BandError(`history[${i}].quarantined is not true or false`);
    if (seen.has(day)) throw new BandError(`history lists ${day} twice`);
    seen.add(day);
    return { day, count, quarantined };
  });
  return days.sort((a, b) => (a.day < b.day ? -1 : 1));
}

function baselineOf(window: readonly number[]): number | null {
  return window.length === 0 ? null : median(window.slice(-BASELINE_DAYS));
}

// The baseline window and the current run of low days, after the history.
function replay(days: readonly BandDay[], band: Band, step: boolean, keep: number): { window: number[]; run: number[] } {
  let window: number[] = [];
  let run: number[] = [];
  for (const d of days) {
    const base = baselineOf(window);
    const below = base !== null && d.count < band.min * base;
    if (d.quarantined) {
      run = below ? [...run, d.count] : [];
      continue;
    }
    if (step && below && run.length >= keep) window = [...run.slice(-keep), d.count];
    else window.push(d.count);
    run = [];
  }
  return { window, run };
}

export function checkBand(count: number, history: readonly BandDay[], band: Band, options: BandOptions): BandResult {
  if (!isAmount(count)) throw new BandError(`count ${JSON.stringify(count)} is not a finite number of at least 0`);
  const problems = bandProblems(band);
  if (problems.length > 0) throw new BandError(`band: ${problems.map((p) => `${p.at}: ${p.detail}`).join("; ")}`);
  if (options.precision !== "day" && options.precision !== "second") throw new BandError(`precision ${JSON.stringify(options.precision)} is not day or second`);
  const resetAfter = options.resetAfter ?? RESET_AFTER;
  if (!(resetAfter === Number.POSITIVE_INFINITY || (Number.isInteger(resetAfter) && resetAfter >= 2))) throw new BandError(`resetAfter ${resetAfter} is not an integer of at least 2, nor Infinity`);
  const days = checkHistory(history);
  const day = options.precision === "day";
  const low: BandResult = day
    ? { verdict: "quarantine", reason: "below", median: null, floor: null, ceiling: null, reset: null }
    : { verdict: "hold", reason: "below", median: null, floor: null, ceiling: null, reset: null };

  if (!band.relative) {
    const bounds = { median: null, floor: band.min, ceiling: band.max, reset: null };
    if (count > band.max) return { ...bounds, verdict: "hold", reason: "above" };
    if (count < band.min) return { ...low, ...bounds };
    return { ...bounds, verdict: "ok", reason: "within" };
  }

  // A reset takes the resetAfter - 1 low days before this one; with Infinity
  // no run is ever long enough.
  const keep = resetAfter - 1;
  const { window, run } = replay(days, band, day, keep);
  const base = baselineOf(window);
  if (base === null) return { verdict: "ok", reason: "no-baseline", median: null, floor: null, ceiling: null, reset: null };
  const bounds = { median: base, floor: band.min * base, ceiling: band.max * base, reset: null };
  if (count > bounds.ceiling) return { ...bounds, verdict: "hold", reason: "above" };
  if (count >= bounds.floor) return { ...bounds, verdict: "ok", reason: "within" };
  if (day && run.length >= keep) return { ...bounds, verdict: "ok", reason: "step-change", reset: median([...run.slice(-keep), count]) };
  return { ...low, ...bounds };
}
