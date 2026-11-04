// DOM-029 instrument 01, copied from .tmp/dom029/measure-head.mjs as it ran on 2026-11-01T07:47Z.
// The question: what each stage of the adapter costs a line over the head of one dump, and what one sort of every key costs against runs merged by a heap (design M7).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/01-measure-head.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// .tmp/dom029/measure-head.mjs — DOM-029 design measurement (not tracked).
// Times, over the head of one THC dump (a Range read, truncated gzip), the
// stages the thc-ct adapter would run in a Worker-shaped module (web APIs
// only, as adapters/*/src must be): gunzip by DecompressionStream, line split
// by TextDecoder, normalise and key of @domains/names, split of the PSL for
// the registrable domain, then the sort of keys two ways:
//   A  one Array.prototype.sort of every key string;
//   B  runs of RUN keys sorted in memory, each front-coded and compressed with
//      CompressionStream('deflate-raw') into Uint8Arrays, then a k-way merge
//      that decodes them back, dedupes, and counts.
// Usage: node docs/research/2026-11-01-thc-ct/01-measure-head.mjs FILE.gz PSL [RUN]
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { key, loadPsl, normalise, split } from '@domains/names';

const [file, pslPath, runArg] = process.argv.slice(2);
const RUN = Number(runArg ?? 1_000_000);
const mem = () => {
  const m = process.memoryUsage();
  return `rss ${(m.rss / 2 ** 20).toFixed(0)} MiB heap ${(m.heapUsed / 2 ** 20).toFixed(0)} MiB ext ${((m.external + m.arrayBuffers) / 2 ** 20).toFixed(0)} MiB`;
};
const t = () => performance.now();
const psl = await loadPsl(readFileSync(pslPath));

// 1. gzip header.
const gz = readFileSync(file);
console.log(`file ${file} ${gz.length} B; magic ${gz[0].toString(16)} ${gz[1].toString(16)} method ${gz[2]} flags ${gz[3]} mtime ${gz.readUInt32LE(4)} xfl ${gz[8]} os ${gz[9]}`);

