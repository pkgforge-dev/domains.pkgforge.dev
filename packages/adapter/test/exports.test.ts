// The three checks of packages/adapter that scripts/ingest/run.mjs and
// packages/state call (DOM-024): checkHistory of band.ts, and checkResult and
// checkSources of harness.ts. Each is exported from the package, and each is
// the function checkBand or runAdapter itself uses: a planted fault (a day
// listed twice, stats that are not numbers, a segment of a foreign source) is
// refused by the export with the very message the inner call gives. The
// adapters and recordings are the synthetic ones of synthetic.ts and
// fixtures/http/.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { readRecordings } from "../node/files.ts";
import * as adapter from "../src/index.ts";
import type { Band, BandDay, Cursor, RunResult, Source } from "../src/index.ts";
import { BandError, ContractError, checkBand, checkHistory, checkResult, checkSources, HARNESS_USER_AGENT, memoryWriter, replayFetch, runAdapter } from "../src/index.ts";
import { DAY_SOURCE, type DayPlant, dayAdapter } from "./synthetic.ts";

const RECORDINGS = readRecordings(join(import.meta.dirname, "fixtures", "http"));
const NOW = "2026-10-29T06:00:00Z";
const START: Cursor = { last_day: "2026-10-25" };
const BAND: Band = { metric: "count", min: 0.4, max: 2.5, relative: true };
const SOURCE = { id: DAY_SOURCE, precision: "day", datasets: ["names"] } as unknown as Source;

// The message of the error `fn` throws, held to its class.
function messageOf(fn: () => unknown, kind: new (...args: never[]) => Error): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof kind, `expected a ${kind.name}, got ${String(err)}`);
    return err.message;
  }
  assert.fail(`expected a ${kind.name}, and nothing was thrown`);
}

async function rejection(p: Promise<unknown>): Promise<ContractError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ContractError, String(err));
    return err;
  }
  assert.fail("expected a ContractError, and the run passed");
}

// One run of a planted adapter outside the harness: what run.mjs holds to the
// contract itself.
async function rawRun(plant: DayPlant): Promise<RunResult> {
  const ctx = Object.freeze({ fetch: replayFetch(RECORDINGS).fetch, now: NOW, userAgent: HARNESS_USER_AGENT, writer: memoryWriter() });
  return dayAdapter(plant).run(START, ctx);
}

test("adapter exports: checkHistory is the history check of checkBand, refusing a day listed twice with checkBand's own message", () => {
  assert.equal(adapter.checkHistory, checkHistory);
  const good: BandDay[] = [
    { day: "2026-10-27", count: 5, quarantined: false },
    { day: "2026-10-26", count: 4, quarantined: true },
  ];
  assert.deepEqual(
    checkHistory(good).map((d) => d.day),
    ["2026-10-26", "2026-10-27"],
  );
  const twice: BandDay[] = [...good, { day: "2026-10-26", count: 9, quarantined: false }];
  const own = messageOf(() => checkHistory(twice), BandError);
  assert.equal(own, "history lists 2026-10-26 twice");
  assert.equal(
    messageOf(() => checkBand(5, twice, BAND, { precision: "day" }), BandError),
    own,
  );
  const badDay = [{ day: "2026-02-30", count: 1, quarantined: false }];
  assert.equal(
    messageOf(() => checkHistory(badDay), BandError),
    messageOf(() => checkBand(1, badDay, BAND, { precision: "day" }), BandError),
  );
});

test("adapter exports: checkResult is runAdapter's result check, refusing stats that are not numbers with the harness's own message", async () => {
  assert.equal(adapter.checkResult, checkResult);
  const clean = await rawRun("none");
  assert.equal(checkResult(clean, "run 1"), clean);
  const bad = await rawRun("bad-stats");
  const own = messageOf(() => checkResult(bad, "run 1"), ContractError);
  assert.equal(own, "result: run 1: stats is not an object of finite numbers");
  const harness = await rejection(runAdapter(dayAdapter("bad-stats"), { recordings: RECORDINGS, cursor: START, now: NOW }));
  assert.equal(harness.check, "result");
  assert.equal(harness.message, own);
  assert.equal(
    messageOf(() => checkResult(null, "run 1"), ContractError),
    "result: run 1: run() did not return an object",
  );
});

