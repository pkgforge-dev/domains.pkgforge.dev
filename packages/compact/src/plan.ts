// packages/compact/src/plan.ts — the input packs of one tier unit, from the
// live set of a root (docs/architecture.md sections 4.5 and 4.6).
//
//   planTier(root, "names", "w", "2026-10-26T00:00:00Z")   ready, wait, present or skip, with the inputs
//   planTier(root, "names", "d", "2026-10-31T00:00:00Z", { now, absorb: true })   the daily's: expected sources, absorb
//
// A unit is one span of a tier: a UTC day (d), an ISO week from Monday (w), a
// calendar month (m) or a year (y), aligned, under the tag tierTag of
// @domains/ghcr gives it. Its pack replaces every live pack of the dataset
// whose span lies inside it, so it is built only when those packs are the
// whole unit. The verdicts, in the order they are decided:
//
//   skip      a week that crosses the first of a month: a month pack spans one
//             calendar month and a week pack across two months could never be
//             replaced by one, so such a week stays as its day packs until the
//             two monthly compactions take them. Also a unit whose every day is
//             a gap (ruling 24), or a unit of feed or new-name whose packs are
//             all quarantined (ruling 23): no empty pack is written, and the
//             unit above replaces the quarantined packs. Also a unit that ends
//             at or before the dataset's corpus_since: no source covers it.
//   present   a live pack of the tier, or of a higher tier, covers the unit.
//   wait      the unit is not whole. `missing` names each span that no pack of
//             the tier below covers (the slot tiers: d from h and segments, w
//             from d, m from w and the days of the weeks that cross its edges,
//             y from m), less the days that the root's `gaps` names for any
//             source, and less the spans of the quarantined packs of feed and
//             new-name, which are no input of any tier and which the output
//             replaces. Ruling 24: the root accepts a hole whose every day
//             gaps names, so such a hole is no missing span, on a day no pack
//             covers or on a day some pack covers in part. For a day it also names each
//             source of the day's packs that has not reached the end of the
//             day: a lane behind its clock would add an hour pack the day
//             pack could not take. Only that source's own gap days excuse it:
//             a day another source lacks says nothing of this lane's clock.
//             A unit that starts before the dataset's corpus_since and ends
//             after it is never built (the lead's decision of DOM-023, ruling
//             20): the root derives corpus_since from the first span start of
//             the dataset's packs, so a pack of the whole unit would move it
//             back and claim a coverage no source gives (AGENTS.md absolute
//             11). Its packs stay at the tier below: the year 2026 of names
//             stays four month packs. The verdict stays wait, its reason says
//             the unit is never built, and the span before corpus_since is
//             named as such.
//             Expected sources (D15 of DOM-029): with `now`, a day of a dataset
//             that a row of EXPECTED names waits on that row's source while
//             the source has no live pack in the day and the root's gaps names
//             no day of it there for that source, until `untilS` seconds after
//             the day's start. planTier cannot see a source with no pack in the
//             day otherwise, and a day pack built without it would never take
//             it in. After that instant the day goes on, and `late` names the
//             source. day.mjs plans with no `now`: the plan job decided.
//   ready     the inputs, in the root's order, and every manifest the output replaces.
//
// Absorb (D17 of DOM-029). With `absorb`, a live day pack is not `present`
// while live segments lie inside its day: they came after it, as a THC file
// that lands after its day pack was built. The unit is ready with the day
// pack and those segments as inputs, its output replaces all of them under the
// next -rN of the day (ruling 25, tagDecision), and `absorb` is true. A day
// pack with no segment inside stays present. A day of feed follows its day of
// domains: a live feed day pack is ready, the one input its rebuild carries
// and replaces, when the domains day absorbs a segment that is not quarantined,
// since the exact join of the day changes then; a quarantined one adds no row
// (ruling 23). A pack of a tier but seg beside a live day pack is refused
// (CompactError plan): the root's live-set rule lets no such pack overlap.
//
// A live pack that crosses an edge of the unit is refused (CompactError
// straddle): no pack of the unit can replace it. Ruling 23: a pack marked
// quarantined (its entry's `quarantine` field, true, of a segment: DOM-029) is
// no input of feed or new-name, whose rows are new names. The output still
// replaces it, so its rows leave the feed. In names, domains and rev it is an
// input like any other: its names are served.
//
// It imports nothing from `node:` and is type-checked as Worker code
// (tsconfig.worker.json); no test runs it in workerd.
import { LayoutError, type TierDataset, tierTag } from "@domains/ghcr";
import { isoOf, msOf, type PackEntry, QUARANTINE_FIELD, RootError, type RootTier, rankOf, tierEnd } from "@domains/root";
import { CompactError } from "./errors.ts";

