// packages/feed/src/confidence.ts: every rule of design B section 4 with ruling
// 19, on events built from the payload shapes of the entry's Premise. The three
// OpenINTEL payloads are recorded (helpers.ts, design A's broker answers); the
// ISC, WhoisDS, zone and RDAP rows are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Evidence, FEED_SUSPECT, FEED_SUSPECT_CERT, FEED_SUSPECT_RDAP, type Seen } from "@domains/pack";
import { type ConfidenceLevel, classOf, confidenceOf, type DomainEvent, FeedError, SUSPECT_CERT_AGE_SECONDS, type Window } from "../src/index.ts";
import { at, BIT, CONFIRMED_EVENT, D, DAY, EPOCH_UNIX, evidence, FRESH_CERT_EVENT, HOUR, isc, mergeEvents, OLD_CERT_EVENT, oiConfirmed, oiNrd, rng, seen, table, whoisds } from "./helpers.ts";

const isFeed = (code: string) => (e: unknown) => e instanceof FeedError && e.code === code;
const dayWindow = (day: number): Window => ({ t0: day * DAY, t1: (day + 1) * DAY });
const of = (event: DomainEvent, window: Window) => confidenceOf(event.sources, event.evidence, { table, window, facts: event.facts });

// 2026-10-26T08:00:00Z, as a Unix time for synthetic payloads.
const T = EPOCH_UNIX + D * DAY + 8 * HOUR;
// 2026-10-15, the day of the two recorded newly_registered_domain messages.
const OCT15 = 287;

test("confidence: the recorded oi-nrd event with a certificate 3.9 s old is single and not suspect", () => {
  const event = oiNrd(FRESH_CERT_EVENT);
  assert.equal(event.key, "com.pracovento");
  assert.equal(event.sources[0].first, at("2026-10-15T13:00:51Z"));
  const c = of(event, dayWindow(OCT15));
  assert.equal(c.level, "single");
  assert.equal(c.suspect, false);
  assert.equal(c.corroborated, false);
  assert.equal(c.basis, 2 ** 2, "nrd-list");
  assert.deepEqual(c.why, []);
  assert.ok(Math.abs(FRESH_CERT_EVENT.timestamp - FRESH_CERT_EVENT.submission_timestamp - 3.863) < 1e-3);
});

test("confidence: the recorded oi-nrd event, its certificate 40.7 days older than the event, is suspect", () => {
  const event = oiNrd(OLD_CERT_EVENT);
  assert.equal(event.key, "com.creatorwide");
  // 1792069250 is 2026-10-15T13:00:50Z (date -u -d @1792069250).
  assert.equal(event.sources[0].first, at("2026-10-15T13:00:50Z"));
  const c = of(event, dayWindow(OCT15));
  assert.equal(c.suspect, true);
  assert.deepEqual([c.suspectCert, c.suspectRdap], [true, false]);
  assert.equal(c.feedFlags, FEED_SUSPECT | FEED_SUSPECT_CERT, "suspect and its reason, bit 4");
  assert.equal(c.level, "single");
  const age = OLD_CERT_EVENT.timestamp - OLD_CERT_EVENT.submission_timestamp;
  assert.deepEqual(c.why, [{ rule: "cert-age", bit: BIT.oiNrd, seconds: age }]);
  assert.ok(Math.abs(age - 3_514_451.215) < 1e-3);
});

test("confidence: a certificate exactly 7 days old is not suspect, and one second older is", () => {
  const make = (age: number) => oiNrd({ domain: "edge-synthetic.com.", cert_index: 2, ct_name: "synthetic log", timestamp: T, submission_timestamp: T - age });
  assert.equal(of(make(SUSPECT_CERT_AGE_SECONDS), dayWindow(D)).suspect, false);
  assert.equal(of(make(SUSPECT_CERT_AGE_SECONDS + 1), dayWindow(D)).suspect, true);
  assert.equal(SUSPECT_CERT_AGE_SECONDS, 7 * DAY);
});

const confirmed = (level: number) => oiConfirmed({ domain: "confirmed-synthetic.com.", cert_index: 3, ct_name: "synthetic log", timestamp: T, confidence: level });

