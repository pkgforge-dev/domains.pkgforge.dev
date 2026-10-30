// The exact feed of a day and the ledger's daily rebuild
// (packages/compact/src/daily.ts, DOM-023): the join with `since`, the carry
// of the hour packs' suspect verdicts, summary.json and its manifest layer,
// and the filter and the rebased delta. Real packs of synthetic records
// (daily-helpers.ts); each refusal is planted alone.
//
//   node scripts/test.mjs packages/compact --name "daily:"
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BloomFilter, HashDelta, hashKey, LedgerError } from "@domains/ledger";
import {
  FEED_CODEC,
  FEED_PROVISIONAL,
  FEED_SUSPECT,
  FEED_SUSPECT_CERT,
  FEED_TIME_CODEC,
  type FeedRecord,
  MemorySink,
  mergePacks,
  PackReader,
  parseHead,
  partsSource,
  timeBindFault,
} from "@domains/pack";
import { nodeCompress } from "@domains/pack/node";
import { pack } from "../../root/test/helpers.ts";
import { CompactError } from "../src/index.ts";
import { basePacks, buildDay, checkLedger, dayOf, joinInputs, rebuildLedger, SUMMARY_FORMAT, SummaryCounter } from "../src/daily.ts";
import { collect, DAY, dayNo, domain, entryOf, HOUR, name, REGISTRY, secs, segment, tierPack } from "./daily-helpers.ts";

const D = "2026-10-27";
const T = (hhmmss: string): number => secs(`${D}T${hhmmss}Z`);
const refused = (fn: () => unknown, code: string, message: RegExp): void => {
  assert.throws(fn, (e: unknown) => e instanceof CompactError && e.code === code && message.test(e.message));
};
const sourceIds = (r: FeedRecord): string[] => r.sources.map((b) => (REGISTRY.find((x) => x.bit === b) as { id: string }).id);

test("daily: dayOf gives the span, its seconds since 2026-01-01 and the three tags; a text that is not a day is refused", () => {
  const d = dayOf(D);
  assert.deepEqual(d, {
    date: D,
    start: "2026-10-27T00:00:00Z",
    end: "2026-10-28T00:00:00Z",
    t0: 299 * DAY,
    t1: 300 * DAY,
    domainsTag: "domains-d-20261027",
    feedTag: "feed-d-20261027",
    filterTag: "ledger-filter-20261027",
  });
  for (const bad of ["2026-10-32", "2026-02-29", "20261027", "2025-12-31", "2026-1-27"]) refused(() => dayOf(bad), "usage", /YYYY-MM-DD|before 2026-01-01/);
});

test("daily: basePacks are the live domains packs that end by the day's start; a pack across the start is refused", () => {
  const live = (packs: ReturnType<typeof pack>[]) => ({ datasets: { domains: packs.map((p) => p.pack) } });
  const early = pack("domains", "d", "2026-10-26T00:00:00Z");
  const seg = pack("domains", "seg", "2026-10-26T23:50:00Z", { sources: ["oi-nrd"], end: "2026-10-27T00:00:00Z" });
  const today = pack("domains", "seg", "2026-10-27T00:00:00Z", { sources: ["oi-nrd"] });
  const later = pack("domains", "seg", "2026-10-28T00:00:00Z", { sources: ["oi-nrd"] });
  assert.deepEqual(
    basePacks(live([early, seg, today, later]), dayOf(D)).map((p) => p.tag),
    [early.pack.tag, seg.pack.tag],
  );
  const across = pack("domains", "seg", "2026-10-26T23:55:00Z", { sources: ["oi-nrd"], end: "2026-10-27T00:05:00Z" });
  refused(() => basePacks(live([early, across]), dayOf(D)), "straddle", /crosses the start of the day 2026-10-27T00:00:00Z/);
});

test("daily: joinInputs leaves out the inputs the root marks quarantined, and their sources (ruling 23)", () => {
  const a = pack("domains", "seg", "2026-10-27T00:00:00Z", { sources: ["thc-ct"], end: "2026-10-28T00:00:00Z" }).pack;
  const b = { ...pack("domains", "seg", "2026-10-27T05:00:00Z", { sources: ["oi-nrd"] }).pack, quarantine: 1 };
  const c = pack("domains", "seg", "2026-10-27T06:00:00Z", { sources: ["isc-new"] }).pack;
  assert.deepEqual(joinInputs([a, b], ["A", "B"]), { readers: ["A"], left: [b], sources: ["thc-ct"] });
  // The sources of the inputs read, sorted; oi-nrd's one input is quarantined.
  assert.deepEqual(joinInputs([b, c, a], ["B", "C", "A"]), { readers: ["C", "A"], left: [b], sources: ["isc-new", "thc-ct"] });
  assert.deepEqual(joinInputs([a], ["A"]), { readers: ["A"], left: [], sources: ["thc-ct"] });
  refused(() => joinInputs([a, b], ["A"]), "usage", /2 pack entries and 1 readers/);
});

