// planTier: the input packs of one tier unit from a root's live set
// (docs/architecture.md sections 4.5 and 4.6, rulings 23 and 24). Each case
// plants one fault in a live set of synthetic pack entries
// (packages/root/test/helpers.ts).
//
//   node scripts/test.mjs packages/compact --name plan
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TierDataset } from "@domains/ghcr";
import type { PackEntry, RootTier } from "@domains/root";
import { pack } from "../../root/test/helpers.ts";
import { CompactError, type LiveInput, planTier } from "../src/index.ts";

const entry = (dataset: TierDataset, tier: RootTier, start: string, o: Parameters<typeof pack>[3] = {}): PackEntry => pack(dataset, tier, start, o).pack;
const day = (d: string): string => `${d}T00:00:00Z`;
const days = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(day(from)) + i * 86_400_000).toISOString().slice(0, 10));
const hoursOf = (dataset: TierDataset, d: string, o: Parameters<typeof pack>[3] = {}, upTo = 24): PackEntry[] =>
  Array.from({ length: upTo }, (_, h) => entry(dataset, "h", `${d}T${String(h).padStart(2, "0")}:00:00Z`, o));
const liveOf = (dataset: string, packs: PackEntry[], gaps: Record<string, string[]> = {}): LiveInput => ({ datasets: { [dataset]: packs }, gaps });
const refused = (fn: () => unknown, code: string, message: RegExp): void => {
  assert.throws(fn, (e: unknown) => e instanceof CompactError && e.code === code && message.test(e.message));
};

const WEEK43 = days("2026-10-19", 7);

test("plan: a whole week of day packs is ready, and the week pack replaces each of them", () => {
  const packs = WEEK43.map((d) => entry("names", "d", day(d)));
  const plan = planTier(liveOf("names", packs), "names", "w", day("2026-10-19"));
  assert.equal(plan.verdict, "ready", plan.reason);
  assert.equal(plan.tag, "names-w-2026w43");
  assert.deepEqual(plan.span, { start: "2026-10-19T00:00:00Z", end: "2026-10-26T00:00:00Z" });
  assert.deepEqual(
    plan.inputs.map((p) => p.tag),
    WEEK43.map((d) => `names-d-${d.replaceAll("-", "")}`),
  );
  assert.deepEqual(
    plan.replaces,
    packs.map((p) => p.manifest),
  );
  assert.equal(plan.records, 70);
  assert.deepEqual(plan.sources, ["thc-ct"]);
  // A pack outside the unit is no input.
  const wider = planTier(liveOf("names", [entry("names", "d", day("2026-10-18")), ...packs, entry("names", "d", day("2026-10-26"))]), "names", "w", day("2026-10-19"));
  assert.equal(wider.inputs.length, 7);
});

test("plan: a week with a missing day waits, and names the day", () => {
  const packs = WEEK43.filter((d) => d !== "2026-10-22").map((d) => entry("names", "d", day(d)));
  const plan = planTier(liveOf("names", packs), "names", "w", day("2026-10-19"));
  assert.equal(plan.verdict, "wait");
  assert.deepEqual(
    plan.missing.map((m) => [m.start, m.end, m.found]),
    [["2026-10-22T00:00:00Z", "2026-10-23T00:00:00Z", []]],
  );
  assert.match(plan.reason, /2026-10-22T00:00:00Z to 2026-10-23T00:00:00Z \(no d pack covers it\)/);
  // A day still in hour packs is missing too: the week waits for the daily compaction.
  const hours = planTier(liveOf("names", [...packs, ...hoursOf("names", "2026-10-22")]), "names", "w", day("2026-10-19"));
  assert.equal(hours.verdict, "wait");
  assert.equal(hours.missing[0].found.length, 24);
  assert.equal(hours.missing[0].found[0], "names:names-h-2026102200");
});

