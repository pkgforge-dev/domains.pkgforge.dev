// adapters/thc-ct/src/sorter.ts against Array.prototype.sort: the external
// merge sort gives every key once, ascending in byte order, its flags the OR
// of every add, whatever the run length (design section 13.1 item 17).
//
//   node scripts/test.mjs adapters/thc-ct --name "thc-ct sorter"
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Keyed, MAX_KEY, RunSorter } from "../src/sorter.ts";

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_.-";

// A seeded generator, so a failure names keys that come back on the next run.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 10,000 adds of keys from [a-z0-9_.-], repeats among them, with the key-order
// trap of packages/names/src/key.ts: `np.com-x` sorts before `np.com.a`.
function adds(seed = 7): [string, number][] {
  const r = rng(seed);
  const out: [string, number][] = [
    ["np.com.a", 1],
    ["np.com-x", 2],
    ["np.com", 1],
    ["np.com.", 2],
  ];
  while (out.length < 10_000) {
    const n = 1 + Math.floor(r() * 12);
    let k = "";
    for (let i = 0; i < n; i++) k += CHARS[Math.floor(r() * CHARS.length)];
    out.push([k, 1 + Math.floor(r() * 2)]);
    // A repeat of an earlier key with the other flag, so flags OR across runs.
    if (r() < 0.2) out.push([out[Math.floor(r() * out.length)]![0], 1 + Math.floor(r() * 2)]);
  }
  return out;
}

// The oracle: one sort of every key, folded.
function expected(list: readonly [string, number][]): Keyed[] {
  const m = new Map<string, number>();
  for (const [k, f] of list) m.set(k, (m.get(k) ?? 0) | f);
  return [...m.keys()].sort().map((key) => ({ key, flags: m.get(key)! }));
}

async function sorted(list: readonly [string, number][], runKeys: number): Promise<{ out: Keyed[]; s: RunSorter }> {
  const s = new RunSorter(runKeys);
  for (const [k, f] of list) {
    s.add(k, f);
    if (s.pending > 2) await s.drain(2);
  }
  const out: Keyed[] = [];
  for await (const x of s.finish()) out.push(x);
  return { out, s };
}

test("thc-ct sorter: 10,000 random keys come back as one sort of them, folded, for runs of 3, 7 and 10,001", async () => {
  const list = adds();
  const want = expected(list);
  assert.ok(want.length > 5_000 && want.length < list.length, "the adds hold repeats");
  // Byte order, as LC_ALL=C sort: `-` (0x2D) before `.` (0x2E).
  const at = (k: string): number => want.findIndex((x) => x.key === k);
  assert.ok(at("np.com") < at("np.com-x") && at("np.com-x") < at("np.com.") && at("np.com.") < at("np.com.a"));
  for (const runKeys of [3, 7, 10_001]) {
    const { out, s } = await sorted(list, runKeys);
    assert.deepEqual(out, want, `runKeys ${runKeys}`);
    // A run seals at runKeys distinct keys, and a key added again in a later run counts there too.
    assert.ok(s.runs >= Math.ceil(want.length / runKeys), `runKeys ${runKeys}: ${s.runs} runs`);
    assert.ok(s.storedBytes > 0);
  }
});

test("thc-ct sorter: a key added in two runs comes back once, its flags ORed across the runs", async () => {
  const list: [string, number][] = [
    ["b.example", 1],
    ["a.example", 2],
    ["c.example", 1],
    ["a.example", 1],
    ["d.example", 2],
    ["b.example", 2],
    ["a.example", 4],
  ];
  const { out, s } = await sorted(list, 2);
  assert.deepEqual(out, [
    { key: "a.example", flags: 7 },
    { key: "b.example", flags: 3 },
    { key: "c.example", flags: 1 },
    { key: "d.example", flags: 2 },
  ]);
  assert.ok(s.runs >= 3, `${s.runs} runs`);
});

test("thc-ct sorter: no key gives nothing, and one key gives that key", async () => {
  assert.deepEqual((await sorted([], 3)).out, []);
  assert.deepEqual((await sorted([], 3)).s.runs, 0);
  assert.deepEqual((await sorted([["x.example", 2]], 3)).out, [{ key: "x.example", flags: 2 }]);
  // A key of 253 characters, the most a name holds, front-codes in one byte.
  const long = `${"a".repeat(MAX_KEY - 8)}.example`;
  assert.deepEqual(
    (
      await sorted(
        [
          [long, 1],
          [`${long.slice(0, -1)}f`, 1],
        ],
        1,
      )
    ).out.length,
    2,
  );
});

test("thc-ct sorter: drain bounds the seals in flight, and drain(0) waits for every one", async () => {
  const s = new RunSorter(3);
  let most = 0;
  for (let i = 0; i < 60; i++) {
    s.add(`k${String(i).padStart(3, "0")}.example`, 1);
    most = Math.max(most, s.pending);
  }
  assert.ok(most > 2, `the adds outran the seals (${most} in flight)`);
  await s.drain(2);
  assert.ok(s.pending <= 2, `${s.pending} in flight after drain(2)`);
  await s.drain(0);
  assert.equal(s.pending, 0);
  assert.equal(s.runs, 20);
  const out: Keyed[] = [];
  for await (const x of s.finish()) out.push(x);
  assert.equal(out.length, 60);
});

test("thc-ct sorter: a key that is empty, too long or not ASCII, flags past a byte, an add after finish and a second finish are refused", async () => {
  const bad = async (fn: (s: RunSorter) => void | Promise<void>, why: RegExp): Promise<void> => {
    const s = new RunSorter(1);
    await assert.rejects(async () => {
      await fn(s);
      for await (const _ of s.finish()) {
        // Draining is the point.
      }
    }, why);
  };
  await bad((s) => s.add("", 1), /a key of 0 characters/);
  await bad((s) => s.add("a".repeat(MAX_KEY + 1), 1), /a key of 254 characters/);
  await bad((s) => s.add("bücher.example", 1), /is not ASCII/);
  assert.throws(() => new RunSorter(1).add("a.example", 256), /flags 256 are not 0 to 255/);
  assert.throws(() => new RunSorter(0), /runKeys 0 is not a whole number from 1/);
  const s = new RunSorter(2);
  s.add("a.example", 1);
  for await (const _ of s.finish()) {
    // Draining is the point.
  }
  assert.throws(() => s.add("b.example", 1), /add after finish/);
  await assert.rejects(async () => {
    for await (const _ of s.finish()) {
      // Draining is the point.
    }
  }, /finish called twice/);
});
