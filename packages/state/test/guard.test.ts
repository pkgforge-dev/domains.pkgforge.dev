// packages/state: the guard of state:latest and the move of the cursors
// (DOM-024's Test bullet), against the GHCR double of registry.ts. Each test
// drives a run as the workflow does: a lane pushes its segments under
// write-once tags and proposes a cursor; the job `push` reads the live state,
// advances it over the proposals and moves `state:latest` under the guard.
// Every test name starts `guard:` (the Prove,
// `node scripts/test.mjs packages/state --name guard`). All synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { segTag, stateRunTag, tierTag } from "@domains/ghcr";
import { advance, emptyState, encodeState, guard, HISTORY_DAYS, type Held, type OwedItem, OWED_DAYS, type Proposal, propose, type State, StateError, settle, validateState } from "../src/index.ts";
import { LATEST, lane, MockRegistry, pushJob, sameWork } from "./registry.ts";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const T0 = "2026-10-30T08:00:00Z";
const T1 = "2026-10-30T08:10:00Z";
const T2 = "2026-10-30T08:20:00Z";
const NOW1 = "2026-10-30T08:12:00Z";
const NOW2 = "2026-10-30T08:27:00Z";
const RUN1 = "40000000001";
const RUN2 = "40000000002";

// Throws a StateError of this code; the error, for its message.
function refuses(fn: () => unknown, code: string): StateError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof StateError, `expected a StateError ${code}, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected a StateError ${code}, and nothing was thrown`);
}

// One window of oi-cs, a second-precision stream: a names and a domains segment.
const streamWindow = (start: string, end: string, n = 1) => [
  { source: "oi-cs", dataset: "names" as const, start, end, records: `com.example.n${n}\ncom.example.www.n${n}\n` },
  { source: "oi-cs", dataset: "domains" as const, start, end, records: `com.example.n${n}\n` },
];

// The state after run 1 moved oi-cs to { offset: 100 }.
function firstRun(reg: MockRegistry) {
  const kafka = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, at: NOW1, live: reg.state(), segments: streamWindow(T0, T1), after: { offset: 100 } });
  const job = pushJob(reg, [kafka.proposal], { now: NOW1, run: RUN1 });
  return { kafka, job };
}

// Another writer moves state:latest to a state of its own, as a second run would.
function otherWriter(reg: MockRegistry, live: State): string {
  const other = validateState({
    ...live,
    updated: "2026-10-30T08:25:00Z",
    cursors: { ...live.cursors, "ct-le": { tile: 9 } },
    moved: { ...live.moved, "ct-le": { at: "2026-10-30T08:25:00Z", run: "40000000009" } },
  });
  const pushed = reg.push(`state:${stateRunTag(other.updated)}`, encodeState(other));
  reg.tag(LATEST, pushed.digest);
  return pushed.digest;
}

