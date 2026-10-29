// A replay of THC's daily dumps into the ledger, on a measured slice: the first
// 1,000 lines of the days 2026-09-15 and 2026-10-24 to 2026-10-27 as published
// (test/fixtures/thc-slice.json, written by test/make-thc-slice.ts from Range
// reads; not synthetic). Each day's lines are normalised with DOM-015's names,
// written as a `names` pack, aggregated to a `domains` pack, and the day packs
// merged into the ledger, every pack through DOM-017's writer and reader. The
// ledger is held to a plain computation from the lines, to ten domains whose
// days were read off the slice by string matching, and to the exact join of
// each day against the days before it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { key as keyOf, normalise, type Psl, split } from "@domains/names";
import { DOMAINS_CODEC, FLAG_EXACT, FLAG_WILDCARD, mergePacks, NAMES_CODEC, type NameRecord, type PackReader, type DomainRecord } from "@domains/pack";
import { aggregateToDomains, DAY_SECONDS, exactNew, firstSeen, isoOf, lastSeen, newCounts, precisionsOf, secondsOf } from "../src/index.ts";
import { collect, type MemPack, pinnedPsl, readerOf, writeMem } from "./helpers.ts";

interface SliceDay {
  readonly day: string;
  readonly lines: readonly string[];
}
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "thc-slice.json"), "utf8")) as { format: string; measured: boolean; days: SliceDay[] };

// thc-ct is bit 0, a day source (config/source-bits.json, docs/sources.md).
const THC = 0;
const precision = precisionsOf([{ bit: THC, precision: "day" }]);
const dayOf = (iso: string): number => secondsOf(iso) / DAY_SECONDS;

// The ten domains, with the days the slice shows them on, read by string
// matching (a line equal to the domain or ending in "." plus it, after "*."),
// with no list and no pack. `exact`: a line is the domain itself.
const KNOWN: readonly { domain: string; first: string; last: string; exact: boolean }[] = [
  { domain: "pages.dev", first: "2026-09-15", last: "2026-10-27", exact: false },
  { domain: "kdns.fr", first: "2026-09-15", last: "2026-10-27", exact: false },
  { domain: "ccwu.cc", first: "2026-10-24", last: "2026-10-27", exact: false },
  { domain: "boner.com", first: "2026-09-15", last: "2026-10-25", exact: false },
  { domain: "00000000000000000000.online", first: "2026-09-15", last: "2026-10-27", exact: false },
  { domain: "dpdns.org", first: "2026-10-24", last: "2026-10-27", exact: false },
  { domain: "00001988.xyz", first: "2026-10-25", last: "2026-10-27", exact: true },
  { domain: "danielbrentoncole.com", first: "2026-10-26", last: "2026-10-27", exact: false },
  { domain: "flvcdn-dev.net", first: "2026-10-27", last: "2026-10-27", exact: false },
  { domain: "0000.co.uk", first: "2026-10-24", last: "2026-10-24", exact: true },
];

// One day's lines as name records: normalised, keyed, flags merged, sorted.
function namesOfDay(day: SliceDay, psl: Psl): NameRecord[] {
  const flags = new Map<string, number>();
  const d = dayOf(day.day);
  for (const line of day.lines) {
    const n = normalise(line, psl);
    if ("refused" in n) continue;
    const k = keyOf(n.name);
    flags.set(k, (flags.get(k) ?? 0) | (n.wild ? FLAG_WILDCARD : FLAG_EXACT));
  }
  return [...flags.keys()].sort().map((k) => ({ key: k, flags: flags.get(k) as number, sources: [{ bit: THC, first: d, last: d }] }));
}

interface Replay {
  readonly days: { readonly day: string; readonly pack: MemPack; readonly reader: PackReader<DomainRecord> }[];
  readonly ledger: MemPack;
  readonly reader: PackReader<DomainRecord>;
}

async function ledgerOf(days: readonly MemPack[]): Promise<MemPack> {
  const readers = await Promise.all(days.map((p) => readerOf(p, DOMAINS_CODEC)));
  return writeMem(mergePacks(readers, DOMAINS_CODEC), DOMAINS_CODEC);
}