test("confidence: the recorded confirmed event of level 3 is registered-confirmed; levels 1 and 5 are, levels 6, 10 and 0 are not", () => {
  assert.equal(CONFIRMED_EVENT.confidence, 3);
  const three = of(oiConfirmed(CONFIRMED_EVENT), dayWindow(299));
  assert.equal(three.level, "registered-confirmed");
  assert.equal(three.oiLevel, 3);
  assert.equal(three.basis, 2 ** 3, "nrd-ct+rdap");
  assert.deepEqual(three.why, [{ rule: "nrd-ct+rdap", bit: BIT.oiConfirmed, level: 3 }]);
  // Level 1 is the closest to the RDAP date, level 5 the farthest that counts.
  for (const level of [1, 5]) {
    const c = of(confirmed(level), dayWindow(D));
    assert.equal(c.level, "registered-confirmed", `level ${level}`);
    assert.equal(c.oiLevel, level);
    assert.deepEqual(c.why, [{ rule: "nrd-ct+rdap", bit: BIT.oiConfirmed, level }]);
  }
  for (const level of [6, 10, 0]) {
    const c = of(confirmed(level), dayWindow(D));
    assert.equal(c.level, "single", `level ${level}`);
    assert.equal(c.basis, 2 ** 3, "the basis stays: the event is a registry claim of a weaker level");
    assert.deepEqual(c.why, [], `level ${level} gives no nrd-ct+rdap reason`);
  }
  // Two levels of one triple, merged by the codec before confidenceOf sees them,
  // keep the stronger, the lowest that is not 0.
  const both = mergeEvents(confirmed(7), confirmed(2));
  assert.equal(of(both, dayWindow(D)).oiLevel, 2);
  assert.equal(of(both, dayWindow(D)).level, "registered-confirmed");
});

test("confidence: confidenceOf itself keeps the stronger of two nrd-ct+rdap levels it is given, in either order", () => {
  // Evidence passed straight to confidenceOf, no codec merge before it.
  const e = (level: number) => evidence(3, BIT.oiConfirmed, D * DAY + 60, level);
  const sources = [seen(BIT.oiConfirmed, D * DAY + 60)];
  const levelOf = (levels: number[]) => confidenceOf(sources, levels.map(e), { table, window: dayWindow(D) });
  for (const levels of [
    [7, 2],
    [2, 7],
  ]) {
    const c = levelOf(levels);
    assert.equal(c.oiLevel, 2, levels.join(" then "));
    assert.equal(c.level, "registered-confirmed", levels.join(" then "));
  }
  // 0 states no level: the other entry's level stands.
  assert.equal(levelOf([0, 9]).oiLevel, 9);
  assert.equal(levelOf([9, 0]).oiLevel, 9);
});

test("confidence: a zone add is registered-confirmed, from a zone source or a zone row of the confirmed topic", () => {
  const zoneRow = oiConfirmed({ domain: "zone-synthetic.se.", cert_index: -1, ct_name: "zone_data", timestamp: T, confidence: 0 });
  const c = of(zoneRow, dayWindow(D));
  assert.equal(c.level, "registered-confirmed");
  assert.equal(c.basis, 2 ** 0);
  const fromZone = of({ key: "se.zone-synthetic", flags: 0, sources: [seen(BIT.oiZone, D)], evidence: [evidence(0, BIT.oiZone, D)] }, dayWindow(D));
  assert.equal(fromZone.level, "registered-confirmed");
  assert.deepEqual(fromZone.why, [{ rule: "zone", bit: BIT.oiZone, at: D * DAY }]);
});

test("confidence: an RDAP creation time in the window is registered-confirmed, and one outside it adds no basis bit", () => {
  // The RDAP source alone, so no other rule decides the class.
  const event = (created: number): DomainEvent => ({ key: "com.rdap-synthetic", flags: 0, sources: [seen(BIT.rdap, created)], evidence: [evidence(1, BIT.rdap, created)] });
  const c = of(event(D * DAY + 3 * HOUR), dayWindow(D));
  assert.equal(c.level, "registered-confirmed");
  assert.equal(c.basis, 2 ** 1);
  assert.deepEqual(c.why, [{ rule: "rdap", bit: BIT.rdap, at: D * DAY + 3 * HOUR }]);
  const before = of(event(D * DAY - 1), dayWindow(D));
  assert.equal(before.level, "single");
  assert.equal(before.basis, 0, "no rdap bit for a creation time outside the window");
  assert.deepEqual(before.why, [{ rule: "rdap-outside-window", bit: BIT.rdap, at: D * DAY - 1 }]);
  assert.equal(of(event((D + 1) * DAY), dayWindow(D)).level, "single", "the window is half-open");
});