// The day 2026-10-27: an earlier day pack, THC's day segment, two oi-nrd
// windows and an ISC day segment, and two hour packs of the feed.
async function dayFixture() {
  const base = await tierPack("domains", "d", "2026-10-26T00:00:00Z", [domain("com.old-synthetic", "thc-ct", dayNo("2026-10-26"))], { sources: ["thc-ct"] });
  const thc = await segment("thc-ct", "2026-10-27T00:00:00Z", "2026-10-28T00:00:00Z", [
    domain("com.old-synthetic", "thc-ct", 299),
    domain("com.thc-synthetic", "thc-ct", 299),
    domain("np.com.nepal-synthetic", "thc-ct", 299),
  ]);
  const oi5 = await segment("oi-nrd", "2026-10-27T05:00:00Z", "2026-10-27T06:00:00Z", [domain("com.fresh-synthetic", "oi-nrd", T("05:10:00")), domain("net.cert-synthetic", "oi-nrd", T("05:20:00"))]);
  const oi6 = await segment("oi-nrd", "2026-10-27T06:00:00Z", "2026-10-27T07:00:00Z", [domain("np.com.nepal-synthetic", "oi-nrd", T("06:30:00"))]);
  // ISC dates com.early-synthetic to day 290: its own source saw it before the day.
  const isc = await segment("isc-new", "2026-10-27T00:00:00Z", "2026-10-28T00:00:00Z", [domain("com.early-synthetic", "isc-new", 290), domain("com.isc-synthetic", "isc-new", 299)]);
  const hour5 = await tierPack(
    "feed",
    "h",
    "2026-10-27T05:00:00Z",
    [
      { key: "com.fresh-synthetic", flags: 0, firstSeen: T("05:10:00"), sources: [1], basis: 4, confidence: 0, feedFlags: FEED_PROVISIONAL },
      { key: "net.cert-synthetic", flags: 0, firstSeen: T("05:20:00"), sources: [1], basis: 4, confidence: 0, feedFlags: FEED_PROVISIONAL | FEED_SUSPECT | FEED_SUSPECT_CERT },
    ],
    { sources: ["oi-nrd"] },
  );
  const hour6 = await tierPack(
    "feed",
    "h",
    "2026-10-27T06:00:00Z",
    [{ key: "com.old-synthetic", flags: 0, firstSeen: T("06:01:00"), sources: [1], basis: 4, confidence: 0, feedFlags: FEED_PROVISIONAL }],
    { sources: ["oi-nrd"] },
  );
  return { base, thc, oi5, oi6, isc, hour5, hour6 };
}

test("daily: the day pack holds the domains the exact join keeps with since: not one an earlier pack holds, nor one its own source dates before the day; the hour packs' suspect verdicts are carried", async () => {
  const f = await dayFixture();
  const day = dayOf(D);
  const dayInputs = [f.thc.reader, f.oi5.reader, f.oi6.reader, f.isc.reader];
  const sink = new MemorySink();
  const timeSink = new MemorySink();
  const built = await buildDay({
    day,
    records: () => mergePacks(dayInputs, (f.thc.reader as PackReader<never>).codec),
    base: [f.base.reader as never],
    carry: mergePacks([f.hour5.reader, f.hour6.reader] as PackReader<FeedRecord>[], FEED_CODEC),
    registry: REGISTRY,
    compress: nodeCompress,
    sink,
    time: { sink: timeSink },
  });
  const rows = await collect((await PackReader.open(built.summary.idx, partsSource(sink.parts()), FEED_CODEC)).scan());
  assert.deepEqual(
    rows.map((r) => [r.key, r.firstSeen - day.t0, sourceIds(r), r.feedFlags]),
    [
      ["com.fresh-synthetic", 5 * HOUR + 600, ["oi-nrd"], 0],
      ["com.isc-synthetic", 0, ["isc-new"], 0],
      ["com.thc-synthetic", 0, ["thc-ct"], 0],
      ["net.cert-synthetic", 5 * HOUR + 1200, ["oi-nrd"], FEED_SUSPECT | FEED_SUSPECT_CERT],
      ["np.com.nepal-synthetic", 0, ["thc-ct", "oi-nrd"], 0],
    ],
  );
  // com.old-synthetic: the earlier pack holds it; com.early-synthetic: ISC dates it to day 290.
  assert.deepEqual(built.exact, { day: 7, new: 5, early: 1, blocksRead: built.exact.blocksRead });
  // The hour row of com.old-synthetic was provisional, and the join retracts it.
  assert.deepEqual(built.carry, { hourRows: 3, matched: 2, carried: 1, retracted: 1 });
  assert.equal(built.rows, 5);
  // The time copy binds to the key copy, inside the day.
  assert.equal(
    timeBindFault(parseHead(built.summary.idx, built.summary.idx.length), parseHead((built.time as { idx: Uint8Array }).idx, (built.time as { idx: Uint8Array }).idx.length), {
      t0: day.t0,
      t1: day.t1,
    }),
    null,
  );
  const time = await collect((await PackReader.open((built.time as { idx: Uint8Array }).idx, partsSource(timeSink.parts()), FEED_TIME_CODEC)).scan());
  assert.deepEqual(
    time.map((r) => r.key),
    ["com.isc-synthetic", "com.thc-synthetic", "np.com.nepal-synthetic", "com.fresh-synthetic", "net.cert-synthetic"],
  );
  // summary.json: the rows a suffix, the suspect ones, and a source.
  assert.deepEqual(built.daySummary, {
    format: SUMMARY_FORMAT,
    day: D,
    rows: 5,
    suffixes: {
      com: { new_registrable: 3, suspect: 0, by_source: { "isc-new": 1, "oi-nrd": 1, "thc-ct": 1 } },
      "com.np": { new_registrable: 1, suspect: 0, by_source: { "oi-nrd": 1, "thc-ct": 1 } },
      net: { new_registrable: 1, suspect: 1, by_source: { "oi-nrd": 1 } },
    },
  });
  assert.equal(new TextDecoder().decode(built.summaryBytes), `${JSON.stringify(built.daySummary)}\n`);
});

