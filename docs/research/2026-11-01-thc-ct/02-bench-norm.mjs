// DOM-029 instrument 02, copied from .tmp/dom029/bench-norm.mjs as it ran on 2026-11-01T07:49Z.
// The question: what gunzip, normalise, key and the registrable domain cost a line (design M8).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/02-bench-norm.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// .tmp/dom029/bench-norm.mjs — DOM-029 design measurement (not tracked).
// Splits the per-line cost of the head measurement: decode+split, normalise,
// key, split of the PSL, over the first N lines of the head of one dump.
// Usage: node docs/research/2026-11-01-thc-ct/02-bench-norm.mjs FILE.gz PSL [N]
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { key, loadPsl, normalise, split } from '@domains/names';

const [file, pslPath, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 2_000_000);
const psl = await loadPsl(readFileSync(pslPath));
const gz = readFileSync(file);
const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
const dec = new TextDecoder();
const lines = [];
let tail = '';
const d0 = performance.now();
while (lines.length < N) {
  let r;
  try {
    r = await reader.read();
  } catch {
    break;
  }
  if (r.done) break;
  const parts = (tail + dec.decode(r.value, { stream: true })).split('\n');
  tail = parts.pop();
  for (const l of parts) if (l.length > 0 && lines.length < N) lines.push(l);
}
const d1 = performance.now();
console.log(`lines ${lines.length}; gunzip+decode+split ${((d1 - d0) / 1000).toFixed(2)} s (${(((d1 - d0) * 1000) / lines.length).toFixed(2)} us a line)`);

const time = (what, f) => {
  const a = performance.now();
  const out = f();
  const b = performance.now();
  console.log(`${what}: ${((b - a) / 1000).toFixed(2)} s (${(((b - a) * 1000) / lines.length).toFixed(2)} us a line)`);
  return out;
};
const normed = time('normalise', () => lines.map((l) => normalise(l, psl)));
const ok = normed.filter((n) => !('refused' in n));
const keys = time('key(name)', () => ok.map((n) => key(n.name)));
const rev = time('reverse by split/reverse/join (no check)', () => ok.map((n) => n.name.split('.').reverse().join('.')));
time('split(name).reg', () => ok.map((n) => split(n.name, psl).reg));
const distinct = [...new Set(keys)];
console.log(`distinct keys ${distinct.length} of ${keys.length}`);
time('sort of the distinct keys', () => distinct.slice().sort());
console.log(`rev equals key: ${rev.every((r, i) => r === keys[i])}`);