test("confidence: oi-nrd and isc-new within 48 h are corroborated; one family twice, or 48 h and one second apart, is not", () => {
  const nrd = oiNrd(FRESH_CERT_EVENT);
  const fromIsc = isc({ domainname: "pracovento.com", firstseen: "2026-10-15", score: 0, scorereason: "synthetic" });
  const c = of(mergeEvents(nrd, fromIsc), dayWindow(OCT15));
  assert.equal(c.corroborated, true);
  assert.equal(c.level, "corroborated");
  assert.deepEqual(c.why, [{ rule: "corroborated", bits: [BIT.oiNrd, BIT.isc], families: ["ct", "isc"] }]);
  // oi-nrd and thc-ct are both family ct.
  const sameFamily = mergeEvents(nrd, { key: nrd.key, flags: 0, sources: [seen(BIT.thc, OCT15)], evidence: [] });
  assert.equal(of(sameFamily, dayWindow(OCT15)).corroborated, false);
  // A day value stands for its whole day: days D and D+1 are surely within 48 h.
  const nextDay = mergeEvents(fromIsc, whoisds("pracovento.com", "2026-10-17"));
  assert.equal(nextDay.sources[1].first, OCT15 + 1);
  assert.equal(of(nextDay, dayWindow(OCT15)).corroborated, true);
  // Day D and the second 48 h after its start: the farthest instants are 48 h apart.
  const atOffset = (offset: number): DomainEvent => mergeEvents(fromIsc, { key: nrd.key, flags: 0, sources: [seen(BIT.oiNrd, OCT15 * DAY + offset)], evidence: [] });
  assert.equal(of(atOffset(48 * HOUR), dayWindow(OCT15)).corroborated, true);
  assert.equal(of(atOffset(48 * HOUR + 1), dayWindow(OCT15)).corroborated, false, "a day value is not read as its first second");
  // Days D and D+2: 72 h apart at the farthest.
  assert.equal(of(mergeEvents(fromIsc, whoisds("pracovento.com", "2026-10-18")), dayWindow(OCT15)).corroborated, false);
});

test("confidence: corroboration takes any pair of the record's sources, not only the first or two adjacent ones", () => {
  const corroborated = (sources: ReturnType<typeof seen>[]) => confidenceOf(sources, [], { table, window: dayWindow(D) });
  // thc-ct (ct) 30 days before; oi-nrd (ct) and isc-new (isc) on day D: the pair is the second and the third.
  const second = corroborated([seen(BIT.thc, D - 30), seen(BIT.oiNrd, D * DAY + 100), seen(BIT.isc, D)]);
  assert.equal(second.corroborated, true, "the second and the third source");
  assert.deepEqual(second.why, [{ rule: "corroborated", bits: [BIT.oiNrd, BIT.isc], families: ["ct", "isc"] }]);
  // thc-ct and isc-new on day D, oi-nrd 30 days before between them: the pair is the first and the third.
  const apart = corroborated([seen(BIT.thc, D), seen(BIT.oiNrd, (D - 30) * DAY + 100), seen(BIT.isc, D)]);
  assert.equal(apart.corroborated, true, "the first and the third source, a far source between");
  assert.deepEqual(apart.why, [{ rule: "corroborated", bits: [BIT.thc, BIT.isc], families: ["ct", "isc"] }]);
});

test("confidence: an RDAP creation date before 2026 sets suspect, with its reason in why, and is not evidence (ruling 19)", () => {
  const event: DomainEvent = {
    key: "com.old-synthetic",
    flags: 0,
    sources: [seen(BIT.oiNrd, D * DAY + 5)],
    evidence: [],
    facts: { rdapCreated: [{ bit: BIT.rdap, date: "2012-03-04" }] },
  };
  const c = of(event, dayWindow(D));
  assert.equal(c.suspect, true);
  assert.deepEqual([c.suspectCert, c.suspectRdap], [false, true]);
  assert.equal(c.feedFlags, FEED_SUSPECT | FEED_SUSPECT_RDAP, "suspect and its reason, bit 5");
  assert.equal(c.basis, 0, "no basis: the date is no evidence");
  assert.deepEqual(c.why, [{ rule: "rdap-before-2026", bit: BIT.rdap, date: "2012-03-04" }]);
  assert.throws(() => of({ ...event, facts: { rdapCreated: [{ bit: BIT.rdap, date: "2026-01-01" }] } }, dayWindow(D)), isFeed("facts"));
  assert.throws(() => of({ ...event, facts: { rdapCreated: [{ bit: BIT.rdap, date: "2025-02-30" }] } }, dayWindow(D)), isFeed("facts"));
});