test("daily: buildDay refuses an earlier pack that is not of the dataset domains before it reads a record", async () => {
  const f = await dayFixture();
  const names = await segment("ct-le", "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z", [name("com.old-synthetic.www", "ct-le", T("00:00:00") - DAY)], { dataset: "names" });
  let scans = 0;
  await assert.rejects(
    buildDay({
      day: dayOf(D),
      records: () => {
        scans += 1;
        return f.thc.reader.scan();
      },
      base: [f.base.reader as never, names.reader as never],
      registry: REGISTRY,
      compress: nodeCompress,
      sink: new MemorySink(),
      time: { sink: new MemorySink() },
    }),
    (e: unknown) => e instanceof CompactError && e.code === "usage" && /earlier pack 1 is dataset 1, not 2 \(domains\)/.test(e.message),
  );
  assert.equal(scans, 0);
});

test("daily: summary.json counts a row once a suffix and once a source it carries, in key order, whatever the order of the rows", () => {
  const ids = (bit: number) => ({ 1: "oi-nrd", 8: "isc-new" })[bit] as string;
  const row = (key: string, sources: number[], feedFlags = 0): FeedRecord => ({ key, flags: 0, firstSeen: 299 * DAY, sources, basis: 4, confidence: 0, feedFlags });
  const rows = [row("uk.co.b-synthetic", [8]), row("com.a-synthetic", [1, 8], FEED_SUSPECT | FEED_SUSPECT_CERT), row("uk.co.a-synthetic", [1])];
  const a = new SummaryCounter(dayOf(D), ids);
  for (const r of rows) a.add(r);
  const b = new SummaryCounter(dayOf(D), ids);
  for (const r of [...rows].reverse()) b.add(r);
  assert.deepEqual(a.toJSON().suffixes, {
    com: { new_registrable: 1, suspect: 1, by_source: { "isc-new": 1, "oi-nrd": 1 } },
    "co.uk": { new_registrable: 2, suspect: 0, by_source: { "isc-new": 1, "oi-nrd": 1 } },
  });
  assert.deepEqual(a.bytes(), b.bytes());
  assert.deepEqual(Object.keys(a.toJSON()), ["format", "day", "rows", "suffixes"]);
  // A key of one label has no suffix: it is not a registrable domain.
  refused(() => new SummaryCounter(dayOf(D), ids).add(row("com", [1])), "usage", /not a registrable domain/);
});

