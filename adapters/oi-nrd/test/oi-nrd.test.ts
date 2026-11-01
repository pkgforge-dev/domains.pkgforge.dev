// adapters/oi-nrd over the fake broker of test/broker.ts (real magic-2 batches
// on 127.0.0.1), in process, with liveConnect: a real socket, as the DOM-004
// and DOM-005 tests read the fake broker (design 7.2). Each test names the
// messages it plants and the window rule, the cap, the cursor or the fault it
// holds; every result is held to checkResult and to source.json's sources.
// The contract over the recorded broker runs in the sandbox (recorded.test.ts).
//
//   node scripts/test.mjs adapters/oi-nrd --name "oi-nrd:"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  type AdapterContext,
  type Cursor,
  canonicalJson,
  checkResult,
  checkSources,
  type Fetch,
  memoryWriter,
  type RunResult,
  type SocketAddress,
  validateSourceFile,
  type Written,
} from "@domains/adapter";
import { LIVE_CONNECT_LIMITS, type LiveConnectLimits, liveConnect, readBits } from "@domains/adapter/node";
import { confidenceOf, sourceTable } from "@domains/feed";
import { loadPsl } from "@domains/names";
import { BASIS } from "@domains/pack";
import { closedPort, type FakeBroker } from "../../../scripts/measure/fixtures/kafka/broker.mjs";
import { buildBatch } from "../../../scripts/measure/fixtures/kafka/build.mjs";
import { crc32c } from "../../../scripts/measure/kafka-protocol.mjs";
import { CLOCK_SLACK_S, LIMITS, type Limits, MAX_IDLE_FETCHES, MISMATCH_S, makeRun, TOPICS } from "../src/index.ts";
import { EPOCH_2026_S } from "../src/window.ts";
import { at, BASE, type BrokerOptions, CONFIRMED, confirmed, confirmedZone, DOMAIN, days, FQDN, fqdn, type Message, nrd, nrdZone, raw, withBroker } from "./broker.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PSL = await loadPsl(readFileSync(join(ROOT, "packages", "names", "test", "fixtures", "psl-2026-10-27.dat")));
const SOURCES = validateSourceFile(JSON.parse(readFileSync(join(import.meta.dirname, "..", "source.json"), "utf8")), readBits(ROOT)).sources;
const UA = "domains.pkgforge.dev oi-nrd test (synthetic)";
const NOW = "2026-10-31T06:00:00Z";

// The adapter reads no HTTP: a call is a defect of the test's subject.
const noFetch: Fetch = async (input) => {
  throw new Error(`oi-nrd fetched ${String(input)}; it reads Kafka alone`);
};

interface Read {
  readonly result: RunResult;
  readonly written: readonly Written[];
}

interface RunOptions {
  readonly cursor?: Cursor;
  readonly now?: string;
  readonly limits?: Partial<Limits>;
  readonly connect?: Partial<LiveConnectLimits>;
  // Wraps the connect a run is given (a close that fails, say).
  readonly wrap?: (connect: AdapterContext["connect"]) => AdapterContext["connect"];
}

// One run against the broker at `address`, held to the contract.
async function runAt(address: SocketAddress, o: RunOptions = {}): Promise<Read> {
  const writer = memoryWriter();
  const live = liveConnect({ ...LIVE_CONNECT_LIMITS, idleMs: 5_000, ...o.connect });
  const ctx: AdapterContext = Object.freeze({ fetch: noFetch, connect: o.wrap?.(live) ?? live, psl: PSL, now: o.now ?? NOW, userAgent: UA, writer });
  const result = checkResult(await makeRun({ ...LIMITS, ...o.limits }, address)(o.cursor ?? null, ctx), "oi-nrd test");
  checkSources(result.segments, SOURCES, "oi-nrd test");
  assert.deepEqual(
    result.segments,
    writer.written.map((w) => w.segment),
    "the segments returned are the segments written",
  );
  return { result, written: writer.written };
}

// One run against a broker of `messages`.
const read = (messages: readonly Message[], o: RunOptions & { readonly broker?: BrokerOptions } = {}): Promise<Read> => withBroker(messages, o.broker ?? {}, (address) => runAt(address, o));

// A time as a record stores it: whole seconds since 2026-01-01T00:00:00Z.
const t26 = (ms: number): number => Math.floor(ms / 1000) - EPOCH_2026_S;
// "HH:MM:SS" of an ISO time of 2026-10-31.
const hms = (iso: string): string => iso.slice(11, 19);
const ofSource = (r: Read, source: string): Written[] => r.written.filter((w) => w.segment.source === source);
// Each window of `source` as [start, end, records].
const windows = (r: Read, source: string): [string, string, number][] => ofSource(r, source).map((w) => [hms(w.segment.window.start), hms(w.segment.window.end), w.segment.count]);
const faults = (r: Read): [string, string][] => r.result.errors.map((e) => [e.source, e.code]);
const cursorOf = (offsets: Readonly<Record<string, number>>, through: Readonly<Record<string, string>>): Cursor => ({
  through: { ...through },
  topics: Object.fromEntries(Object.entries(offsets).map(([t, o]) => [t, { "0": o }])),
});
const iso = (time: string): string => `2026-10-31T${time}Z`;
const slice = (topic: string, offset: number, start: string): Cursor => ({ through: { [topic]: start }, topics: { [topic]: { "0": offset } } });

test("oi-nrd: TOPICS names each source of source.json with its bit and its dataset, in bit order", () => {
  assert.deepEqual(
    TOPICS.map((t) => [t.source, t.bit, [t.dataset]]),
    SOURCES.map((s) => [s.id, s.bit, s.datasets]),
  );
  assert.deepEqual(
    TOPICS.map((t) => t.topic),
    SOURCES.map((s) => s.urls[0]!.slice(s.urls[0]!.lastIndexOf("/") + 1)),
  );
  // Only oi-nrd writes facts.json: its domains reach the feed with their certificate ages.
  assert.deepEqual(
    TOPICS.filter((t) => t.facts).map((t) => t.source),
    ["oi-nrd"],
  );
  assert.equal(LIMITS.maxMessagesPerRun, 300_000);
  assert.equal(LIMITS.maxSegmentMessages, 200_000);
  assert.equal(LIMITS.maxWindowsPerRun, 12);
  assert.equal(CLOCK_SLACK_S, 300);
  assert.equal(MISMATCH_S, 3600);
});

test("oi-nrd: an old-certificate event writes its age, over 7 days, into facts.json", async () => {
  const r = await read([nrd(at("05:41:00"), "old.com", days(30)), nrd(at("05:42:00"), "new.com", 12.5), nrd(at("05:50:01"), "next.com")]);
  assert.deepEqual(windows(r, "oi-nrd"), [["05:41:00", "05:50:00", 2]]);
  const [w] = ofSource(r, "oi-nrd");
  assert.deepEqual(w!.facts, [
    { key: "com.new", cert_age: 12 },
    { key: "com.old", cert_age: 30 * 86_400 + 3 },
  ]);
  assert.ok(w!.segment.facts !== undefined, "Segment.facts names the rows");
  assert.equal(r.result.stats["oi-nrd.cert_age_known"], 3);
  assert.equal(r.result.stats["oi-nrd.cert_age_over_7d"], 1);
  assert.deepEqual(r.result.errors, []);
});

test("oi-nrd: a fresh event of the same domain in the window lowers the age to its own", async () => {
  const r = await read([nrd(at("05:41:00"), "x.com", days(40)), nrd(at("05:43:00"), "www.x.com", 4.75), nrd(at("05:50:00"), "y.com")]);
  const [w] = ofSource(r, "oi-nrd");
  assert.deepEqual(w!.records, [
    { key: "com.x", flags: 0, sources: [{ bit: 1, first: t26(at("05:41:00")), last: t26(at("05:43:00")) }], evidence: [{ tier: 2, basis: 2, source: 1, at: t26(at("05:41:00")), confidence: 0 }] },
  ]);
  assert.deepEqual(w!.facts, [{ key: "com.x", cert_age: 4 }]);
  // www.x.com is keyed by its registrable domain.
  assert.equal(r.result.stats["oi-nrd.reg_differs"], 1);
});

