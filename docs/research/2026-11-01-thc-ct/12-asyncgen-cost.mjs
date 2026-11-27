// DOM-029 instrument 12, copied from .tmp/dom029/challenge/asyncgen-cost.mjs as it ran on 2026-11-01T08:24Z.
// The question: what an async generator costs a line against one a batch (design M27).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/12-asyncgen-cost.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Challenge probe: cost of `for await (const line of linesOf(chunks))` (one async-generator yield per line, as
// design.md section 4.4 step 3 writes it) against a synchronous loop over each chunk's split array (what M7's
// measure-head.mjs timed). Same work in the body: a charCode scan of the line.
// Usage: node asyncgen-cost.mjs FILE.gz [LINES]
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const gz = readFileSync(process.argv[2]);
const LIMIT = Number(process.argv[3] ?? 3_000_000);
const t = () => performance.now();

// All lines of the head, decoded once, as arrays per chunk (so the two variants do identical decode work).
async function chunksOfLines() {
  const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const dec = new TextDecoder('utf-8');
  const out = [];
  let tail = '';
  let n = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      const parts = (tail + dec.decode(r.value, { stream: true })).split('\n');
      tail = parts.pop();
      out.push(parts);
      n += parts.length;
      if (n >= LIMIT) break;
    }
  } catch {
    // truncated head: tolerated
  }
  return out;
}

const batches = await chunksOfLines();
let total = 0;
for (const b of batches) total += b.length;
console.log(`${total} lines in ${batches.length} batches (${(total / batches.length) | 0} a batch)`);

function work(line) {
  let h = 0;
  for (let i = 0; i < line.length; i++) h = (h + line.charCodeAt(i)) | 0;
  return h;
}

// A: synchronous loop.
{
  const t0 = t();
  let acc = 0;
  for (const b of batches) for (const line of b) acc = (acc + work(line)) | 0;
  const dt = t() - t0;
  console.log(`A sync loop           : ${dt.toFixed(0)} ms, ${((dt * 1000) / total).toFixed(3)} us a line (acc ${acc})`);
}

// B: one async-generator yield per line, consumed by for await.
{
  async function* linesOf() {
    for (const b of batches) for (const line of b) yield line;
  }
  const t0 = t();
  let acc = 0;
  for await (const line of linesOf()) acc = (acc + work(line)) | 0;
  const dt = t() - t0;
  console.log(`B async gen per line  : ${dt.toFixed(0)} ms, ${((dt * 1000) / total).toFixed(3)} us a line (acc ${acc})`);
}

// C: async generator yielding one batch (an array of lines) at a time.
{
  async function* batchesOf() {
    for (const b of batches) yield b;
  }
  const t0 = t();
  let acc = 0;
  for await (const b of batchesOf()) for (const line of b) acc = (acc + work(line)) | 0;
  const dt = t() - t0;
  console.log(`C async gen per batch : ${dt.toFixed(0)} ms, ${((dt * 1000) / total).toFixed(3)} us a line (acc ${acc})`);
}

// D: names records generator shape: an async generator that, per input, does the body and yields once per OUTPUT
// record (the sorted merge). Same per-yield cost as B; shown for the merge side, 5.15M distinct of 5.98M lines.
{
  async function* recs() {
    for (let i = 0; i < total * 0.86; i++) yield { key: 'x', flags: 1, sources: [] };
  }
  const t0 = t();
  let n = 0;
  for await (const r of recs()) n += r.flags;
  const dt = t() - t0;
  console.log(`D async gen of records: ${dt.toFixed(0)} ms, ${((dt * 1000) / (total * 0.86)).toFixed(3)} us a record (n ${n})`);
}
console.log(`node ${process.version}`);
