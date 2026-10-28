// packages/names/src/key.ts: reversed labels, their inverse, and the key range
// of a subtree. The range test holds the three keys that sort beside a parent
// (`np.com-x`, `np.com0`, `np.comz`); a seeded property test holds the range to
// the descendants of random parents over an alphabet with `-`, `_` and digits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromKey, key, rangeOfDescendants } from "../src/key.ts";
import { NameError } from "../src/syntax.ts";

const inRange = (k: string, [start, end]: readonly [string, string]) => k >= start && k < end;
const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a, "latin1"), Buffer.from(b, "latin1"));

test("names key: reverses the labels, and fromKey inverts it", () => {
  assert.equal(key("api.example.com.np"), "np.com.example.api");
  assert.equal(fromKey("np.com.example.api"), "api.example.com.np");
  assert.equal(key("np.com"), "com.np");
  assert.equal(key("com.np"), "np.com");
  assert.equal(key("_dmarc.example.com"), "com.example._dmarc");
  assert.equal(key("np"), "np");
  assert.equal(fromKey(key("a.b-c.d_e.0")), "a.b-c.d_e.0");
});

test("names key: the descendants range of np.com holds np.com.a and excludes np.com itself, np.com-x, np.com0 and np.comz", () => {
  const range = rangeOfDescendants("np.com");
  assert.deepEqual(range, ["np.com.", "np.com/"]);
  for (const k of ["np.com.a", "np.com.example", "np.com.example.api", "np.com.-", "np.com.0", "np.com.z", "np.com._dmarc"]) assert.equal(inRange(k, range), true, k);
  // np.com is the point lookup; np.com-x sorts below the range (`-` is below
  // `.`), np.com0 and np.comz above it (`0` and `z` are above `/`).
  for (const k of ["np.com", "np.com-x", "np.com-x.a", "np.com0", "np.com0.a", "np.comz", "np.comz.a", "np.co", "np.con", "np"]) assert.equal(inRange(k, range), false, k);
  // A whole top-level domain is one range too.
  const np = rangeOfDescendants("np");
  assert.equal(inRange("np.com", np), true);
  assert.equal(inRange("np.com-x", np), true);
  assert.equal(inRange("np-x.com", np), false);
  assert.equal(inRange("npa.com", np), false);
});

test("names key: key order is byte order, and is not label-by-label order: np.com-x sorts before np.com.a", () => {
  const keys = ["np.com.a", "np.com-x", "np.com", "np.com0", "np.comz", "np.com._", "np.com.-"];
  const sorted = [...keys].sort();
  assert.deepEqual(sorted, [...keys].sort(bytewise));
  assert.deepEqual(sorted, ["np.com", "np.com-x", "np.com.-", "np.com._", "np.com.a", "np.com0", "np.comz"]);
  // Label by label, `com` is a prefix of `com-x`, so np.com.a would come first.
  const byLabels = (a: string, b: string) => {
    const x = a.split(".");
    const y = b.split(".");
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
    return x.length - y.length;
  };
  assert.equal(byLabels("np.com.a", "np.com-x"), -1);
  assert.equal("np.com-x" < "np.com.a", true);
});

// A small seeded generator (mulberry32), so a failure names its seed and repeats.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("names key: seeded property: fromKey(key(n)) is n, string order is byte order, and the range holds exactly the descendants", () => {
  const ALPHABET = ["a", "z", "0", "9", "-", "_", "m"];
  for (const seed of [1, 2, 3, 20261028]) {
    const next = rng(seed);
    const pick = (n: number) => Math.floor(next() * n);
    const label = () => Array.from({ length: 1 + pick(3) }, () => ALPHABET[pick(ALPHABET.length)]).join("");
    const names = new Set<string>();
    while (names.size < 600) names.add(Array.from({ length: 1 + pick(4) }, label).join("."));
    const all = [...names];
    for (const n of all) assert.equal(fromKey(key(n)), n, `seed ${seed}: ${n}`);
    const keys = all.map(key);
    assert.deepEqual([...keys].sort(), [...keys].sort(bytewise), `seed ${seed}`);
    // Parents: every name and every suffix of a name.
    const parents = new Set<string>();
    for (const n of all) {
      const labels = n.split(".");
      for (let i = 0; i < labels.length; i++) parents.add(labels.slice(i).join("."));
    }
    for (const p of parents) {
      const range = rangeOfDescendants(key(p));
      for (const n of all) assert.equal(inRange(key(n), range), n.endsWith(`.${p}`), `seed ${seed}: ${n} under ${p}`);
    }
  }
});

test("names key: key, fromKey and rangeOfDescendants refuse text that is not lowercase labels", () => {
  for (const [text, reason] of [
    ["", "label-empty"],
    ["a..b", "label-empty"],
    ["a.b.", "label-empty"],
    [".a", "label-empty"],
    ["A.b", "upper"],
    ["ü.b", "high"],
    ["a/b", "charset"],
    [`${"a".repeat(64)}.b`, "label-long"],
    [`${"a.".repeat(127)}b`, "name-long"],
  ] as const) {
    for (const fn of [key, fromKey, rangeOfDescendants]) {
      assert.throws(
        () => fn(text),
        (e: Error) => e instanceof NameError && e.reason === reason,
        `${fn.name}(${JSON.stringify(text)})`,
      );
    }
  }
});