// The tiers a compaction builds; an hour pack is built from the segments of
// its hour by the live run (DOM-024), not here.
export const COMPACT_TIERS = Object.freeze(["d", "w", "m", "y"] as const);
export type CompactTier = (typeof COMPACT_TIERS)[number];

// The tiers whose packs make a unit whole: the tier below, and for a month the
// days of the weeks that cross its edges (a week across two months is never
// built). A day is whole from its hour packs, or from a segment that spans it,
// as THC's day segment spans a day of the backfill, which has no hour packs.
export const SLOT_TIERS: Readonly<Record<CompactTier, readonly RootTier[]>> = Object.freeze({
  d: Object.freeze(["h", "seg"] as const),
  w: Object.freeze(["d"] as const),
  m: Object.freeze(["w", "d"] as const),
  y: Object.freeze(["m"] as const),
});

// The datasets whose rows are new names: a quarantined pack is none of their inputs (ruling 23).
export const NEW_DATASETS: readonly TierDataset[] = Object.freeze(["feed", "new-name"] as const);
// The field of a pack entry that marks it quarantined (ruling 23): root.json's
// own (QUARANTINE_FIELD of @domains/root, DOM-029), one value in one place.
export { QUARANTINE_FIELD };

const DAY_MS = 86_400_000;

// A source a day of `datasets` waits for until `untilS` seconds after the
// day's start (D15 of DOM-029).
export interface Expected {
  readonly source: string;
  readonly datasets: readonly TierDataset[];
  readonly untilS: number;
}

// thc-ct, until D+1 06:00Z: 108,000 s after the day's start is 21,600 s
// after its end, the lateAfterS of adapters/thc-ct, from which its cursor
// holds the day open and reads the next days. Its file lands at 00:02 to
// 00:05 of D+1 (DOM-029's design M1 and M2).
export const EXPECTED: readonly Expected[] = Object.freeze([Object.freeze({ source: "thc-ct", datasets: Object.freeze(["names", "domains"] as const), untilS: 108_000 })]);

export interface PlanOptions {
  // The instant the plan is made, YYYY-MM-DDTHH:MM:SSZ: with it, the expected
  // rule runs for a day unit (scripts/compact/plan.mjs gives its clock).
  readonly now?: string;
  // The sources a day waits for, EXPECTED unless given.
  readonly expected?: readonly Expected[];
  // A live day pack with live segments inside its day is ready with them (D17).
  readonly absorb?: boolean;
}

// The dataset whose day decides the absorb of another's: the rows of feed are
// the exact join of the day of domains.
const ABSORB_FOLLOWS: Readonly<Partial<Record<TierDataset, TierDataset>>> = Object.freeze({ feed: "domains" });

export type TierVerdict = "ready" | "wait" | "present" | "skip";

// The root's fields a plan reads: its live packs, the first span start of each
// dataset's packs, and the days each source lacks.
export interface LiveInput {
  readonly datasets: Readonly<Record<string, readonly PackEntry[]>>;
  readonly corpus_since?: Readonly<Record<string, string>>;
  readonly gaps?: Readonly<Record<string, readonly string[]>>;
}

export interface Missing {
  readonly start: string;
  readonly end: string;
  // Why the span is missing: no pack of the slot tiers covers it, or a source
  // of the unit's packs has not reached the end of the unit.
  readonly why: string;
  // The live packs inside the span that are not of the slot tiers, PACKAGE:TAG.
  readonly found: readonly string[];
}

