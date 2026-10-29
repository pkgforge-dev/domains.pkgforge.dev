// packages/ledger/src/time.ts — first and last seen of a domain in one unit, and
// the corpus state.
//
//   const precision = precisionsOf(registry.sources);    // bit → "day" | "second"
//   firstSeen(record, precision)   →  { at, precision, bit }   at in seconds since 2026-01-01T00:00:00Z
//   lastSeen(record, precision)    →  the same shape, for the latest observation
//   corpusState("2026-12-15T00:00:00Z", "2026-09-01")  →  "warming"
//
// A record stores each source's times in that source's unit (docs/format.md
// section 5.2): days since 2026-01-01 for a `day` source, seconds since
// 2026-01-01T00:00:00Z for a `second` source. Comparing two sources needs one
// unit, and a day value is an interval, not an instant:
//   - first seen: a day counts as the start of its day. A `second` source that
//     saw the domain at 00:00:10 of that day is later than the `day` source,
//     whose sighting may have been at 00:00:00. A tie goes to the `second`
//     source, which states the instant.
//   - last seen: a day counts as the end of its day, for the same reason the
//     other way round. A tie goes to the `second` source.
// The answer keeps the winner's precision, so a day value is never shown as a
// time of day (docs/architecture.md section 2): `at` is the start of the day
// and `precision` says "day".
import type { NameRecord } from "@domains/pack";
import { LedgerError } from "./errors.ts";

export const DAY_SECONDS = 86_400;
// The epoch of every stored time: 2026-01-01T00:00:00Z, in milliseconds.
export const EPOCH_MS = Date.UTC(2026, 0, 1);
// docs/architecture.md section 2: `confidence` is `warming` while the corpus is
// younger than 90 days.
export const WARMING_DAYS = 90;

export type Precision = "day" | "second";
export type PrecisionOf = (bit: number) => Precision;

// One observation in seconds since the epoch, with the precision and the source
// bit it came from.
export interface Moment {
  readonly at: number;
  readonly precision: Precision;
  readonly bit: number;
}

// The precision of each source bit, from rows that carry `bit` and `precision`
// (config/sources.json). A row with no bit feeds no masked dataset and is
// skipped. A bit given twice with two precisions, a precision that is not
// "day" or "second", and later a bit the rows did not name, are refused.
export function precisionsOf(rows: readonly { readonly bit: number | null; readonly precision: string }[]): PrecisionOf {
  const table = new Map<number, Precision>();
  for (const row of rows) {
    if (row.bit === null) continue;
    if (!Number.isInteger(row.bit) || row.bit < 0 || row.bit > 63) throw new LedgerError("precision", `a source row has bit ${String(row.bit)}, not 0 to 63`);
    if (row.precision !== "day" && row.precision !== "second") throw new LedgerError("precision", `source bit ${row.bit} has precision ${JSON.stringify(row.precision)}, not "day" or "second"`);
    const before = table.get(row.bit);
    if (before !== undefined && before !== row.precision) throw new LedgerError("precision", `source bit ${row.bit} is given as both ${before} and ${row.precision}`);
    table.set(row.bit, row.precision);
  }
  return (bit: number): Precision => {
    const p = table.get(bit);
    if (p === undefined) throw new LedgerError("precision", `source bit ${bit} has no precision in the table`);
    return p;
  };
}

const startOf = (p: Precision, value: number): number => (p === "day" ? value * DAY_SECONDS : value);

function check(record: NameRecord): void {
  if (!Array.isArray(record.sources) || record.sources.length === 0) throw new LedgerError("usage", `the record ${JSON.stringify(String(record.key).slice(0, 80))} has no source`);
}

// The earliest observation of any source: a day counts as the start of its day.
export function firstSeen(record: NameRecord, precision: PrecisionOf): Moment {
  check(record);
  let best: Moment | null = null;
  for (const s of record.sources) {
    const p = precision(s.bit);
    const at = startOf(p, s.first);
    if (best === null || at < best.at || (at === best.at && p === "second" && best.precision === "day")) best = { at, precision: p, bit: s.bit };
  }
  return best as Moment;
}

// The latest observation of any source: a day counts as the end of its day for
// the comparison, and is answered as the start of its day with precision "day".
export function lastSeen(record: NameRecord, precision: PrecisionOf): Moment {
  check(record);
  let best: Moment | null = null;
  let bestEnd = -1;
  for (const s of record.sources) {
    const p = precision(s.bit);
    const at = startOf(p, s.last);
    const end = p === "day" ? at + DAY_SECONDS - 1 : at;
    if (best === null || end > bestEnd || (end === bestEnd && p === "second" && best.precision === "day")) {
      best = { at, precision: p, bit: s.bit };
      bestEnd = end;
    }
  }
  return best as Moment;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

// Seconds since the epoch of an ISO 8601 UTC date (`2026-09-01`, its start) or
// time (`2026-09-01T12:00:00Z`). Anything else, a date that does not exist, and
// a time before the epoch are refused: the stored times are unsigned.
export function secondsOf(iso: string): number {
  const m = typeof iso === "string" ? (ISO_TIME.exec(iso) ?? ISO_DAY.exec(iso)) : null;
  if (m === null) throw new LedgerError("time", `${JSON.stringify(iso)} is not an ISO 8601 UTC date or time`);
  const [y, mo, d, h = "0", mi = "0", s = "0"] = m.slice(1);
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const back = new Date(ms);
  if (back.getUTCFullYear() !== Number(y) || back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59)
    throw new LedgerError("time", `${JSON.stringify(iso)} is not a time that exists`);
  if (ms < EPOCH_MS) throw new LedgerError("time", `${JSON.stringify(iso)} is before 2026-01-01T00:00:00Z, the epoch of every stored time`);
  return Math.floor((ms - EPOCH_MS) / 1000);
}

// The ISO 8601 form of a moment: a date for a day value, a time for a second.
export function isoOf(m: Moment): string {
  const text = new Date(EPOCH_MS + m.at * 1000).toISOString();
  return m.precision === "day" ? text.slice(0, 10) : `${text.slice(0, 19)}Z`;
}

export type CorpusState = "warming" | "full";

// "warming" while less than `warmingDays` days separate corpusSince from now,
// else "full". A now before corpusSince is refused: no answer is older than
// its corpus.
export function corpusState(now: string, corpusSince: string, warmingDays = WARMING_DAYS): CorpusState {
  if (!Number.isInteger(warmingDays) || warmingDays < 0) throw new LedgerError("usage", `corpusState: warmingDays must be a whole number of days, not ${warmingDays}`);
  const t = secondsOf(now);
  const since = secondsOf(corpusSince);
  if (t < since) throw new LedgerError("time", `corpusState: now ${now} is before corpus_since ${corpusSince}`);
  return t - since < warmingDays * DAY_SECONDS ? "warming" : "full";
}
