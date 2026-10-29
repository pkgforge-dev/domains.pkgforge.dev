// packages/adapter/src/harness.ts on the synthetic adapters of synthetic.ts
// and the synthetic recordings of fixtures/http/. Each
// refusal test plants one fault, the one its check catches; a clean adapter
// passes every check.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRecordings } from "../node/files.ts";
import { HARNESS_USER_AGENT, parseRecording, RECORDING_FORMAT, type Recording, replayFetch, runAdapter } from "../src/harness.ts";
import type { Source } from "../src/types.ts";
import { ContractError } from "../src/validate.ts";
import { BASE, DAY_SOURCE, type DayPlant, dayAdapter, FILE_SOURCE, fileAdapter, NETWORK_OPENS } from "./synthetic.ts";

const HTTP = join(import.meta.dirname, "fixtures", "http");
const RECORDINGS = readRecordings(HTTP);
const NOW = "2026-10-29T06:00:00Z";
const START = { last_day: "2026-10-25" };

const run = (plant: DayPlant, extra: { sources?: readonly Source[] } = {}) => runAdapter(dayAdapter(plant), { recordings: RECORDINGS, cursor: START, now: NOW, ...extra });

// Rejects with a ContractError of exactly this check.
async function refuses(p: Promise<unknown>, check: string): Promise<ContractError> {
  let caught: unknown = null;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ContractError, `expected a ContractError ${check}, got ${caught === null ? "no error" : String(caught)}`);
  assert.equal(caught.check, check, caught.message);
  return caught;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

test("adapter harness: reads the fixture recordings in file-name order, each labelled synthetic", () => {
  assert.deepEqual(
    RECORDINGS.map((r) => r.name),
    ["day-2026-10-26.http.json", "day-2026-10-27.http.json", "day-2026-10-28.http.json", "file-2026-10-28.http.json", "file-latest-unchanged.http.json", "file-latest.http.json"],
  );
  assert.ok(RECORDINGS.every((r) => r.origin === "synthetic" && r.recordedAt === null));
});

test("adapter harness: a clean day adapter passes all three runs, and run 3 writes nothing new", async () => {
  const { first, again, next } = await run("none");
  const segs = first.result.segments;
  assert.deepEqual(
    segs.map((s) => [s.source, s.window.start, s.count]),
    [
      [DAY_SOURCE, "2026-10-26T00:00:00Z", 2],
      [DAY_SOURCE, "2026-10-27T00:00:00Z", 1],
    ],
  );
  // The in-memory writer's digest is the SHA-256 of each record's canonical JSON and a newline.
  assert.equal(segs[0]!.sha256, sha('{"key":"com.example.a"}\n{"key":"org.example.b"}\n'));
  assert.equal(segs[0]!.raw?.sha256, sha("a.example.com\nb.example.org\na.example.com\n"));
  assert.deepEqual(first.result.cursor, { last_day: "2026-10-27" });
  assert.deepEqual(again.result.segments, segs);
  assert.deepEqual(next.result.segments, []);
  assert.deepEqual(
    next.requests.map((r) => [r.url, r.recording]),
    [[`${BASE}2026-10-28.txt`, "day-2026-10-28.http.json"]],
  );
  assert.ok(first.requests.every((r) => r.userAgent === HARNESS_USER_AGENT));
});

test("adapter harness: an adapter that calls an unrecorded URL fails the unrecorded check", async () => {
  const err = await refuses(run("extra-url"), "unrecorded");
  assert.match(err.message, /GET https:\/\/feed\.example\.test\/robots\.txt/);
});

test("adapter harness: an unrecorded URL fails the run even when the adapter catches the error", async () => {
  await refuses(run("extra-url-caught"), "unrecorded");
});

test("adapter harness: an adapter whose two runs differ fails the deterministic check", async () => {
  const err = await refuses(run("nondeterministic"), "deterministic");
  assert.match(err.message, /segments\[0\] differs/);
});

test("adapter harness: an adapter whose two runs return different cursors fails the deterministic check", async () => {
  const err = await refuses(run("cursor-differs"), "deterministic");
  assert.match(err.message, /the cursor differs between two runs/);
});

test("adapter harness: an adapter that calls the global fetch fails, and the global fetch is restored", async () => {
  const before = globalThis.fetch;
  await refuses(run("global-fetch"), "global-fetch");
  assert.equal(globalThis.fetch, before);
});