test("guard: a tag that holds what the run read passes, absent included; any other is refused stale, naming both digests", () => {
  guard(LATEST, A, A);
  guard(LATEST, null, null);
  const moved = refuses(() => guard(LATEST, A, B), "stale");
  assert.equal(moved.message, `state:latest holds ${B}, and this run read ${A}: another writer moved it. The live one is kept`);
  assert.equal(refuses(() => guard(LATEST, A, null), "stale").message, `state:latest holds nothing, and this run read ${A}: another writer moved it. The live one is kept`);
  assert.equal(refuses(() => guard("state:ledger-delta", null, B), "stale").message, `state:ledger-delta holds ${B}, and this run read nothing: another writer moved it. The live one is kept`);
  // A digest is a digest or null, never a word that compares unequal to null.
  refuses(() => guard(LATEST, "none" as unknown as null, null), "usage");
  refuses(() => guard(LATEST, A, `sha256:${"A".repeat(64)}`), "usage");
  refuses(() => guard("", A, A), "usage");
  // A caller that read neither digest, or one of them, is refused, never passed.
  const missing = undefined as unknown as null;
  assert.match(refuses(() => guard(LATEST, missing, missing), "usage").message, /the guard's expected digest is missing; it is neither a sha256: digest nor null/);
  refuses(() => guard(LATEST, missing, null), "usage");
  assert.match(refuses(() => guard(LATEST, null, missing), "usage").message, /the guard's found digest is missing/);
  refuses(() => guard(LATEST, A, missing), "usage");
});

test("guard: a stale read refuses the push, and the live state stays: a second writer before the run object is pushed, or before oras tag", () => {
  for (const at of [2, 3] as const) {
    const reg = new MockRegistry();
    firstRun(reg);
    const live = reg.state()!;
    const liveDigest = reg.tags.get(LATEST)!;
    const tiles = lane(reg, {
      adapter: "ct-le",
      lane: "tiles",
      run: RUN2,
      at: NOW2,
      live,
      segments: [{ source: "ct-le", dataset: "names", start: T1, end: T2, records: "org.example.a\n" }],
      after: { tile: 4 },
    });
    // Heads of state:latest in the job push: 1 the live read, 2 the guard
    // before the run object's push, 3 the guard before oras tag.
    let heads = 0;
    let theirs: string | null = null;
    reg.beforeHead = (ref) => {
      if (ref === LATEST && ++heads === at) theirs = otherWriter(reg, live);
    };
    const refused = refuses(() => pushJob(reg, [tiles.proposal], { now: NOW2, run: RUN2 }), "stale");
    assert.ok(theirs !== null && theirs !== liveDigest);
    assert.equal(refused.message, `state:latest holds ${theirs}, and this run read ${liveDigest}: another writer moved it. The live one is kept`);
    // The other writer's state is live, and this run moved nothing.
    assert.equal(reg.tags.get(LATEST), theirs);
    assert.deepEqual(reg.state()!.cursors["ct-le"], { tile: 9 });
    assert.equal(reg.calls.filter((c) => c.startsWith(`tag ${LATEST}`)).at(-1), `tag ${LATEST} ${theirs}`);
    const runTag = `state:${stateRunTag(NOW2)}`;
    // Refused before its push, the run object was never written; refused
    // after it, the run object stands unreferenced, which is harmless.
    assert.equal(reg.tags.has(runTag), at === 3);
  }
});

test("guard: a re-run regenerates the same tags with no write (present), and its proposal is dropped stale-before once the state moved", () => {
  const reg = new MockRegistry();
  const { kafka, job } = firstRun(reg);
  assert.deepEqual(kafka.answers, ["pushed", "pushed"]);
  assert.deepEqual(
    job.advanced.accepted.map((p) => p.adapter),
    ["oi-cs"],
  );
  const tagsBefore = new Map(reg.tags);
  // The re-run read the state its first attempt read, before run 1 moved it.
  const again = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, attempt: 2, at: "2026-10-30T08:14:00Z", live: null, segments: streamWindow(T0, T1), after: { offset: 100 } });
  assert.deepEqual(again.answers, ["present", "present"]);
  assert.deepEqual(reg.tags, tagsBefore);
  assert.equal(sameWork(again.proposal), sameWork(kafka.proposal));
  const rerun = pushJob(reg, [again.proposal], { now: "2026-10-30T08:15:00Z", run: RUN1 });
  assert.deepEqual(rerun.advanced.dropped, [
    { adapter: "oi-cs", code: "stale-before", detail: 'oi-cs proposes from the cursor none, and the live cursor is {"offset":100}: another run moved it; the adapter is read again from the live one' },
  ]);
  assert.equal(rerun.advanced.changed, false);
  assert.equal(rerun.moved, null);
  assert.deepEqual(reg.tags, tagsBefore);
  assert.deepEqual(reg.state()!.cursors, { "oi-cs": { offset: 100 } });
});