test("daily: packManifest puts summary.json after the pack's layers, in the digest, and the promotion reads the manifest back; a title of the pack's own layers or a second summary.json is refused", async () => {
  const start = `${D}T00:00:00Z`;
  const rows: FeedRecord[] = [{ key: "com.fresh-synthetic", flags: 0, firstSeen: T("05:10:00"), sources: [1], basis: 4, confidence: 0, feedFlags: 0 }];
  const bytes = new TextEncoder().encode('{"format":"domains.feed-summary.v1"}\n');
  const summary = { title: "summary.json", mediaType: "application/json", bytes };
  const plain = await tierPack("feed", "d", start, rows, { sources: ["oi-nrd"] });
  const built = await tierPack("feed", "d", start, rows, { sources: ["oi-nrd"], extra: [summary] });
  assert.deepEqual(built.json.layers.slice(0, -1), plain.json.layers);
  assert.deepEqual(built.json.layers.at(-1), {
    mediaType: "application/json",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.length,
    annotations: { "org.opencontainers.image.title": "summary.json" },
  });
  assert.notEqual(built.digest, plain.digest);
  assert.equal(built.digest, `sha256:${createHash("sha256").update(built.text).digest("hex")}`);
  assert.equal(built.text, JSON.stringify(built.json));
  const read = entryOf(built);
  assert.equal(read.pack.manifest, built.digest);
  assert.deepEqual(read.pack, { ...entryOf(plain).pack, manifest: built.digest });
  const rejected = (extra: { title: string; mediaType: string; bytes: Uint8Array }[], message: RegExp) =>
    assert.rejects(tierPack("feed", "d", start, rows, { sources: ["oi-nrd"], extra }), (e: unknown) => e instanceof CompactError && e.code === "usage" && message.test(e.message));
  await rejected([summary, summary], /holds a layer summary.json already/);
  for (const title of ["idx", "part.000", "time.idx", "time.part.001", "Summary.json", ""]) await rejected([{ ...summary, title }], /not the title of an extra layer/);
});

// A filter of `keys` as of `asOf`, and a delta paired with it of `delta`.
function ledgerOf(keys: readonly string[], asOf: number, delta: readonly string[] = []) {
  const f = BloomFilter.forKeys(Math.max(1, keys.length), { asOf });
  for (const k of keys) f.add(hashKey(k));
  const d = HashDelta.empty(f);
  for (const k of delta) d.add(hashKey(k));
  return { filter: f.encode(), delta: d.encode() };
}

test("daily: checkLedger holds the live delta to its filter, takes a filter older than the day's end, calls one of the day's end present, and refuses a newer one", () => {
  const day = dayOf(D);
  assert.deepEqual(checkLedger(null, day), { action: "write", live: null });
  const live = ledgerOf(["com.old-synthetic"], day.t0, ["com.fresh-synthetic"]);
  const ok = checkLedger(live, day);
  assert.equal(ok.action, "write");
  assert.equal(ok.live?.delta.size, 1);
  assert.throws(
    () => checkLedger({ filter: live.filter, delta: ledgerOf(["com.other-synthetic"], day.t0).delta }, day),
    (e: unknown) => e instanceof LedgerError && e.code === "pair",
  );
  assert.equal(checkLedger(ledgerOf([], day.t1), day).action, "present");
  refused(() => checkLedger(ledgerOf([], day.t1 + HOUR), day), "plan", /does not move the filter back/);
});

test("daily: rebuildLedger builds the filter through the day's end and rebases the delta: it keeps the domains first seen after the day and drops those the new table holds", async () => {
  const f = await dayFixture();
  const day = dayOf(D);
  const domainsDay = await tierPack("domains", "d", day.start, await collect(mergePacks([f.thc.reader, f.oi5.reader, f.oi6.reader, f.isc.reader], (f.thc.reader as PackReader<never>).codec)), {
    sources: ["isc-new", "oi-nrd", "thc-ct"],
  });
  // The live delta holds a domain of the day, which the new table holds,
  // and one an hour job saw after midnight, which it does not.
  const live = ledgerOf(["com.old-synthetic"], day.t0, ["com.fresh-synthetic", "org.after-midnight-synthetic"]);
  const check = checkLedger(live, day);
  const next = await rebuildLedger([f.base.reader as never, domainsDay.reader as never], day, check);
  const filter = BloomFilter.decode(next.filter);
  const delta = HashDelta.decode(next.delta);
  assert.equal(filter.asOf, day.t1);
  // The distinct domains of the two packs: com.old-synthetic is in both.
  assert.equal(next.keys, 7);
  for (const k of ["com.old-synthetic", "com.thc-synthetic", "com.fresh-synthetic", "com.early-synthetic", "np.com.nepal-synthetic"]) assert.equal(filter.has(hashKey(k)), true, k);
  assert.deepEqual([next.before, next.kept, delta.size], [2, 1, 1]);
  assert.equal(delta.has(hashKey("org.after-midnight-synthetic")), true);
  assert.equal(delta.has(hashKey("com.fresh-synthetic")), false);
  assert.deepEqual([delta.filterAsOf, delta.filterCrc], [filter.asOf, filter.crc]);
  // The first build starts with an empty delta.
  const first = await rebuildLedger([f.base.reader as never], day, checkLedger(null, day));
  assert.equal(HashDelta.decode(first.delta).size, 0);
  await assert.rejects(rebuildLedger([f.base.reader as never], day, checkLedger(ledgerOf([], day.t1), day)), (e: unknown) => e instanceof CompactError && e.code === "usage");
});
