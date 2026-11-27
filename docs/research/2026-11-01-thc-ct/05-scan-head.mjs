// DOM-029 instrument 05, copied from .tmp/dom029/scan-head.mjs as it ran on 2026-11-01T08:05Z.
// The question: whether the head of a dump holds non-ASCII bytes, carriage returns, empty lines or xn-- labels, and how far its order is from bytes (design M11).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/05-scan-head.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// .tmp/dom029/scan-head.mjs — DOM-029 design measurement (not tracked).
// Counts, over the head of one dump, the line shapes the fixture slice must
// hold: non-ASCII lines, CR, upper case, `*.` lines, xn-- labels, lines that
// are a public suffix, numeric TLDs, and the longest line; and the order: the
// adjacent inversions of the raw lines and of their reversed keys.
// Usage: node docs/research/2026-11-01-thc-ct/05-scan-head.mjs FILE.gz PSL
import { readFileSync } from 'node:fs';
import { loadPsl, normalise } from '@domains/names';

const [file, pslPath] = process.argv.slice(2);
const psl = await loadPsl(readFileSync(pslPath));
const reader = new Blob([readFileSync(file)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
const dec = new TextDecoder();
const c = { lines: 0, high: 0, cr: 0, upper: 0, wild: 0, xn: 0, ps: 0, numeric: 0, empty: 0, maxLen: 0, rawInv: 0, keyInv: 0, dupAdjacent: 0 };
const samples = { high: [], ps: [], xn: [] };
let tail = '';
let prev = null;
let prevKey = null;
for (;;) {
  let r;
  try {
    r = await reader.read();
  } catch {
    break;
  }
  if (r.done) break;
  const parts = (tail + dec.decode(r.value, { stream: true })).split('\n');
  tail = parts.pop();
  for (const l of parts) {
    if (l.length === 0) {
      c.empty += 1;
      continue;
    }
    c.lines += 1;
    if (l.length > c.maxLen) c.maxLen = l.length;
    if (/[^\x00-\x7f]/.test(l)) {
      c.high += 1;
      if (samples.high.length < 3) samples.high.push(l);
    }
    if (l.includes('\r')) c.cr += 1;
    if (/[A-Z]/.test(l)) c.upper += 1;
    if (l.startsWith('*.')) c.wild += 1;
    if (/(^|\.)xn--/i.test(l)) {
      c.xn += 1;
      if (samples.xn.length < 3) samples.xn.push(l);
    }
    const n = normalise(l, psl);
    if ('refused' in n) {
      if (n.refused === 'public-suffix') {
        c.ps += 1;
        if (samples.ps.length < 5) samples.ps.push(l);
      }
      if (n.refused === 'numeric-tld') c.numeric += 1;
    }
    if (prev !== null && l < prev) c.rawInv += 1;
    if (prev !== null && l === prev) c.dupAdjacent += 1;
    const k = 'refused' in n ? null : n.name.split('.').reverse().join('.');
    if (k !== null && prevKey !== null && k < prevKey) c.keyInv += 1;
    if (k !== null) prevKey = k;
    prev = l;
  }
}
console.log(JSON.stringify(c));
console.log(JSON.stringify(samples));
