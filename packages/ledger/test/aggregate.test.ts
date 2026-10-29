// packages/ledger/src/aggregate.ts: name records fold into the records of their
// registrable domains, in key order, with the minimum first and maximum last of
// each source. The names are synthetic; the list is the pinned PSL fixture, or
// a synthetic list where a test needs a rule the real one does not hold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromKey, key as keyOf, loadPsl, type Psl, split } from "@domains/names";
import { type DomainRecord, FLAG_EXACT, FLAG_WILDCARD, mergeSeen, type NameRecord } from "@domains/pack";
import { aggregateToDomains, LedgerError, newCounts, releaseKey } from "../src/index.ts";
import { collect, nameRecord, pinnedPsl, rng, seen } from "./helpers.ts";

const isLedger = (code: string) => (e: unknown) => e instanceof LedgerError && e.code === code;

// A list of three ICANN rules: `com`, and `deep.zone.com` with no `zone.com`.
// So `zone.com` is registrable, and so is `a.deep.zone.com`, whose key sorts
// between the keys of two names of `zone.com`. Synthetic: the real list holds
// no such pair the tests can rely on.
const DEEP_PSL = ["// ===BEGIN ICANN DOMAINS===", "com", "deep.zone.com", "// ===END ICANN DOMAINS===", "// ===BEGIN PRIVATE DOMAINS===", "// ===END PRIVATE DOMAINS==="].join("\n");

// The same aggregation done the plain way: every name's domain into a map,
// then sorted. It holds every domain in memory, which aggregateToDomains must
// not, and is the reference the streaming one is held to.
function naive(names: readonly NameRecord[], psl: Psl): DomainRecord[] {
  const byKey = new Map<string, DomainRecord>();
  for (const r of names) {
    const name = fromKey(r.key);
    const reg = split(name, psl).reg;
    if (reg === null) continue;
    const k = keyOf(reg);
    const flags = k === r.key ? r.flags & FLAG_EXACT : 0;
    const before = byKey.get(k);
    byKey.set(k, before === undefined ? { key: k, flags, sources: [...r.sources], evidence: [] } : { ...before, flags: before.flags | flags, sources: mergeSeen(before.sources, r.sources) });
  }
  return [...byKey.keys()].sort().map((k) => byKey.get(k) as DomainRecord);
}

test("aggregate: the names of one domain fold into one record with the minimum first and the maximum last of each source", async () => {
  const psl = await pinnedPsl();
  const names = [
    nameRecord("com.example", [seen(0, 290, 295)], FLAG_WILDCARD),
    nameRecord("com.example.api", [seen(0, 280, 281), seen(5, 1_000, 2_000)]),
    nameRecord("com.example.www", [seen(0, 285, 299), seen(5, 900, 1_500), seen(9, 7)]),
  ];
  const counts = newCounts();
  const out = await collect(aggregateToDomains(names, psl, counts));
  assert.deepEqual(out, [{ key: "com.example", flags: 0, sources: [seen(0, 280, 299), seen(5, 900, 2_000), seen(9, 7)], evidence: [] }]);
  assert.deepEqual(counts, { names: 3, domains: 1, suffixes: 0, held: 1 });
});

test("aggregate: the wildcard flag is dropped, and the exact flag is kept only when the domain itself was seen", async () => {
  const psl = await pinnedPsl();
  const out = await collect(
    aggregateToDomains([nameRecord("com.a", [seen(0, 1)], FLAG_EXACT | FLAG_WILDCARD), nameRecord("com.b", [seen(0, 1)], FLAG_WILDCARD), nameRecord("com.c.www", [seen(0, 1)], FLAG_EXACT)], psl),
  );
  assert.deepEqual(
    out.map((d) => [d.key, d.flags]),
    [
      ["com.a", FLAG_EXACT],
      ["com.b", 0],
      ["com.c", 0],
    ],
  );
});

test("aggregate: a domain whose names arrive after a hyphenated neighbour's still leaves in key order", async () => {
  const psl = await pinnedPsl();
  // `-` sorts below `.`: the names of com.my-site arrive before com.my.www,
  // and the domain com.my sorts below com.my-site.
  const names = [nameRecord("com.my-site", [seen(0, 5)]), nameRecord("com.my-site.www", [seen(0, 6)]), nameRecord("com.my.www", [seen(0, 7)]), nameRecord("com.myz", [seen(0, 8)])];
  assert.equal(releaseKey("com.my-site", psl), "com.my/");
  const out = await collect(aggregateToDomains(names, psl));
  assert.deepEqual(
    out.map((d) => d.key),
    ["com.my", "com.my-site", "com.myz"],
  );
  assert.deepEqual(out[1].sources, [seen(0, 5, 6)]);
});

