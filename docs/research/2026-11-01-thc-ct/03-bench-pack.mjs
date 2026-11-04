// DOM-029 instrument 03, copied from .tmp/dom029/bench-pack.mjs as it ran on 2026-11-01T07:51Z.
// The question: what the names and the domains packs of the head sample cost a record and a name (design M9).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/03-bench-pack.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// .tmp/dom029/bench-pack.mjs — DOM-029 design measurement (not tracked).
// Times writePackFiles of @domains/pack/node (the writer the disk writer of
// scripts/ingest/writer.mjs calls) over the names and domains records of the
// head of one dump, as thc-ct would write them (bit 0, first = last = the day
// index, flags exact/wildcard; domains with one ct-first evidence entry).
// Usage: node docs/research/2026-11-01-thc-ct/03-bench-pack.mjs FILE.gz PSL OUTDIR
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadPsl, normalise, split } from '@domains/names';
import { codecOf } from '@domains/compact';
import { writePackFiles } from '@domains/pack/node';

const [file, pslPath, out] = process.argv.slice(2);
const psl = await loadPsl(readFileSync(pslPath));
const DAY = Math.round((Date.UTC(2026, 9, 31) - Date.UTC(2026, 0, 1)) / 86400000);
const gz = readFileSync(file);
const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
const dec = new TextDecoder();
const flags = new Map();
let tail = '';
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
    if (l.length === 0) continue;
    const n = normalise(l, psl);
    if ('refused' in n) continue;
    const k = n.name.split('.').reverse().join('.');
    flags.set(k, (flags.get(k) ?? 0) | (n.wild ? 2 : 1));
  }
}
const keys = [...flags.keys()].sort();
const regSet = new Set();
for (const k of keys) {
  const reg = split(k.split('.').reverse().join('.'), psl).reg;
  if (reg !== null) regSet.add(reg.split('.').reverse().join('.'));
}
const regs = [...regSet].sort();
console.log(`names ${keys.length}, regs ${regs.length}, day index ${DAY}`);
const size = (dir) => readdirSync(dir).reduce((a, f) => a + statSync(join(dir, f)).size, 0);
{
  const a = performance.now();
  function* recs() {
    for (const k of keys) yield { key: k, flags: flags.get(k), sources: [{ bit: 0, first: DAY, last: DAY }] };
  }
  const w = await writePackFiles(recs(), join(out, 'names'), { codec: codecOf('names') });
  const b = performance.now();
  const bytes = size(join(out, 'names'));
  console.log(`names pack: ${((b - a) / 1000).toFixed(2)} s, ${w.summary.records} records, ${bytes} B on disk, ${(bytes / w.summary.records).toFixed(3)} B a name (${((((b - a) * 1000) / keys.length)).toFixed(2)} us a record)`);
}
{
  const a = performance.now();
  function* recs() {
    for (const k of regs) yield { key: k, flags: 0, sources: [{ bit: 0, first: DAY, last: DAY }], evidence: [{ tier: 3, basis: 4, source: 0, at: DAY, confidence: 0 }] };
  }
  const w = await writePackFiles(recs(), join(out, 'domains'), { codec: codecOf('domains') });
  const b = performance.now();
  const bytes = size(join(out, 'domains'));
  console.log(`domains pack: ${((b - a) / 1000).toFixed(2)} s, ${w.summary.records} records, ${bytes} B on disk, ${(bytes / w.summary.records).toFixed(3)} B a domain`);
}