test("plan: a day the root's gaps names is no missing day (ruling 24)", () => {
  const packs = WEEK43.filter((d) => d !== "2026-10-22").map((d) => entry("names", "d", day(d)));
  const plan = planTier(liveOf("names", packs, { "thc-ct": ["2026-10-04", "2026-10-22"] }), "names", "w", day("2026-10-19"));
  assert.equal(plan.verdict, "ready", plan.reason);
  assert.deepEqual(plan.gapDays, ["2026-10-22"]);
  assert.equal(plan.inputs.length, 6);
  // A gap of another day does not cover this one.
  const other = planTier(liveOf("names", packs, { "thc-ct": ["2026-10-04"] }), "names", "w", day("2026-10-19"));
  assert.equal(other.verdict, "wait");
  // A unit whose every day is a gap writes no pack.
  const all = planTier(liveOf("names", [], { "thc-ct": ["2026-10-09"] }), "names", "d", day("2026-10-09"));
  assert.equal(all.verdict, "skip");
  assert.match(all.reason, /every day of the unit is a gap/);
});

test("plan: a week across the first of a month is skipped; its days wait for the months", () => {
  const packs = days("2026-10-26", 7).map((d) => entry("names", "d", day(d)));
  const plan = planTier(liveOf("names", packs), "names", "w", day("2026-10-26"));
  assert.equal(plan.verdict, "skip");
  assert.match(plan.reason, /crosses the first of a month/);
  assert.equal(plan.inputs.length, 0);
});

test("plan: a month takes its weeks and the days of the weeks across its edges", () => {
  const packs = [
    ...days("2026-10-01", 4).map((d) => entry("names", "d", day(d))),
    entry("names", "w", day("2026-10-05")),
    entry("names", "w", day("2026-10-12")),
    entry("names", "w", day("2026-10-19")),
    ...days("2026-10-26", 6).map((d) => entry("names", "d", day(d))),
  ];
  const plan = planTier(liveOf("names", packs), "names", "m", day("2026-10-01"));
  assert.equal(plan.verdict, "ready", plan.reason);
  assert.equal(plan.tag, "names-m-202610");
  assert.equal(plan.inputs.length, 13);
  // A year takes its months, and waits for the ones not built.
  const year = planTier(liveOf("names", [entry("names", "m", day("2026-01-01"))]), "names", "y", day("2026-01-01"));
  assert.equal(year.verdict, "wait");
  assert.deepEqual(
    year.missing.map((m) => [m.start, m.end]),
    [["2026-02-01T00:00:00Z", "2027-01-01T00:00:00Z"]],
  );
});

test("plan: a live pack across an edge of the unit is refused (straddle)", () => {
  const packs = [entry("names", "w", day("2026-09-28")), ...days("2026-10-05", 27).map((d) => entry("names", "d", day(d)))];
  refused(() => planTier(liveOf("names", packs), "names", "m", day("2026-10-01")), "straddle", /names:names-w-2026w40 \(tier w, 2026-09-28T00:00:00Z to 2026-10-05T00:00:00Z\) crosses an edge/);
});

test("plan: a unit a live pack of its tier or above covers is present", () => {
  const week = entry("names", "w", day("2026-10-19"));
  const plan = planTier(liveOf("names", [week]), "names", "w", day("2026-10-19"));
  assert.equal(plan.verdict, "present");
  assert.equal(plan.present?.tag, "names-w-2026w43");
  const month = entry("names", "m", day("2026-10-01"));
  const covered = planTier(liveOf("names", [month]), "names", "d", day("2026-10-26"));
  assert.equal(covered.verdict, "present");
  assert.equal(covered.present?.tag, "names-m-202610");
});