test("guard: a crash between the segment and the state leaves a state the next run repairs: the same segment is present, the same proposal is accepted", () => {
  const reg = new MockRegistry();
  firstRun(reg);
  const live = reg.state()!;
  // Run 2 pushes the next window's segments, then dies before its job push.
  const crashed = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN2, at: NOW2, live, segments: streamWindow(T1, T2, 2), after: { offset: 200 } });
  assert.deepEqual(crashed.answers, ["pushed", "pushed"]);
  assert.deepEqual(reg.state(), live);
  // Run 3 reads the cursor run 2 read, writes the same bytes, and moves it.
  const repaired = lane(reg, { adapter: "oi-cs", lane: "kafka", run: "40000000003", at: "2026-10-30T08:42:00Z", live: reg.state(), segments: streamWindow(T1, T2, 2), after: { offset: 200 } });
  assert.deepEqual(repaired.answers, ["present", "present"]);
  assert.equal(sameWork(repaired.proposal), sameWork(crashed.proposal));
  const job = pushJob(reg, [repaired.proposal], { now: "2026-10-30T08:42:00Z", run: "40000000003" });
  assert.deepEqual(
    job.advanced.accepted.map((p) => p.adapter),
    ["oi-cs"],
  );
  assert.deepEqual(job.advanced.dropped, []);
  const next = reg.state()!;
  assert.deepEqual(next.cursors, { "oi-cs": { offset: 200 } });
  assert.deepEqual(next.moved, { "oi-cs": { at: "2026-10-30T08:42:00Z", run: "40000000003" } });
  // Every segment of both windows is owed to the root, run 2's under run 3's time.
  assert.deepEqual(
    next.owed.map((o) => [o.ref, o.since]),
    [
      ["obs:oi-cs.20261030t080000z.20261030t081000z", NOW1],
      ["obs:oi-cs.20261030t080000z.20261030t081000z-d", NOW1],
      ["obs:oi-cs.20261030t081000z.20261030t082000z", "2026-10-30T08:42:00Z"],
      ["obs:oi-cs.20261030t081000z.20261030t082000z-d", "2026-10-30T08:42:00Z"],
    ],
  );
  assert.equal(next.owed[2]!.digest, repaired.proposal.segments[0]!.digest);
});

test("guard: two lanes that each propose a cursor are both applied by one advance, and state:latest moves once", () => {
  const reg = new MockRegistry();
  const kafka = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, at: NOW1, live: null, segments: streamWindow(T0, T1), after: { offset: 100 } });
  const tiles = lane(reg, {
    adapter: "ct-le",
    lane: "tiles",
    run: RUN1,
    at: NOW1,
    live: null,
    segments: [{ source: "ct-le", dataset: "names", start: T0, end: T1, records: "org.example.a\n" }],
    after: { tile: 4 },
  });
  const job = pushJob(reg, [kafka.proposal, tiles.proposal], { now: NOW1, run: RUN1 });
  assert.deepEqual(
    job.advanced.accepted.map((p) => p.adapter),
    ["ct-le", "oi-cs"],
  );
  assert.deepEqual(job.advanced.dropped, []);
  assert.equal(job.advanced.changed, true);
  const next = reg.state()!;
  assert.deepEqual(next.cursors, { "ct-le": { tile: 4 }, "oi-cs": { offset: 100 } });
  assert.deepEqual(next.moved, { "ct-le": { at: NOW1, run: RUN1 }, "oi-cs": { at: NOW1, run: RUN1 } });
  assert.equal(next.owed.length, 3);
  assert.equal(next.updated, NOW1);
  assert.deepEqual(
    reg.calls.filter((c) => c.startsWith(`tag ${LATEST}`)),
    [`tag ${LATEST} ${job.moved}`],
  );
});

test("guard: a proposal whose before is not the live cursor is dropped stale-before, and the live cursor is kept", () => {
  const reg = new MockRegistry();
  firstRun(reg);
  const live = reg.state()!;
  // A lane that read an older cursor, and one that names a cursor where the live state has none.
  const old = lane(reg, {
    adapter: "oi-cs",
    lane: "kafka",
    run: RUN2,
    at: NOW2,
    live: validateState({ ...live, cursors: { "oi-cs": { offset: 50 } } }),
    segments: streamWindow(T1, T2, 2),
    after: { offset: 150 },
  });
  const fresh = propose({ ...old.proposal, adapter: "ct-le", before: { tile: 1 }, after: { tile: 2 }, segments: [], raw: [], history: [] });
  const job = pushJob(reg, [old.proposal, fresh], { now: NOW2, run: RUN2 });
  assert.deepEqual(
    job.advanced.dropped.map((d) => [d.adapter, d.code, d.detail]),
    [
      ["ct-le", "stale-before", 'ct-le proposes from the cursor {"tile":1}, and the live cursor is none: another run moved it; the adapter is read again from the live one'],
      ["oi-cs", "stale-before", 'oi-cs proposes from the cursor {"offset":50}, and the live cursor is {"offset":100}: another run moved it; the adapter is read again from the live one'],
    ],
  );
  assert.equal(job.advanced.changed, false);
  assert.equal(job.moved, null);
  assert.deepEqual(reg.state(), live);
});