test("oi-nrd: a zone row of the confirmed topic writes T2 nrd-list with its confidence and no age, and a row with a certificate writes nrd-ct+rdap", async () => {
  const r = await read([
    confirmedZone(at("05:41:00"), "zone.top", 9),
    confirmed(at("05:42:00"), "cert.com", 3),
    confirmedZone(at("05:43:00"), "both.net", 10),
    confirmed(at("05:44:00"), "both.net", 2),
    confirmed(at("05:50:30"), "later.com", 5),
  ]);
  const [w] = ofSource(r, "oi-nrd-confirmed");
  assert.equal(w!.segment.dataset, "domains");
  assert.deepEqual(w!.records, [
    { key: "com.cert", flags: 0, sources: [{ bit: 3, first: t26(at("05:42:00")), last: t26(at("05:42:00")) }], evidence: [{ tier: 2, basis: 3, source: 3, at: t26(at("05:42:00")), confidence: 3 }] },
    {
      key: "net.both",
      flags: 0,
      sources: [{ bit: 3, first: t26(at("05:43:00")), last: t26(at("05:44:00")) }],
      evidence: [
        { tier: 2, basis: 2, source: 3, at: t26(at("05:43:00")), confidence: 10 },
        { tier: 2, basis: 3, source: 3, at: t26(at("05:44:00")), confidence: 2 },
      ],
    },
    { key: "top.zone", flags: 0, sources: [{ bit: 3, first: t26(at("05:41:00")), last: t26(at("05:41:00")) }], evidence: [{ tier: 2, basis: 2, source: 3, at: t26(at("05:41:00")), confidence: 9 }] },
  ]);
  // The topic has no submission_timestamp: no age, and no facts layer.
  assert.equal(w!.facts, null);
  assert.equal(w!.segment.facts, undefined);
  assert.equal(r.result.stats["oi-nrd-confirmed.zone_rows"], 2);
  assert.equal(r.result.stats["oi-nrd-confirmed.cert_age_known"], 0);
});

test("oi-nrd: a zone row of newly_registered_domain writes T2 nrd-list and no age", async () => {
  const r = await read([nrdZone(at("05:41:00"), "zone.ch"), nrdZone(at("05:41:00"), "zone.ch"), nrd(at("05:51:00"), "next.com")]);
  const [w] = ofSource(r, "oi-nrd");
  assert.deepEqual(w!.records, [
    { key: "ch.zone", flags: 0, sources: [{ bit: 1, first: t26(at("05:41:00")), last: t26(at("05:41:00")) }], evidence: [{ tier: 2, basis: 2, source: 1, at: t26(at("05:41:00")), confidence: 0 }] },
  ]);
  assert.equal(w!.facts, null, "a window whose keys have no known age writes no facts");
  assert.equal(r.result.stats["oi-nrd.zone_rows"], 2);
});

test("oi-nrd: the strongest confidence of a key's events in a window is kept", async () => {
  const r = await read([confirmed(at("05:41:00"), "c.com", 7), confirmed(at("05:42:00"), "c.com", 2), confirmed(at("05:43:00"), "c.com", 5), confirmed(at("05:52:00"), "d.com", 1)]);
  const [w] = ofSource(r, "oi-nrd-confirmed");
  assert.deepEqual(w!.records, [
    { key: "com.c", flags: 0, sources: [{ bit: 3, first: t26(at("05:41:00")), last: t26(at("05:43:00")) }], evidence: [{ tier: 2, basis: 3, source: 3, at: t26(at("05:41:00")), confidence: 2 }] },
  ]);
});

test("oi-nrd: a key's flags are the OR of its events' flags, exact 1 and wildcard 2", async () => {
  const r = await read([
    fqdn(at("05:41:00"), "*.w.x.com"),
    fqdn(at("05:42:00"), "w.x.com"),
    fqdn(at("05:43:00"), "only.x.com"),
    fqdn(at("05:44:00"), "*.wild.x.com"),
    fqdn(at("05:52:00"), "next.x.com"),
  ]);
  const [w] = ofSource(r, "oi-nrd-fqdn");
  assert.equal(w!.segment.dataset, "names");
  assert.deepEqual(
    w!.records.map((x) => [x.key, x.flags]),
    [
      ["com.x.only", 1],
      ["com.x.w", 3],
      ["com.x.wild", 2],
    ],
  );
  assert.deepEqual(w!.records[1], { key: "com.x.w", flags: 3, sources: [{ bit: 2, first: t26(at("05:41:00")), last: t26(at("05:42:00")) }] });
  // Names segments carry no facts: names reach no feed.
  assert.equal(w!.facts, null);
});

test("oi-nrd: windows are 10 minutes near now, one window for an hour that ended an hour before now, and the first window starts at the earliest message's second", async () => {
  const r = await read([nrd(at("03:10:05"), "a.com"), nrd(at("03:50:00"), "b.com"), nrd(at("05:21:30"), "c.com"), nrd(at("05:35:00"), "d.com")]);
  assert.deepEqual(windows(r, "oi-nrd"), [
    ["03:10:05", "04:00:00", 2],
    ["04:00:00", "05:00:00", 0],
    ["05:00:00", "05:10:00", 0],
    ["05:10:00", "05:20:00", 0],
    ["05:20:00", "05:30:00", 1],
  ]);
  assert.deepEqual(r.result.cursor, cursorOf({ [CONFIRMED]: BASE[CONFIRMED]!, [DOMAIN]: BASE[DOMAIN]! + 3, [FQDN]: BASE[FQDN]! }, { [DOMAIN]: iso("05:30:00") }));
  assert.equal(r.result.stats["oi-nrd.windows"], 5);
  assert.equal(r.result.stats["oi-nrd.empty_windows"], 3);
  assert.equal(r.result.stats["oi-nrd.behind_s"], 30 * 60);
  assert.equal(r.result.stats["oi-nrd.lag"], 1);
});

test("oi-nrd: a window with no message between two messages is written as an empty segment", async () => {
  const r = await read([nrd(at("05:21:00"), "a.com"), nrd(at("05:45:00"), "b.com")]);
  assert.deepEqual(windows(r, "oi-nrd"), [
    ["05:21:00", "05:30:00", 1],
    ["05:30:00", "05:40:00", 0],
  ]);
  const empty = ofSource(r, "oi-nrd")[1]!;
  // No raw bytes, so no raw lane member; the offsets prove the topic was quiet.
  assert.equal(empty.raw, null);
  assert.equal(empty.rawMember, null);
  assert.equal(empty.segment.raw, undefined);
  assert.deepEqual(empty.segment.cursorBefore, slice(DOMAIN, BASE[DOMAIN]! + 1, iso("05:30:00")));
  assert.deepEqual(empty.segment.cursorAfter, slice(DOMAIN, BASE[DOMAIN]! + 1, iso("05:40:00")));
});

test("oi-nrd: a record timestamp before its window joins the open window at its start and counts late", async () => {
  const cursor = cursorOf({ [DOMAIN]: BASE[DOMAIN]! }, { [DOMAIN]: iso("05:40:00") });
  const r = await read([nrd(at("05:39:55"), "late.com"), nrd(at("05:45:00"), "b.com"), nrd(at("05:52:00"), "c.com")], { cursor });
  const [w] = ofSource(r, "oi-nrd");
  assert.deepEqual([hms(w!.segment.window.start), hms(w!.segment.window.end)], ["05:40:00", "05:50:00"]);
  assert.deepEqual(w!.records[1]!.sources, [{ bit: 1, first: t26(at("05:40:00")), last: t26(at("05:40:00")) }]);
  assert.equal(r.result.stats["oi-nrd.late"], 1);
  assert.deepEqual(w!.segment.cursorBefore, slice(DOMAIN, BASE[DOMAIN]!, iso("05:40:00")));
});

test("oi-nrd: a window of maxSegmentMessages closes at the first following second above every second it holds; a late record, or one of a second it holds, joins it", async () => {
  const s = (sec: number): number => at("05:41:00") + sec * 1000;
  const r = await read(
    [
      nrd(s(1), "a1.com"),
      nrd(s(2), "a2.com"),
      nrd(s(3), "a3.com"),
      nrd(s(4), "a4.com"),
      nrd(s(5), "a5.com"),
      // The window holds 5: one of its second joins, and so does one of an earlier second.
      nrd(s(5), "a6.com"),
      nrd(s(4), "a7.com"),
      // The first second above every second it holds closes it, and starts the next window.
      nrd(s(6), "b1.com"),
      // Before the new window's start: late, at the start.
      nrd(s(5), "b2.com"),
      nrd(s(7), "b3.com"),
      nrd(at("05:52:00"), "c.com"),
    ],
    { limits: { maxSegmentMessages: 5 } },
  );
  assert.deepEqual(windows(r, "oi-nrd"), [
    ["05:41:01", "05:41:06", 7],
    ["05:41:06", "05:50:00", 3],
  ]);
  const [one, two] = ofSource(r, "oi-nrd");
  assert.deepEqual(one!.segment.cursorAfter, slice(DOMAIN, BASE[DOMAIN]! + 7, iso("05:41:06")));
  assert.deepEqual(two!.segment.cursorBefore, one!.segment.cursorAfter);
  assert.deepEqual(two!.records.find((x) => x.key === "com.b2")!.sources, [{ bit: 1, first: t26(s(6)), last: t26(s(6)) }]);
  assert.equal(r.result.stats["oi-nrd.late"], 1);
});

