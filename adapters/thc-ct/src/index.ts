// adapters/thc-ct/src/index.ts — the adapter of THC's daily CT dumps, one gzip
// file of names a UTC day, on cs2.ip.thc.org and in the Hugging Face bucket
// IP-THC-ORG/Daily-Cerstream-Dumps (DOM-029; docs/architecture.md section 5.6).
// One source, thc-ct, bit 0, writing a names and a domains segment a day.
//
//   export const run = makeRun(LIMITS, HOSTS);            // run(cursor, ctx): the live run
//   export const backfill = makeBackfill(LIMITS, HOSTS);  // backfill({ start, end }, ctx)
//
// The live run (design section 4.2), from the cursor { next, open } of
// cursor.ts (null starts at the day before ctx.now's day):
//   1. the days to try: each open day, oldest first, then next, next + 1, ...
//      while the day is before ctx.now's day. The run stops once it has
//      written maxFilesPerRun days (1) or spent maxGetsPerRun GETs (2);
//   2. each day through writeDay (day.ts) with the live order, cs2 then the
//      bucket (locate.ts), each host's whole pass before any write (pass.ts);
//   3. written: the day leaves open, or next steps. Otherwise, with D the
//      day's end: at D + gapAfterS (D+2 12:00Z) the day is declared a gap,
//      { source, day } in the result's gaps and one fault `gap` naming why
//      (the last fault of each host, or that each answered absent), and it
//      leaves open or next steps. Before that, next at D + lateAfterS (D+1
//      06:00Z) or later goes to open and the run goes on to the next day; an
//      open day stays open and the run goes on. A next day that is neither
//      stops the run: THC publishes in date order, and a fault before the late
//      instant is the next hour's to retry. A day left untried for want of a
//      GET stops the run, decided by nothing;
//   4. the result: the segments, the cursor { next, open }, the stats, the
//      faults and the gaps. A day faulted on every host is one fault a host
//      (cs2, hf, timeout, length, encoding, gzip, empty, format, size) and a
//      declared day a fault `gap` (design D25): run.mjs exits 1 after the
//      proposal. A day not yet published, or not yet late, is no fault: the
//      stats `late` and `open` carry it, and DOM-034's watchdog reads the
//      lateness from the root's through.
// A host that faults before another host's pass holds is no fault of the day:
// the stats host_faults and host_fault_<code> count it.
//
// The backfill (design section 4.3): each whole day of [start, end), its own
// budget of maxGetsPerRun GETs, the bucket first, then cs2. Written: its two
// segments. Faulted on every host: its faults. Absent from both: a gap when
// ctx.now is at or past its gap instant, else the fault `unpublished`. It
// returns the cursor null and moves none: run.mjs keeps the live cursor (D17
// of DOM-024).
//
// It reads no clock and no environment: what it writes depends only on the
// hosts' answers, the list and ctx.now, so two runs from one cursor write the
// same segments, which the harness's replay of a recording rests on.
import { type AdapterContext, type AdapterFault, type Cursor, type Gap, MAX_GAPS, type RunResult, type Segment, type Window } from "@domains/adapter";
import { cursorJson, type DayLimits, gapAt, isDay, isoOfMs, lateAt, nextDay, parseCursor, today } from "./cursor.ts";
import { type Budget, type DayOutcome, SOURCE, writeDay } from "./day.ts";
import type { Hosts, LocateLimits } from "./locate.ts";
import { Locator } from "./locate.ts";
import type { HostFault, PassLimits } from "./pass.ts";

export { BIT, SOURCE } from "./day.ts";
export type { Hosts } from "./locate.ts";

export interface Limits extends DayLimits, PassLimits, LocateLimits {
  // Keys a sorter run holds before it is sealed.
  readonly runKeys: number;
  // The most bytes of a day's file: FILE_RAW_BYTES of scripts/ingest/writer.mjs (D27).
  readonly maxFileBytes: number;
  readonly maxFilesPerRun: number;
  // Body downloads a run, a candidate's pass each.
  readonly maxGetsPerRun: number;
  // The deadline of a request, a whole body's read among it.
  readonly readDeadlineS: number;
  // Seconds after a day ends: late (D+1 06:00Z), lacking (D+2 12:00Z).
  readonly lateAfterS: number;
  readonly gapAfterS: number;
  readonly maxOpen: number;
  readonly maxListingPages: number;
  // The share of non-empty lines refused above which the file is `format`.
  readonly refusedFault: number;
}

