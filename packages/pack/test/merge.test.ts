// packages/pack/src/merge.ts through real packs: written with the production
// compressor, read back by range, merged, and written again. The three laws of
// the Prove of DOM-017 (merge(a, a) = a, commutative, associative), a random
// split of one record list into packs, and the minimum first and maximum last
// of each source. The records are synthetic (test/helpers.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMAINS_CODEC, type DatasetCodec, mergePacks, mergeRecords, NAMES_CODEC, type NameRecord, PackError, type Seen } from "../src/index.ts";
import { collect, type MemPack, randomDomains, randomNames, readerOf, rng, writeMem } from "./helpers.ts";

const write = <R>(records: Iterable<R> | AsyncIterable<R>, codec: DatasetCodec<R>) => writeMem(records, { codec, recordsPerBlock: 50, pageEntries: 4 });

async function merged<R>(packs: MemPack[], codec: DatasetCodec<R>): Promise<MemPack> {
  const readers = await Promise.all(packs.map((p) => readerOf(p, codec)));
  return write(mergePacks(readers, codec), codec);
}

const recordsOf = async <R>(pack: MemPack, codec: DatasetCodec<R>): Promise<R[]> => collect((await readerOf(pack, codec)).scan());

// Two overlapping record lists: b holds half of a's keys, with other times and
// sources, and keys of its own.
function pair(seed: number): [NameRecord[], NameRecord[], NameRecord[]] {
  const all = randomNames(1200, seed);
  const next = rng(seed + 100);
  const moved = (s: Seen): Seen => {
    const first = s.first + Math.floor(next() * 5);
    return { bit: s.bit, first, last: Math.max(first, s.last + Math.floor(next() * 50)) };
  };
  const pick = () => all.filter(() => next() < 0.5).map((r) => ({ ...r, flags: 1 + Math.floor(next() * 3), sources: r.sources.map(moved) }));
  return [pick(), pick(), pick()];
}

test("pack merge: merge(a, a) gives a, byte for byte", async () => {
  const [a] = pair(41);
  const pa = await write(a, NAMES_CODEC);
  const m = await merged([pa, pa], NAMES_CODEC);
  assert.deepEqual(m.parts, pa.parts);
  assert.deepEqual(m.summary.idx, pa.summary.idx);
  assert.deepEqual(await recordsOf(m, NAMES_CODEC), a);
});

test("pack merge: merge(a, b) equals merge(b, a)", async () => {
  const [a, b] = pair(42);
  const [pa, pb] = await Promise.all([write(a, NAMES_CODEC), write(b, NAMES_CODEC)]);
  const ab = await merged([pa, pb], NAMES_CODEC);
  const ba = await merged([pb, pa], NAMES_CODEC);
  assert.equal(ab.summary.sha256, ba.summary.sha256);
  assert.deepEqual(ab.parts, ba.parts);
  assert.ok(ab.summary.records > a.length && ab.summary.records > b.length);
});

test("pack merge: merge(merge(a, b), c) equals merge(a, merge(b, c)) and merge(a, b, c)", async () => {
  const [a, b, c] = pair(43);
  const [pa, pb, pc] = await Promise.all([write(a, NAMES_CODEC), write(b, NAMES_CODEC), write(c, NAMES_CODEC)]);
  const left = await merged([await merged([pa, pb], NAMES_CODEC), pc], NAMES_CODEC);
  const right = await merged([pa, await merged([pb, pc], NAMES_CODEC)], NAMES_CODEC);
  const flat = await merged([pa, pb, pc], NAMES_CODEC);
  assert.equal(left.summary.sha256, right.summary.sha256);
  assert.equal(left.summary.sha256, flat.summary.sha256);
  assert.deepEqual(left.summary.idx, right.summary.idx);
});