test("plan: a quarantined pack is no input of feed or new-name, and is replaced; in names it is an input (ruling 23)", () => {
  const quarantined = (p: PackEntry): PackEntry => ({ ...p, quarantine: true }) as PackEntry;
  for (const dataset of ["feed", "new-name"] as const) {
    const hours = hoursOf(dataset, "2026-10-26");
    hours[5] = quarantined(hours[5]);
    const plan = planTier(liveOf(dataset, hours), dataset, "d", day("2026-10-26"));
    assert.equal(plan.verdict, "ready", plan.reason);
    assert.equal(plan.inputs.length, 23);
    assert.deepEqual(plan.excluded, [{ repo: hours[5].repo, manifest: hours[5].manifest, tag: hours[5].tag, reason: "quarantined" }]);
    assert.equal(plan.excluded[0].repo, "pkgforge-dev/domains.pkgforge.dev/feed");
    assert.equal(plan.replaces.length, 24);
    assert.ok(plan.replaces.includes(hours[5].manifest));
    assert.ok(!plan.inputs.some((p) => p.manifest === hours[5].manifest));
  }
  // A quarantined segment of obs in a feed day: excluded, and named in its own package.
  const seg = quarantined(entry("feed", "seg", day("2026-10-26"), { end: day("2026-10-27"), sources: ["oi-nrd"] }));
  const withSeg = planTier(liveOf("feed", [...hoursOf("feed", "2026-10-26"), seg]), "feed", "d", day("2026-10-26"));
  assert.equal(withSeg.verdict, "ready", withSeg.reason);
  assert.deepEqual(withSeg.excluded, [{ repo: "pkgforge-dev/domains.pkgforge.dev/obs", manifest: seg.manifest, tag: seg.tag, reason: "quarantined" }]);
  const names = hoursOf("names", "2026-10-26");
  names[5] = quarantined(names[5]);
  const plan = planTier(liveOf("names", names), "names", "d", day("2026-10-26"));
  assert.equal(plan.inputs.length, 24);
  assert.deepEqual(plan.excluded, []);
});

test("plan: a feed day whose every pack is quarantined writes no day pack, and its week replaces its hour packs (ruling 23)", () => {
  const quarantined = (p: PackEntry): PackEntry => ({ ...p, quarantine: true }) as PackEntry;
  const hours = hoursOf("feed", "2026-10-22").map(quarantined);
  const day22 = planTier(liveOf("feed", hours), "feed", "d", day("2026-10-22"));
  assert.equal(day22.verdict, "skip");
  assert.match(day22.reason, /every pack of the unit is quarantined/);
  const others = WEEK43.filter((d) => d !== "2026-10-22").map((d) => entry("feed", "d", day(d)));
  const week = planTier(liveOf("feed", [...others, ...hours]), "feed", "w", day("2026-10-19"));
  assert.equal(week.verdict, "ready", week.reason);
  assert.equal(week.inputs.length, 6);
  assert.equal(week.excluded.length, 24);
  assert.equal(week.replaces.length, 30);
  // In names the same hour packs are inputs, so the week waits for their day pack.
  const names = planTier(
    liveOf("names", [...WEEK43.filter((d) => d !== "2026-10-22").map((d) => entry("names", "d", day(d))), ...hoursOf("names", "2026-10-22").map(quarantined)]),
    "names",
    "w",
    day("2026-10-19"),
  );
  assert.equal(names.verdict, "wait");
  // One hour of the day not quarantined is still missing from the week: its day is built first.
  const mixed = [...hours.slice(0, 23), entry("feed", "h", "2026-10-22T23:00:00Z")];
  const waits = planTier(liveOf("feed", [...others, ...mixed]), "feed", "w", day("2026-10-19"));
  assert.equal(waits.verdict, "wait");
  assert.deepEqual(
    waits.missing.map((m) => [m.start, m.end, m.found]),
    [["2026-10-22T23:00:00Z", "2026-10-23T00:00:00Z", ["feed:feed-h-2026102223"]]],
  );
});