test("guard: a proposal that names a missing tag is dropped missing-tag, and one whose tag holds another digest is dropped digest", () => {
  const reg = new MockRegistry();
  const good = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, at: NOW1, live: null, segments: streamWindow(T0, T1), after: { offset: 100 } });
  const seg = { source: "ct-le", dataset: "names" as const, start: T0, end: T1, count: 1, quarantined: false };
  // Named, and never pushed.
  const missing = propose({
    adapter: "ct-le",
    lane: "tiles",
    run: RUN1,
    attempt: 1,
    at: NOW1,
    before: null,
    after: { tile: 4 },
    segments: [{ ...seg, ref: "obs:ct-le.20261030t080000z.20261030t081000z", digest: A }],
    raw: [],
    history: [],
  });
  // Pushed with other bytes than the proposal says.
  const pushed = reg.push("obs:ct-ipng.20261030t080000z.20261030t081000z", new TextEncoder().encode("org.example.b\n"));
  const other = propose({
    adapter: "ct-ipng",
    lane: "tiles",
    run: RUN1,
    attempt: 1,
    at: NOW1,
    before: null,
    after: { tile: 7 },
    segments: [{ ...seg, source: "ct-ipng", ref: "obs:ct-ipng.20261030t080000z.20261030t081000z", digest: B }],
    raw: [],
    history: [],
  });
  const job = pushJob(reg, [missing, good.proposal, other], { now: NOW1, run: RUN1 });
  assert.deepEqual(
    job.advanced.dropped.map((d) => [d.adapter, d.code, d.detail]),
    [
      ["ct-ipng", "digest", `ct-ipng names obs:ct-ipng.20261030t080000z.20261030t081000z at ${B}, and the tag holds ${pushed.digest}; the adapter is read again from its cursor none`],
      ["ct-le", "missing-tag", "ct-le names obs:ct-le.20261030t080000z.20261030t081000z, which GHCR does not hold; the adapter is read again from its cursor none"],
    ],
  );
  assert.deepEqual(
    job.advanced.accepted.map((p) => p.adapter),
    ["oi-cs"],
  );
  assert.deepEqual(Object.keys(reg.state()!.cursors), ["oi-cs"]);
  assert.ok(!reg.state()!.owed.some((o) => o.ref.startsWith("obs:ct-")));
});

test("guard: a proposal whose raw object GHCR does not hold is dropped missing-tag, and one whose raw tag holds other bytes is dropped digest", () => {
  const reg = new MockRegistry();
  const raw = (pushed: boolean) => [{ source: "oi-cs", start: T0, end: T1, bytes: "raw bytes of the window\n", pushed }];
  // The segments are pushed, the raw object is not: GHCR holds no raw-oi-cs tag.
  const absent = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, at: NOW1, live: null, segments: streamWindow(T0, T1), after: { offset: 100 }, raw: raw(false) });
  const rawRef = "obs:raw-oi-cs.20261030t080000z.20261030t081000z";
  assert.deepEqual(
    absent.proposal.raw.map((r) => r.ref),
    [rawRef],
  );
  const a = advance(null, [absent.proposal], (ref) => reg.head(ref), { now: NOW1, run: RUN1 });
  assert.deepEqual(
    a.dropped.map((d) => [d.adapter, d.code, d.detail]),
    [["oi-cs", "missing-tag", `oi-cs names ${rawRef}, which GHCR does not hold; the adapter is read again from its cursor none`]],
  );
  assert.deepEqual([a.state.cursors, a.changed], [{}, false]);
  // The raw tag holds other bytes than the proposal says.
  const other = reg.push(rawRef, new TextEncoder().encode("other bytes\n"));
  const b = advance(null, [absent.proposal], (ref) => reg.head(ref), { now: NOW1, run: RUN1 });
  assert.deepEqual(
    b.dropped.map((d) => [d.code, d.detail]),
    [["digest", `oi-cs names ${rawRef} at ${absent.proposal.raw[0]!.digest}, and the tag holds ${other.digest}; the adapter is read again from its cursor none`]],
  );
  assert.deepEqual(b.state.cursors, {});
  // Pushed, the same proposal is accepted.
  const reg2 = new MockRegistry();
  const held = lane(reg2, { adapter: "oi-cs", lane: "kafka", run: RUN1, at: NOW1, live: null, segments: streamWindow(T0, T1), after: { offset: 100 }, raw: raw(true) });
  assert.deepEqual(held.answers, ["pushed", "pushed", "pushed"]);
  const c = advance(null, [held.proposal], (ref) => reg2.head(ref), { now: NOW1, run: RUN1 });
  assert.deepEqual([c.dropped, c.state.cursors], [[], { "oi-cs": { offset: 100 } }]);
});

