// adapters/thc-ct/src/day.ts — one THC day: its hosts tried in order, each
// through its whole integrity pass, and the two writes of the first pass that
// holds (DOM-029, design D3, D5, D20 and D23).
//
//   const outcome = await writeDay(day, locator.live(day), ctx, limits, budget);
//
// The probes are called in order, each only when the one before it gave no
// written day. A candidate's pass (pass.ts) spends one GET of `budget`; with
// none left and a candidate still to try, the day is `unfinished` and the run
// stops there. The outcome is:
//   written     the names and the domains segment of the day;
//   absent      every host answered absent (cs2 404, and the listing read
//               without the day);
//   faulted     no candidate held: one fault a host, a located fault (a
//               listing that failed) among them;
//   unfinished  a candidate was left untried for want of a GET.
//
// The two writes, in this order, both with the file as their raw layer (the
// same blob, so the domains tag is the names tag with the variant d):
//   names    one record a distinct name, ascending by key: flags FLAG_EXACT
//            (1) for a plain line, FLAG_WILDCARD (2) for a `*.` line, ORed per
//            key, as oi-nrd-fqdn writes them; sources [{ bit 0, first d, last d }],
//            d the day's index since 2026-01-01 (2026-09-01 is 243);
//   domains  one record a distinct ICANN registrable domain of those names
//            (split(name, psl).reg, as oi-nrd writes its domains), flags 0, the
//            same sources, and the evidence [{ tier 3, basis ct-first, source 0,
//            at d, confidence 0 }] (docs/format.md section 5.3). No facts.
// The registrable domain is computed once per distinct name, as the names
// write pulls each record, into a second sorter. The writer drains the raw
// bytes before it pulls a record (scripts/ingest/writer.mjs step 3), and the
// chunks reach it through an async generator, never a byte ReadableStream,
// which would detach them for the second write (design M28). A throw from
// either write goes up: a names segment returned with no domains segment, or
// with the cursor unmoved, would be a half-written day.
// Each segment's cursorBefore is { day } and cursorAfter { day: day + 1 }, in a
// live run and a backfill alike, so a second build of a day has the identity
// of the first (scripts/ghcr/push.mjs finds it present). Its url is the
// candidate's (locate.ts).
import type { AdapterContext, Segment, SegmentDraft, SegmentRecord } from "@domains/adapter";
import { fromKey, key, split } from "@domains/names";
import { BASIS, BASIS_TIER } from "@domains/pack";
import { dayIndex, dayStart, nextDay } from "./cursor.ts";
import type { Candidate, Host, Probe } from "./locate.ts";
import { HostFault, MAX_SEALS, type Pass, type PassLimits, readPass } from "./pass.ts";
import { RunSorter } from "./sorter.ts";

// The source this adapter writes; test/thc-ct.test.ts holds both to source.json.
export const SOURCE = "thc-ct";
export const BIT = 0;
export const CT_FIRST = BASIS["ct-first"];

export interface Budget {
  gets: number;
}

export type DayOutcome =
  | {
      readonly kind: "written";
      readonly segments: readonly Segment[];
      readonly pass: Pass;
      readonly names: number;
      readonly domains: number;
      readonly runs: number;
      readonly faults: readonly HostFault[];
    }
  | { readonly kind: "absent"; readonly details: readonly string[] }
  | { readonly kind: "faulted"; readonly faults: readonly HostFault[]; readonly absent: readonly Host[] }
  | { readonly kind: "unfinished"; readonly faults: readonly HostFault[] };

async function* rawOf(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array, void, undefined> {
  for (const c of chunks) yield c;
}

async function write(day: string, pass: Pass, ctx: AdapterContext, limits: PassLimits): Promise<{ segments: Segment[]; runs: number }> {
  const d = dayIndex(day);
  const sources = Object.freeze([Object.freeze({ bit: BIT, first: d, last: d })]);
  const evidence = Object.freeze([Object.freeze({ tier: BASIS_TIER[CT_FIRST]!, basis: CT_FIRST, source: BIT, at: d, confidence: 0 })]);
  const draft = (dataset: "names" | "domains", c: Candidate): SegmentDraft => ({
    source: SOURCE,
    dataset,
    window: { start: dayStart(day), end: dayStart(nextDay(day)) },
    cursorBefore: { day },
    cursorAfter: { day: nextDay(day) },
    precision: "day",
    url: c.url,
  });
  const regs = new RunSorter(limits.runKeys);
  async function* namesRecords(): AsyncGenerator<SegmentRecord, void, undefined> {
    for await (const { key: k, flags } of pass.names.finish()) {
      // normalise refused every name that is itself an ICANN suffix, so each name kept has a registrable domain.
      const reg = split(fromKey(k), ctx.psl).reg;
      if (reg === null) throw new Error(`thc-ct: ${fromKey(k)} has no registrable domain under the list ${ctx.psl.sha256}`);
      regs.add(key(reg), 0);
      if (regs.pending > MAX_SEALS) await regs.drain(MAX_SEALS);
      yield { key: k, flags, sources };
    }
  }
  async function* domainsRecords(): AsyncGenerator<SegmentRecord, void, undefined> {
    for await (const { key: k } of regs.finish()) yield { key: k, flags: 0, sources, evidence };
  }
  const names = await ctx.writer.write(draft("names", pass.candidate), namesRecords(), rawOf(pass.chunks));
  // finish() sealed the last run of names.
  const runs = pass.names.runs;
  const domains = await ctx.writer.write(draft("domains", pass.candidate), domainsRecords(), rawOf(pass.chunks));
  return { segments: [names, domains], runs };
}

export async function writeDay(day: string, probes: readonly Probe[], ctx: AdapterContext, limits: PassLimits, budget: Budget): Promise<DayOutcome> {
  const faults: HostFault[] = [];
  const absent: Host[] = [];
  const details: string[] = [];
  for (const probe of probes) {
    const loc = await probe();
    if ("absent" in loc) {
      absent.push(loc.absent);
      details.push(loc.detail);
      continue;
    }
    if ("fault" in loc) {
      faults.push(loc.fault);
      continue;
    }
    if (budget.gets <= 0) return { kind: "unfinished", faults };
    budget.gets -= 1;
    let pass: Pass;
    try {
      pass = await readPass(loc.found, ctx, limits);
    } catch (err) {
      if (!(err instanceof HostFault)) throw err;
      faults.push(err);
      continue;
    }
    // A pass that holds has every key added; its runs are sealed by finish().
    const { segments, runs } = await write(day, pass, ctx, limits);
    return { kind: "written", segments, pass, names: segments[0]!.count, domains: segments[1]!.count, runs, faults };
  }
  if (absent.length === probes.length) return { kind: "absent", details };
  return { kind: "faulted", faults, absent };
}
