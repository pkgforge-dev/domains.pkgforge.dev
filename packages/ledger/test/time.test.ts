// packages/ledger/src/time.ts: first and last seen across a `day` and a `second`
// source, the precision table, ISO times, and the corpus state. Synthetic records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { corpusState, DAY_SECONDS, firstSeen, isoOf, LedgerError, lastSeen, precisionsOf, secondsOf } from "../src/index.ts";
import { domainRecord, seen } from "./helpers.ts";

// Bit 0 is a day source (as thc-ct), bit 5 a second source (as ct-le).
const precision = precisionsOf([
  { bit: 0, precision: "day" },
  { bit: 5, precision: "second" },
  { bit: null, precision: "day" },
]);
const D = 298; // 2026-10-26
const S = D * DAY_SECONDS; // 2026-10-26T00:00:00Z
const isLedger = (code: string) => (e: unknown) => e instanceof LedgerError && e.code === code;

test("precision: a day value counts as the start of its day for first seen", () => {
  const r = domainRecord("com.example", [seen(0, D), seen(5, S + 10)]);
  assert.deepEqual(firstSeen(r, precision), { at: S, precision: "day", bit: 0 });
  assert.equal(isoOf(firstSeen(r, precision)), "2026-10-26");
});

test("precision: a second source before the day's start is first, and a tie goes to the second source", () => {
  assert.deepEqual(firstSeen(domainRecord("com.example", [seen(0, D), seen(5, S - 1)]), precision), { at: S - 1, precision: "second", bit: 5 });
  assert.deepEqual(firstSeen(domainRecord("com.example", [seen(0, D), seen(5, S)]), precision), { at: S, precision: "second", bit: 5 });
  assert.equal(isoOf({ at: S - 1, precision: "second", bit: 5 }), "2026-10-25T23:59:59Z");
});

test("precision: a day value counts as the end of its day for last seen", () => {
  // The second source's 01:23:20 is inside the day source's last day.
  assert.deepEqual(lastSeen(domainRecord("com.example", [seen(0, D - 3, D), seen(5, S - 100, S + 5000)]), precision), { at: S, precision: "day", bit: 0 });
  // The second source's first second of the next day is later.
  assert.deepEqual(lastSeen(domainRecord("com.example", [seen(0, D - 3, D), seen(5, S, S + DAY_SECONDS)]), precision), { at: S + DAY_SECONDS, precision: "second", bit: 5 });
  // The day's last second ties, and the second source states the instant.
  assert.deepEqual(lastSeen(domainRecord("com.example", [seen(0, D), seen(5, S + DAY_SECONDS - 1)]), precision), { at: S + DAY_SECONDS - 1, precision: "second", bit: 5 });
});

test("precision: a bit the table does not name, two precisions for one bit and an unknown precision are refused", () => {
  assert.throws(() => firstSeen(domainRecord("com.example", [seen(3, D)]), precision), isLedger("precision"));
  assert.throws(
    () =>
      precisionsOf([
        { bit: 1, precision: "day" },
        { bit: 1, precision: "second" },
      ]),
    isLedger("precision"),
  );
  assert.throws(() => precisionsOf([{ bit: 1, precision: "hour" }]), isLedger("precision"));
  assert.throws(() => precisionsOf([{ bit: 64, precision: "day" }]), isLedger("precision"));
  assert.throws(() => firstSeen(domainRecord("com.example", []), precision), isLedger("usage"));
});

test("time: secondsOf reads ISO 8601 UTC dates and times from the 2026 epoch, and refuses anything else", () => {
  assert.equal(secondsOf("2026-01-01"), 0);
  assert.equal(secondsOf("2026-09-01"), 243 * DAY_SECONDS);
  assert.equal(secondsOf("2026-10-26T00:00:10Z"), S + 10);
  assert.equal(secondsOf("2026-10-26T00:00:10.999Z"), S + 10);
  for (const bad of ["2025-12-31", "2026-02-30", "2026-10-26T24:00:00Z", "2026-10-26 00:00:00", "2026-10-26T00:00:00+01:00", "", "1792000000"])
    assert.throws(() => secondsOf(bad), isLedger("time"), bad);
});

test("warming: the corpus is warming for 90 days after corpus_since, then full", () => {
  // 2026-09-01 plus 90 days is 2026-11-30.
  assert.equal(corpusState("2026-09-01", "2026-09-01"), "warming");
  assert.equal(corpusState("2026-11-29T23:59:59Z", "2026-09-01"), "warming");
  assert.equal(corpusState("2026-11-30T00:00:00Z", "2026-09-01"), "full");
  assert.equal(corpusState("2027-03-01", "2026-09-01"), "full");
  assert.equal(corpusState("2026-09-02", "2026-09-01", 1), "full");
  assert.throws(() => corpusState("2026-08-31", "2026-09-01"), isLedger("time"));
  assert.throws(() => corpusState("2026-10-01", "2026-09-01", -1), isLedger("usage"));
});