test("guard: a source whose id is a key of Object.prototype, constructor, merges its history like any other", () => {
  const reg = new MockRegistry();
  const start = "2026-10-29T00:00:00Z";
  const end = "2026-10-30T00:00:00Z";
  const feeds = lane(reg, {
    adapter: "constructor",
    lane: "feeds",
    run: RUN1,
    at: NOW1,
    live: null,
    segments: [{ source: "constructor", dataset: "names", start, end, records: "com.example.c\n", file: "constructor 2026-10-29" }],
    after: { last_day: "2026-10-29" },
    history: [{ source: "constructor", day: "2026-10-29", count: 1, quarantined: false }],
  });
  const kafka = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, at: NOW1, live: null, segments: streamWindow(T0, T1), after: { offset: 100 } });
  const job = pushJob(reg, [feeds.proposal, kafka.proposal], { now: NOW1, run: RUN1 });
  assert.deepEqual(
    job.advanced.accepted.map((p) => p.adapter),
    ["constructor", "oi-cs"],
  );
  const next = reg.state()!;
  assert.deepEqual(next.history, { constructor: [{ day: "2026-10-29", count: 1, quarantined: false }] });
  assert.deepEqual(next.cursors, { constructor: { last_day: "2026-10-29" }, "oi-cs": { offset: 100 } });
  assert.ok(Object.hasOwn(next.history, "constructor"));
});

test("guard: advance refuses a call off its shape as usage, and a live state of another format as format, before it reads a proposal", () => {
  const reg = new MockRegistry();
  const p = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, at: NOW1, live: null, segments: streamWindow(T0, T1), after: { offset: 100 } }).proposal;
  const head = (ref: string) => reg.head(ref);
  const opts = { now: NOW1, run: RUN1 };
  assert.match(refuses(() => advance(null, [], head, null as unknown as typeof opts), "usage").message, /advance takes the options \{ now, run \}/);
  assert.match(refuses(() => advance(null, [], head, { ...opts, now: "yesterday" }), "usage").message, /now "yesterday" is not an ISO 8601 UTC time to the second/);
  // With a live state too: no empty state is built from now to refuse it.
  assert.match(refuses(() => advance(emptyState(NOW1), [], head, { ...opts, now: "yesterday" }), "usage").message, /now "yesterday" is not an ISO 8601 UTC time to the second/);
  assert.match(refuses(() => advance(null, [], head, { ...opts, run: "abc" }), "usage").message, /run "abc" is not a workflow run id/);
  assert.match(refuses(() => advance(null, [], 7 as unknown as typeof head, opts), "usage").message, /tagExists is not a function/);
  assert.match(refuses(() => advance(null, undefined as unknown as [], head, opts), "usage").message, /the proposals are not a list/);
  // A live state this reader does not know is not rewritten as v1.
  const v2 = { ...emptyState(NOW1), format: "domains.state.v2" } as unknown as State;
  refuses(() => advance(v2, [], head, opts), "format");
  refuses(() => advance(v2, [p], head, opts), "format");
  // A tagExists that answers neither a digest nor null fails loudly, never drops as digest.
  assert.match(refuses(() => advance(null, [p], () => undefined as unknown as null, opts), "usage").message, /^tagExists answered undefined for obs:/);
  assert.match(refuses(() => advance(null, [p], () => "none", opts), "usage").message, /^tagExists answered "none" for obs:/);
});

test("guard: two proposals of one adapter are both dropped duplicate, and the other adapters still advance", () => {
  const reg = new MockRegistry();
  const one = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, at: NOW1, live: null, segments: streamWindow(T0, T1), after: { offset: 100 } });
  const two = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, attempt: 2, at: "2026-10-30T08:13:00Z", live: null, segments: streamWindow(T0, T1), after: { offset: 100 } });
  const tiles = lane(reg, {
    adapter: "ct-le",
    lane: "tiles",
    run: RUN1,
    at: NOW1,
    live: null,
    segments: [{ source: "ct-le", dataset: "names", start: T0, end: T1, records: "org.example.a\n" }],
    after: { tile: 4 },
  });
  const job = pushJob(reg, [one.proposal, tiles.proposal, two.proposal], { now: NOW1, run: RUN1 });
  const detail = `oi-cs has 2 proposals (run ${RUN1} attempt 1 at ${NOW1}, run ${RUN1} attempt 2 at 2026-10-30T08:13:00Z); none is applied, and the adapter is read again from its live cursor`;
  assert.deepEqual(job.advanced.dropped, [
    { adapter: "oi-cs", code: "duplicate", detail },
    { adapter: "oi-cs", code: "duplicate", detail },
  ]);
  assert.deepEqual(reg.state()!.cursors, { "ct-le": { tile: 4 } });
});