test("oi-nrd: the run stops after maxWindowsPerRun windows a topic, and the next run starts at the record that closed the last", async () => {
  const messages = ["05:01:00", "05:11:00", "05:21:00", "05:31:00", "05:41:00", "05:51:00"].map((t, i) => nrd(at(t), `m${i}.com`));
  await withBroker(messages, {}, async (address) => {
    const limits = { maxWindowsPerRun: 3 };
    const one = await runAt(address, { limits });
    assert.deepEqual(windows(one, "oi-nrd"), [
      ["05:01:00", "05:10:00", 1],
      ["05:10:00", "05:20:00", 1],
      ["05:20:00", "05:30:00", 1],
    ]);
    const after = cursorOf({ [CONFIRMED]: BASE[CONFIRMED]!, [DOMAIN]: BASE[DOMAIN]! + 3, [FQDN]: BASE[FQDN]! }, { [DOMAIN]: iso("05:30:00") });
    assert.deepEqual(one.result.cursor, after);
    assert.deepEqual(ofSource(one, "oi-nrd").at(-1)!.segment.cursorAfter, slice(DOMAIN, BASE[DOMAIN]! + 3, iso("05:30:00")));
    const two = await runAt(address, { limits, cursor: one.result.cursor });
    assert.deepEqual(windows(two, "oi-nrd"), [
      ["05:30:00", "05:40:00", 1],
      ["05:40:00", "05:50:00", 1],
    ]);
    assert.deepEqual(two.result.cursor, cursorOf({ [CONFIRMED]: BASE[CONFIRMED]!, [DOMAIN]: BASE[DOMAIN]! + 5, [FQDN]: BASE[FQDN]! }, { [DOMAIN]: iso("05:50:00") }));
  });
});

test("oi-nrd: the run stops at maxMessagesPerRun on a window edge", async () => {
  const six = (from: string, p: string): Message[] => Array.from({ length: 6 }, (_, i) => nrd(at(from) + i * 1000, `${p}${i}.com`));
  const r = await read([...six("05:10:05", "a"), ...six("05:20:05", "b"), ...six("05:30:05", "c"), nrd(at("05:40:30"), "d.com")], { limits: { maxMessagesPerRun: 10 } });
  // 6 messages, then 12: the second close reaches the cap, and the record that closed it is the next run's.
  assert.deepEqual(windows(r, "oi-nrd"), [
    ["05:10:05", "05:20:00", 6],
    ["05:20:00", "05:30:00", 6],
  ]);
  assert.deepEqual((r.result.cursor as { topics: Record<string, unknown> }).topics[DOMAIN], { "0": BASE[DOMAIN]! + 12 });
  assert.equal(r.result.stats["oi-nrd.messages"], 12);
});

test("oi-nrd: a first run with no cursor starts at the earliest retained offset", async () => {
  const base = { [DOMAIN]: 170_127_254, [FQDN]: 179_754_818, [CONFIRMED]: 79_233_962 };
  const r = await read(
    [
      nrd(at("05:41:07"), "a.com"),
      fqdn(at("05:42:09"), "www.a.com"),
      confirmed(at("05:43:11"), "a.com", 4),
      nrd(at("05:51:00"), "b.com"),
      fqdn(at("05:51:00"), "www.b.com"),
      confirmed(at("05:51:00"), "b.com", 4),
    ],
    {
      broker: { base },
    },
  );
  assert.deepEqual(
    r.written.map((w) => [w.segment.source, w.segment.cursorBefore]),
    [
      ["oi-nrd", slice(DOMAIN, base[DOMAIN], iso("05:41:07"))],
      ["oi-nrd-fqdn", slice(FQDN, base[FQDN], iso("05:42:09"))],
      ["oi-nrd-confirmed", slice(CONFIRMED, base[CONFIRMED], iso("05:43:11"))],
    ],
  );
  assert.equal(r.result.stats["oi-nrd.retained"], 2);
});

test("oi-nrd: a cursor below the earliest offset is the fault retention-gap, and the read resumes at the earliest", async () => {
  const cursor = cursorOf({ [DOMAIN]: BASE[DOMAIN]! - 10 }, { [DOMAIN]: iso("05:20:00") });
  const r = await read([nrd(at("05:41:00"), "a.com"), nrd(at("05:51:00"), "b.com")], { cursor });
  assert.deepEqual(faults(r), [["oi-nrd", "retention-gap"]]);
  const detail = r.result.errors[0]!.detail;
  assert.match(detail, new RegExp(`the 10 message\\(s\\) from ${BASE[DOMAIN]! - 10} to ${BASE[DOMAIN]! - 1}, after through 2026-10-31T05:20:00Z, are deleted`));
  assert.match(detail, new RegExp(`the first record read is at offset ${BASE[DOMAIN]}, time 2026-10-31T05:41:00Z`));
  // A fresh window at the first record read.
  assert.deepEqual(windows(r, "oi-nrd"), [["05:41:00", "05:50:00", 1]]);
  assert.deepEqual(ofSource(r, "oi-nrd")[0]!.segment.cursorBefore, slice(DOMAIN, BASE[DOMAIN]!, iso("05:41:00")));
});

test("oi-nrd: a cursor above the latest offset is the fault offset-ahead, and the read relocates to the first offset at or after through, keeping it", async () => {
  const messages = [nrd(at("05:35:00"), "old.com"), nrd(at("05:41:00"), "a.com"), nrd(at("05:45:00"), "b.com"), nrd(at("05:52:00"), "c.com")];
  await withBroker(messages, {}, async (address) => {
    const r = await runAt(address, { cursor: cursorOf({ [DOMAIN]: BASE[DOMAIN]! + 1000 }, { [DOMAIN]: iso("05:40:00") }) });
    assert.deepEqual(faults(r), [["oi-nrd", "offset-ahead"]]);
    assert.match(r.result.errors[0]!.detail, new RegExp(`the read relocates to ${BASE[DOMAIN]! + 1}, the first offset at or after through 2026-10-31T05:40:00Z`));
    assert.deepEqual(windows(r, "oi-nrd"), [["05:40:00", "05:50:00", 2]]);
    assert.deepEqual(ofSource(r, "oi-nrd")[0]!.segment.cursorBefore, slice(DOMAIN, BASE[DOMAIN]! + 1, iso("05:40:00")));
    // No record at or after through: the topic reads nothing, and its cursor is { latest, through }.
    const none = await runAt(address, { cursor: cursorOf({ [DOMAIN]: BASE[DOMAIN]! + 1000 }, { [DOMAIN]: iso("05:55:00") }) });
    assert.deepEqual(faults(none), [["oi-nrd", "offset-ahead"]]);
    assert.match(none.result.errors[0]!.detail, /no record is at or after through 2026-10-31T05:55:00Z, so the topic reads nothing this run/);
    assert.deepEqual(none.written, []);
    assert.deepEqual((none.result.cursor as { topics: Record<string, unknown>; through: Record<string, string> }).topics[DOMAIN], { "0": BASE[DOMAIN]! + 4 });
    assert.equal((none.result.cursor as { through: Record<string, string> }).through[DOMAIN], iso("05:55:00"));
  });
});

test("oi-nrd: a first record more than an hour before the cursor's through is the fault cursor-mismatch, and the read relocates the same way", async () => {
  // A topic recreated under the cursor: its offsets now hold older records.
  const messages = [nrd(at("03:00:00"), "x.com"), nrd(at("03:10:00"), "y.com"), nrd(at("05:41:00"), "a.com"), nrd(at("05:52:00"), "b.com")];
  const r = await read(messages, { cursor: cursorOf({ [DOMAIN]: BASE[DOMAIN]! + 1 }, { [DOMAIN]: iso("05:40:00") }) });
  assert.deepEqual(faults(r), [["oi-nrd", "cursor-mismatch"]]);
  assert.match(
    r.result.errors[0]!.detail,
    new RegExp(`at offset ${BASE[DOMAIN]! + 1}, has the time 2026-10-31T03:10:00Z, more than 3600 s before through 2026-10-31T05:40:00Z.+relocates to ${BASE[DOMAIN]! + 2}`),
  );
  assert.deepEqual(windows(r, "oi-nrd"), [["05:40:00", "05:50:00", 1]]);
  assert.deepEqual(ofSource(r, "oi-nrd")[0]!.segment.cursorBefore, slice(DOMAIN, BASE[DOMAIN]! + 2, iso("05:40:00")));
  // A quiet stream puts the next record far after through, which is no mismatch.
  const quiet = await read([nrd(at("05:41:00"), "a.com"), nrd(at("05:58:00"), "b.com")], { cursor: cursorOf({ [DOMAIN]: BASE[DOMAIN]! }, { [DOMAIN]: iso("04:30:00") }) });
  assert.deepEqual(faults(quiet), []);
});

test("oi-nrd: a topic of two partitions is the fault partitions, and the other topics are read", async () => {
  const cursor = cursorOf({ [CONFIRMED]: BASE[CONFIRMED]! }, { [CONFIRMED]: iso("05:30:00") });
  const r = await read([nrd(at("05:41:00"), "a.com"), nrd(at("05:51:00"), "b.com"), confirmed(at("05:41:00"), "a.com", 1), confirmed(at("05:51:00"), "b.com", 1)], {
    cursor,
    broker: { partitions: { [CONFIRMED]: 2 } },
  });
  assert.deepEqual(faults(r), [["oi-nrd-confirmed", "partitions"]]);
  assert.match(r.result.errors[0]!.detail, /confirmed_newly_registered_domain has 2 partition\(s\) \(0, 1\)/);
  assert.deepEqual(windows(r, "oi-nrd"), [["05:41:00", "05:50:00", 1]]);
  assert.deepEqual(ofSource(r, "oi-nrd-confirmed"), []);
  // Its cursor is kept as given.
  assert.deepEqual((r.result.cursor as { topics: Record<string, unknown> }).topics[CONFIRMED], { "0": BASE[CONFIRMED]! });
  assert.equal((r.result.cursor as { through: Record<string, string> }).through[CONFIRMED], iso("05:30:00"));
});