let replayed: Promise<Replay> | null = null;
function replay(): Promise<Replay> {
  replayed ??= (async () => {
    const psl = await pinnedPsl();
    const days = [];
    for (const day of fixture.days) {
      const names = await readerOf(await writeMem(namesOfDay(day, psl), NAMES_CODEC), NAMES_CODEC);
      const pack = await writeMem(aggregateToDomains(names.scan(), psl, newCounts()), DOMAINS_CODEC);
      days.push({ day: day.day, pack, reader: await readerOf(pack, DOMAINS_CODEC) });
    }
    const ledger = await ledgerOf(days.map((d) => d.pack));
    return { days, ledger, reader: await readerOf(ledger, DOMAINS_CODEC) };
  })();
  return replayed;
}

test("replay: the fixture is the measured THC slice of five days", () => {
  assert.equal(fixture.format, "domains.test.thc-slice.v1");
  assert.equal(fixture.measured, true);
  assert.deepEqual(
    fixture.days.map((d) => [d.day, d.lines.length]),
    ["2026-09-15", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"].map((d) => [d, 1000]),
  );
});

test("replay: five THC days build a ledger whose ten known domains carry their first and last day", async () => {
  const { reader } = await replay();
  for (const k of KNOWN) {
    const r = await reader.get(keyOf(k.domain));
    assert.ok(r !== null, k.domain);
    assert.deepEqual(r.sources, [{ bit: THC, first: dayOf(k.first), last: dayOf(k.last) }], k.domain);
    assert.equal(isoOf(firstSeen(r, precision)), k.first, k.domain);
    assert.equal(isoOf(lastSeen(r, precision)), k.last, k.domain);
    assert.equal(r.flags, k.exact ? FLAG_EXACT : 0, k.domain);
    assert.deepEqual(r.evidence, [], k.domain);
  }
});

test("replay: the ledger holds every domain of the slice with the first and last day a plain count gives", async () => {
  const psl = await pinnedPsl();
  const { ledger, reader } = await replay();
  // The plain way: every line's registrable domain, no packs and no streaming.
  const plain = new Map<string, { first: number; last: number }>();
  for (const day of fixture.days) {
    const d = dayOf(day.day);
    for (const line of day.lines) {
      const n = normalise(line, psl);
      if ("refused" in n) continue;
      const reg = split(n.name, psl).reg;
      if (reg === null) continue;
      const k = keyOf(reg);
      const before = plain.get(k);
      plain.set(k, before === undefined ? { first: d, last: d } : { first: Math.min(before.first, d), last: Math.max(before.last, d) });
    }
  }
  const records = await collect(reader.scan());
  assert.deepEqual(
    records.map((r) => r.key),
    [...plain.keys()].sort(),
  );
  for (const r of records) assert.deepEqual(r.sources, [{ bit: THC, ...plain.get(r.key) }], r.key);
  assert.equal(ledger.summary.records, 832);
});

test("replay: each day's exact new domains are those no earlier day holds", async () => {
  const { days } = await replay();
  const firstDay = new Map(KNOWN.map((k) => [keyOf(k.domain), k.first]));
  const earlier = new Set<string>();
  for (const [i, d] of days.entries()) {
    const own = await collect(d.reader.scan());
    const fresh = (
      await collect(
        exactNew(
          own,
          days.slice(0, i).map((x) => x.reader),
          { since: secondsOf(d.day), precision },
        ),
      )
    ).map((r) => r.key);
    assert.deepEqual(
      fresh,
      own.map((r) => r.key).filter((k) => !earlier.has(k)),
      d.day,
    );
    for (const [k, first] of firstDay) assert.equal(fresh.includes(k), first === d.day, `${k} on ${d.day}`);
    for (const r of own) earlier.add(r.key);
  }
});

test("replay: the ledger is the same whatever the order of the days, and with a day replayed twice", async () => {
  const { days, ledger } = await replay();
  const packs = days.map((d) => d.pack);
  const shuffled = await ledgerOf([packs[3], packs[0], packs[4], packs[2], packs[1], packs[3]]);
  assert.equal(shuffled.summary.sha256, ledger.summary.sha256);
  assert.deepEqual(shuffled.parts, ledger.parts);
  const again = await ledgerOf([ledger, ...packs]);
  assert.equal(again.summary.sha256, ledger.summary.sha256);
});