// A pack the output replaces and does not read. Its repo names its package,
// which the replacement of the workflows reads: a quarantined segment of obs
// sits in a feed or new-name unit beside the packs of the feed package.
export interface Excluded {
  readonly repo: string;
  readonly manifest: string;
  readonly tag: string;
  readonly reason: "quarantined";
}

export interface TierPlan {
  readonly verdict: TierVerdict;
  readonly dataset: TierDataset;
  readonly tier: CompactTier;
  readonly span: { readonly start: string; readonly end: string };
  // The tag the span gives (tierTag); a rebuild adds -rN (ruling 25).
  readonly tag: string;
  // One line that says why the verdict is what it is.
  readonly reason: string;
  // The packs the merge reads, in the root's order.
  readonly inputs: readonly PackEntry[];
  // Every manifest the output replaces in the live set: the inputs and the excluded packs.
  readonly replaces: readonly string[];
  readonly excluded: readonly Excluded[];
  readonly missing: readonly Missing[];
  // The days of the unit that the root's gaps names, YYYY-MM-DD.
  readonly gapDays: readonly string[];
  // The live pack that already covers the unit, for `present`.
  readonly present: PackEntry | null;
  // The sources of the inputs, sorted, and the distinct PSL hashes they were built under.
  readonly sources: readonly string[];
  readonly psl: readonly string[];
  // The records of the inputs, summed: an upper bound of the output's.
  readonly records: number;
  // The expected sources the day goes on without, past their instant (D15), sorted.
  readonly late: readonly string[];
  // True when the unit absorbs segments into a live day pack, or rebuilds the
  // feed day of a domains day that does (D17): its output takes the next -rN.
  readonly absorb: boolean;
}

interface Interval {
  readonly a: number;
  readonly b: number;
}

// True when the root marks the pack entry quarantined (ruling 23): the field
// QUARANTINE_FIELD, true. validatePack of @domains/root takes no other value,
// so no other is read. planTier and the day job read it alike.
export const isQuarantined = (p: PackEntry): boolean => (p as unknown as Record<string, unknown>)[QUARANTINE_FIELD] === true;

const pkgTag = (p: PackEntry): string => `${p.repo.slice(p.repo.lastIndexOf("/") + 1)}:${p.tag}`;

// [a, b) less the union of `cover`, as sorted disjoint intervals.
function uncovered(unit: Interval, cover: readonly Interval[]): Interval[] {
  const sorted = [...cover].filter((c) => c.b > unit.a && c.a < unit.b).sort((x, y) => x.a - y.a);
  const out: Interval[] = [];
  let at = unit.a;
  for (const c of sorted) {
    if (c.a > at) out.push({ a: at, b: Math.min(c.a, unit.b) });
    if (c.b > at) at = c.b;
    if (at >= unit.b) break;
  }
  if (at < unit.b) out.push({ a: at, b: unit.b });
  return out;
}

const dayInterval = (day: string): Interval => {
  const a = msOf(`${day}T00:00:00Z`, `the gap day ${day}`);
  return { a, b: a + DAY_MS };
};

const spanOf = (p: PackEntry): Interval => ({ a: msOf(p.span.start, `${pkgTag(p)} span.start`), b: msOf(p.span.end, `${pkgTag(p)} span.end`) });

// The unit of `tier` from `start`: its interval and its tag. A start off the
// tier's boundary, or a tier that is not one, is refused (usage).
export function unitOf(dataset: TierDataset, tier: CompactTier, start: string): { readonly startMs: number; readonly endMs: number; readonly tag: string } {
  // A dataset with no tiers is refused by tierTag below, in the same words.
  if (!(COMPACT_TIERS as readonly string[]).includes(tier)) throw new CompactError("usage", `${JSON.stringify(tier)} is not a tier a compaction builds: ${COMPACT_TIERS.join(", ")}`);
  let tag: string;
  try {
    tag = tierTag(dataset, tier, start);
  } catch (e) {
    if (e instanceof LayoutError) throw new CompactError("usage", e.message);
    throw e;
  }
  const startMs = Date.parse(start);
  return { startMs, endMs: tierEnd(tier, startMs), tag };
}