test("oi-nrd: a message that is not JSON, or has no name, counts malformed and makes one fault, and the window is written", async () => {
  const r = await read([
    raw(DOMAIN, at("05:41:00"), "{not json"),
    raw(DOMAIN, at("05:42:00"), JSON.stringify({ domain: 5 })),
    raw(DOMAIN, at("05:43:00"), null),
    nrd(at("05:44:00"), "ok.com"),
    nrd(at("05:52:00"), "next.com"),
    raw(CONFIRMED, at("05:41:00"), JSON.stringify({ domain: "c.com.", confidence: 11, ct_name: "Log", cert_index: 1, timestamp: 1 })),
    confirmed(at("05:52:00"), "d.com", 1),
  ]);
  assert.deepEqual(faults(r), [
    ["oi-nrd", "malformed"],
    ["oi-nrd-confirmed", "malformed"],
  ]);
  assert.match(r.result.errors[0]!.detail, new RegExp(`^3 message\\(s\\) are not JSON or hold no name, the first at offset ${BASE[DOMAIN]}, a value that is not UTF-8 JSON`));
  const [w] = ofSource(r, "oi-nrd");
  assert.deepEqual(
    w!.records.map((x) => x.key),
    ["com.ok"],
  );
  // The raw lane keeps every batch of the window, the malformed ones among them.
  assert.equal(w!.rawMember!.batches, 4);
  assert.equal(r.result.stats["oi-nrd.malformed"], 3);
  assert.deepEqual(windows(r, "oi-nrd-confirmed"), [["05:41:00", "05:50:00", 0]]);
});

test("oi-nrd: a name that normalise refuses counts by refusal and writes nothing", async () => {
  const r = await read([nrd(at("05:41:00"), "co.uk"), nrd(at("05:42:00"), "localhost"), nrd(at("05:43:00"), "fine.com"), nrd(at("05:52:00"), "next.com")]);
  assert.deepEqual(
    ofSource(r, "oi-nrd")[0]!.records.map((x) => x.key),
    ["com.fine"],
  );
  assert.equal(r.result.stats["oi-nrd.refused"], 2);
  assert.equal(r.result.stats["oi-nrd.refused.public-suffix"], 1);
  assert.equal(r.result.stats["oi-nrd.refused.no-dot"], 1);
  assert.deepEqual(r.result.errors, []);
});

test("oi-nrd: a corrupt batch is the fault decode, and the topic stops before it", async () => {
  const b = BASE[DOMAIN]!;
  const r = await read(
    [
      nrd(at("05:31:00"), "a.com"),
      nrd(at("05:41:00"), "b.com"),
      nrd(at("05:42:00"), "c.com"),
      nrd(at("05:43:00"), "bad.com"),
      nrd(at("05:52:00"), "d.com"),
      fqdn(at("05:41:00"), "www.a.com"),
      fqdn(at("05:51:00"), "www.b.com"),
    ],
    { broker: { corrupt: { [DOMAIN]: [b + 3] } } },
  );
  assert.deepEqual(faults(r), [["oi-nrd", "decode"]]);
  assert.match(r.result.errors[0]!.detail, new RegExp(`^the batch at offset ${b + 3}: crc: CRC-32C`));
  assert.deepEqual(windows(r, "oi-nrd"), [["05:31:00", "05:40:00", 1]]);
  assert.deepEqual(windows(r, "oi-nrd-fqdn"), [["05:41:00", "05:50:00", 1]]);
  // The open window's first offset and start: the next run reads the batch again.
  assert.deepEqual((r.result.cursor as { topics: Record<string, unknown> }).topics[DOMAIN], { "0": b + 1 });
  assert.equal((r.result.cursor as { through: Record<string, string> }).through[DOMAIN], iso("05:40:00"));
});

test("oi-nrd: a partition error code in a Fetch answer is the fault fetch-error, that topic stops, and the others are read", { timeout: 60_000 }, async () => {
  const r = await read([nrd(at("05:41:00"), "a.com"), nrd(at("05:51:00"), "b.com"), fqdn(at("05:41:00"), "www.a.com"), fqdn(at("05:51:00"), "www.b.com")], {
    broker: { faults: { fetchError: { topic: FQDN, partition: 0, code: 6 } } },
  });
  assert.deepEqual(faults(r), [["oi-nrd-fqdn", "fetch-error"]]);
  assert.match(r.result.errors[0]!.detail, /the broker answered NOT_LEADER_OR_FOLLOWER \(6\) for offset/);
  assert.deepEqual(windows(r, "oi-nrd"), [["05:41:00", "05:50:00", 1]]);
  assert.deepEqual(ofSource(r, "oi-nrd-fqdn"), []);
  assert.deepEqual((r.result.cursor as { topics: Record<string, unknown> }).topics[FQDN], { "0": BASE[FQDN]! });
});

test("oi-nrd: a broker that answers no Fetch: the fault read, the topics keep their cursors", { timeout: 60_000 }, async () => {
  const cursor = cursorOf({ [CONFIRMED]: BASE[CONFIRMED]!, [DOMAIN]: BASE[DOMAIN]!, [FQDN]: BASE[FQDN]! }, { [CONFIRMED]: iso("05:40:00"), [DOMAIN]: iso("05:40:00"), [FQDN]: iso("05:40:00") });
  const r = await read([nrd(at("05:41:00"), "a.com"), fqdn(at("05:41:00"), "www.a.com"), confirmed(at("05:41:00"), "a.com", 3)], {
    cursor,
    broker: { faults: { silentApi: 1 } },
    connect: { idleMs: 300 },
  });
  assert.deepEqual(faults(r), [
    ["oi-nrd", "read"],
    ["oi-nrd-fqdn", "read"],
    ["oi-nrd-confirmed", "read"],
  ]);
  assert.match(r.result.errors[0]!.detail, /idle/);
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.result.cursor, cursor);
});

test("oi-nrd: a socket that dies mid-run is the fault read; the windows it closed are written, and the cursor is its open window's", async () => {
  // A message a minute, about 210 bytes a batch: 60 of them pass the cap of
  // 6,000 bytes, and the first 21 close two windows below it.
  const messages = Array.from({ length: 60 }, (_, i) => nrd(at("05:00:30") + i * 60_000, `m${i}.com`));
  const r = await read(messages, { now: "2026-10-31T06:10:00Z", limits: { fetchPartitionBytes: 400 }, connect: { maxBytes: 6_000 } });
  assert.deepEqual(faults(r), [["oi-nrd", "read"]]);
  assert.match(r.result.errors[0]!.detail, /bytes: .+past the cap of 6000/);
  const written = ofSource(r, "oi-nrd");
  assert.ok(written.length >= 2 && written.length < 6, `${written.length} window(s) closed before the socket died`);
  assert.deepEqual(slice(DOMAIN, ...pick(r.result.cursor, DOMAIN)), written.at(-1)!.segment.cursorAfter);
});

// A topic's [offset, through] of a run cursor.
function pick(cursor: Cursor, topic: string): [number, string] {
  const c = cursor as { topics: Record<string, { "0": number }>; through: Record<string, string> };
  return [c.topics[topic]!["0"], c.through[topic]!];
}

test("oi-nrd: each segment's cursors are its topic's slice: window k's cursorAfter is window k+1's cursorBefore, and the last one's is the run's cursor of the topic", async () => {
  const r = await read([
    nrd(at("05:01:00"), "a.com"),
    nrd(at("05:25:00"), "b.com"),
    nrd(at("05:33:00"), "c.com"),
    nrd(at("05:44:00"), "d.com"),
    fqdn(at("05:15:00"), "www.a.com"),
    fqdn(at("05:35:00"), "www.b.com"),
    fqdn(at("05:47:00"), "www.c.com"),
  ]);
  for (const t of TOPICS.slice(0, 2)) {
    const segs = ofSource(r, t.source).map((w) => w.segment);
    assert.ok(segs.length >= 3, t.source);
    for (let k = 0; k + 1 < segs.length; k++) assert.deepEqual(segs[k]!.cursorAfter, segs[k + 1]!.cursorBefore, `${t.source} window ${k}`);
    assert.deepEqual(segs.at(-1)!.cursorAfter, slice(t.topic, ...pick(r.result.cursor, t.topic)), t.source);
    for (const s of segs) assert.deepEqual(Object.keys((s.cursorBefore as { topics: object }).topics), [t.topic], "a slice names its own topic alone");
  }
  assert.deepEqual(windows(r, "oi-nrd"), [
    ["05:01:00", "05:10:00", 1],
    ["05:10:00", "05:20:00", 0],
    ["05:20:00", "05:30:00", 1],
    ["05:30:00", "05:40:00", 1],
  ]);
});

