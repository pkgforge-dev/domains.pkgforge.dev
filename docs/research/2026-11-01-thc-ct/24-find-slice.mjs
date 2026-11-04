// DOM-029 instrument 24, copied from the session scratchpad (find-slice.mjs) as it ran on 2026-11-02T04:05Z.
// The question: which window of 2,000 real lines of the head of 2026-10-31 holds upper case, wildcards, an xn-- line and an address literal (the fixture slice of stage 3).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/24-find-slice.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Scratch: find 2,000-line windows of a THC head file holding upper case, a
// `*.` line, an xn-- line and an address literal (numeric-tld).
// Usage: node find-slice.mjs HEAD.gz PSL [N]
import { readFileSync } from 'node:fs';
import { loadPsl, normalise } from '../../../packages/names/src/index.ts';

const [file, pslPath, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 2000);
const psl = await loadPsl(readFileSync(pslPath));
const reader = new Blob([readFileSync(file)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
const dec = new TextDecoder();
const lines = [];
const offs = [];
let tail = '';
let byte = 0;
outer: for (;;) {
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
    lines.push(l);
    offs.push(byte);
    byte += Buffer.byteLength(l) + 1;
    if (lines.length >= 3_000_000) break outer;
  }
}
const kind = lines.map((l) => {
  const n = normalise(l, psl);
  return {
    upper: /[A-Z]/.test(l),
    wild: l.startsWith('*.'),
    xn: /(^|\.)xn--/.test(l),
    numeric: 'refused' in n && n.refused === 'numeric-tld',
    refused: 'refused' in n ? n.refused : null,
  };
});
const found = [];
for (let s = 0; s + N <= lines.length && found.length < 8; s += 500) {
  const w = kind.slice(s, s + N);
  const c = { upper: 0, wild: 0, xn: 0, numeric: 0, refused: {} };
  for (const k of w) {
    if (k.upper) c.upper++;
    if (k.wild) c.wild++;
    if (k.xn) c.xn++;
    if (k.numeric) c.numeric++;
    if (k.refused) c.refused[k.refused] = (c.refused[k.refused] ?? 0) + 1;
  }
  if (c.upper > 0 && c.wild > 0 && c.xn > 0 && c.numeric > 0) found.push({ start: s, byte: offs[s], end: offs[s + N - 1] + Buffer.byteLength(lines[s + N - 1]) + 1, ...c });
}
console.log(`lines read ${lines.length}`);
for (const f of found) console.log(JSON.stringify(f));
