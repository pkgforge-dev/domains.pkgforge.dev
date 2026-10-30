// The hour pack of the feed (packages/compact/src/hour.ts, DOM-023): which
// segments of the hour it reads, the filter and its delta it asks, and the
// provisional rows it writes. Real packs of synthetic records
// (daily-helpers.ts); each refusal is planted alone.
//
//   node scripts/test.mjs packages/compact --name "hour:"
import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactType, segTag } from "@domains/ghcr";
import { BloomFilter, HashDelta, hashKey, LedgerError } from "@domains/ledger";
import { FEED_CODEC, FEED_PROVISIONAL, MemorySink, PackReader, partsSource } from "@domains/pack";
import { nodeCompress } from "@domains/pack/node";
import { TIER_ANNOTATION } from "@domains/root";
import { CompactError } from "../src/index.ts";
import { buildHour, hourOf, membershipOf, planHour, type SegmentInput } from "../src/hour.ts";
import { collect, domain, name, REGISTRY, secs, segment, tierPack } from "./daily-helpers.ts";

const H = "2026-10-27T05";
const at = (mmss: string): string => `${H}:${mmss}Z`;
const input = (s: { tag: string; digest: string; json: SegmentInput["json"]; idx: Uint8Array }): SegmentInput => ({ tag: s.tag, digest: s.digest, json: s.json, idx: s.idx });
const refused = (fn: () => unknown, code: string, message: RegExp): void => {
  assert.throws(fn, (e: unknown) => e instanceof CompactError && e.code === code && message.test(e.message));
};

// The segments of 05:00 to 06:00 on 2026-10-27: two oi-nrd windows that
// cover the hour, and three the pack leaves.
async function hourSegments() {
  const t = (mmss: string) => secs(at(mmss));
  const a = await segment("oi-nrd", at("00:00"), at("30:00"), [domain("com.alpha-synthetic", "oi-nrd", t("01:10")), domain("com.beta-synthetic", "oi-nrd", t("12:00"))]);
  const b = await segment("oi-nrd", at("30:00"), "2026-10-27T06:00:00Z", [domain("com.beta-synthetic", "oi-nrd", t("31:00")), domain("net.gamma-synthetic", "oi-nrd", t("59:59"))]);
  const names = await segment("ct-le", at("00:00"), "2026-10-27T06:00:00Z", [name("com.alpha-synthetic.www", "ct-le", t("02:00"))], { dataset: "names" });
  const day = await segment("isc-new", at("00:00"), "2026-10-27T06:00:00Z", [domain("com.isc-synthetic", "isc-new", 299)]);
  const quarantined = await segment("oi-nrd-confirmed", at("00:00"), "2026-10-27T06:00:00Z", [domain("com.q-synthetic", "oi-nrd-confirmed", t("05:00"))], { quarantine: true });
  return { a, b, names, day, quarantined };
}

test("hour: hourOf gives the span, its seconds since 2026-01-01 and the tag; a text that is not an hour is refused", () => {
  const h = hourOf("2026102705");
  assert.deepEqual(h, { start: "2026-10-27T05:00:00Z", end: "2026-10-27T06:00:00Z", t0: 299 * 86_400 + 5 * 3600, t1: 299 * 86_400 + 6 * 3600, tag: "feed-h-2026102705" });
  assert.equal(hourOf("2026123123").end, "2027-01-01T00:00:00Z");
  for (const bad of ["2026102724", "20261027", "2026022905", "2025123123", "x026102705"]) refused(() => hourOf(bad), "usage", /YYYYMMDDHH|before 2026-01-01/);
});

