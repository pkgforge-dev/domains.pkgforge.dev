// adapters/thc-ct/src/cursor.ts — the days of THC's dumps: the cursor, the day
// arithmetic, and the instants a day is late and lacking (DOM-029, design D10
// and D11).
//
// The cursor is { "next": "YYYY-MM-DD", "open": ["YYYY-MM-DD", ...] }:
//   next  the first day the run has not yet decided, written or declared;
//   open  the days before next that are past their late instant and not
//         written, sorted, distinct, at most maxOpen. A day is open from D+1
//         06:00Z to D+2 12:00Z, so two at a time in practice, and the cursor's
//         canonical JSON stays far inside the 1,024 characters of a cursor
//         annotation.
// null (the first run) starts at the day before ctx.now's day. Anything else
// is ContractError `cursor`.
//
// A day's value in a record is its index since 2026-01-01 (docs/format.md
// section 1, the Time row): 2026-09-01 is 243. A day before 2026-01-01 has no
// index, so no cursor names one.
import { ContractError, type Cursor } from "@domains/adapter";

export const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(2026, 0, 1);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface DayCursor {
  readonly next: string;
  readonly open: readonly string[];
}

// The instants of one day, in seconds after the day ends.
export interface DayLimits {
  readonly lateAfterS: number;
  readonly gapAfterS: number;
  readonly maxOpen: number;
}

// A calendar day YYYY-MM-DD on or after 2026-01-01: V8 rolls 2026-02-30 to
// 2026-03-02, so only the round trip refuses it.
export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) && ms >= EPOCH_MS && new Date(ms).toISOString().slice(0, 10) === v;
}

// The start of a day, in ms since the Unix epoch.
export const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const dayOfMs = (ms: number): string => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
export const nextDay = (day: string, n = 1): string => dayOfMs(dayMs(day) + n * DAY_MS);
// The UTC day of an ISO time.
export const today = (now: string): string => dayOfMs(Date.parse(now));
// Days since 2026-01-01: a record's first and last of a day source.
export const dayIndex = (day: string): number => (dayMs(day) - EPOCH_MS) / DAY_MS;
// ISO 8601 UTC of a day's start, as a segment's window names it.
export const dayStart = (day: string): string => `${day}T00:00:00Z`;
// The instant a day not written is late (D+1 06:00Z) and lacking (D+2 12:00Z), in ms.
export const lateAt = (day: string, limits: DayLimits): number => dayMs(day) + DAY_MS + limits.lateAfterS * 1000;
export const gapAt = (day: string, limits: DayLimits): number => dayMs(day) + DAY_MS + limits.gapAfterS * 1000;
export const isoOfMs = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseCursor(cursor: Cursor, now: string, limits: DayLimits): DayCursor {
  if (cursor === null) return { next: nextDay(today(now), -1), open: [] };
  const bad = (detail: string): ContractError => new ContractError("cursor", `thc-ct: the cursor ${detail}`);
  if (!isObj(cursor) || Object.keys(cursor).sort().join(",") !== "next,open") throw bad('is not null or { "next": DAY, "open": [DAY, ...] }');
  const { next, open } = cursor;
  if (!isDay(next)) throw bad(`next ${JSON.stringify(next)} is not a calendar day YYYY-MM-DD from 2026-01-01`);
  if (!Array.isArray(open)) throw bad("open is not a list");
  if (open.length > limits.maxOpen) throw bad(`open holds ${open.length} days, over ${limits.maxOpen}`);
  open.forEach((d: unknown, i: number) => {
    if (!isDay(d)) throw bad(`open[${i}] ${JSON.stringify(d)} is not a calendar day YYYY-MM-DD from 2026-01-01`);
    if (d >= next) throw bad(`open[${i}] ${d} is not before next ${next}`);
    if (i > 0 && d <= (open[i - 1] as string)) throw bad(`open[${i}] ${d} does not sort after ${open[i - 1] as string}: open is sorted, each day once`);
  });
  return { next, open: [...(open as string[])] };
}

export const cursorJson = (c: DayCursor): Cursor => ({ next: c.next, open: [...c.open].sort() });