test("guard: a quarantined segment is not owed, and its day enters the history as quarantined", () => {
  const reg = new MockRegistry();
  const day = { source: "isc-new", dataset: "names" as const, start: "2026-10-29T00:00:00Z", end: "2026-10-30T00:00:00Z" };
  const feeds = lane(reg, {
    adapter: "isc-new",
    lane: "feeds",
    run: RUN1,
    at: NOW1,
    live: null,
    segments: [
      { ...day, records: "com.example.q\n", quarantined: true },
      { ...day, dataset: "domains", records: "com.example.q\n", quarantined: true },
    ],
    after: { last_day: "2026-10-29" },
    history: [{ source: "isc-new", day: "2026-10-29", count: 1, quarantined: true }],
  });
  const kafka = lane(reg, { adapter: "oi-cs", lane: "kafka", run: RUN1, at: NOW1, live: null, segments: streamWindow(T0, T1).map((s, i) => ({ ...s, quarantined: i === 0 })), after: { offset: 100 } });
  pushJob(reg, [feeds.proposal, kafka.proposal], { now: NOW1, run: RUN1 });
  const next = reg.state()!;
  // Only oi-cs's domains segment was not quarantined.
  assert.deepEqual(
    next.owed.map((o) => o.ref),
    ["obs:oi-cs.20261030t080000z.20261030t081000z-d"],
  );
  assert.deepEqual(next.history, { "isc-new": [{ day: "2026-10-29", count: 1, quarantined: true }] });
  assert.deepEqual(next.cursors["isc-new"], { last_day: "2026-10-29" });
});