// The day of an instant, YYYY-MM-DD.
const dayOf = (ms: number): string => isoOf(ms).slice(0, 10);

// The days the root's gaps names, of any source (ruling 24), as a set.
function gapDaysOf(gaps: LiveInput["gaps"]): Set<string> {
  const out = new Set<string>();
  for (const days of Object.values(gaps ?? {})) for (const d of days) out.add(d);
  return out;
}

// The days from `a` (00:00:00Z of a day) up to `b` that `days` holds, YYYY-MM-DD.
const daysIn = (days: ReadonlySet<string>, a: number, b: number): string[] => {
  const out: string[] = [];
  for (let d = a; d < b; d += DAY_MS) if (days.has(dayOf(d))) out.push(dayOf(d));
  return out;
};

// The segments the day of `dataset` takes in by absorb, PACKAGE:TAG, when a
// live day pack of it spans [U.a, U.b): the segments inside the day that are
// not quarantined. None when no day pack of it is live.
function absorbedOf(live: LiveInput, dataset: TierDataset, U: Interval): string[] {
  const packs = live.datasets[dataset] ?? [];
  const day = packs.some((p) => p.tier === "d" && spanOf(p).a === U.a && spanOf(p).b === U.b);
  if (!day) return [];
  return packs.filter((p) => p.tier === "seg" && spanOf(p).a >= U.a && spanOf(p).b <= U.b && !isQuarantined(p)).map(pkgTag);
}

