// packages/feed/src/time.ts: windows, and the precision a feed row reads back
// with. Synthetic rows; the precision table is the one of helpers.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWindow, FeedError, inWindow, rowPrecision, rowSpan } from "../src/index.ts";
import { BIT, D, DAY, row, table } from "./helpers.ts";

const isFeed = (code: string) => (e: unknown) => e instanceof FeedError && e.code === code;

test("time: precision: a row reads back as day precision from a day source at the start of a day, else as second", () => {
  const p = table.precision;
  assert.equal(rowPrecision(row("com.a", D * DAY, { sources: [BIT.isc] }), p), "day");
  assert.equal(rowPrecision(row("com.a", D * DAY, { sources: [BIT.oiNrd, BIT.isc] }), p), "day", "a day source and the start of its day: the day holds the instant");
  assert.equal(rowPrecision(row("com.a", D * DAY + 7, { sources: [BIT.oiNrd, BIT.isc] }), p), "second");
  assert.equal(rowPrecision(row("com.a", D * DAY, { sources: [BIT.oiNrd] }), p), "second", "a second source at midnight is a second");
  assert.deepEqual(rowSpan(row("com.a", D * DAY, { sources: [BIT.isc] }), p), { t0: D * DAY, t1: (D + 1) * DAY });
  assert.deepEqual(rowSpan(row("com.a", D * DAY + 7), p), { t0: D * DAY + 7, t1: D * DAY + 8 });
  // A row of day sources alone at another second than the start of a day
  // cannot come from the builder.
  assert.throws(() => rowPrecision(row("com.a", D * DAY + 5, { sources: [BIT.isc, BIT.whoisds] }), p), isFeed("precision"));
});

test("time: a window is half-open, and a day row is inside it when its day overlaps it", () => {
  const p = table.precision;
  const second = row("com.s", D * DAY + 100);
  assert.equal(inWindow(second, { t0: D * DAY + 100, t1: D * DAY + 101 }, p), true);
  assert.equal(inWindow(second, { t0: D * DAY, t1: D * DAY + 100 }, p), false);
  assert.equal(inWindow(second, { t0: D * DAY + 101, t1: D * DAY + 200 }, p), false);
  const day = row("com.d", D * DAY, { sources: [BIT.isc] });
  assert.equal(inWindow(day, { t0: (D + 1) * DAY - 1, t1: (D + 1) * DAY }, p), true, "the last second of the day");
  assert.equal(inWindow(day, { t0: (D + 1) * DAY, t1: (D + 2) * DAY }, p), false, "the next day");
  assert.equal(inWindow(day, { t0: D * DAY - 10, t1: D * DAY }, p), false, "the window ends where the day starts");
  for (const w of [
    { t0: 5, t1: 5 },
    { t0: -1, t1: 5 },
    { t0: 1.5, t1: 5 },
    { t0: 0, t1: Number.NaN },
  ])
    assert.throws(() => checkWindow(w), isFeed("window"), JSON.stringify(w));
});