// Stand-ins for the network globals, so a trap that is missing reaches a
// constructor that records the call instead of the network.
test("adapter harness: an adapter that opens a WebSocket, an XMLHttpRequest or an EventSource fails the global-fetch check, even when it catches the error", async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const names = NETWORK_OPENS.map(([name]) => name);
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const reached: string[] = [];
  const standIns = names.map(
    (name) =>
      class {
        constructor() {
          reached.push(name);
        }
      },
  );
  names.forEach((name, i) => {
    Object.defineProperty(globalThis, name, { value: standIns[i], configurable: true, writable: true });
  });
  try {
    const err = await refuses(run("network-globals"), "global-fetch");
    assert.deepEqual(reached, []);
    assert.deepEqual(err.message.split(" was called for ")[1]!.split(", "), ["WebSocket wss://feed.example.test/ws", "XMLHttpRequest", "EventSource https://feed.example.test/events"]);
    // Each global is the one it was before the run.
    names.forEach((name, i) => {
      assert.equal(g[name], standIns[i], name);
    });
  } finally {
    names.forEach((name, i) => {
      const d = saved[i];
      if (d === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, d);
    });
  }
});

test("adapter harness: a request without ctx.userAgent fails the user-agent check", async () => {
  await refuses(run("no-user-agent"), "user-agent");
  await refuses(run("own-user-agent"), "user-agent");
});

// The window check of run 3 would also catch a cursor that stays put; this one
// names the fault before run 3 reads anything.
test("adapter harness: segments written while the cursor stays put fail the continuation check before run 3", async () => {
  const err = await refuses(run("stuck-cursor"), "continuation");
  assert.match(err.message, /run 1 wrote segments and returned the cursor it started from/);
});