export function planTier(live: LiveInput, dataset: TierDataset, tier: CompactTier, start: string, options: PlanOptions = {}): TierPlan {
  const unit = unitOf(dataset, tier, start);
  const U: Interval = { a: unit.startMs, b: unit.endMs };
  const span = { start: isoOf(U.a), end: isoOf(U.b) };
  const base = { dataset, tier, span, tag: unit.tag };
  const empty = { inputs: [], replaces: [], excluded: [], missing: [], gapDays: [], present: null, sources: [], psl: [], records: 0, late: [], absorb: false };
  let nowMs: number | null = null;
  if (options.now !== undefined) {
    try {
      nowMs = msOf(options.now, "now");
    } catch (e) {
      if (e instanceof RootError) throw new CompactError("usage", e.message);
      throw e;
    }
  }
  const expected = options.expected ?? EXPECTED;
  for (const e of expected)
    if (!Number.isSafeInteger(e.untilS) || e.untilS < 0)
      throw new CompactError("usage", `the expected source ${JSON.stringify(e.source)} waits ${JSON.stringify(e.untilS)} s, not a whole number of seconds`);
  const absorbing = options.absorb === true && tier === "d";

  if (tier === "w" && dayOf(U.a).slice(0, 7) !== dayOf(U.b - 1).slice(0, 7)) {
    return { ...base, ...empty, verdict: "skip", reason: `the week ${span.start} to ${span.end} crosses the first of a month: its days stay day packs until each month is compacted` };
  }

  const packs = live.datasets[dataset] ?? [];
  const inside: PackEntry[] = [];
  let dayPack: PackEntry | null = null;
  for (const p of packs) {
    const s = spanOf(p);
    if (s.b <= U.a || s.a >= U.b) continue;
    const within = s.a >= U.a && s.b <= U.b;
    if (within && p.tier === tier && s.a === U.a && s.b === U.b) {
      const presentPlan: TierPlan = { ...base, ...empty, verdict: "present", present: p, reason: `${pkgTag(p)} is live and spans the unit` };
      if (!absorbing) return presentPlan;
      dayPack = p;
      inside.push(p);
      continue;
    }
    if (within) {
      inside.push(p);
      continue;
    }
    if (s.a <= U.a && s.b >= U.b && p.tier !== "seg" && rankOf(p.tier) > rankOf(tier)) {
      return { ...base, ...empty, verdict: "present", present: p, reason: `${pkgTag(p)} (tier ${p.tier}) is live and covers the unit` };
    }
    throw new CompactError("straddle", `${pkgTag(p)} (tier ${p.tier}, ${p.span.start} to ${p.span.end}) crosses an edge of the unit ${span.start} to ${span.end}: no pack of the unit can replace it`);
  }

  // D17: the live day pack takes in the segments beside it, or the feed day
  // follows a domains day that does. With neither, it is present.
  let absorbReason: string | null = null;
  if (dayPack !== null) {
    const live0 = dayPack;
    const beside = inside.filter((p) => p !== live0);
    const odd = beside.find((p) => p.tier !== "seg");
    if (odd !== undefined)
      throw new CompactError("plan", `${pkgTag(odd)} (tier ${odd.tier}) lies inside the day of the live day pack ${pkgTag(live0)}: only a segment may overlap a pack (the root's live-set rule)`);
    const follows = ABSORB_FOLLOWS[dataset];
    const followed = follows === undefined ? [] : absorbedOf(live, follows, U);
    if (beside.length === 0 && followed.length === 0) return { ...base, ...empty, verdict: "present", present: live0, reason: `${pkgTag(live0)} is live and spans the unit` };
    const parts: string[] = [];
    if (beside.length > 0) parts.push(`${pkgTag(live0)} takes in ${beside.length} segment(s) that came after it: ${beside.map(pkgTag).join(" ")}`);
    if (followed.length > 0)
      parts.push(
        `the day of ${follows} takes in ${followed.length} segment(s) that are not quarantined (${followed.join(" ")}), so ${pkgTag(live0)} is built again from its exact join, its rows carried`,
      );
    absorbReason = `absorb: ${parts.join("; ")}`;
  }

  // The root derives corpus_since from the first span start of the dataset's
  // packs (docs/architecture.md section 4.6), so no live pack lies before it.
  // A unit that starts before it is never built (D1 of DOM-023): a pack of
  // the whole unit would move corpus_since back to the unit's start, a
  // coverage no source gives (AGENTS.md absolute 11), and a pack from
  // corpus_since alone would not span its tier unit, which the live-set rule
  // asks. The span before corpus_since ends at the unit's end at most: when it
  // reaches the end, no day of the unit is in the corpus, and the unit is skipped.
  const since = live.corpus_since?.[dataset];
  const sinceMs = since === undefined ? null : msOf(since, `corpus_since.${dataset}`);
  const beforeCorpus: Interval[] = sinceMs !== null && sinceMs > U.a ? [{ a: U.a, b: Math.min(sinceMs, U.b) }] : [];
  if (beforeCorpus.length > 0 && beforeCorpus[0].b === U.b) {
    return {
      ...base,
      ...empty,
      verdict: "skip",
      reason: `the unit ends at ${span.end}, at or before the corpus of ${dataset} starts at ${since} (corpus_since): no source covers it, and no pack is written`,
    };
  }

  const gapDays = daysIn(gapDaysOf(live.gaps), U.a, U.b);
  const gapCover = gapDays.map(dayInterval);

  const excluded: Excluded[] = [];
  const inputs: PackEntry[] = [];
  for (const p of inside) {
    if (isQuarantined(p) && (NEW_DATASETS as readonly string[]).includes(dataset)) excluded.push({ repo: p.repo, manifest: p.manifest, tag: p.tag, reason: "quarantined" });
    else inputs.push(p);
  }

  const missing: Missing[] = [];
  for (const b of beforeCorpus)
    missing.push({ start: isoOf(b.a), end: isoOf(b.b), why: `the corpus of ${dataset} starts at ${since} (corpus_since): no pack covers a span before it, and the unit is never built`, found: [] });
  const slots = SLOT_TIERS[tier];
  const slotCover = inside.filter((p) => slots.includes(p.tier)).map(spanOf);
  // A quarantined pack of feed or new-name is no input whatever its tier, and
  // the output replaces it, so it covers its span as a pack of the slot tiers
  // does. A day whose every pack is quarantined writes no day pack (skip), and
  // its week takes its hour packs out of the live set instead of waiting on
  // them forever. The live day pack an absorb takes in covers its day.
  const excludedCover = inside.filter((p) => excluded.some((e) => e.manifest === p.manifest)).map(spanOf);
  const dayCover = dayPack === null ? [] : [spanOf(dayPack)];
  for (const hole of uncovered(U, [...slotCover, ...excludedCover, ...dayCover, ...gapCover, ...beforeCorpus])) {
    const found = inside.filter((p) => !slots.includes(p.tier) && spanOf(p).a < hole.b && spanOf(p).b > hole.a).map(pkgTag);
    missing.push({ start: isoOf(hole.a), end: isoOf(hole.b), why: `no ${slots.join(" or ")} pack covers it`, found });
  }
  // A day is built from the lanes' hour packs: a source of the day's packs
  // whose live packs end before the day does is behind, and the hour packs it
  // has yet to add would overlap the day pack. Only the days the root's gaps
  // names for that source excuse its tail: a gap of another source does not
  // tell whether this lane is late.
  const late: string[] = [];
  if (tier === "d") {
    const sources = [...new Set(inside.flatMap((p) => p.sources))].sort();
    for (const s of sources) {
      const reach = Math.max(...packs.filter((p) => p.sources.includes(s)).map((p) => spanOf(p).b));
      if (reach < U.b) {
        const own = daysIn(new Set(live.gaps?.[s] ?? []), U.a, U.b).map(dayInterval);
        for (const hole of uncovered({ a: reach, b: U.b }, own)) missing.push({ start: isoOf(hole.a), end: isoOf(hole.b), why: `the source ${s} has no live pack past ${isoOf(reach)}`, found: [] });
      }
    }
    // D15: an expected source with no pack in the day, and no gap day of its
    // own there, holds the day until its instant; past it the day goes on.
    if (nowMs !== null) {
      const date = dayOf(U.a);
      for (const e of expected) {
        if (!e.datasets.includes(dataset) || inside.some((p) => p.sources.includes(e.source)) || (live.gaps?.[e.source] ?? []).includes(date)) continue;
        const until = U.a + e.untilS * 1000;
        if (nowMs < until)
          missing.push({ start: span.start, end: span.end, why: `the source ${e.source} is expected in ${dataset} until ${isoOf(until)}, and no live pack of it lies in the day`, found: [] });
        else late.push(e.source);
      }
      late.sort();
    }
  }

  const sources = [...new Set(inputs.flatMap((p) => p.sources))].sort();
  const psl = [...new Set(inputs.map((p) => p.psl))].sort();
  const records = inputs.reduce((n, p) => n + p.count, 0);
  const replaces = [...inputs.map((p) => p.manifest), ...excluded.map((e) => e.manifest)];
  const facts = { inputs, replaces, excluded, gapDays, present: null, sources, psl, records, late, absorb: absorbReason !== null };
  if (beforeCorpus.length > 0) {
    const reason = `the unit is never built: it starts at ${span.start}, before the corpus of ${dataset} starts at ${since} (corpus_since), and a pack of it would move corpus_since back to its start, a coverage no source gives; its packs stay at the tier below`;
    return { ...base, ...facts, missing, verdict: "wait", reason };
  }
  if (missing.length > 0) {
    return { ...base, ...facts, missing, verdict: "wait", reason: `the unit is not whole: ${missing.map((m) => `${m.start} to ${m.end} (${m.why})`).join("; ")}` };
  }
  if (inputs.length === 0) {
    const why = excluded.length > 0 ? "every pack of the unit is quarantined" : "every day of the unit is a gap the root names";
    return { ...base, ...facts, missing, verdict: "skip", reason: `${why}: no pack is written (ruling ${excluded.length > 0 ? "23" : "24"})` };
  }
  const lateNote = late.length === 0 ? "" : `; without ${late.join(", ")}, late past its instant`;
  return { ...base, ...facts, missing, verdict: "ready", reason: `${absorbReason ?? `${inputs.length} input pack(s) make the unit whole`}${lateNote}` };
}
