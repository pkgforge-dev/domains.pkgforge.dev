// packages/feed/src/time.ts — windows, and the precision of a feed row.
//
//   checkWindow({ t0, t1 })                 whole seconds since 2026-01-01T00:00:00Z, t0 below t1
//   rowPrecision(row, table.precision)      "day" or "second"
//   inWindow(row, window, table.precision)  docs/architecture.md section 7.4
//
// A window is half-open: [t0, t1). A second-precision row at `first_seen` is
// inside it when t0 <= first_seen < t1. A day-precision row stands for its whole
// day, [first_seen, first_seen + 86,400), and is inside the window when that day
// overlaps it: the day starts before t1 and ends after t0. A day value is never
// read as a time of day (docs/architecture.md section 2).
//
// A feed record stores first_seen in seconds and no precision (docs/format.md
// section 5.4). rowPrecision reads it back from the row's sources: the row is
// day-precision when one of its sources is a `day` source and first_seen is
// the start of a day. The builder takes first_seen from firstSeen of
// @domains/ledger, which counts a day as its start, so a row whose earliest
// source is a day source reads back as "day". A second source that saw the
// domain at exactly 00:00:00 of a day, in a row that also holds a day source,
// reads back as that day: a day that holds the instant, never a time the source
// did not state. A row whose every source is a day source and whose first_seen
// is not the start of a day cannot come from the builder, and is refused.
import { DAY_SECONDS, type PrecisionOf } from "@domains/ledger";
import { FeedError } from "./errors.ts";

export interface Window {
  // Seconds since 2026-01-01T00:00:00Z; the window is [t0, t1).
  readonly t0: number;
  readonly t1: number;
}

export type RowPrecision = "day" | "second";

// The fields of a feed row that its time depends on.
export interface Timed {
  readonly key: string;
  readonly firstSeen: number;
  readonly sources: readonly number[];
}

export const HOUR_SECONDS = 3600;

export function checkWindow(window: Window, what = "the window"): Window {
  const { t0, t1 } = window ?? ({} as Window);
  if (!Number.isSafeInteger(t0) || !Number.isSafeInteger(t1) || t0 < 0 || !(t0 < t1))
    throw new FeedError("window", `${what} [${String(t0)}, ${String(t1)}) is not whole seconds since 2026-01-01 with t0 below t1`);
  return { t0, t1 };
}

export const dayStart = (t: number): number => t - (t % DAY_SECONDS);

export function rowPrecision(row: Timed, precision: PrecisionOf): RowPrecision {
  let day = false;
  let second = false;
  for (const bit of row.sources) {
    if (precision(bit) === "day") day = true;
    else second = true;
  }
  const atDayStart = row.firstSeen % DAY_SECONDS === 0;
  if (day && !second && !atDayStart)
    throw new FeedError("precision", `the row ${JSON.stringify(row.key.slice(0, 80))} has only day sources and first_seen ${row.firstSeen}, which is not the start of a day`);
  return day && atDayStart ? "day" : "second";
}

// The interval a row's first_seen stands for: one second, or its whole day.
export function rowSpan(row: Timed, precision: PrecisionOf): Window {
  const length = rowPrecision(row, precision) === "day" ? DAY_SECONDS : 1;
  return { t0: row.firstSeen, t1: row.firstSeen + length };
}

export const overlaps = (a: Window, b: Window): boolean => a.t0 < b.t1 && a.t1 > b.t0;

export function inWindow(row: Timed, window: Window, precision: PrecisionOf): boolean {
  return overlaps(rowSpan(row, precision), window);
}