test("confidence: a ct_name source implies the basis ct-first, and a fact about a source the record lacks is refused", () => {
  const thc: DomainEvent = { key: "com.thc-synthetic", flags: 1, sources: [seen(BIT.thc, D)], evidence: [] };
  const c = of(thc, dayWindow(D));
  assert.equal(c.basis, 2 ** 4);
  assert.equal(c.level, "single");
  assert.throws(() => of({ ...thc, facts: { certAges: [{ bit: BIT.oiNrd, seconds: 9 * DAY }] } }, dayWindow(D)), isFeed("facts"));
  assert.throws(() => of({ ...thc, evidence: [{ tier: 3, basis: 9, source: BIT.thc, at: D, confidence: 0 }] }, dayWindow(D)), isFeed("facts"));
  assert.throws(() => of({ ...thc, sources: [seen(40, D)] }, dayWindow(D)), isFeed("usage"), "a bit the table does not name");
  // A fact names a source bit of 0 to 63. An RDAP date of bit 64 passes every
  // other check of its fact, so only the bit check refuses it.
  const isBit = (e: unknown) => e instanceof FeedError && e.code === "facts" && /names source bit 64, not 0 to 63/.test(e.message);
  assert.throws(() => of({ ...thc, facts: { rdapCreated: [{ bit: 64, date: "2012-03-04" }] } }, dayWindow(D)), isBit);
  assert.throws(() => of({ ...thc, facts: { certAges: [{ bit: 64, seconds: 9 * DAY }] } }, dayWindow(D)), isBit);
  // A certificate age that is not a finite number: NaN is above nothing, so
  // without its own check it would pass as not suspect.
  for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(
      () => of({ ...thc, facts: { certAges: [{ bit: BIT.thc, seconds }] } }, dayWindow(D)),
      (e: unknown) => isFeed("facts")(e) && /seconds/.test((e as Error).message),
      String(seconds),
    );
});

// The class by design B section 4, from a record's raw sources and evidence,
// written apart from confidenceOf and classOf: registered-confirmed for a zone
// entry, an rdap entry whose time falls in the window, or an nrd-ct+rdap entry
// of level 1 to 5; else corroborated for two sources of different families
// whose first sightings are surely within 48 h (a day value is every instant of
// its day); else single.
function designB(sources: readonly Seen[], ev: readonly Evidence[], window: Window): ConfidenceLevel {
  // The first and the last instant a value stands for.
  const instants = (bit: number, value: number): [number, number] => (table.precision(bit) === "day" ? [value * DAY, (value + 1) * DAY - 1] : [value, value]);
  for (const e of ev) {
    if (e.basis === 0) return "registered-confirmed";
    const [a, b] = instants(e.source, e.at);
    if (e.basis === 1 && a < window.t1 && b >= window.t0) return "registered-confirmed";
    if (e.basis === 3 && e.confidence >= 1 && e.confidence <= 5) return "registered-confirmed";
  }
  for (const x of sources) {
    for (const y of sources) {
      if (table.family(x.bit) === table.family(y.bit)) continue;
      const [x0, x1] = instants(x.bit, x.first);
      const [y0, y1] = instants(y.bit, y.first);
      if (Math.max(x1, y1) - Math.min(x0, y0) <= 48 * HOUR) return "corroborated";
    }
  }
  return "single";
}

test("confidence: on random records, the level and the class of the stored fields equal design B section 4 computed from the raw inputs", () => {
  const next = rng(22);
  const bits = [BIT.thc, BIT.oiNrd, BIT.oiConfirmed, BIT.isc, BIT.whoisds, BIT.oiZone, BIT.rdap];
  const levels = new Map<string, number>();
  let cases = 0;
  let levelOne = 0;
  for (let n = 0; n < 2000; n += 1) {
    const chosen = bits.filter(() => next() < 0.35);
    if (chosen.length === 0) continue;
    cases += 1;
    const sources = chosen.map((bit) => (table.precision(bit) === "day" ? seen(bit, D - 2 + Math.floor(next() * 4)) : seen(bit, (D - 2) * DAY + Math.floor(next() * 4 * DAY))));
    const ev = sources
      .filter((s) => s.bit === BIT.oiConfirmed || s.bit === BIT.oiZone || s.bit === BIT.rdap)
      .map((s) => (s.bit === BIT.oiConfirmed ? evidence(3, s.bit, s.first, Math.floor(next() * 11)) : evidence(s.bit === BIT.oiZone ? 0 : 1, s.bit, s.first)))
      .sort((a, b) => a.tier - b.tier || a.basis - b.basis || a.source - b.source);
    if (ev.some((e) => e.basis === 3 && e.confidence === 1)) levelOne += 1;
    const window = dayWindow(D);
    const want = designB(sources, ev, window);
    const c = confidenceOf(sources, ev, { table, window });
    assert.equal(c.level, want, `case ${n}: confidenceOf`);
    // The fields the builder stores, read back as a reader reads a stored row.
    assert.equal(classOf({ basis: c.basis, confidence: c.oiLevel, feedFlags: c.feedFlags }), want, `case ${n}: classOf of the stored fields`);
    levels.set(want, (levels.get(want) ?? 0) + 1);
  }
  // The draws that chose no source are skipped: about 5% of them.
  assert.ok(cases > 1800, `${cases} cases`);
  assert.deepEqual([...levels.keys()].sort(), ["corroborated", "registered-confirmed", "single"], "the cases reach every class");
  assert.ok(levelOne > 0, "the cases hold an nrd-ct+rdap entry of level 1");
});