// runKeys: 500,000 distinct keys a run, about 90 MB of strings (173 B a key,
// design M7), far under the leg's 8 GiB heap (D24). Over the same 3,000,000
// real lines it was faster than 2,000,000 in each of three pairings, at less
// memory (MEASURED 2026-11-02T04:45Z to 04:55Z, DOM-029's stage 3 notes); a
// September day is then about 222 runs, each merged through its own
// decompressor of a few hundred KB. maxFileBytes: 2 GiB (D27),
// held equal to FILE_RAW_BYTES by a test. readDeadlineS: 900 s, three times the
// slowest read measured from a runner (282 s at 3.5 MB/s for 986 MB, design
// section 2.4). lateAfterS and gapAfterS: D10; lateAfterS also ends the wait of
// the daily compaction (EXPECTED of packages/compact, untilS 108,000 s from
// the day's start). maxOpen: two days are open at a time in practice (D11).
// refusedFault: half of the non-empty lines (D4).
export const LIMITS: Limits = Object.freeze({
  runKeys: 500_000,
  maxFileBytes: 2 * 1024 ** 3,
  maxFilesPerRun: 1,
  maxGetsPerRun: 2,
  readDeadlineS: 900,
  lateAfterS: 21_600,
  gapAfterS: 129_600,
  maxOpen: 8,
  maxListingPages: 20,
  refusedFault: 0.5,
});

// The hosts (MEASURED 2026-11-01, DOM-029's design M1 to M3). cs2 and the
// resolve root lie under the two urls of source.json, so the url of each
// segment does too (checkDraftUrl of @domains/adapter).
export const HOSTS: Hosts = Object.freeze({
  cs2: "https://cs2.ip.thc.org/",
  listing: "https://huggingface.co/api/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/tree?recursive=true",
  resolve: "https://huggingface.co/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/resolve/",
});