test("plan: a day is whole from its hour packs, or from a segment that spans it; it waits for a source behind", () => {
  const thc = entry("names", "seg", day("2026-10-26"), { end: day("2026-10-27"), sources: ["thc-ct"] });
  // A day of the backfill: THC's day segment alone.
  const backfill = planTier(liveOf("names", [thc]), "names", "d", day("2026-10-26"));
  assert.equal(backfill.verdict, "ready", backfill.reason);
  assert.deepEqual(
    backfill.inputs.map((p) => p.tier),
    ["seg"],
  );
  // A live day: 24 hour packs of a lane and THC's day segment beside them.
  const lane = hoursOf("names", "2026-10-26", { sources: ["oi-cs"] });
  const whole = planTier(liveOf("names", [thc, ...lane]), "names", "d", day("2026-10-26"));
  assert.equal(whole.verdict, "ready", whole.reason);
  assert.equal(whole.inputs.length, 25);
  assert.deepEqual(whole.sources, ["oi-cs", "thc-ct"]);
  // The lane has reached 20:00 only: the segment covers the day, and the day still waits.
  const behind = planTier(liveOf("names", [thc, ...lane.slice(0, 20)]), "names", "d", day("2026-10-26"));
  assert.equal(behind.verdict, "wait");
  assert.deepEqual(
    behind.missing.map((m) => [m.start, m.end, m.why]),
    [["2026-10-26T20:00:00Z", "2026-10-27T00:00:00Z", "the source oi-cs has no live pack past 2026-10-26T20:00:00Z"]],
  );
  // Hours with no segment beside them, one missing: the hour is missing.
  const hole = planTier(
    liveOf(
      "names",
      lane.filter((_, h) => h !== 7),
    ),
    "names",
    "d",
    day("2026-10-26"),
  );
  assert.equal(hole.verdict, "wait");
  assert.deepEqual(
    hole.missing.map((m) => [m.start, m.end]),
    [["2026-10-26T07:00:00Z", "2026-10-26T08:00:00Z"]],
  );
});

test("plan: the slot packs of two sources cover a day together, a long cover then shorter ones inside it", () => {
  // A source that writes a segment each 12 hours, and a lane of hour packs
  // that lacks 05:00, which the first segment covers.
  const le = [
    entry("names", "seg", day("2026-10-26"), { end: "2026-10-26T12:00:00Z", sources: ["ct-le"] }),
    entry("names", "seg", "2026-10-26T12:00:00Z", { end: day("2026-10-27"), sources: ["ct-le"] }),
  ];
  const lane = hoursOf("names", "2026-10-26", { sources: ["oi-cs"] }).filter((_, h) => h !== 5);
  const plan = planTier(liveOf("names", [...le, ...lane]), "names", "d", day("2026-10-26"));
  assert.equal(plan.verdict, "ready", plan.reason);
  assert.equal(plan.inputs.length, 25);
  assert.deepEqual(plan.sources, ["ct-le", "oi-cs"]);
});

test("plan: a source behind its clock is excused by its own gap days only; a hole inside a day that a gap of any source names is no missing span (ruling 24)", () => {
  // The lane reached 12:00, and the root names the day a gap of that lane: it will add no more.
  const lane = hoursOf("names", "2026-10-22", { sources: ["oi-cs"] }, 12);
  const own = planTier(liveOf("names", lane, { "oi-cs": ["2026-10-22"] }), "names", "d", day("2026-10-22"));
  assert.equal(own.verdict, "ready", own.reason);
  assert.equal(own.inputs.length, 12);
  assert.deepEqual(own.gapDays, ["2026-10-22"]);
  // A gap of another source says nothing of this lane's clock: the day waits for it.
  const other = planTier(liveOf("names", lane, { "thc-ct": ["2026-10-22"] }), "names", "d", day("2026-10-22"));
  assert.equal(other.verdict, "wait", other.reason);
  assert.deepEqual(
    other.missing.map((m) => [m.start, m.end, m.why]),
    [["2026-10-22T12:00:00Z", "2026-10-23T00:00:00Z", "the source oi-cs has no live pack past 2026-10-22T12:00:00Z"]],
  );
  // A lane that passed 05:00 to 07:00 by: a hole the root accepts on a day gaps names, of any source.
  const holed = hoursOf("names", "2026-10-22", { sources: ["oi-cs"] }).filter((_, h) => h < 5 || h > 7);
  const named = planTier(liveOf("names", holed, { "thc-ct": ["2026-10-22"] }), "names", "d", day("2026-10-22"));
  assert.equal(named.verdict, "ready", named.reason);
  assert.equal(named.inputs.length, 21);
  const unnamed = planTier(liveOf("names", holed), "names", "d", day("2026-10-22"));
  assert.equal(unnamed.verdict, "wait");
  assert.deepEqual(
    unnamed.missing.map((m) => [m.start, m.end, m.why]),
    [["2026-10-22T05:00:00Z", "2026-10-22T08:00:00Z", "no h or seg pack covers it"]],
  );
});

