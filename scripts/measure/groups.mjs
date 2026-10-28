// scripts/measure/groups.mjs — how many names each registrable domain holds,
// after design B's groups.mjs (docs/research/2026-10-27-design-b/scripts/groups.mjs),
// for the THC day measurement (DOM-009).
//
// Design B M2 found that 25 registrable domains hold 35% of a day's names and
// that 41% of registrable domains hold one name. groupHistogram counts the same
// from the sorted per-name domain hashes of regdoms.mjs: each run of one hash is
// one domain and its length is the names it holds. Design B's script grouped
// consecutive keys instead, which splits a domain whenever a sibling such as
// `com.example-x` sorts inside it; a run of hashes does not split.
//
// The file and the list are flags, not the fixed `rev/r26.sorted` and
// `psl/public_suffix_list.dat` of design B's script.
//
// Usage:
//   import { groupHistogram } from './groups.mjs'
//   node scripts/measure/groups.mjs --psl FILE --input SORTED.tsv   prints the histogram as JSON
// Exit codes: 0 counted, 1 the input is not a sorted record file, 2 could not run.
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { loadPsl } from './psl.mjs';
import { createSplitter } from './regdoms.mjs';
import { RecordError, readRecords } from './revlabel.mjs';

const EDGES = [1, 2, 10, 100, 1000, 10000, 100000, Number.POSITIVE_INFINITY];
const LABELS = ['=1', '2-9', '10-99', '100-999', '1k-9.9k', '10k-99k', '>=100k'];

// sorted: the per-name domain hashes in ascending order. named: hash to domain
// text for the domains whose text is known. Returns the domains, the names,
// the histogram of names a domain, and the `top` largest domains.
export function groupHistogram(sorted, named = new Map(), top = 25) {
  const regs = new Array(LABELS.length).fill(0);
  const names = new Array(LABELS.length).fill(0);
  const largest = [];
  let distinct = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j] === sorted[i]) j += 1;
    const count = j - i;
    distinct += 1;
    let b = 0;
    while (count >= EDGES[b + 1]) b += 1;
    regs[b] += 1;
    names[b] += count;
    if (largest.length < top || count > largest[largest.length - 1][0]) {
      largest.push([count, sorted[i]]);
      largest.sort((x, y) => y[0] - x[0]);
      if (largest.length > top) largest.pop();
    }
    i = j;
  }
  const total = sorted.length;
  const pct = (n, d) => (d === 0 ? 0 : +((100 * n) / d).toFixed(1));
  const topNames = largest.reduce((a, [count]) => a + count, 0);
  return {
    registrable: distinct,
    names: total,
    buckets: LABELS.map((label, b) => ({ label, registrable: regs[b], names: names[b], pct_registrable: pct(regs[b], distinct), pct_names: pct(names[b], total) })),
    top: largest.map(([count, hash]) => ({ reg: named.get(hash) ?? null, names: count })),
    top_pct_names: pct(topNames, total),
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (typeof args.psl !== 'string' || typeof args.input !== 'string') {
    console.error('usage: node scripts/measure/groups.mjs --psl FILE --input SORTED.tsv');
    return 2;
  }
  let psl;
  try {
    psl = loadPsl(args.psl);
  } catch (err) {
    console.error(`groups: ${err.message}`);
    return 2;
  }
  const splitter = createSplitter(psl);
  try {
    await readRecords(args.input, (key, flags) => splitter.add(key, flags));
  } catch (err) {
    console.error(`groups: ${err.message}`);
    return err instanceof RecordError ? 1 : 2;
  }
  const { sortedRegs, named } = splitter.finish();
  console.log(JSON.stringify({ input: args.input, ...groupHistogram(sortedRegs, named) }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
