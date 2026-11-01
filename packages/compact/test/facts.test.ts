// The certificate facts as the hour and the day builds read them
// (packages/compact/src/facts.ts, DOM-026): eventFactsOf over the tables of
// facts.json (parseFacts of @domains/adapter). Every key and age is made up.
//
//   node scripts/test.mjs packages/compact --name "facts:"
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFacts, type Facts, FactsError, type FactsTable, parseFacts } from "@domains/adapter";
import { CompactError, eventFactsOf } from "../src/index.ts";

// A table of `rows` [key, bit, facts], through the layer's bytes and back, as a build reads one.
const table = (rows: readonly [string, number, Facts][]): FactsTable => {
  const m = new Map<string, Map<number, Facts>>();
  for (const [key, bit, facts] of rows) {
    if (!m.has(key)) m.set(key, new Map());
    m.get(key)?.set(bit, facts);
  }
  return parseFacts(encodeFacts(m));
};

test("facts: eventFactsOf takes the minimum age per key and source bit over the tables, and gives no facts for a key with no age", () => {
  const a = table([
    ["com.alpha-synthetic", 1, { cert_age: 2_592_000 }],
    ["com.beta-synthetic", 1, { cert_age: 5 }],
    ["com.beta-synthetic", 3, {}],
  ]);
  const b = table([
    ["com.alpha-synthetic", 1, { cert_age: 100 }],
    ["com.alpha-synthetic", 3, { cert_age: 864_000 }],
    ["com.beta-synthetic", 1, { cert_age: 900_000 }],
    ["com.gamma-synthetic", 1, {}],
  ]);
  const facts = eventFactsOf([a, b]);
  // A fresh event of a domain clears an old certificate's age; each bit keeps its own.
  assert.deepEqual(facts("com.alpha-synthetic"), {
    certAges: [
      { bit: 1, seconds: 100 },
      { bit: 3, seconds: 864_000 },
    ],
  });
  // A bit with no age in either table gives none; the other bit keeps its minimum.
  assert.deepEqual(facts("com.beta-synthetic"), { certAges: [{ bit: 1, seconds: 5 }] });
  assert.equal(facts("com.gamma-synthetic"), undefined);
  assert.equal(facts("com.nowhere-synthetic"), undefined);
  // The order of the tables does not change the answer.
  const turned = eventFactsOf([b, a]);
  for (const k of ["com.alpha-synthetic", "com.beta-synthetic", "com.gamma-synthetic"]) assert.deepEqual(turned(k), facts(k), k);
  // One table is read as it is; no table gives no facts.
  assert.deepEqual(eventFactsOf([a])("com.alpha-synthetic"), { certAges: [{ bit: 1, seconds: 2_592_000 }] });
  assert.equal(eventFactsOf([])("com.alpha-synthetic"), undefined);
});

test("facts: eventFactsOf refuses tables that are not a list of Maps", () => {
  assert.throws(
    () => eventFactsOf("tables" as never),
    (e: unknown) => e instanceof CompactError && e.code === "usage",
  );
  assert.throws(
    () => eventFactsOf([{}] as never),
    (e: unknown) => e instanceof FactsError && e.code === "usage",
  );
  assert.throws(
    () => eventFactsOf([new Map(), {}] as never),
    (e: unknown) => e instanceof FactsError && e.code === "usage",
  );
});