test('plan: the quarantine mark is true, 1 or "1"; any other value marks nothing (ruling 23)', () => {
  for (const v of [true, 1, "1"]) {
    const hours = hoursOf("feed", "2026-10-26");
    hours[3] = { ...hours[3], quarantine: v } as PackEntry;
    const plan = planTier(liveOf("feed", hours), "feed", "d", day("2026-10-26"));
    assert.equal(plan.inputs.length, 23, `quarantine ${JSON.stringify(v)}`);
    assert.deepEqual(
      plan.excluded.map((e) => e.tag),
      ["feed-h-2026102603"],
    );
  }
  for (const v of [false, 0, "0", "true", null]) {
    const hours = hoursOf("feed", "2026-10-26");
    hours[3] = { ...hours[3], quarantine: v } as PackEntry;
    const plan = planTier(liveOf("feed", hours), "feed", "d", day("2026-10-26"));
    assert.equal(plan.inputs.length, 24, `quarantine ${JSON.stringify(v)}`);
    assert.deepEqual(plan.excluded, []);
  }
});

test("plan: a unit that starts before the dataset's corpus_since is never built: it waits, and its reason and the span before corpus_since say so", () => {
  // THC's backfill starts the names corpus at 2026-09-01 (TODO/storage.md,
  // DOM-021): no pack covers 2026-01-01 to 2026-09-01, and a pack of the
  // year would move corpus_since back to 2026-01-01, a coverage no source
  // gives. The lead's decision D1 of DOM-023: such a unit is never built, and
  // the year 2026 of names stays four month packs.
  const months = ["2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"].map((d) => entry("names", "m", day(d)));
  const live: LiveInput = { datasets: { names: months }, corpus_since: { names: day("2026-09-01") }, gaps: {} };
  const year = planTier(live, "names", "y", day("2026-01-01"));
  assert.equal(year.verdict, "wait");
  assert.equal(
    year.reason,
    "the unit is never built: it starts at 2026-01-01T00:00:00Z, before the corpus of names starts at 2026-09-01T00:00:00Z (corpus_since), and a pack of it would move corpus_since back to its start, a coverage no source gives; its packs stay at the tier below",
  );
  assert.doesNotMatch(year.reason, /ruling/);
  assert.deepEqual(
    year.missing.map((m) => [m.start, m.end, m.why]),
    [["2026-01-01T00:00:00Z", "2026-09-01T00:00:00Z", "the corpus of names starts at 2026-09-01T00:00:00Z (corpus_since): no pack covers a span before it, and the unit is never built"]],
  );
  assert.equal(year.inputs.length, 4);
  // A corpus that starts mid-day: its first day is never built either, and stays hour packs.
  const first = planTier({ datasets: { names: hoursOf("names", "2026-09-01").slice(5) }, corpus_since: { names: "2026-09-01T05:00:00Z" } }, "names", "d", day("2026-09-01"));
  assert.equal(first.verdict, "wait");
  assert.deepEqual(
    first.missing.map((m) => [m.start, m.end]),
    [["2026-09-01T00:00:00Z", "2026-09-01T05:00:00Z"]],
  );
  assert.match(first.reason, /^the unit is never built: it starts at 2026-09-01T00:00:00Z, before the corpus of names starts at 2026-09-01T05:00:00Z \(corpus_since\)/);
  // A unit that starts exactly at corpus_since is built: the day 2026-09-01 and the month 2026-09.
  const since = { names: day("2026-09-01") };
  const firstDay = planTier({ datasets: { names: hoursOf("names", "2026-09-01") }, corpus_since: since }, "names", "d", day("2026-09-01"));
  assert.equal(firstDay.verdict, "ready", firstDay.reason);
  assert.equal(firstDay.inputs.length, 24);
  const september = planTier({ datasets: { names: days("2026-09-01", 30).map((d) => entry("names", "d", day(d))) }, corpus_since: since }, "names", "m", day("2026-09-01"));
  assert.equal(september.verdict, "ready", september.reason);
  assert.equal(september.inputs.length, 30);
  // A unit from corpus_since on is planned as before, and a corpus_since of another dataset is not read.
  const week = days("2026-09-07", 7).map((d) => entry("names", "d", day(d)));
  assert.equal(planTier({ datasets: { names: week }, corpus_since: { names: day("2026-09-01") } }, "names", "w", day("2026-09-07")).verdict, "ready");
  assert.equal(planTier({ datasets: { names: months }, corpus_since: { feed: day("2026-10-27") } }, "names", "y", day("2026-01-01")).missing[0].why, "no m pack covers it");
});