test("oi-nrd: a record time after now plus the slack is the fault clock, and the topic stops before that record", async () => {
  const future = await read([nrd(at("05:31:00"), "a.com"), nrd(at("05:41:00"), "b.com"), nrd(at("06:05:01"), "future.com"), nrd(at("05:42:00"), "c.com")]);
  assert.deepEqual(faults(future), [["oi-nrd", "clock"]]);
  assert.match(future.result.errors[0]!.detail, /has the time 2026-10-31T06:05:01\.000Z, later than the run's time 2026-10-31T06:00:00Z plus 300 s; the topic stops before it/);
  // The window that holds b.com is not closed by the record past the slack.
  assert.deepEqual(windows(future, "oi-nrd"), [["05:31:00", "05:40:00", 1]]);
  assert.deepEqual(pick(future.result.cursor, DOMAIN), [BASE[DOMAIN]! + 1, iso("05:40:00")]);
  // At the slack itself the record is read.
  const edge = await read([nrd(at("05:41:00"), "b.com"), nrd(at("06:05:00"), "edge.com")]);
  assert.deepEqual(faults(edge), []);
});

// A value stamped 2025 by a producer whose clock failed, of the domain `name`.
const ancient = (ms: number, name: string): Message => raw(DOMAIN, ms, JSON.stringify({ domain: `${name}.`, timestamp: 1 }));

test("oi-nrd: a record time before 2026 is the fault clock-low and stops nothing: it joins the open window at its start, counted late, and the run goes on past it, run after run", async () => {
  const old = Date.UTC(2025, 11, 31, 23, 59, 59);
  const cursor = cursorOf({ [DOMAIN]: BASE[DOMAIN]! }, { [DOMAIN]: iso("05:30:00") });
  const messages = [nrd(at("05:31:00"), "a.com"), ancient(old, "old.com"), ancient(0, "zero.com"), nrd(at("05:41:00"), "b.com"), nrd(at("05:52:00"), "c.com")];
  await withBroker(messages, {}, async (address) => {
    const r = await runAt(address, { cursor });
    assert.deepEqual(faults(r), [["oi-nrd", "clock-low"]]);
    assert.match(
      r.result.errors[0]!.detail,
      new RegExp(`^2 record\\(s\\) are stamped before 2026-01-01T00:00:00Z, which no record stores, the first at offset ${BASE[DOMAIN]! + 1}, time 2025-12-31T23:59:59\\.000Z; each joins`),
    );
    assert.deepEqual(windows(r, "oi-nrd"), [
      ["05:30:00", "05:40:00", 3],
      ["05:40:00", "05:50:00", 1],
    ]);
    const [w] = ofSource(r, "oi-nrd");
    for (const key of ["com.old", "com.zero"]) assert.deepEqual(w!.records.find((x) => x.key === key)!.sources, [{ bit: 1, first: t26(at("05:30:00")), last: t26(at("05:30:00")) }], key);
    assert.equal(w!.rawMember!.batches, 3, "the raw lane keeps their batches");
    assert.equal(r.result.stats["oi-nrd.clock_low"], 2);
    assert.equal(r.result.stats["oi-nrd.late"], 2);
    // The next run starts past them: the stall the review found is gone.
    assert.deepEqual(pick(r.result.cursor, DOMAIN), [BASE[DOMAIN]! + 4, iso("05:50:00")]);
    const next = await runAt(address, { cursor: r.result.cursor });
    assert.deepEqual(faults(next), []);
    assert.equal(next.result.stats["oi-nrd.clock_low"], 0);
    assert.deepEqual(next.result.cursor, r.result.cursor);
  });
});

test("oi-nrd: a fresh topic's records stamped before 2026 wait for its first window, join it at its start, and the cursor stays at the first of them while no window opens", async () => {
  const old = Date.UTC(2025, 6, 1);
  const r = await read([ancient(old, "old.com"), nrd(at("05:41:07"), "a.com"), nrd(at("05:51:00"), "b.com")]);
  assert.deepEqual(faults(r), [["oi-nrd", "clock-low"]]);
  assert.deepEqual(windows(r, "oi-nrd"), [["05:41:07", "05:50:00", 2]]);
  const [w] = ofSource(r, "oi-nrd");
  assert.deepEqual(w!.segment.cursorBefore, slice(DOMAIN, BASE[DOMAIN]!, iso("05:41:07")));
  assert.deepEqual(w!.records.find((x) => x.key === "com.old")!.sources, [{ bit: 1, first: t26(at("05:41:07")), last: t26(at("05:41:07")) }]);
  assert.equal(w!.rawMember!.base_offset, BASE[DOMAIN]!);
  // Only such records up to the latest offset: no window opens, and the cursor stays at the first.
  const only = await read([ancient(old, "old1.com"), ancient(old + 1000, "old2.com")]);
  assert.deepEqual(faults(only), [["oi-nrd", "clock-low"]]);
  assert.deepEqual(only.written, []);
  assert.deepEqual((only.result.cursor as { topics: Record<string, unknown> }).topics[DOMAIN], { "0": BASE[DOMAIN]! });
  assert.equal((only.result.cursor as { through: Record<string, string> }).through[DOMAIN], undefined);
  // More of them than a window holds, with no window open: the fault clock stops the topic before them.
  const many = await read([ancient(old, "m1.com"), ancient(old, "m2.com"), ancient(old, "m3.com"), nrd(at("05:41:00"), "a.com")], { limits: { maxSegmentMessages: 2 } });
  assert.deepEqual(faults(many), [
    ["oi-nrd", "clock"],
    ["oi-nrd", "clock-low"],
  ]);
  assert.match(many.result.errors[0]!.detail, new RegExp(`^the 2 records from offset ${BASE[DOMAIN]} are all stamped before 2026-01-01T00:00:00Z`));
  assert.deepEqual((many.result.cursor as { topics: Record<string, unknown> }).topics[DOMAIN], { "0": BASE[DOMAIN]! });
});

test("oi-nrd: a record at exactly 2026-01-01T00:00:00Z is read, and one a second earlier is clock-low", async () => {
  const epoch = Date.UTC(2026, 0, 1);
  const now = "2026-01-01T01:00:00Z";
  const exact = await read([nrd(epoch, "edge.com"), nrd(epoch + 700_000, "next.com")], { now });
  assert.deepEqual(faults(exact), []);
  assert.deepEqual(
    ofSource(exact, "oi-nrd").map((w) => [w.segment.window.start, w.segment.count]),
    [["2026-01-01T00:00:00Z", 1]],
  );
  const before = await read([nrd(epoch - 1000, "early.com"), nrd(epoch, "edge.com"), nrd(epoch + 700_000, "next.com")], { now });
  assert.deepEqual(faults(before), [["oi-nrd", "clock-low"]]);
  assert.equal(before.result.stats["oi-nrd.clock_low"], 1);
  assert.equal(ofSource(before, "oi-nrd")[0]!.segment.count, 2);
});

test("oi-nrd: a record at or after the latest offset read at the start is left for the next run, so an answer that holds it replays the same", async () => {
  await withBroker([nrd(at("05:31:00"), "a.com"), nrd(at("05:41:00"), "b.com")], {}, async (address, broker: FakeBroker) => {
    // Once both ListOffsets are answered, two records arrive: the first would close b.com's window.
    const part = (broker.topics as Record<string, { batches: { baseOffset: number; lastOffset: number; timestamps: number[]; bytes: Buffer }[]; hwm: number }[]>)[DOMAIN]![0]!;
    const before = part.batches.reduce((n, b) => n + b.bytes.length, 0);
    const handle = broker.handle.bind(broker);
    let listed = 0;
    broker.handle = (req: Buffer) => {
      const out = handle(req);
      if (req.readInt16BE(0) === 2 && ++listed === 2) {
        for (const [i, ms] of [at("05:52:00"), at("05:53:00")].entries()) {
          const baseOffset = part.hwm;
          part.batches.push({
            baseOffset,
            lastOffset: baseOffset,
            timestamps: [ms],
            bytes: buildBatch({ baseOffset, records: [{ timestamp: ms, value: nrd(ms, `late${i}.com`).value }], codec: "none" }),
          });
          part.hwm += 1;
        }
      }
      return out;
    };
    const r = await runAt(address);
    assert.deepEqual(windows(r, "oi-nrd"), [["05:31:00", "05:40:00", 1]]);
    assert.deepEqual(pick(r.result.cursor, DOMAIN), [BASE[DOMAIN]! + 1, iso("05:40:00")]);
    assert.equal(r.result.stats["oi-nrd.lag"], 1, "the lag is to the latest offset read at the start");
    // A batch at or after it is not decoded: its bytes are not read as the topic's.
    assert.equal(r.result.stats["oi-nrd.wire_bytes"], before);
    // The next run reads them.
    const next = await runAt(address, { cursor: r.result.cursor });
    assert.deepEqual(windows(next, "oi-nrd"), [["05:40:00", "05:50:00", 1]]);
  });
});

test("oi-nrd: a batch that holds records on both sides of the latest offset read at the start gives only the records before it", async () => {
  await withBroker([nrd(at("05:31:00"), "a.com"), nrd(at("05:41:00"), "b.com")], {}, async (address, broker: FakeBroker) => {
    // A batch of two records at the end of the log, the latest offset between them.
    const part = (broker.topics as Record<string, { batches: unknown[]; hwm: number }[]>)[DOMAIN]![0]!;
    const baseOffset = part.hwm;
    const records = [at("05:45:00"), at("05:52:00")].map((ms, i) => ({ timestamp: ms, value: nrd(ms, `pair${i}.com`).value }));
    part.batches.push({ baseOffset, lastOffset: baseOffset + 1, timestamps: records.map((x) => x.timestamp), bytes: buildBatch({ baseOffset, records, codec: "none" }) });
    part.hwm += 1;
    const r = await runAt(address);
    // pair1.com, at the latest offset, would close the window that holds b.com and pair0.com.
    assert.deepEqual(windows(r, "oi-nrd"), [["05:31:00", "05:40:00", 1]]);
    assert.deepEqual(pick(r.result.cursor, DOMAIN), [BASE[DOMAIN]! + 1, iso("05:40:00")]);
    assert.equal(r.result.stats["oi-nrd.messages"], 3);
  });
});

test("oi-nrd: a batch whose last offset holds no record is read past, so the topic reaches the latest offset", async () => {
  await withBroker([nrd(at("05:31:00"), "a.com"), nrd(at("05:41:00"), "b.com")], {}, async (address, broker: FakeBroker) => {
    // The last batch spans two offsets and holds one record: the second offset
    // was removed from the log, and the latest offset is past it.
    const part = (broker.topics as Record<string, { batches: { baseOffset: number; lastOffset: number; bytes: Buffer }[]; hwm: number }[]>)[DOMAIN]![0]!;
    const last = part.batches[1]!;
    last.bytes.writeInt32BE(1, 23);
    last.bytes.writeUInt32BE(crc32c(last.bytes, 21), 17);
    last.lastOffset += 1;
    part.hwm += 1;
    const r = await runAt(address);
    assert.deepEqual(faults(r), []);
    assert.equal(r.result.stats.fetches, 1);
    assert.equal(r.result.stats["oi-nrd.lag"], 2);
    assert.deepEqual(windows(r, "oi-nrd"), [["05:31:00", "05:40:00", 1]]);
  });
});

test("oi-nrd: the Kafka client id is ctx.userAgent", async () => {
  await withBroker([nrd(at("05:41:00"), "a.com"), nrd(at("05:51:00"), "b.com")], {}, async (address, broker: FakeBroker) => {
    await runAt(address);
    const requests = broker.requests as { apiKey: number; clientId: string }[];
    assert.deepEqual(
      requests.map((q) => q.apiKey),
      [18, 3, 2, 2, 1],
    );
    assert.ok(
      requests.every((q) => q.clientId === UA),
      JSON.stringify(requests),
    );
  });
});

test("oi-nrd: a 10-minute window of 150,000 messages is written whole", async () => {
  const n = 150_000;
  const messages: Message[] = Array.from({ length: n }, (_, i) => nrd(at("05:40:00") + Math.floor((i * 600) / n) * 1000, `burst${i}.com`));
  messages.push(nrd(at("05:50:00"), "next.com"));
  const r = await read(messages);
  assert.deepEqual(windows(r, "oi-nrd"), [["05:40:00", "05:50:00", n]]);
  assert.equal(ofSource(r, "oi-nrd")[0]!.rawMember!.batches, n);
  assert.deepEqual(r.result.errors, []);
});

test("oi-nrd: an hour of more than 200,000 messages is split at a second once a window holds maxSegmentMessages", async () => {
  const n = 210_000;
  // 100 messages a second from 05:00:00, in an hour that ended more than an hour before now.
  const messages: Message[] = Array.from({ length: n }, (_, i) => nrdZone(at("05:00:00") + Math.floor(i / 100) * 1000, `z${i}.com`));
  messages.push(nrd(at("06:00:00"), "next.com"));
  const r = await read(messages, { now: "2026-10-31T07:30:00Z" });
  assert.deepEqual(windows(r, "oi-nrd"), [
    ["05:00:00", "05:33:20", 200_000],
    ["05:33:20", "06:00:00", 10_000],
  ]);
  assert.equal(r.result.stats["oi-nrd.zone_rows"], n);
  assert.deepEqual(r.result.errors, []);
  assert.ok(canonicalJson(r.result.cursor).length <= 1024);
});

test(`oi-nrd: ${MAX_IDLE_FETCHES} Fetch answers in a row that move a topic nothing are the fault read`, { timeout: 60_000 }, async () => {
  const r = await read([nrd(at("05:41:00"), "a.com"), nrd(at("05:51:00"), "b.com")], { broker: { faults: { emptyFetch: true } } });
  assert.deepEqual(faults(r), [["oi-nrd", "read"]]);
  assert.match(r.result.errors[0]!.detail, new RegExp(`${MAX_IDLE_FETCHES} Fetch answers in a row moved the topic nothing at offset ${BASE[DOMAIN]}`));
  assert.equal(r.result.stats.fetches, MAX_IDLE_FETCHES);
});

test("oi-nrd: makeRun refuses limits that are not whole numbers from 1, and a window that does not divide an hour", () => {
  const at1 = { hostname: "127.0.0.1", port: 1 };
  for (const k of ["windowS", "catchUpAfterS", "maxWindowsPerRun", "maxMessagesPerRun", "maxSegmentMessages", "fetchPartitionBytes", "fetchMaxBytes", "maxWaitMs"] as const)
    for (const v of [0, -1, 1.5, Number.NaN, 2 ** 53]) assert.throws(() => makeRun({ ...LIMITS, [k]: v }, at1), new RegExp(`oi-nrd: the limit ${k} ${v} is not a whole number from 1`), `${k} ${v}`);
  assert.throws(() => makeRun({ ...LIMITS, windowS: 700 }, at1), /does not divide an hour/);
});

test("oi-nrd: a cursor of another shape is a ContractError cursor before any connection", async () => {
  const run = makeRun(LIMITS, { hostname: "127.0.0.1", port: 1 });
  const ctx = { fetch: noFetch, connect: () => assert.fail("no connection is opened"), psl: PSL, now: NOW, userAgent: UA, writer: memoryWriter() } as unknown as AdapterContext;
  const bads: unknown[] = [
    { next: 1 },
    { topics: {}, through: {}, extra: 1 },
    { topics: { other: { "0": 1 } }, through: {} },
    { topics: { [DOMAIN]: { "0": -1 } }, through: {} },
    { topics: { [DOMAIN]: { "1": 5 } }, through: {} },
    { topics: { [DOMAIN]: { "0": 5 } }, through: { [DOMAIN]: "2026-10-31T05:40:00.000Z" } },
    { topics: {}, through: { [DOMAIN]: "2026-10-31T05:40:00Z" } },
    // The review of DOM-026: arrays for the objects, a second partition, a fractional offset, a date the calendar lacks.
    { topics: [], through: {} },
    { topics: {}, through: [] },
    { topics: { [DOMAIN]: { "0": 5, "1": 5 } }, through: {} },
    { topics: { [DOMAIN]: [5] }, through: {} },
    { topics: { [DOMAIN]: { "0": 1.5 } }, through: {} },
    { topics: { [DOMAIN]: { "0": 2 ** 53 } }, through: {} },
    { topics: { [DOMAIN]: { "0": 5 } }, through: { [DOMAIN]: "2026-02-31T00:00:00Z" } },
    { topics: { [DOMAIN]: { "0": 5 } }, through: { [DOMAIN]: 1793416204 } },
  ];
  for (const bad of bads) {
    await assert.rejects(run(bad as Cursor, ctx), (err: Error & { check?: string }) => err.check === "cursor", JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- the review of DOM-026
// Each test below holds a guard that a mutant of the review's guard mutation
// passed: the edge or the input it names was in no test before.

// A topic's log replaced by `batches`, each at its base offset: an offset gap,
// a batch of two records, or a control batch, which makePartition cannot build.
interface PlantedBatch {
  readonly base: number;
  readonly records: readonly Message[];
  readonly control?: boolean;
}
function setLog(broker: FakeBroker, topic: string, batches: readonly PlantedBatch[], hwm?: number): void {
  const part = (broker.topics as Record<string, { batches: unknown[]; earliest: number; hwm: number }[]>)[topic]![0]!;
  part.batches = batches.map((b) => {
    const records = b.records.map((m) => ({ timestamp: m.recordMs, value: m.value === null ? null : typeof m.value === "string" ? m.value : Buffer.from(m.value) }));
    return {
      baseOffset: b.base,
      lastOffset: b.base + records.length - 1,
      timestamps: records.map((r) => r.timestamp),
      bytes: buildBatch({ baseOffset: b.base, records, codec: "none", control: b.control ?? false }),
    };
  });
  part.earliest = batches[0]!.base;
  const last = batches.at(-1)!;
  part.hwm = hwm ?? last.base + last.records.length;
}
// A run against a broker whose DOMAIN log is `batches`.
const readLog = (batches: readonly PlantedBatch[], o: RunOptions = {}, hwm?: number): Promise<Read> =>
  withBroker([], {}, (address, broker) => {
    setLog(broker, DOMAIN, batches, hwm);
    return runAt(address, o);
  });
const B = BASE[DOMAIN]!;
const one = (base: number, m: Message, control = false): PlantedBatch => ({ base, records: [m], control });

test("oi-nrd: a domain that oi-nrd and oi-nrd-confirmed alone carry is not corroborated: the three OpenINTEL sources are one family", () => {
  // The committed registry: config/sources.json, as the feed builds read it.
  const registry = (JSON.parse(readFileSync(join(ROOT, "config", "sources.json"), "utf8")) as { sources: { id: string; family: string }[] }).sources;
  assert.deepEqual(
    registry.filter((r) => r.id.startsWith("oi-nrd")).map((r) => [r.id, r.family]),
    [
      ["oi-nrd", "ct"],
      ["oi-nrd-fqdn", "ct"],
      ["oi-nrd-confirmed", "ct"],
    ],
  );
  const table = sourceTable(registry as unknown as Parameters<typeof sourceTable>[0]);
  const s = 25_000_000;
  const window = { t0: Math.floor(s / 3600) * 3600, t1: Math.floor(s / 3600) * 3600 + 3600 };
  for (const level of [3, 8]) {
    const c = confidenceOf(
      [
        { bit: 1, first: s, last: s },
        { bit: 3, first: s + 2, last: s + 2 },
      ],
      [
        { tier: 2, basis: BASIS["nrd-list"], source: 1, at: s, confidence: 0 },
        { tier: 2, basis: BASIS["nrd-ct+rdap"], source: 3, at: s + 2, confidence: level },
      ],
      { table, window },
    );
    assert.equal(c.corroborated, false, `level ${level}: OpenINTEL agreeing with itself is no corroboration`);
  }
});

test("oi-nrd: a cursor at the latest offset is caught up: no fault, no segment, no Fetch, and the cursor as given, with or without a through", async () => {
  const messages = [nrd(at("05:41:00"), "a.com"), nrd(at("05:45:00"), "b.com")];
  for (const through of [{ [DOMAIN]: iso("05:40:00") }, {}] as Readonly<Record<string, string>>[]) {
    const cursor = cursorOf({ [DOMAIN]: B + 2 }, through);
    const r = await read(messages, { cursor });
    assert.deepEqual(r.result.errors, [], JSON.stringify(through));
    assert.deepEqual(r.written, []);
    assert.equal(r.result.stats.fetches, 0);
    assert.equal(r.result.stats.frame_bytes, 0);
    assert.deepEqual((r.result.cursor as { topics: Record<string, unknown> }).topics[DOMAIN], { "0": B + 2 });
    assert.deepEqual((r.result.cursor as { through: Record<string, string> }).through[DOMAIN], (through as Record<string, string>)[DOMAIN]);
  }
});

test("oi-nrd: a cursor ahead of an empty topic with no through moves to the earliest offset and fetches nothing; on a topic with records it reads from the earliest", async () => {
  const empty = await read([], { cursor: cursorOf({ [DOMAIN]: B + 5 }, {}) });
  assert.deepEqual(faults(empty), [["oi-nrd", "offset-ahead"]]);
  assert.match(empty.result.errors[0]!.detail, new RegExp(`the cursor names no through, so the read resumes at the earliest offset ${B} with a fresh window$`));
  assert.equal(empty.result.stats.fetches, 0);
  assert.deepEqual((empty.result.cursor as { topics: Record<string, unknown> }).topics[DOMAIN], { "0": B });
  const full = await read([nrd(at("05:41:00"), "a.com"), nrd(at("05:52:00"), "b.com")], { cursor: cursorOf({ [DOMAIN]: B + 1000 }, {}) });
  assert.deepEqual(faults(full), [["oi-nrd", "offset-ahead"]]);
  assert.deepEqual(windows(full, "oi-nrd"), [["05:41:00", "05:50:00", 1]]);
  assert.deepEqual(ofSource(full, "oi-nrd")[0]!.segment.cursorBefore, slice(DOMAIN, B, iso("05:41:00")));
});

test("oi-nrd: a broker that refuses the connection, or leaves Metadata or ListOffsets unanswered, is the fault broker of each source, no segment, and the cursor as given", async () => {
  const port = await closedPort();
  const given = cursorOf({ [DOMAIN]: 123 }, { [DOMAIN]: iso("05:40:00") });
  const sources = TOPICS.map((t) => [t.source, "broker"]);
  for (const cursor of [null, given]) {
    const r = await runAt({ hostname: "127.0.0.1", port }, { cursor, connect: { connectMs: 500 } });
    assert.deepEqual(faults(r), sources);
    assert.match(r.result.errors[0]!.detail, /nothing is read this run, and the cursor holds$/);
    assert.deepEqual(r.written, []);
    assert.deepEqual(r.result.cursor, cursor);
  }
  // Metadata (3) and ListOffsets (2) unanswered: the idle bound ends the socket after open, still the fault broker.
  for (const silentApi of [3, 2]) {
    const r = await read([nrd(at("05:41:00"), "a.com")], { cursor: given, broker: { faults: { silentApi } }, connect: { idleMs: 300 } });
    assert.deepEqual(faults(r), sources, `silentApi ${silentApi}`);
    assert.match(r.result.errors[0]!.detail, /idle/);
    assert.deepEqual(r.written, []);
    assert.deepEqual(r.result.cursor, given);
  }
});

test("oi-nrd: a full window's early close needs a second above every second it holds, a late record's among them", async () => {
  const s = (sec: number): number => at("05:41:00") + sec * 1000;
  const r = await read([nrd(s(10), "a.com"), nrd(s(20), "b.com"), nrd(s(30), "c.com"), nrd(at("05:39:00"), "late.com"), nrd(s(15), "d.com"), nrd(at("05:52:00"), "e.com")], {
    cursor: cursorOf({ [DOMAIN]: B }, { [DOMAIN]: iso("05:40:00") }),
    limits: { maxSegmentMessages: 3 },
  });
  // 05:41:15 is below 05:41:30, the most the window holds: it joins, and the window closes at 05:50.
  assert.deepEqual(windows(r, "oi-nrd"), [["05:40:00", "05:50:00", 5]]);
  assert.equal(r.result.stats["oi-nrd.late"], 1);
});

test("oi-nrd: the run stops at a window whose messages equal maxMessagesPerRun exactly", async () => {
  const r = await read([nrd(at("05:01:00"), "a.com"), nrd(at("05:02:00"), "b.com"), nrd(at("05:11:00"), "c.com"), nrd(at("05:12:00"), "d.com"), nrd(at("05:21:00"), "e.com")], {
    limits: { maxMessagesPerRun: 2 },
  });
  assert.deepEqual(windows(r, "oi-nrd"), [["05:01:00", "05:10:00", 2]]);
  assert.deepEqual(pick(r.result.cursor, DOMAIN), [B + 2, iso("05:10:00")]);
  assert.equal(r.result.stats["oi-nrd.messages"], 2);
});

test("oi-nrd: over a log with offset gaps, window k's cursorAfter is window k+1's cursorBefore, each the offset of the record that closed it, and a capped run's cursor is that record's", async () => {
  const r = await readLog([one(B, nrd(at("05:01:00"), "a.com")), one(B + 6, nrd(at("05:25:00"), "b.com")), one(B + 7, nrd(at("05:33:00"), "c.com")), one(B + 9, nrd(at("05:44:00"), "d.com"))]);
  const segs = ofSource(r, "oi-nrd").map((w) => w.segment);
  assert.deepEqual(
    segs.map((g) => [hms(g.window.start), pick(g.cursorBefore, DOMAIN)[0], pick(g.cursorAfter, DOMAIN)[0]]),
    [
      ["05:01:00", B, B + 6],
      ["05:10:00", B + 6, B + 6],
      ["05:20:00", B + 6, B + 7],
      ["05:30:00", B + 7, B + 9],
    ],
  );
  for (let k = 0; k + 1 < segs.length; k++) assert.deepEqual(segs[k]!.cursorAfter, segs[k + 1]!.cursorBefore);
  assert.deepEqual(segs.at(-1)!.cursorAfter, slice(DOMAIN, ...pick(r.result.cursor, DOMAIN)));
  const capped = await readLog([one(B, nrd(at("05:01:00"), "a.com")), one(B + 7, nrd(at("05:11:00"), "b.com"))], { limits: { maxMessagesPerRun: 1 } });
  assert.deepEqual(pick(capped.result.cursor, DOMAIN), [B + 7, iso("05:10:00")]);
});

test("oi-nrd: a control batch moves the read past it: kept in the raw lane between two records, not as a window's first batch, and the topic reaches the latest offset when it is last", async () => {
  const control = (base: number): PlantedBatch => ({ base, records: [raw(DOMAIN, at("05:41:30"), "c1"), raw(DOMAIN, at("05:41:30"), "c2")], control: true });
  // Last in the log, past an empty open window: one Fetch, no fault, and the cursor past it.
  const last = await readLog([one(B, nrd(at("05:41:00"), "a.com")), one(B + 1, nrd(at("05:45:00"), "b.com")), control(B + 2)], {
    cursor: cursorOf({ [DOMAIN]: B + 2 }, { [DOMAIN]: iso("05:50:00") }),
  });
  assert.deepEqual(last.result.errors, []);
  assert.equal(last.result.stats.fetches, 1);
  assert.deepEqual(pick(last.result.cursor, DOMAIN), [B + 4, iso("05:50:00")]);
  // Between two records of a window: the raw lane holds it.
  const mid = await readLog([one(B, nrd(at("05:41:00"), "a.com")), control(B + 1), one(B + 3, nrd(at("05:43:00"), "b.com")), one(B + 4, nrd(at("05:52:00"), "c.com"))]);
  assert.deepEqual(ofSource(mid, "oi-nrd")[0]!.rawMember, { topic: DOMAIN, partition: 0, base_offset: B, last_offset: B + 3, batches: 3 });
  assert.equal(mid.result.stats["oi-nrd.messages"], 3);
  // First in an open window, before any record of it: not kept, though the window's cursor starts at it.
  const first = await readLog([control(B), one(B + 2, nrd(at("05:41:00"), "a.com")), one(B + 3, nrd(at("05:52:00"), "b.com"))], { cursor: cursorOf({ [DOMAIN]: B }, { [DOMAIN]: iso("05:40:00") }) });
  const [w] = ofSource(first, "oi-nrd");
  assert.deepEqual(w!.rawMember, { topic: DOMAIN, partition: 0, base_offset: B + 2, last_offset: B + 2, batches: 1 });
  assert.deepEqual(w!.segment.cursorBefore, slice(DOMAIN, B, iso("05:40:00")));
  // A fresh topic's first window opens at its first record, after the control batch: not kept either.
  const fresh = await readLog([control(B), one(B + 2, nrd(at("05:41:00"), "a.com")), one(B + 3, nrd(at("05:52:00"), "b.com"))]);
  assert.deepEqual(ofSource(fresh, "oi-nrd")[0]!.rawMember, { topic: DOMAIN, partition: 0, base_offset: B + 2, last_offset: B + 2, batches: 1 });
});

test("oi-nrd: a batch of two records is kept once in its window's raw lane, and a batch whose records fall in two windows goes into both", async () => {
  const pair = (base: number, x: Message, y: Message): PlantedBatch => ({ base, records: [x, y] });
  const r = await readLog([pair(B, nrd(at("05:41:00"), "a.com"), nrd(at("05:42:00"), "b.com")), one(B + 2, nrd(at("05:52:00"), "c.com"))]);
  assert.deepEqual(ofSource(r, "oi-nrd")[0]!.rawMember, { topic: DOMAIN, partition: 0, base_offset: B, last_offset: B + 1, batches: 1 });
  const split = await readLog([pair(B, nrd(at("05:45:00"), "a.com"), nrd(at("05:52:00"), "b.com")), one(B + 2, nrd(at("06:01:00"), "c.com"))], { now: "2026-10-31T06:10:00Z" });
  assert.deepEqual(windows(split, "oi-nrd"), [
    ["05:45:00", "05:50:00", 1],
    ["05:50:00", "06:00:00", 1],
  ]);
  for (const w of ofSource(split, "oi-nrd")) assert.deepEqual(w.rawMember, { topic: DOMAIN, partition: 0, base_offset: B, last_offset: B + 1, batches: 1 });
});

test("oi-nrd: the relocation guards at their edges: a retention gap keeps the old through, a first record exactly an hour before through is no mismatch, and a later record far before it is late", async () => {
  // A retention gap whose old through lies after the first record read: the window opens at the old through.
  const gap = await read([nrd(at("05:41:00"), "a.com"), nrd(at("05:43:00"), "b.com"), nrd(at("06:01:00"), "c.com")], { cursor: cursorOf({ [DOMAIN]: B - 10 }, { [DOMAIN]: iso("05:55:00") }) });
  assert.deepEqual(faults(gap), [["oi-nrd", "retention-gap"]]);
  assert.deepEqual(windows(gap, "oi-nrd"), [["05:55:00", "06:00:00", 2]]);
  assert.equal(gap.result.stats["oi-nrd.late"], 2);
  const cursor = cursorOf({ [DOMAIN]: B }, { [DOMAIN]: iso("05:40:00") });
  // Exactly MISMATCH_S before through: late, no mismatch.
  const edge = await read([nrd(at("04:40:00"), "x.com"), nrd(at("05:45:00"), "a.com"), nrd(at("05:52:00"), "b.com")], { cursor });
  assert.deepEqual(faults(edge), []);
  assert.deepEqual(windows(edge, "oi-nrd"), [["05:40:00", "05:50:00", 2]]);
  // Only the first record read is held to through: a later one far before it is late.
  const later = await read([nrd(at("05:41:00"), "a.com"), nrd(at("03:00:00"), "x.com"), nrd(at("05:52:00"), "b.com")], { cursor });
  assert.deepEqual(faults(later), []);
  assert.equal(later.result.stats["oi-nrd.late"], 1);
  assert.equal(later.result.stats.fetches, 1);
});

test("oi-nrd: a Fetch answer that moves nothing between two that move resets the count of idle answers", async () => {
  await withBroker([nrd(at("05:41:00"), "a.com"), nrd(at("05:42:00"), "b.com"), nrd(at("05:52:00"), "c.com")], {}, async (address, broker) => {
    // Three empty answers, then one that moves the topic a batch: never MAX_IDLE_FETCHES in a row.
    const handle = broker.handle.bind(broker);
    let fetches = 0;
    broker.handle = (req: Buffer) => {
      if (req.readInt16BE(0) === 1) (broker.faults as { emptyFetch?: boolean }).emptyFetch = ++fetches % 4 !== 0;
      return handle(req);
    };
    const r = await runAt(address, { limits: { fetchPartitionBytes: 1, fetchMaxBytes: 1 } });
    assert.deepEqual(r.result.errors, []);
    assert.equal(r.result.stats.fetches, 12);
    assert.deepEqual(windows(r, "oi-nrd"), [["05:41:00", "05:50:00", 2]]);
  });
});

test("oi-nrd: a ListOffsets of a relocation that fails, or a socket that dies after the read passed a control batch, is the fault read with the cursor where the read stood", async () => {
  // cursor-mismatch, then the relocation's ListOffsets goes unanswered: the fault read, not a throw.
  await withBroker([nrd(at("03:00:00"), "x.com"), nrd(at("03:10:00"), "y.com"), nrd(at("05:41:00"), "a.com"), nrd(at("05:52:00"), "b.com")], {}, async (address, broker) => {
    const handle = broker.handle.bind(broker);
    broker.handle = (req: Buffer) => {
      if (req.readInt16BE(0) === 1) (broker.faults as { silentApi?: number }).silentApi = 2;
      return handle(req);
    };
    const r = await runAt(address, { cursor: cursorOf({ [DOMAIN]: B + 1 }, { [DOMAIN]: iso("05:40:00") }), connect: { idleMs: 300 } });
    assert.deepEqual(faults(r), [
      ["oi-nrd", "cursor-mismatch"],
      ["oi-nrd", "read"],
    ]);
    assert.deepEqual(pick(r.result.cursor, DOMAIN), [B + 1, iso("05:40:00")]);
  });
  // The first Fetch answers a control batch alone; the second's socket dies: the cursor is past the control batch.
  await withBroker([], {}, async (address, broker) => {
    setLog(broker, DOMAIN, [
      one(B, nrd(at("05:41:00"), "a.com")),
      one(B + 1, nrd(at("05:45:00"), "b.com")),
      { base: B + 2, records: [raw(DOMAIN, at("05:46:00"), "c1"), raw(DOMAIN, at("05:46:00"), "c2")], control: true },
      one(B + 4, nrd(at("05:55:00"), "c.com")),
    ]);
    const handle = broker.handle.bind(broker);
    let fetches = 0;
    broker.handle = (req: Buffer) => {
      if (req.readInt16BE(0) === 1 && ++fetches === 2) {
        for (const s of broker.sockets as Set<{ destroy(): void }>) s.destroy();
        return null;
      }
      return handle(req);
    };
    const r = await runAt(address, { cursor: cursorOf({ [DOMAIN]: B + 2 }, { [DOMAIN]: iso("05:50:00") }), limits: { fetchPartitionBytes: 1, fetchMaxBytes: 1 } });
    assert.deepEqual(faults(r), [["oi-nrd", "read"]]);
    assert.deepEqual(pick(r.result.cursor, DOMAIN), [B + 4, iso("05:50:00")]);
  });
});

test("oi-nrd: a close of the connection that fails after the read leaves the run's result whole", async () => {
  const r = await read([nrd(at("05:41:00"), "a.com"), nrd(at("05:52:00"), "b.com")], {
    wrap: (connect) => (address, options) => {
      const s = connect(address, options);
      return {
        ...s,
        close: async () => {
          await s.close();
          throw new Error("close failed");
        },
      };
    },
  });
  assert.deepEqual(r.result.errors, []);
  assert.deepEqual(windows(r, "oi-nrd"), [["05:41:00", "05:50:00", 1]]);
});