test("aggregate: a registrable prefix cut at a dot holds a deeper domain back", async () => {
  const psl = await loadPsl(DEEP_PSL);
  assert.equal(split("a.deep.zone.com", psl).reg, "a.deep.zone.com");
  assert.equal(split("e.zone.com", psl).reg, "zone.com");
  assert.equal(releaseKey("com.zone.deep.a", psl), "com.zone/");
  const names = [nameRecord("com.zone.deep.a", [seen(0, 1)]), nameRecord("com.zone.e", [seen(0, 2)])];
  assert.deepEqual(
    (await collect(aggregateToDomains(names, psl))).map((d) => d.key),
    ["com.zone", "com.zone.deep.a"],
  );
});

test("aggregate: the output equals a sort of every name's domain, over random names with hyphens, deep suffixes and exceptions", async (t) => {
  const psl = await pinnedPsl();
  const next = rng(21);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  // Suffixes in key form: plain, two labels, the wildcard `*.np`, the
  // wildcard and exception of kawasaki.jp, and `*.ck` with `!www.ck`.
  const SUFFIXES = ["com", "uk.co", "np.com", "np.org", "jp.kawasaki.city", "jp.kawasaki.x1", "jp", "ck.www", "ck.co", "io"];
  const LABELS = ["a", "a-b", "a-b-c", "ab", "a0", "my", "my-site", "my-a", "my_x", "kawasaki", "zone", "x-", "b"];
  // A registrable label: a stem, a digit or none, then a hyphenated tail or
  // none, so "my2", "my2-site" and "my2-a" all occur and sort around "my2.".
  const regLabel = (): string => `${pick(["a", "my", "x", "zone", "b", "kawasaki"])}${next() < 0.5 ? "" : Math.floor(next() * 10)}${pick(["", "", "-site", "-a", "-b-c", "_x"])}`;
  const keys = new Set<string>();
  while (keys.size < 12_000) {
    let k = `${pick(SUFFIXES)}.${regLabel()}`;
    for (let d = Math.floor(next() * 3); d > 0; d -= 1) k += `.${pick(LABELS)}`;
    keys.add(k);
  }
  const names: NameRecord[] = [...keys].sort().map((k) => {
    const sources = [seen(0, Math.floor(next() * 300))];
    if (next() < 0.4) sources.push(seen(5, Math.floor(next() * 1e6)));
    return nameRecord(k, sources, 1 + Math.floor(next() * 3));
  });
  const counts = newCounts();
  const out = await collect(aggregateToDomains(names, psl, counts));
  const expected = naive(names, psl);
  assert.deepEqual(out, expected);
  assert.equal(counts.domains, expected.length);
  assert.ok(counts.suffixes > 0, "some names are suffixes under the list (`*.np`, `*.ck`)");
  t.diagnostic(`names ${counts.names}, domains ${counts.domains}, suffixes ${counts.suffixes}, held at most ${counts.held}`);
});

test("aggregate: a domain with no hyphen and no registrable cut leaves as soon as the input passes it", async () => {
  const psl = await pinnedPsl();
  // com.syn1, com.syn1.www, then com.syn10: "/" sorts below "0", so com.syn1
  // leaves when com.syn10 arrives, and one domain is held at a time.
  const names: NameRecord[] = [];
  for (let n = 0; n < 2000; n += 1) for (const sub of ["", ".api", ".www"]) names.push(nameRecord(`uk.co.syn${n}${sub}`, [seen(0, n % 300)]));
  names.sort((a, b) => (a.key < b.key ? -1 : 1));
  const counts = newCounts();
  const out = await collect(aggregateToDomains(names, psl, counts));
  assert.equal(out.length, 2000);
  assert.equal(counts.held, 1);
});

test("aggregate: a name that the list makes a public suffix is skipped and counted", async () => {
  const psl = await pinnedPsl();
  const counts = newCounts();
  const out = await collect(aggregateToDomains([nameRecord("np.com", [seen(0, 1)]), nameRecord("np.com.shop", [seen(0, 2)])], psl, counts));
  assert.deepEqual(
    out.map((d) => d.key),
    ["np.com.shop"],
  );
  assert.equal(counts.suffixes, 1);
});

test("aggregate: names out of key order are refused", async () => {
  const psl = await pinnedPsl();
  await assert.rejects(collect(aggregateToDomains([nameRecord("com.b", [seen(0, 1)]), nameRecord("com.a", [seen(0, 1)])], psl)), isLedger("order"));
  await assert.rejects(collect(aggregateToDomains([nameRecord("com.a", [seen(0, 1)]), nameRecord("com.a", [seen(0, 2)])], psl)), isLedger("order"));
});

test("aggregate: aggregating is idempotent: the names twice over, merged, give the same domains", async () => {
  const psl = await pinnedPsl();
  const names = [nameRecord("com.example", [seen(0, 3)]), nameRecord("com.example.www", [seen(0, 1, 9)])];
  const once = await collect(aggregateToDomains(names, psl));
  const twice = await collect(
    aggregateToDomains(
      once.map((d) => ({ key: d.key, flags: 1, sources: d.sources })),
      psl,
    ),
  );
  assert.deepEqual(
    twice.map((d) => d.sources),
    once.map((d) => d.sources),
  );
});
