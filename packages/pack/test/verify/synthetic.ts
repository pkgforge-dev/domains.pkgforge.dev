// packages/pack/test/verify/synthetic.ts — the records of the verifier's tests
// and of the fixtures beside this file (make-fixtures.ts).
//
// Every name, time and registry row here is synthetic. A name is a label
// `synthN` under a common suffix, with up to two labels below it. Bit 0 is
// thc-ct of config/source-bits.json, a day source, which saw every name on day
// 298 (2026-10-26). Bit 5 is ct-le, a second source, which saw about half of
// them at a second of that day. The registry rows carry those two ids with
// their bits so the CLI can check them against config/source-bits.json; no
// other field of them is the real source's.
import { join } from "node:path";
import type { NameRecord, Seen } from "../../src/index.ts";
import type { SourceRow } from "../../src/verify.ts";
import { rng } from "../helpers.ts";

export const DAY = 298;
export const DAY_START = DAY * 86_400;
export const SPAN = Object.freeze({ start: "2026-10-26T00:00:00Z", end: "2026-10-27T00:00:00Z" });
export const DAY_ID = "thc-ct";
export const DAY_BIT = 0;
export const SECOND_ID = "ct-le";
export const SECOND_BIT = 5;
export const SOURCES: readonly string[] = Object.freeze([DAY_ID, SECOND_ID]);
export const REGISTRY: readonly SourceRow[] = Object.freeze([
  { id: DAY_ID, bit: DAY_BIT, precision: "day" },
  { id: SECOND_ID, bit: SECOND_BIT, precision: "second" },
]);

// The pinned list of the names package's tests.
export const PSL_FILE = join(import.meta.dirname, "..", "..", "..", "names", "test", "fixtures", "psl-2026-10-27.dat");

// The fixtures: CLEAN_COUNT names from CLEAN_SEED, 64 records a block, 4 entries a page.
export const CLEAN_COUNT = 600;
export const CLEAN_SEED = 18;
export const PAIR_SEED = 2;
export const RECORDS_PER_BLOCK = 64;
export const PAGE_ENTRIES = 4;

const SUFFIXES = ["com", "net", "org", "de", "io", "co.uk", "com.np"];
const BELOW = ["www", "api", "mail", "cdn", "_dmarc", "a-b", "x0", "dev"];

const reversed = (name: string): string => name.split(".").reverse().join(".");

// n distinct synthetic names as records, ascending by key.
export function syntheticNames(n: number, seed: number): NameRecord[] {
  const next = rng(seed);
  const pick = (list: readonly string[]): string => list[Math.floor(next() * list.length)];
  const keys = new Set<string>();
  while (keys.size < n) {
    let name = `synth${Math.floor(next() * 100_000)}.${pick(SUFFIXES)}`;
    const depth = Math.floor(next() * 3);
    for (let d = 0; d < depth; d += 1) name = `${pick(BELOW)}.${name}`;
    keys.add(reversed(name));
  }
  const times = rng(seed + 1);
  return [...keys].sort().map((key) => {
    const sources: Seen[] = [{ bit: DAY_BIT, first: DAY, last: DAY }];
    if (times() < 0.5) {
      // At most 86,000 s into the day, so `last` stays inside it.
      const first = DAY_START + Math.floor(times() * 80_000);
      sources.push({ bit: SECOND_BIT, first, last: first + Math.floor(times() * 6_000) });
    }
    return { key, flags: 1 + Math.floor(times() * 3), sources };
  });
}

// A synthetic config/sources.json of the two sources the names carry. Both
// bands are relative, on the record count, with the floor at 0.4 of the median.
export function syntheticRegistry(): unknown {
  const row = (id: string, bit: number, precision: string, cadence: string) => ({
    id,
    bit,
    family: "ct",
    datasets: ["names"],
    precision,
    kind: "ct_name",
    basis: ["ct-first"],
    cadence,
    band: { metric: "count", min: 0.4, max: 2.5, relative: true },
    urls: ["https://feed.example.test/{date}.txt"],
    retention: "unknown",
    parser: "synthetic/1",
    failure_modes: ["Synthetic: a row of the verifier's tests (packages/pack/test/verify), not this source's registry row."],
    adapter: "synthetic",
  });
  return {
    format: "domains.sources.v1",
    comment: "Synthetic: the registry of the verifier's tests (packages/pack/test/verify/make-fixtures.ts). Not config/sources.json.",
    sources: [row(DAY_ID, DAY_BIT, "day", "P1D"), row(SECOND_ID, SECOND_BIT, "second", "PT10M")],
  };
}