test("adapter exports: checkSources is runAdapter's source check, refusing a segment of a foreign source with the harness's own message", async () => {
  assert.equal(adapter.checkSources, checkSources);
  const clean = await rawRun("none");
  checkSources(clean.segments, [SOURCE], "run 1");
  const foreign = await rawRun("other-source");
  const own = messageOf(() => checkSources(foreign.segments, [SOURCE], "run 1"), ContractError);
  assert.equal(own, `source: run 1: segments[0] is of example-other, which is not one of the adapter's sources (${DAY_SOURCE})`);
  const harness = await rejection(runAdapter(dayAdapter("other-source"), { recordings: RECORDINGS, cursor: START, now: NOW, sources: [SOURCE] }));
  assert.equal(harness.check, "source");
  assert.equal(harness.message, own);
  // Another precision is refused alike.
  assert.match(
    messageOf(() => checkSources(clean.segments, [{ ...SOURCE, precision: "second" }], "run 1"), ContractError),
    /^source: run 1: segments\[0\] has precision day; example-day is second$/,
  );
});

test("adapter exports: each arm of checkResult and checkHistory refuses with its own error, never a TypeError, and checkBand refuses a count that is not finite", () => {
  const segment = {
    source: DAY_SOURCE,
    dataset: "names",
    window: { start: "2026-10-26T00:00:00Z", end: "2026-10-27T00:00:00Z" },
    cursorBefore: null,
    cursorAfter: null,
    count: 0,
    precision: "day",
    bytes: 0,
    sha256: "0".repeat(64),
  };
  const result = { segments: [], cursor: null, stats: {}, errors: [] };
  const contract: [unknown, RegExp][] = [
    [{ ...result, segments: "abc" }, /^result: x: segments is not a list$/],
    [{ ...result, segments: [5] }, /^segment: x: segments\[0\]/],
    [{ ...result, segments: [{ ...segment, records: "x" }] }, /^segment: x: segments\[0\].*unknown field records/],
    [{ ...result, stats: [] }, /^result: x: stats is not an object of finite numbers$/],
    [{ ...result, stats: { n: Number.POSITIVE_INFINITY } }, /^result: x: stats is not an object of finite numbers$/],
    [{ ...result, errors: "none" }, /^result: x: errors is not a list$/],
    [{ ...result, errors: [{ source: DAY_SOURCE, code: "http" }] }, /^result: x: errors\[0\] is not \{ source, code, detail \}$/],
    [{ ...result, errors: [null] }, /^result: x: errors\[0\] is not \{ source, code, detail \}$/],
    [7, /^result: x: run\(\) did not return an object$/],
  ];
  for (const [value, re] of contract)
    assert.match(
      messageOf(() => checkResult(value, "x"), ContractError),
      re,
      JSON.stringify(value),
    );
  assert.match(
    messageOf(() => checkHistory("abc"), BandError),
    /^history is not a list$/,
  );
  assert.match(
    messageOf(() => checkHistory([null]), BandError),
    /^history\[0\] is not an object$/,
  );
  assert.match(
    messageOf(() => checkHistory([7]), BandError),
    /^history\[0\] is not an object$/,
  );
  assert.match(
    messageOf(() => checkHistory([{ day: "2026-10-26", count: Number.POSITIVE_INFINITY, quarantined: false }]), BandError),
    /history\[0\]\.count null is not a finite number of at least 0/,
  );
  assert.match(
    messageOf(() => checkBand(Number.POSITIVE_INFINITY, [], BAND, { precision: "day" }), BandError),
    /^count null is not a finite number of at least 0$/,
  );
  assert.match(
    messageOf(() => checkBand(Number.NaN, [], BAND, { precision: "day" }), BandError),
    /^count null is not a finite number of at least 0$/,
  );
});
