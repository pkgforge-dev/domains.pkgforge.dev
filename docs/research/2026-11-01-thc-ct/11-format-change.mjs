// DOM-029 instrument 11, copied from .tmp/dom029/challenge/format-change.mjs as it ran on 2026-11-01T08:34Z.
// The question: what normalise does with a CSV column, quoting, a trailing space or carriage return and a BOM (design M22).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/11-format-change.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Challenge probe: what normalise says if THC changes the line format (CRLF, a CSV column, a leading BOM).
import { readFileSync } from 'node:fs';
import { loadPsl, normalise } from '@domains/names';
const psl = await loadPsl(readFileSync(new URL('../../../packages/names/test/fixtures/psl-2026-10-27.dat', import.meta.url)));
for (const line of ['a.example.com\r', 'a.example.com,2026-10-31', '﻿a.example.com', '"a.example.com"', 'a.example.com ', 'a.example.com']) {
  console.log(JSON.stringify(line).padEnd(34), JSON.stringify(normalise(line, psl)));
}