test("adapter harness: a cursor that stops short of the last window written fails the continuation check", async () => {
  const err = await refuses(run("rewind-cursor"), "continuation");
  assert.match(err.message, /run 3, from run 1's cursor, wrote example-day names 2026-10-27T00:00:00Z/);
});

test("adapter harness: segments written but not returned fail the reported check", async () => {
  await refuses(run("unreported"), "reported");
});

test("adapter harness: a segment of a source the adapter does not hold fails the source check", async () => {
  const source = { id: DAY_SOURCE, precision: "day", datasets: ["names"] } as unknown as Source;
  await run("none", { sources: [source] });
  await refuses(run("other-source", { sources: [source] }), "source");
  await refuses(run("none", { sources: [{ ...source, precision: "second" }] }), "source");
  await refuses(run("none", { sources: [{ ...source, datasets: ["domains"] }] }), "source");
});

test("adapter harness: an adapter that throws fails the threw check, with the error as its cause", async () => {
  const err = await refuses(run("throws"), "threw");
  assert.match(String((err.cause as Error).message), /planted/);
});

test("adapter harness: a cursor over 4 KiB fails the cursor check", async () => {
  await refuses(run("big-cursor"), "cursor");
});

test("adapter harness: stats that are not numbers, or an error that is not { source, code, detail }, fail the result check", async () => {
  const stats = await refuses(run("bad-stats"), "result");
  assert.match(stats.message, /stats is not an object of finite numbers/);
  for (const plant of ["nan-stats", "infinite-stats"] as const) {
    const fault = await refuses(run(plant), "result");
    assert.match(fault.message, /stats is not an object of finite numbers/, plant);
  }
  const errors = await refuses(run("bad-errors"), "result");
  assert.match(errors.message, /errors\[0\] is not \{ source, code, detail \}/);
});

test("adapter harness: each run gets its own copy of the cursor, so an adapter that moves its argument changes neither run 2 nor the caller's cursor", async () => {
  const cursor = { last_day: "2026-10-25" };
  const { first, again } = await runAdapter(dayAdapter("mutate-cursor"), { recordings: RECORDINGS, cursor, now: NOW });
  assert.equal(first.result.segments.length, 2);
  assert.deepEqual(again.result.segments, first.result.segments);
  assert.deepEqual(cursor, { last_day: "2026-10-25" });
});

test("adapter harness: ctx is frozen, so an adapter that replaces ctx.fetch throws a TypeError", async () => {
  const err = await refuses(run("assign-ctx"), "threw");
  assert.ok(err.cause instanceof TypeError, String(err.cause));
});

test("adapter harness: a second runAdapter while one runs is refused, and the first still passes", async () => {
  const before = globalThis.fetch;
  const one = runAdapter(dayAdapter(), { recordings: RECORDINGS, cursor: START, now: NOW });
  const two = runAdapter(dayAdapter(), { recordings: RECORDINGS, cursor: START, now: NOW });
  const [a, b] = await Promise.allSettled([one, two]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.ok(b.status === "rejected" && b.reason instanceof ContractError && b.reason.check === "options", String(b.status === "rejected" && b.reason));
  assert.equal(globalThis.fetch, before);
});

test("adapter harness: a conditional GET finds its 304 by header, and a redirect is followed hop by hop", async () => {
  const { first, next } = await runAdapter(fileAdapter(), { recordings: RECORDINGS, cursor: { etag: null }, now: NOW });
  assert.deepEqual(
    first.requests.map((r) => r.recording),
    ["file-latest.http.json", "file-2026-10-28.http.json"],
  );
  assert.equal(first.result.segments[0]!.source, FILE_SOURCE);
  assert.equal(first.result.segments[0]!.window.start, "2026-10-28T00:00:00Z");
  assert.deepEqual(first.result.cursor, { etag: '"v1"' });
  assert.deepEqual(first.result.stats, { redirected: 1 });
  assert.deepEqual(
    next.requests.map((r) => r.recording),
    ["file-latest-unchanged.http.json"],
  );
  assert.deepEqual(next.result.segments, []);
});

test("adapter harness: without the 304 recording the conditional GET reads the file again, which fails continuation", async () => {
  const recordings = RECORDINGS.filter((r) => r.name !== "file-latest-unchanged.http.json");
  await refuses(runAdapter(fileAdapter(), { recordings, cursor: { etag: null }, now: NOW }), "continuation");
});

test("adapter harness: options are checked before any run, an empty userAgent among them", async () => {
  await refuses(runAdapter(dayAdapter(), { recordings: RECORDINGS, cursor: START, now: NOW, userAgent: "" }), "options");
  await refuses(runAdapter(dayAdapter(), { recordings: RECORDINGS, cursor: START, now: NOW, userAgent: 1 as unknown as string }), "options");
});

test("adapter harness: redirect manual answers the 3xx itself, and redirect error rejects", async () => {
  const { fetch } = replayFetch(RECORDINGS);
  const manual = await fetch(`${BASE}latest.txt`, { redirect: "manual" });
  assert.equal(manual.status, 302);
  assert.equal(manual.headers.get("location"), "/files/2026-10-28.txt");
  await assert.rejects(fetch(`${BASE}latest.txt`, { redirect: "error" }), TypeError);
  const followed = await fetch(`${BASE}latest.txt`);
  assert.equal(followed.url, `${BASE}files/2026-10-28.txt`);
  assert.equal(followed.redirected, true);
  assert.equal(await followed.text(), "d.example.com\ne.example.com\n");
});

const synthetic = (request: object, response: object) => ({ format: RECORDING_FORMAT, origin: "synthetic", request, response });
const OK = { status: 200, headers: {}, body_base64: "" };
const GET = { method: "GET", url: `${BASE}x` };

test("adapter harness: the replay follows 20 redirects and refuses the 21st, turns a 303 into a GET, and answers HEAD with no body", async () => {
  const hop = (i: number) => parseRecording(synthetic({ method: "GET", url: `${BASE}hop/${i}` }, { status: 302, headers: { location: `/hop/${i + 1}` }, body_base64: "" }), `hop-${i}`);
  const end = parseRecording(synthetic({ method: "GET", url: `${BASE}hop/21` }, { ...OK, body_base64: "ZW5k" }), "hop-21");
  const posted = parseRecording(synthetic({ method: "POST", url: `${BASE}form` }, { status: 303, headers: { location: "/hop/21" }, body_base64: "" }), "form");
  const head = parseRecording(synthetic({ method: "HEAD", url: `${BASE}x` }, { ...OK, body_base64: "ZW5k" }), "head");
  const { fetch } = replayFetch([...Array.from({ length: 21 }, (_, i) => hop(i)), end, posted, head]);
  // hop/1 to hop/21 is 20 redirects; hop/0 to hop/21 is 21.
  assert.equal(await (await fetch(`${BASE}hop/1`)).text(), "end");
  await assert.rejects(fetch(`${BASE}hop/0`), (e: unknown) => e instanceof TypeError && /more than 20 redirects/.test(e.message));
  const after303 = await fetch(`${BASE}form`, { method: "POST", body: "a=1" });
  assert.deepEqual([after303.url, await after303.text()], [`${BASE}hop/21`, "end"]);
  const headed = await fetch(`${BASE}x`, { method: "HEAD" });
  assert.deepEqual([headed.status, headed.body], [200, null]);
});

test("adapter harness: a recording is refused for each fault of its shape", () => {
  const cases: [string, unknown, RegExp][] = [
    ["not an object", [], /not an object/],
    ["unknown field", { ...synthetic(GET, OK), extra: 1 }, /unknown field extra/],
    ["format", { ...synthetic(GET, OK), format: "domains.http-recording.v0" }, /format is not/],
    ["recorded without recorded_at", { ...synthetic(GET, OK), origin: "recorded" }, /needs recorded_at/],
    ["synthetic with recorded_at", { ...synthetic(GET, OK), recorded_at: "2026-10-29T00:00:00Z" }, /synthetic answer has no recorded_at/],
    ["lower-case method", synthetic({ ...GET, method: "get" }, OK), /request\.method/],
    ["not a URL", synthetic({ ...GET, url: "feed.example.test/x" }, OK), /is not a URL/],
    ["not http", synthetic({ ...GET, url: "wss://feed.example.test/x" }, OK), /not http or https/],
    ["status 100", synthetic(GET, { ...OK, status: 100 }), /response\.status/],
    ["bad base64", synthetic(GET, { ...OK, body_base64: "abc" }), /not base64/],
    ["a 304 with a body", synthetic(GET, { ...OK, status: 304, body_base64: "YQ==" }), /a 304 answer has no body/],
    ["a header twice", synthetic({ ...GET, headers: { Accept: "a", accept: "b" } }, OK), /names accept twice/],
  ];
  for (const [what, json, why] of cases)
    assert.throws(
      () => parseRecording(json, what),
      (e: unknown) => e instanceof ContractError && e.check === "recording" && why.test(e.message),
      what,
    );
  const ok = parseRecording({ ...synthetic(GET, { ...OK, body_base64: "YWI=" }), origin: "recorded", recorded_at: "2026-10-29T01:02:03Z" }, "ok");
  assert.equal(new TextDecoder().decode(ok.response.body), "ab");
  assert.equal(ok.recordedAt, "2026-10-29T01:02:03Z");
});

test("adapter harness: two recordings of one request are refused, and two equal matches leave the request unrecorded", async () => {
  const a = parseRecording(synthetic(GET, OK), "a");
  assert.throws(() => replayFetch([a, parseRecording(synthetic(GET, OK), "b")]), /same method, URL and headers/);
  const withA: Recording = parseRecording(synthetic({ ...GET, headers: { accept: "a" } }, OK), "with-accept");
  const withB: Recording = parseRecording(synthetic({ ...GET, headers: { "x-other": "b" } }, OK), "with-other");
  const replay = replayFetch([withA, withB]);
  await assert.rejects(replay.fetch(`${BASE}x`, { headers: { accept: "a", "x-other": "b" } }), /2 recordings match equally/);
  assert.equal(replay.misses.length, 1);
});

test("adapter harness: readRecordings reads only *.http.json files and refuses one that is not JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "adapter-recordings-"));
  try {
    writeFileSync(join(dir, "README.txt"), "not a recording\n");
    writeFileSync(join(dir, "a.http.json"), JSON.stringify(synthetic(GET, OK)));
    assert.deepEqual(
      readRecordings(dir).map((r) => r.name),
      ["a.http.json"],
    );
    writeFileSync(join(dir, "b.http.json"), "{ not json");
    assert.throws(
      () => readRecordings(dir),
      (e: unknown) => e instanceof ContractError && e.check === "recording" && /b\.http\.json: not JSON/.test(e.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter harness: options are checked before any run", async () => {
  await refuses(runAdapter(dayAdapter(), { recordings: RECORDINGS, cursor: START, now: "2026-10-29 06:00" }), "options");
  await refuses(runAdapter({} as never, { recordings: RECORDINGS, cursor: START, now: NOW }), "options");
  await refuses(runAdapter(dayAdapter(), { recordings: RECORDINGS, cursor: { pad: "x".repeat(4096) }, now: NOW }), "cursor");
});