test("hour: the plan reads the domains segments of second sources, and names each segment it leaves and why", async () => {
  const s = await hourSegments();
  const plan = planHour([s.names, s.b, s.day, s.a, s.quarantined].map(input), hourOf("2026102705"), REGISTRY);
  assert.equal(plan.verdict, "ready", plan.reason);
  assert.deepEqual(
    plan.inputs.map((p) => p.tag),
    [s.a.tag, s.b.tag],
  );
  assert.deepEqual(plan.sources, ["oi-nrd"]);
  assert.equal(plan.records, 4);
  assert.deepEqual(
    plan.skipped.map((k) => [k.tag, k.why.split(":")[0]]),
    [
      [s.names.tag, "a names segment"],
      [s.day.tag, "the source isc-new is of day precision"],
      [s.quarantined.tag, "quarantined"],
    ],
  );
  assert.match(plan.skipped[2].why, /ruling 23/);
  // No segment to read: skip, and no pack.
  const none = planHour([s.names, s.day].map(input), hourOf("2026102705"), REGISTRY);
  assert.equal(none.verdict, "skip");
  assert.match(none.reason, /no pack is written/);
});

test("hour: a source whose segments leave a hole in the hour waits, and names the hole", async () => {
  const s = await hourSegments();
  const plan = planHour([input(s.a)], hourOf("2026102705"), REGISTRY);
  assert.equal(plan.verdict, "wait");
  assert.deepEqual(plan.missing, [{ source: "oi-nrd", start: at("30:00"), end: "2026-10-27T06:00:00Z" }]);
  const late = await segment("oi-nrd", at("10:00"), at("30:00"), [domain("com.delta-synthetic", "oi-nrd", secs(at("11:00")))]);
  const front = planHour([input(late), input(s.b)], hourOf("2026102705"), REGISTRY);
  assert.deepEqual(front.missing, [{ source: "oi-nrd", start: at("00:00"), end: at("10:00") }]);
});

test("hour: a segment across the hour's edge, one outside it, two of one source that overlap, an idx not its manifest's, a precision the registry does not give, or a segment given twice is refused", async () => {
  const s = await hourSegments();
  const h = hourOf("2026102705");
  const across = await segment("oi-nrd", "2026-10-27T04:50:00Z", at("10:00"), [domain("com.x-synthetic", "oi-nrd", secs(at("01:00")))]);
  refused(() => planHour([input(across)], h, REGISTRY), "straddle", /crosses an edge of the hour/);
  const outside = await segment("oi-nrd", "2026-10-27T06:00:00Z", "2026-10-27T06:10:00Z", [domain("com.x-synthetic", "oi-nrd", secs("2026-10-27T06:01:00Z"))]);
  refused(() => planHour([input(s.a), input(s.b), input(outside)], h, REGISTRY), "plan", /lies outside the hour/);
  const overlap = await segment("oi-nrd", at("20:00"), at("40:00"), [domain("com.x-synthetic", "oi-nrd", secs(at("21:00")))]);
  refused(() => planHour([input(s.a), input(overlap), input(s.b)], h, REGISTRY), "plan", /of the source oi-nrd overlap/);
  refused(() => planHour([{ ...input(s.a), idx: s.b.idx }], h, REGISTRY), "plan", /its manifest names/);
  const stated = await segment("oi-nrd", at("00:00"), "2026-10-27T06:00:00Z", [domain("com.x-synthetic", "oi-nrd", secs(at("01:00")))], { precision: "day" });
  refused(() => planHour([input(stated)], h, REGISTRY), "plan", /says precision "day"; the registry gives oi-nrd the precision second/);
  refused(() => planHour([input(s.a), input(s.a)], h, REGISTRY), "plan", /given twice/);
});

test("hour: a segment across the hour's end, or wholly before the hour, is refused, each with its own code", async () => {
  const h = hourOf("2026102705");
  // A lane window that starts inside the hour and ends after it.
  const late = await segment("oi-nrd", at("50:00"), "2026-10-27T06:10:00Z", [domain("com.x-synthetic", "oi-nrd", secs(at("55:00")))]);
  refused(() => planHour([input(late)], h, REGISTRY), "straddle", /\(2026-10-27T05:50:00Z to 2026-10-27T06:10:00Z\) crosses an edge of the hour/);
  const before = await segment("oi-nrd", "2026-10-27T04:00:00Z", "2026-10-27T04:30:00Z", [domain("com.x-synthetic", "oi-nrd", secs("2026-10-27T04:01:00Z"))]);
  refused(() => planHour([input(before)], h, REGISTRY), "plan", /\(2026-10-27T04:00:00Z to 2026-10-27T04:30:00Z\) lies outside the hour/);
});