// 2. Multi-member check of DecompressionStream on a synthetic two-member gzip.
{
  const enc = async (s) => new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const a = await enc('a.example.com\n');
  const b = await enc('b.example.com\n');
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  let out = '';
  try {
    out = await new Response(new Blob([both]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } catch (e) {
    out = `threw ${e.message}`;
  }
  console.log(`two-member gzip through DecompressionStream: ${JSON.stringify(out)}`);
}

// 3. gunzip + lines + normalise + keys, streaming, the truncated tail tolerated.
const t0 = t();
const names = [];
const regs = [];
const wildSet = new Set();
let lines = 0;
let bytes = 0;
let upper = 0;
let wild = 0;
const refused = {};
let tail = '';
let stopped = null;
let tGunzip = 0;
let tNorm = 0;
const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
const dec = new TextDecoder('utf-8', { fatal: false });
for (;;) {
  let r;
  const g0 = t();
  try {
    r = await reader.read();
  } catch (e) {
    stopped = e.message;
    break;
  }
  tGunzip += t() - g0;
  if (r.done) break;
  bytes += r.value.length;
  const n0 = t();
  const text = tail + dec.decode(r.value, { stream: true });
  const parts = text.split('\n');
  tail = parts.pop();
  for (const line of parts) {
    if (line.length === 0) continue;
    lines += 1;
    if (/[A-Z]/.test(line)) upper += 1;
    const n = normalise(line, psl);
    if ('refused' in n) {
      refused[n.refused] = (refused[n.refused] ?? 0) + 1;
      continue;
    }
    const k = key(n.name);
    if (n.wild) {
      wild += 1;
    }
    names.push(n.wild ? `${k}\u0001` : k);
    const reg = split(n.name, psl).reg;
    if (reg !== null) regs.push(key(reg));
  }
  tNorm += t() - n0;
}
const t1 = t();
console.log(`gunzip+normalise: ${bytes} B text, ${lines} lines (last partial line dropped), upper ${upper}, wild ${wild}, refused ${JSON.stringify(refused)}; stopped: ${stopped}`);
console.log(`  wall ${((t1 - t0) / 1000).toFixed(2)} s: gunzip ${(tGunzip / 1000).toFixed(2)} s, split+normalise+key+reg ${(tNorm / 1000).toFixed(2)} s; ${mem()}`);
console.log(`  keys ${names.length}, regs ${regs.length}`);

// 4A. One sort of every key.
{
  const copy = names.slice();
  const s0 = t();
  copy.sort();
  const s1 = t();
  let distinct = 0;
  let prev = null;
  for (const k of copy) {
    const base = k.endsWith('\u0001') ? k.slice(0, -1) : k;
    if (base !== prev) distinct += 1;
    prev = base;
  }
  const s2 = t();
  console.log(`A one sort of ${copy.length} keys: ${((s1 - s0) / 1000).toFixed(2)} s, dedupe ${((s2 - s1) / 1000).toFixed(2)} s, distinct ${distinct}; ${mem()}`);
}
{
  const copy = regs.slice();
  const s0 = t();
  copy.sort();
  const s1 = t();
  let distinct = 0;
  let prev = null;
  for (const k of copy) {
    if (k !== prev) distinct += 1;
    prev = k;
  }
  console.log(`A one sort of ${copy.length} reg keys: ${((s1 - s0) / 1000).toFixed(2)} s, distinct ${distinct}`);
}

// 4B. Runs: sort RUN keys, dedupe, front-code, deflate-raw; then a k-way merge.
const te = new TextEncoder();
const td = new TextDecoder();
async function deflate(chunks) {
  return new Uint8Array(await new Response(new Blob(chunks).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
}
async function encodeRun(keys) {
  keys.sort();
  const chunks = [];
  let prev = '';
  let buf = new Uint8Array(1 << 20);
  let at = 0;
  const flush = () => {
    chunks.push(buf.slice(0, at));
    at = 0;
  };
  for (const k of keys) {
    if (k === prev) continue;
    let p = 0;
    const m = Math.min(255, prev.length, k.length);
    while (p < m && prev.charCodeAt(p) === k.charCodeAt(p)) p += 1;
    const rest = te.encode(k.slice(p));
    if (at + rest.length + 2 > buf.length) flush();
    buf[at++] = p;
    buf[at++] = rest.length;
    buf.set(rest, at);
    at += rest.length;
    prev = k;
  }
  flush();
  return deflate(chunks);
}
async function* decodeRun(bytes) {
  const r = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  let prev = '';
  let pend = new Uint8Array(0);
  for (;;) {
    const x = await r.read();
    if (x.done) break;
    const all = new Uint8Array(pend.length + x.value.length);
    all.set(pend);
    all.set(x.value, pend.length);
    let at = 0;
    const out = [];
    while (at + 2 <= all.length && at + 2 + all[at + 1] <= all.length) {
      const p = all[at];
      const n = all[at + 1];
      const k = prev.slice(0, p) + td.decode(all.subarray(at + 2, at + 2 + n));
      out.push(k);
      prev = k;
      at += 2 + n;
    }
    pend = all.slice(at);
    for (const k of out) yield k;
  }
}
async function runsOf(all, what) {
  const r0 = t();
  const runs = [];
  let stored = 0;
  for (let i = 0; i < all.length; i += RUN) {
    const b = await encodeRun(all.slice(i, i + RUN));
    stored += b.length;
    runs.push(b);
  }
  const r1 = t();
  // k-way merge with a binary heap over the runs' heads.
  const its = runs.map((b) => decodeRun(b)[Symbol.asyncIterator]());
  const heap = [];
  const less = (a, b) => a.k < b.k;
  const push = (e) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  for (const it of its) {
    const x = await it.next();
    if (!x.done) push({ k: x.value, it });
  }
  let out = 0;
  let prev = null;
  while (heap.length > 0) {
    const e = pop();
    const base = e.k.endsWith('\u0001') ? e.k.slice(0, -1) : e.k;
    if (base !== prev) out += 1;
    prev = base;
    const x = await e.it.next();
    if (!x.done) push({ k: x.value, it: e.it });
  }
  const r2 = t();
  console.log(`B ${what}: ${runs.length} runs of ${RUN}: sort+encode ${((r1 - r0) / 1000).toFixed(2)} s, stored ${stored} B (${(stored / all.length).toFixed(2)} B a key), merge ${((r2 - r1) / 1000).toFixed(2)} s, distinct ${out}; ${mem()}`);
}
await runsOf(names, 'names');
await runsOf(regs, 'regs');
console.log(`done ${mem()}`);
