// packages/ledger/src/reconcile.ts: the hourly verdict through the filter, and
// the daily exact pass repairing it. Synthetic keys; the false positive is found
// by asking the real filter, so it is the filter's own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFilter, exactNew, HashDelta, hashKey, ProvisionalFilter, provisionalNew, reconcile } from "../src/index.ts";
import { collect, DOMAINS_CODEC, domainKey, domainRecord, readerOf, seen, writeMem } from "./helpers.ts";

const AS_OF = 297 * 86_400;

test("reconcile: a false positive of the filter is repaired by the exact join", async (t) => {
  const tableKeys = Array.from({ length: 2000 }, (_, i) => domainKey(i)).sort();
  const table = await readerOf(
    await writeMem(
      tableKeys.map((k) => domainRecord(k, [seen(0, 200)])),
      DOMAINS_CODEC,
    ),
    DOMAINS_CODEC,
  );
  const filter = await buildFilter([table], { asOf: AS_OF });
  const inTable = new Set(tableKeys);
  // The first key the table does not hold that the filter claims (a false
  // positive), and the first it rightly does not claim.
  let fp: string | null = null;
  let fresh: string | null = null;
  for (let n = 100_000; fp === null || fresh === null; n += 1) {
    const k = domainKey(n);
    if (inTable.has(k)) continue;
    if (filter.has(hashKey(k))) fp ??= k;
    else fresh ??= k;
  }
  if (fp === null || fresh === null) throw new Error("unreachable: the loop ends with both");
  // The hourly job: the false positive is judged old, the other new.
  const hour = new ProvisionalFilter(filter, HashDelta.empty(filter));
  const provisional = provisionalNew([fp, fresh].sort(), hour);
  assert.deepEqual(provisional, [fresh]);
  // The daily job: the exact join against the table finds both new.
  const day = [fp, fresh].sort().map((k) => domainRecord(k, [seen(0, 298)]));
  const exact = (await collect(exactNew(day, [table]))).map((r) => r.key);
  assert.deepEqual(exact, [fp, fresh].sort());
  const fix = reconcile(provisional, exact);
  t.diagnostic(`false positive ${fp}: judged old by the hourly filter, repaired by the exact join`);
  assert.deepEqual(fix, { confirmed: [fresh], repaired: [fp], retracted: [] });
});

test("reconcile: a provisional verdict the exact table contradicts is retracted", async () => {
  // The hourly filter was built before a daily source dated `late` to day 150.
  const filter = await buildFilter([await readerOf(await writeMem([domainRecord("com.base", [seen(0, 100)])], DOMAINS_CODEC), DOMAINS_CODEC)], { asOf: AS_OF });
  const provisional = provisionalNew(["com.late", "com.new"], new ProvisionalFilter(filter, HashDelta.empty(filter)));
  assert.deepEqual(provisional, ["com.late", "com.new"]);
  const table = await readerOf(await writeMem([domainRecord("com.base", [seen(0, 100)]), domainRecord("com.late", [seen(8, 150)])], DOMAINS_CODEC), DOMAINS_CODEC);
  const exact = (await collect(exactNew([domainRecord("com.late", [seen(0, 298)]), domainRecord("com.new", [seen(0, 298)])], [table]))).map((r) => r.key);
  assert.deepEqual(reconcile(provisional, exact), { confirmed: ["com.new"], repaired: [], retracted: ["com.late"] });
});

test("reconcile: inputs in any order and with repeats give sorted, distinct lists", () => {
  assert.deepEqual(reconcile(["com.c", "com.a", "com.c", "com.b"], ["com.d", "com.a", "com.b", "com.a"]), { confirmed: ["com.a", "com.b"], repaired: ["com.d"], retracted: ["com.c"] });
  assert.deepEqual(reconcile([], []), { confirmed: [], repaired: [], retracted: [] });
});