test("plan: a unit that lies wholly before the dataset's corpus_since is skipped: no source covers it", () => {
  // The names corpus starts at 2026-09-01: the month of August and a day of it
  // end at or before corpus_since, and no pack covers either (D1 of DOM-023).
  const months = ["2026-09-01", "2026-10-01"].map((d) => entry("names", "m", day(d)));
  const live: LiveInput = { datasets: { names: months }, corpus_since: { names: day("2026-09-01") }, gaps: {} };
  for (const [tier, start, end] of [
    ["m", "2026-08-01", "2026-09-01"],
    ["d", "2026-08-15", "2026-08-16"],
  ] as const) {
    const plan = planTier(live, "names", tier, day(start));
    assert.equal(plan.verdict, "skip", `${tier} ${start}: ${plan.reason}`);
    assert.equal(plan.reason, `the unit ends at ${day(end)}, at or before the corpus of names starts at 2026-09-01T00:00:00Z (corpus_since): no source covers it, and no pack is written`);
    assert.deepEqual([plan.inputs, plan.replaces, plan.missing], [[], [], []]);
  }
});

test("plan: a week whose last day is the last of its month is ready; only a week that crosses into the next month is skipped", () => {
  // 2026-05-25 is a Monday: the week ends 2026-06-01T00:00:00Z, and its last day, 2026-05-31, is in May.
  const may = days("2026-05-25", 7).map((d) => entry("names", "d", day(d)));
  const plan = planTier(liveOf("names", may), "names", "w", day("2026-05-25"));
  assert.equal(plan.verdict, "ready", plan.reason);
  assert.equal(plan.tag, "names-w-2026w22");
  assert.equal(plan.inputs.length, 7);
});

test("plan: a tier, a dataset or a start that is not one is refused (usage)", () => {
  const live = liveOf("names", []);
  refused(() => planTier(live, "names", "w", day("2026-10-20")), "usage", /not 00:00:00Z of a Monday/);
  refused(() => planTier(live, "names", "h" as never, "2026-10-20T01:00:00Z"), "usage", /not a tier a compaction builds/);
  refused(() => planTier(live, "dumps" as never, "d", day("2026-10-20")), "usage", /not a dataset with tiers/);
});