test("hour: each source the pack reads must cover the hour: a hole in the second source in sorted order waits", async () => {
  const s = await hourSegments();
  const ct = await segment("ct-le", at("00:00"), "2026-10-27T06:00:00Z", [domain("com.ct-synthetic", "ct-le", secs(at("03:00")))]);
  // ct-le covers the hour; oi-nrd, sorted after it, gives 05:00 to 05:30 alone.
  const plan = planHour([input(ct), input(s.a)], hourOf("2026102705"), REGISTRY);
  assert.equal(plan.verdict, "wait", plan.reason);
  assert.deepEqual(plan.sources, ["ct-le", "oi-nrd"]);
  assert.deepEqual(plan.missing, [{ source: "oi-nrd", start: at("30:00"), end: "2026-10-27T06:00:00Z" }]);
  // Both whole: ready, two sources.
  const whole = planHour([input(ct), input(s.a), input(s.b)], hourOf("2026102705"), REGISTRY);
  assert.equal(whole.verdict, "ready", whole.reason);
  assert.equal(whole.records, 5);
});

test("hour: an idx of the manifest's size and other bytes, a manifest the promotion refuses, or a segment of two sources is refused (plan)", async () => {
  const s = await hourSegments();
  const h = hourOf("2026102705");
  // The same size, one byte changed: only the digest tells it apart.
  const other = new Uint8Array(s.a.idx);
  other[other.length - 1] ^= 0xff;
  refused(() => planHour([{ ...input(s.a), idx: other }], h, REGISTRY), "plan", new RegExp(`is ${other.length} B hashing to sha256:[0-9a-f]{64}; its manifest names ${other.length} B, `));
  // packFromManifest of @domains/root refuses a count its index does not hold: a RootError, held as plan.
  const count = { ...s.a.json, annotations: { ...s.a.json.annotations, "dev.pkgforge.domains.count": "999" } };
  refused(() => planHour([{ ...input(s.a), json: count }], h, REGISTRY), "plan", /the index holds 2 records, and the annotation dev\.pkgforge\.domains\.count says 999/);
  // A segment that names two sources, ct-le first in sorted order.
  const { "dev.pkgforge.domains.precision": _, ...noPrecision } = s.a.json.annotations;
  const two = { ...s.a.json, annotations: { ...noPrecision, "dev.pkgforge.domains.source": "oi-nrd,ct-le" } };
  refused(() => planHour([{ ...input(s.a), json: two }], h, REGISTRY), "plan", /names the sources ct-le, oi-nrd; a segment is of one source/);
});

// A segment of the dataset feed, which the promotion reads as it reads any
// segment: the feed pack of one oi-nrd row (tierPack), its manifest made a
// segment's (artifact type segment, tier seg) and its time copy's layers left
// out, since no segment carries one.
test("hour: a segment of a dataset other than names and domains is refused (plan), though its source is of second precision", async () => {
  const s = await hourSegments();
  const h = hourOf("2026102705");
  const row = { key: "com.feed-synthetic", flags: 0, firstSeen: secs(at("10:00")), sources: [1], basis: 4, confidence: 0, feedFlags: FEED_PROVISIONAL };
  const feed = await tierPack("feed", "h", `${H}:00:00Z`, [row], { sources: ["oi-nrd"] });
  const json = {
    ...feed.json,
    artifactType: artifactType("segment"),
    layers: feed.json.layers.filter((l) => !l.annotations["org.opencontainers.image.title"].startsWith("time.")),
    annotations: { ...feed.json.annotations, [TIER_ANNOTATION]: "seg" },
  };
  const seg: SegmentInput = { tag: segTag("oi-nrd", at("00:00"), "2026-10-27T06:00:00Z"), digest: feed.digest, json, idx: feed.idx };
  refused(() => planHour([seg], h, REGISTRY), "plan", new RegExp(`^the segment ${seg.tag.replaceAll(".", "\\.")} is of the dataset feed; the hour reads names and domains segments$`));
  // Beside segments the hour reads, alike: no pack takes the feed segment's rows as domain records.
  refused(() => planHour([input(s.a), input(s.b), seg], h, REGISTRY), "plan", /is of the dataset feed; the hour reads names and domains segments/);
});

