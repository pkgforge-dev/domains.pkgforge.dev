// packages/ledger/bench/ledger-filter.mjs: its flags, its verdict, and one small
// run. The keys are the bench's own synthetic keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bench, judge, parseFlags, SCHEMA, syntheticKey, UsageError } from "../bench/ledger-filter.mjs";

test("bench: flags take whole numbers, --keys is required, and an unknown flag is refused", () => {
  assert.deepEqual(parseFlags(["--keys", "10000000"]), { keys: 10_000_000, absent: 1_000_000, delta: 800_000, seed: 1, bitsPerKey: 10, hashes: 7, out: null });
  assert.equal(parseFlags(["--keys=5", "--absent=7", "--out", "x.json"]).absent, 7);
  for (const argv of [[], ["--keys"], ["--keys", "0"], ["--keys", "1.5"], ["--keys", "5", "--fast", "1"], ["5"]]) assert.throws(() => parseFlags(argv), UsageError, argv.join(" "));
});

test("bench: the verdict fails a rate outside 0.8% to 1.2%, a filter above its size, a missed key and a failed round trip", () => {
  const good = { keys: 1000, bits_per_key: 10, rate: 0.0082, filter_bytes: 1260, missed: 0, round_trip: true };
  assert.equal(judge(good).pass, true);
  assert.equal(judge({ ...good, rate: 0.0079 }).pass, false);
  assert.equal(judge({ ...good, rate: 0.0121 }).pass, false);
  assert.equal(judge({ ...good, filter_bytes: 1263 }).pass, false);
  assert.equal(judge({ ...good, missed: 1 }).pass, false);
  assert.equal(judge({ ...good, round_trip: false }).pass, false);
});

test("bench: a run of 200,000 keys measures the rate against the theory and passes", (t) => {
  const r = bench(parseFlags(["--keys", "200000", "--absent", "200000", "--delta", "5000"]));
  t.diagnostic(`rate ${r.rate}, theory ${r.theory}, filter ${r.filter_bytes} B, delta ${r.delta_bytes} B`);
  assert.equal(r.schema, SCHEMA);
  assert.equal(r.missed, 0);
  assert.equal(r.delta_bytes, 32 + 8 * 5000);
  assert.ok(Math.abs(r.rate - r.theory) < 5 * r.sigma);
  assert.equal(r.pass, true);
  assert.notEqual(syntheticKey(1, 1), syntheticKey(1, 2));
});
