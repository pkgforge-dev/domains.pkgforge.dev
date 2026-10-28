// packages/names/bin/split.mjs — the suffix, the registrable domain and the
// site of each name, through the names package's own normalise and split.
//
// One line per NAME, in the order given, its fields named:
//   name N suffix S reg R site X     N is the normalised name; S and R come from
//                                    the ICANN section, X from both sections
//                                    (`-` when N is itself a suffix of the full
//                                    list, as `github.io` is)
//   input "TEXT" refused REASON      normalise refused the text (JSON-quoted)
//
// The list defaults to the pinned copy of the package's tests,
// packages/names/test/fixtures/psl-2026-10-27.dat. DOM-019 is to hold the live
// copy in its ref package; --psl reads any copy.
//
// Usage:
//   node packages/names/bin/split.mjs [--psl FILE] NAME...
// Exit codes: 0 every name split · 1 a name was refused · 2 could not run (no
// name, the list cannot be read, or it is not a list).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../../../scripts/lib/args.mjs';
import { loadPsl, normalise, PslError, split } from '../src/index.ts';

export const DEFAULT_PSL = new URL('../test/fixtures/psl-2026-10-27.dat', import.meta.url);

// One output line for one input.
export function line(input, psl) {
  const r = normalise(input, psl);
  if ('refused' in r) return { refused: true, text: `input ${JSON.stringify(input)} refused ${r.refused}` };
  const s = split(r.name, psl);
  return { refused: false, text: `name ${r.name} suffix ${s.suffix} reg ${s.reg ?? '-'} site ${s.site ?? '-'}` };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args._.length === 0 || args.psl === true) {
    console.error('usage: node packages/names/bin/split.mjs [--psl FILE] NAME...');
    return 2;
  }
  const path = typeof args.psl === 'string' ? args.psl : DEFAULT_PSL;
  let psl;
  try {
    psl = await loadPsl(readFileSync(path));
  } catch (err) {
    if (!(err instanceof PslError) && err?.code === undefined) throw err;
    console.error(`split: cannot read the list ${path}: ${err.message}`);
    return 2;
  }
  let refused = false;
  for (const input of args._) {
    const out = line(input, psl);
    if (out.refused) refused = true;
    console.log(out.text);
  }
  return refused ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