function checkLimits(limits: Limits): void {
  const bad = (detail: string): TypeError => new TypeError(`thc-ct: ${detail}`);
  for (const k of ["runKeys", "maxFileBytes", "maxFilesPerRun", "maxGetsPerRun", "lateAfterS", "gapAfterS", "maxOpen", "maxListingPages"] as const) {
    const v = limits?.[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw bad(`the limit ${k} ${v} is not a whole number from 1`);
  }
  if (!(typeof limits.readDeadlineS === "number" && limits.readDeadlineS > 0 && Number.isFinite(limits.readDeadlineS)))
    throw bad(`the limit readDeadlineS ${limits.readDeadlineS} is not a number above 0`);
  if (!(typeof limits.refusedFault === "number" && limits.refusedFault > 0 && limits.refusedFault <= 1)) throw bad(`the limit refusedFault ${limits.refusedFault} is not above 0 and at most 1`);
  if (limits.gapAfterS <= limits.lateAfterS) throw bad(`gapAfterS ${limits.gapAfterS} is not after lateAfterS ${limits.lateAfterS}`);
}

function checkHosts(hosts: Hosts): void {
  for (const k of ["cs2", "listing", "resolve"] as const) {
    let u: URL;
    try {
      u = new URL(hosts?.[k]);
    } catch {
      throw new TypeError(`thc-ct: the host ${k} ${JSON.stringify(hosts?.[k])} is not a URL`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new TypeError(`thc-ct: the host ${k} ${u.href} is not http or https`);
  }
  // A file's URL is the root and a path: each root ends in "/".
  for (const k of ["cs2", "resolve"] as const) if (!hosts[k].endsWith("/")) throw new TypeError(`thc-ct: the host ${k} ${hosts[k]} does not end in "/"`);
}

const faultOf = (day: string, f: HostFault): AdapterFault => ({ source: SOURCE, code: f.code, detail: `${day} ${f.host}: ${f.message}` });

// The why of a gap: the last fault of each host that faulted, else that each answered absent.
function whyOf(o: Exclude<DayOutcome, { kind: "written" | "unfinished" }>): string {
  if (o.kind === "absent") return `every host answered absent (${o.details.join("; ")})`;
  const last = new Map<string, HostFault>();
  for (const f of o.faults) last.set(f.host, f);
  return [...[...last].map(([host, f]) => `${host} faulted last with ${f.code}: ${f.message}`), ...o.absent.map((h) => `${h} answered absent`)].join("; ");
}

// The counts of the days a run wrote, and its stats.
class Tally {
  private readonly n = { files: 0, bytes: 0, lines: 0, names: 0, domains: 0, wild_lines: 0, upper_lines: 0, crlf_lines: 0, empty_lines: 0, from_cs2: 0, from_hf: 0, runs: 0, host_faults: 0 };
  private readonly refused = new Map<string, number>();
  // The faults of hosts before the pass that held, by code.
  private readonly hostFaults = new Map<string, number>();
  private refusedLines = 0;
  private lagS: number | null = null;

  add(o: Extract<DayOutcome, { kind: "written" }>, nowMs: number | null): void {
    const s = o.pass.stats;
    this.n.files += 1;
    this.n.bytes += s.bytes;
    this.n.lines += s.lines;
    this.n.names += o.names;
    this.n.domains += o.domains;
    this.n.wild_lines += s.wild_lines;
    this.n.upper_lines += s.upper_lines;
    this.n.crlf_lines += s.crlf_lines;
    this.n.empty_lines += s.empty_lines;
    this.n.runs += o.runs;
    this.n.host_faults += o.faults.length;
    for (const f of o.faults) this.hostFaults.set(f.code, (this.hostFaults.get(f.code) ?? 0) + 1);
    if (o.pass.candidate.host === "cs2") this.n.from_cs2 += 1;
    else this.n.from_hf += 1;
    this.refusedLines += s.refused_lines;
    for (const [code, v] of s.refused) this.refused.set(code, (this.refused.get(code) ?? 0) + v);
    const lm = o.pass.candidate.lastModified;
    if (nowMs !== null && lm !== null) this.lagS = Math.round((nowMs - Date.parse(lm)) / 1000);
  }

  stats(limits: Limits, extra: Readonly<Record<string, number>>): Record<string, number> {
    const out: Record<string, number> = { ...this.n };
    const nonEmpty = this.n.lines - this.n.empty_lines;
    for (const [code, v] of [...this.refused].sort(([a], [b]) => (a < b ? -1 : 1))) out[`refused_${code}`] = v;
    for (const [code, v] of [...this.hostFaults].sort(([a], [b]) => (a < b ? -1 : 1))) out[`host_fault_${code}`] = v;
    out.refused_share = nonEmpty === 0 ? 0 : this.refusedLines / nonEmpty;
    if (this.lagS !== null) out.lag_s = this.lagS;
    out.run_keys = limits.runKeys;
    return { ...out, ...extra };
  }
}

export function makeRun(limits: Limits, hosts: Hosts): (cursor: Cursor, ctx: AdapterContext) => Promise<RunResult> {
  checkLimits(limits);
  checkHosts(hosts);
  return async (cursor, ctx) => {
    const start = parseCursor(cursor, ctx.now, limits);
    const nowMs = Date.parse(ctx.now);
    const end = today(ctx.now);
    const locator = new Locator(ctx, hosts, limits);
    const budget: Budget = { gets: limits.maxGetsPerRun };
    const segments: Segment[] = [];
    const errors: AdapterFault[] = [];
    const gaps: Gap[] = [];
    const tally = new Tally();
    const open = [...start.open];
    let next = start.next;
    let files = 0;
    let stop = false;
    const room = (): boolean => files < limits.maxFilesPerRun && budget.gets > 0;
    const declare = (day: string, o: Exclude<DayOutcome, { kind: "written" | "unfinished" }>): void => {
      gaps.push({ source: SOURCE, day });
      errors.push({ source: SOURCE, code: "gap", detail: `${day}: no file of the day was written by ${isoOfMs(gapAt(day, limits))}, so the day is declared a gap: ${whyOf(o)}` });
    };
    // The outcome of one day, its faults kept; null when the run stops there.
    const attempt = async (day: string): Promise<Exclude<DayOutcome, { kind: "unfinished" }> | null> => {
      const o = await writeDay(day, locator.live(day), ctx, limits, budget);
      if (o.kind === "written") {
        segments.push(...o.segments);
        tally.add(o, nowMs);
        files += 1;
      } else if (o.kind !== "absent") for (const f of o.faults) errors.push(faultOf(day, f));
      return o.kind === "unfinished" ? null : o;
    };

    for (const day of [...open]) {
      if (!room()) {
        stop = true;
        break;
      }
      const o = await attempt(day);
      if (o === null) {
        stop = true;
        break;
      }
      if (o.kind === "written") open.splice(open.indexOf(day), 1);
      else if (nowMs >= gapAt(day, limits)) {
        declare(day, o);
        open.splice(open.indexOf(day), 1);
      }
    }
    while (!stop && next < end) {
      if (!room()) break;
      const day = next;
      const o = await attempt(day);
      if (o === null) break;
      if (o.kind === "written") {
        next = nextDay(day);
        continue;
      }
      if (nowMs >= gapAt(day, limits)) {
        declare(day, o);
        next = nextDay(day);
        continue;
      }
      if (nowMs < lateAt(day, limits)) break;
      if (open.length >= limits.maxOpen) {
        errors.push({
          source: SOURCE,
          code: "open-full",
          detail: `${day}: late and not written, and the cursor's open list holds ${open.length} days already (${open.join(", ")}); the day stays next`,
        });
        break;
      }
      open.push(day);
      next = nextDay(day);
    }
    open.sort();
    // Days past their late instant and not written: the open days, and any the run did not reach.
    let late = open.length;
    for (let d = next; d < end && nowMs >= lateAt(d, limits); d = nextDay(d)) late += 1;
    const stats = tally.stats(limits, { gets: limits.maxGetsPerRun - budget.gets, late, open: open.length });
    gaps.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return { segments, cursor: cursorJson({ next, open }), stats, errors, ...(gaps.length > 0 ? { gaps } : {}) };
  };
}

// The whole days of a backfill window, or a RangeError: a window that holds a
// part of a day would write nothing for it while reporting success.
export function daysOf(window: Window): string[] {
  const { start, end } = window ?? ({} as Window);
  const s = typeof start === "string" ? start.slice(0, 10) : "";
  const e = typeof end === "string" ? end.slice(0, 10) : "";
  if (start !== `${s}T00:00:00Z` || end !== `${e}T00:00:00Z` || !isDay(s) || !isDay(e) || s >= e)
    throw new RangeError(`thc-ct: the backfill window ${JSON.stringify(window)} is not whole UTC days, start before end, each at 00:00:00Z`);
  const days: string[] = [];
  for (let d = s; d < e; d = nextDay(d)) days.push(d);
  if (days.length > MAX_GAPS) throw new RangeError(`thc-ct: the backfill window holds ${days.length} days, over ${MAX_GAPS}`);
  return days;
}

export function makeBackfill(limits: Limits, hosts: Hosts): (window: Window, ctx: AdapterContext) => Promise<RunResult> {
  checkLimits(limits);
  checkHosts(hosts);
  return async (window, ctx) => {
    const days = daysOf(window);
    const nowMs = Date.parse(ctx.now);
    const locator = new Locator(ctx, hosts, limits);
    const segments: Segment[] = [];
    const errors: AdapterFault[] = [];
    const gaps: Gap[] = [];
    const tally = new Tally();
    let gets = 0;
    for (const day of days) {
      const budget: Budget = { gets: limits.maxGetsPerRun };
      const o = await writeDay(day, locator.backfill(day), ctx, limits, budget);
      gets += limits.maxGetsPerRun - budget.gets;
      if (o.kind === "written") {
        segments.push(...o.segments);
        tally.add(o, null);
        continue;
      }
      if (o.kind !== "absent") {
        for (const f of o.faults) errors.push(faultOf(day, f));
        continue;
      }
      if (nowMs >= gapAt(day, limits)) {
        gaps.push({ source: SOURCE, day });
        errors.push({ source: SOURCE, code: "gap", detail: `${day}: no file of the day by ${isoOfMs(gapAt(day, limits))}, so the day is declared a gap: ${whyOf(o)}` });
      } else
        errors.push({
          source: SOURCE,
          code: "unpublished",
          detail: `${day}: ${whyOf(o)}; the day is not published yet, and becomes a gap at ${isoOfMs(gapAt(day, limits))}`,
        });
    }
    const stats = tally.stats(limits, { gets, days: days.length });
    return { segments, cursor: null, stats, errors, ...(gaps.length > 0 ? { gaps } : {}) };
  };
}

export const run = makeRun(LIMITS, HOSTS);
export const backfill = makeBackfill(LIMITS, HOSTS);