// A day source's proposal of one day: its names segment and its history day.
function dayProposal(reg: MockRegistry, live: State, d: string, count: number, at: string): Proposal {
  const start = `${d}T00:00:00Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString().replace(".000Z", "Z");
  const records = Array.from({ length: count }, (_, i) => `com.example.d${i}\n`).join("");
  return lane(reg, {
    adapter: "isc-new",
    lane: "feeds",
    run: RUN2,
    at,
    live,
    segments: [{ source: "isc-new", dataset: "names", start, end, records, file: `${d} ${count}` }],
    after: { last_day: d, at },
    history: [{ source: "isc-new", day: d, count, quarantined: false }],
  }).proposal;
}

test("guard: history merges a day, replaces a day verified again, and keeps the newest 90 a source", () => {
  const reg = new MockRegistry();
  const days = Array.from({ length: HISTORY_DAYS }, (_, i) => new Date(Date.UTC(2026, 6, 31) + i * 86_400_000).toISOString().slice(0, 10));
  assert.deepEqual([days[0], days.at(-1)], ["2026-07-31", "2026-10-28"]);
  const live = validateState({
    ...emptyState(NOW1),
    cursors: { "isc-new": { last_day: "2026-10-28" } },
    moved: { "isc-new": { at: NOW1, run: RUN1 } },
    history: { "isc-new": days.map((day) => ({ day, count: 10, quarantined: false })), "other-day": [{ day: "2026-10-01", count: 3, quarantined: false }] },
  });
  const tick = (v: number) => `2026-10-30T09:0${v}:00Z`;
  const p1 = dayProposal(reg, live, "2026-10-29", 3, tick(1));
  const a1 = advance(live, [p1], (ref) => reg.head(ref), { now: tick(1), run: RUN2 });
  const h1 = a1.state.history["isc-new"]!;
  assert.equal(h1.length, HISTORY_DAYS);
  assert.deepEqual([h1[0]!.day, h1.at(-1)], ["2026-08-01", { day: "2026-10-29", count: 3, quarantined: false }]);
  // Another source's history is left as it was.
  assert.deepEqual(a1.state.history["other-day"], live.history["other-day"]);
  // The same day verified again replaces its item; the list keeps its length.
  const p2 = dayProposal(reg, a1.state, "2026-10-29", 4, tick(2));
  const a2 = advance(a1.state, [p2], (ref) => reg.head(ref), { now: tick(2), run: RUN2 });
  const h2 = a2.state.history["isc-new"]!;
  assert.equal(h2.length, HISTORY_DAYS);
  assert.deepEqual(
    h2.filter((d) => d.day === "2026-10-29"),
    [{ day: "2026-10-29", count: 4, quarantined: false }],
  );
  assert.equal(h2[0]!.day, "2026-08-01");
  // A day older than the 90 kept (a backfill) merges and leaves at once: the newest 90 are kept.
  const p3 = dayProposal(reg, a2.state, "2026-07-01", 5, tick(3));
  const h3 = advance(a2.state, [p3], (ref) => reg.head(ref), { now: tick(3), run: RUN2 }).state.history["isc-new"]!;
  assert.deepEqual(h3, h2);
});

// The held of section 6.2, from a synthetic live root: `held` when the root
// names the ref, `withdrawn` when its withdrawn lists the digest, `covered`
// when an owed hour pack of feed lies in a feed pack of tier d, w, m or y.
interface RootPack {
  readonly repo: string;
  readonly tag: string;
  readonly tier: string;
  readonly start: string;
  readonly end: string;
}
function heldBy(root: { readonly packs: readonly RootPack[]; readonly withdrawn: readonly string[] }): Held {
  return (item: OwedItem) => {
    const [repo, tag] = [item.ref.slice(0, item.ref.indexOf(":")), item.ref.slice(item.ref.indexOf(":") + 1)];
    if (root.packs.some((p) => p.repo === repo && p.tag === tag)) return { code: "held", detail: `the live root names ${item.ref}` };
    if (root.withdrawn.includes(item.digest)) return { code: "withdrawn", detail: `the live root withdrew ${item.digest}` };
    const span = root.packs.find((p) => item.tier === "h" && p.repo === "feed" && ["d", "w", "m", "y"].includes(p.tier) && p.start <= item.start && item.end <= p.end);
    if (span !== undefined) return { code: "covered", detail: `feed:${span.tag} spans ${item.ref}` };
    return null;
  };
}

test("guard: settle drops held, covered, withdrawn and expired items, and keeps a segment a higher tier spans", () => {
  const now = "2026-10-30T12:00:00Z";
  const owedSince = "2026-10-30T08:12:00Z";
  const d = (c: string) => `sha256:${c.repeat(64)}`;
  // A names segment of oi-cs of the ten minutes from HHMM of 2026-10-29.
  const seg = (hhmm: string, digest: string, since = owedSince): OwedItem => {
    const start = `2026-10-29T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`;
    const end = new Date(Date.parse(start) + 600_000).toISOString().replace(".000Z", "Z");
    return { ref: `obs:${segTag("oi-cs", start, end)}`, digest, dataset: "names", tier: "seg", start, end, since };
  };
  // The hour pack of feed of an hour.
  const hour = (start: string, digest: string): OwedItem => ({
    ref: `feed:${tierTag("feed", "h", start)}`,
    digest,
    dataset: "feed",
    tier: "h",
    start,
    end: new Date(Date.parse(start) + 3_600_000).toISOString().replace(".000Z", "Z"),
    since: owedSince,
  });
  const items = [
    seg("0800", d("1")),
    seg("0810", d("2")),
    // Owed 7 days and 1 second, and 7 days exactly.
    seg("0820", d("3"), "2026-10-23T11:59:59Z"),
    seg("0830", d("4"), "2026-10-23T12:00:00Z"),
    // A segment inside the span of a day pack of names built while it was owed.
    seg("0900", d("5")),
    hour("2026-10-29T10:00:00Z", d("6")),
    hour("2026-10-30T09:00:00Z", d("7")),
  ];
  const state = validateState({ ...emptyState(owedSince), owed: items });
  const root = {
    packs: [
      { repo: "obs", tag: segTag("oi-cs", "2026-10-29T08:00:00Z", "2026-10-29T08:10:00Z"), tier: "seg", start: "2026-10-29T08:00:00Z", end: "2026-10-29T08:10:00Z" },
      { repo: "names", tag: "names-d-20261029", tier: "d", start: "2026-10-29T00:00:00Z", end: "2026-10-30T00:00:00Z" },
      { repo: "feed", tag: "feed-d-20261029", tier: "d", start: "2026-10-29T00:00:00Z", end: "2026-10-30T00:00:00Z" },
    ],
    withdrawn: [d("2")],
  };
  const { state: next, settled } = settle(state, heldBy(root), now);
  assert.deepEqual(
    settled.map((s) => [s.item.ref, s.code]),
    [
      ["obs:oi-cs.20261029t080000z.20261029t081000z", "held"],
      ["obs:oi-cs.20261029t081000z.20261029t082000z", "withdrawn"],
      ["obs:oi-cs.20261029t082000z.20261029t083000z", "expired"],
      ["feed:feed-h-2026102910", "covered"],
    ],
  );
  assert.equal(settled[2]!.detail, `obs:oi-cs.20261029t082000z.20261029t083000z is owed since 2026-10-23T11:59:59Z, more than ${OWED_DAYS} days before ${now}, and no root names it`);
  assert.deepEqual(
    next.owed.map((o) => o.ref),
    ["obs:oi-cs.20261029t083000z.20261029t084000z", "obs:oi-cs.20261029t090000z.20261029t091000z", "feed:feed-h-2026103009"],
  );
  assert.equal(next.updated, now);
  // Nothing to drop: the state as it was, its time kept, at a later time too.
  const again = settle(next, () => null, now);
  assert.deepEqual(again.settled, []);
  assert.deepEqual(again.state, next);
  const fresh = validateState({ ...emptyState(owedSince), owed: [seg("0850", d("9"))] });
  const later = settle(fresh, () => null, "2026-10-30T12:30:00Z");
  assert.deepEqual(later.settled, []);
  assert.equal(later.state.updated, owedSince);
  assert.deepEqual(later.state, fresh);
  // A held that calls a segment covered is refused, never taken: the day
  // pack of names was built while the segment was owed and lacks its records.
  const careless: Held = (item) => (item.ref.includes("t090000z") ? { code: "covered", detail: "names-d-20261029 spans it" } : null);
  const refused = refuses(() => settle(next, careless, now), "usage");
  assert.match(refused.message, /^held answered covered for obs:oi-cs\.20261029t090000z\.20261029t091000z, a segment/);
  refuses(() => settle(next, () => ({ code: "expired", detail: "x" }) as unknown as ReturnType<Held>, now), "usage");
  // A held answer carries its detail.
  assert.match(refuses(() => settle(next, () => ({ code: "held" }) as unknown as ReturnType<Held>, now), "usage").message, /^held answered \{"code":"held"\} for /);
  // The root is asked first: an item the root names is held, however long it was owed.
  const old = validateState({ ...emptyState(owedSince), owed: [seg("0840", d("8"), "2026-09-01T00:00:00Z")] });
  assert.deepEqual(
    settle(old, () => ({ code: "held", detail: "the live root names it" }), now).settled.map((s) => s.code),
    ["held"],
  );
  assert.deepEqual(
    settle(old, () => null, now).settled.map((s) => s.code),
    ["expired"],
  );
  // settle's own arguments: a time to the second, a held function, a state of this format.
  assert.match(refuses(() => settle(old, () => null, "yesterday"), "usage").message, /now "yesterday" is not an ISO 8601 UTC time to the second/);
  assert.match(refuses(() => settle(old, 7 as unknown as Held, now), "usage").message, /held is not a function/);
  refuses(() => settle({ ...old, format: "domains.state.v2" } as unknown as State, () => null, now), "format");
});

test("guard: a run with no proposal leaves the state as it is, and pushes no state, the first one included", () => {
  const reg = new MockRegistry();
  const none = pushJob(reg, [], { now: NOW1, run: RUN1 });
  assert.equal(none.advanced.changed, false);
  assert.equal(none.moved, null);
  assert.equal(reg.tags.size, 0);
  firstRun(reg);
  const live = reg.state()!;
  const tags = new Map(reg.tags);
  const idle = pushJob(reg, [], { now: NOW2, run: RUN2 });
  assert.equal(idle.advanced.changed, false);
  assert.equal(idle.advanced.state.updated, live.updated);
  assert.deepEqual(idle.advanced.state, live);
  assert.deepEqual(reg.tags, tags);
});