test("pack merge: one record list split at random into packs merges back to the one pack", async () => {
  const next = rng(44);
  const records = randomDomains(2000, 44);
  const one = await write(records, DOMAINS_CODEC);
  // Each record goes to one of four packs, or to two of them with its sources
  // and its times cut in two: the merge must join them again.
  const lists: (typeof records)[] = [[], [], [], []];
  for (const r of records) {
    const i = Math.floor(next() * 4);
    if (next() < 0.5) {
      lists[i].push(r);
      continue;
    }
    const j = (i + 1 + Math.floor(next() * 3)) % 4;
    const early: Seen[] = r.sources.map((s) => ({ bit: s.bit, first: s.first, last: s.first }));
    const late: Seen[] = r.sources.map((s) => ({ bit: s.bit, first: s.last, last: s.last }));
    const cut = Math.floor(r.evidence.length / 2);
    lists[i].push({ ...r, sources: early, evidence: r.evidence.slice(0, cut) });
    lists[j].push({ ...r, sources: late, evidence: r.evidence.slice(cut) });
  }
  for (const list of lists) list.sort((x, y) => (x.key < y.key ? -1 : 1));
  const packs = await Promise.all(lists.map((l) => write(l, DOMAINS_CODEC)));
  const m = await merged(packs, DOMAINS_CODEC);
  assert.equal(m.summary.sha256, one.summary.sha256);
  assert.deepEqual(await recordsOf(m, DOMAINS_CODEC), records);
});

test("pack merge: the merged record keeps the minimum first and the maximum last of each source", async () => {
  const a: NameRecord[] = [{ key: "com.example", flags: 1, sources: [{ bit: 0, first: 10, last: 20 }] }];
  const b: NameRecord[] = [
    {
      key: "com.example",
      flags: 2,
      sources: [
        { bit: 0, first: 15, last: 40 },
        { bit: 3, first: 5, last: 6 },
      ],
    },
  ];
  const c: NameRecord[] = [{ key: "com.example", flags: 1, sources: [{ bit: 0, first: 4, last: 30 }] }];
  const m = await merged(await Promise.all([write(a, NAMES_CODEC), write(b, NAMES_CODEC), write(c, NAMES_CODEC)]), NAMES_CODEC);
  assert.deepEqual(await recordsOf(m, NAMES_CODEC), [
    {
      key: "com.example",
      flags: 3,
      sources: [
        { bit: 0, first: 4, last: 40 },
        { bit: 3, first: 5, last: 6 },
      ],
    },
  ]);
});

test("pack merge: an input whose keys do not ascend is refused, and a reader of another dataset too", async () => {
  const r = (key: string): NameRecord => ({ key, flags: 1, sources: [{ bit: 0, first: 1, last: 1 }] });
  await assert.rejects(
    () =>
      collect(
        mergeRecords(
          [
            [r("com.a"), r("com.c")],
            [r("com.b"), r("com.b")],
          ],
          NAMES_CODEC,
        ),
      ),
    (e: unknown) => e instanceof PackError && e.code === "order" && /merge input 1/.test(e.message),
  );
  const names = await readerOf(await write(randomNames(10, 45), NAMES_CODEC), NAMES_CODEC);
  assert.throws(
    () => mergePacks([names] as never, DOMAINS_CODEC),
    (e: unknown) => e instanceof PackError && e.code === "dataset",
  );
});

test("pack merge: a caller that stops early closes every input", async () => {
  const closed: number[] = [];
  async function* input(n: number) {
    try {
      for (const key of ["com.a", "com.b", "com.c"]) yield { key: `${key}${n}`, flags: 1, sources: [{ bit: n, first: 1, last: 1 }] };
    } finally {
      closed.push(n);
    }
  }
  const out: NameRecord[] = [];
  for await (const rec of mergeRecords([input(0), input(1)], NAMES_CODEC)) {
    out.push(rec);
    if (out.length === 2) break;
  }
  assert.deepEqual(
    out.map((x) => x.key),
    ["com.a0", "com.a1"],
  );
  assert.deepEqual(closed.sort(), [0, 1]);
});
