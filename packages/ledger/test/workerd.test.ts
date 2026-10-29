// packages/ledger in workerd (Miniflare, through @domains/testkit), under the
// harness's compatibility date and flags (no nodejs_compat): the Worker path is
// run, not assumed. test/ledger-worker.ts answers what the ledger's src gives in
// workerd, and each answer is held equal to Node's on the same input.
// Synthetic keys and records; the PSL is the pinned fixture.
//
//   node scripts/test.mjs packages/ledger --name workerd
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withWorker } from "@domains/testkit";
import { toHex } from "@domains/pack";
import { aggregateToDomains, BloomFilter, firstSeen, HashDelta, hashHex, hashKey, lastSeen, precisionsOf } from "../src/index.ts";
import { collect, domainKey, domainRecord, nameRecord, PSL_PATH, pinnedPsl, seen } from "./helpers.ts";

const WORKER = join(import.meta.dirname, "ledger-worker.ts");

test("ledger workerd: the hash, the filter and delta bytes, first seen, the corpus state and the aggregation answer in workerd as in Node", async () => {
  const filter = BloomFilter.forKeys(500, { asOf: 298 * 86_400 });
  for (let n = 0; n < 500; n += 1) filter.add(hashKey(domainKey(n)));
  const delta = HashDelta.empty(filter);
  for (let n = 500; n < 520; n += 1) delta.add(hashKey(domainKey(n)));
  const keys = [domainKey(3), domainKey(510), "com.never-added", "x".repeat(400)];
  const record = domainRecord("com.example", [seen(0, 298), seen(5, 298 * 86_400 + 10, 299 * 86_400)]);
  const names = [nameRecord("com.my-site", [seen(0, 5)]), nameRecord("com.my.www", [seen(0, 7)]), nameRecord("uk.co.example.www", [seen(5, 9, 99)])];
  const precision = precisionsOf([
    { bit: 0, precision: "day" },
    { bit: 5, precision: "second" },
  ]);
  const psl = await pinnedPsl();
  await withWorker({ scriptPath: WORKER }, async (w) => {
    const body = { keys, filter: toHex(filter.encode()), delta: toHex(delta.encode()), record, psl: readFileSync(PSL_PATH, "utf8"), names };
    const res = await w.fetch("/ledger", { method: "POST", body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    const got = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(
      got.hashes,
      keys.map((k) => hashHex(hashKey(k))),
    );
    assert.deepEqual(
      got.has,
      keys.map((k) => filter.has(hashKey(k)) || delta.has(hashKey(k))),
    );
    assert.deepEqual(got.has, [true, true, false, false]);
    assert.deepEqual(got.delta, [...delta.hashes()].map(hashHex));
    assert.deepEqual(got.first, firstSeen(record, precision));
    assert.deepEqual(got.last, lastSeen(record, precision));
    assert.deepEqual(got.state, ["warming", "full"]);
    assert.deepEqual(got.domains, await collect(aggregateToDomains(names, psl)));
    // A delta of another filter is refused in workerd too.
    const other = BloomFilter.forKeys(10, { asOf: 1 });
    const refused = await w.fetch("/ledger", { method: "POST", body: JSON.stringify({ ...body, filter: toHex(other.encode()) }) });
    assert.equal(refused.status, 422);
    assert.equal(((await refused.json()) as { code: string }).code, "pair");
  });
});