// A filter of `keys` as of `asOf`, and an empty delta paired with it.
function ledger(keys: readonly string[], asOf: number): { filter: Uint8Array; delta: Uint8Array } {
  const f = BloomFilter.forKeys(Math.max(1, keys.length), { asOf });
  for (const k of keys) f.add(hashKey(k));
  return { filter: f.encode(), delta: HashDelta.empty(f).encode() };
}

test("hour: the membership refuses a filter newer than the hour's start and a delta of another filter, and takes a filter as of the hour's start", () => {
  const h = hourOf("2026102705");
  const ok = ledger(["com.old-synthetic"], h.t0);
  assert.equal(membershipOf(ok.filter, ok.delta, h).has(hashKey("com.old-synthetic")), true);
  const newer = ledger([], h.t0 + 1);
  refused(() => membershipOf(newer.filter, newer.delta, h), "plan", /after the hour starts at 2026-10-27T05:00:00Z: it holds the hour's own domains/);
  const other = ledger(["com.other-synthetic"], h.t0);
  assert.throws(
    () => membershipOf(ok.filter, other.delta, h),
    (e: unknown) => e instanceof LedgerError && e.code === "pair",
  );
});

test("hour: the pack holds the domains neither the filter nor the delta held, provisional, in key order; the delta gains them, so the hour built again holds none", async () => {
  const s = await hourSegments();
  const h = hourOf("2026102705");
  // The filter holds com.alpha-synthetic: an earlier day saw it.
  const l = ledger(["com.alpha-synthetic"], secs("2026-10-27T00:00:00Z"));
  const membership = membershipOf(l.filter, l.delta, h);
  const sink = new MemorySink();
  const timeSink = new MemorySink();
  const built = await buildHour([s.a.reader, s.b.reader], membership, { registry: REGISTRY, hour: h, compress: nodeCompress, sink, time: { sink: timeSink } });
  assert.deepEqual([built.domains, built.rows, built.deltaBefore, built.deltaAfter], [3, 2, 0, 2]);
  const rows = await collect((await PackReader.open(built.summary.idx, partsSource(sink.parts()), FEED_CODEC)).scan());
  assert.deepEqual(
    rows.map((r) => [r.key, r.firstSeen - h.t0, r.feedFlags]),
    [
      // Two windows saw com.beta-synthetic: the earlier sighting is its first_seen.
      ["com.beta-synthetic", 12 * 60, FEED_PROVISIONAL],
      ["net.gamma-synthetic", 59 * 60 + 59, FEED_PROVISIONAL],
    ],
  );
  assert.equal(built.time?.records, 2);
  assert.equal(membership.delta.has(hashKey("net.gamma-synthetic")), true);
  // The next delta, decoded with its filter, holds the hour's domains.
  const next = membershipOf(l.filter, membership.delta.encode(), h);
  const again = await buildHour([s.a.reader, s.b.reader], next, { registry: REGISTRY, hour: h, compress: nodeCompress, sink: new MemorySink() });
  assert.deepEqual([again.rows, again.deltaBefore, again.deltaAfter, again.time], [0, 2, 2, null]);
  // A reader of another dataset is refused.
  await assert.rejects(
    buildHour([s.names.reader], membership, { registry: REGISTRY, hour: h, compress: nodeCompress, sink: new MemorySink() }),
    (e: unknown) => e instanceof CompactError && e.code === "usage",
  );
});
