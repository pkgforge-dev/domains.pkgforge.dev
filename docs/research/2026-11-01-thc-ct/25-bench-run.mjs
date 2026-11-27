// DOM-029 instrument 25, copied from the session scratchpad (bench-run.mjs) as it ran on 2026-11-02T04:2xZ to 04:54Z.
// The question: what the live run of the adapter costs over N real lines, with a fetch double and a counting writer, at a given runKeys (stage 3, S3-D20).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/25-bench-run.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Scratch bench: the thc-ct live run over a valid gzip of the first N lines of
// the 2026-10-31 head, with a fetch double and a counting writer.
// Usage: node bench-run.mjs HEAD.gz PSL N [runKeys]
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';

const R = new URL('../../../', import.meta.url).href;
const { loadPsl } = await import(`${R}packages/names/src/index.ts`);
const { makeRun, LIMITS, HOSTS } = await import(`${R}adapters/thc-ct/src/index.ts`);

const [file, pslPath, nArg, rkArg] = process.argv.slice(2);
const N = Number(nArg);
const psl = await loadPsl(readFileSync(pslPath));
// N whole lines of the truncated head.
const reader = new Blob([readFileSync(file)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
const dec = new TextDecoder();
const lines = [];
let tail = '';
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
    if (lines.length >= N) break outer;
  }
}
await reader.cancel().catch(() => {});
const gz = gzipSync(Buffer.from(lines.join('\n') + '\n'));
console.log(`lines ${lines.length} gz ${gz.length} B`);
lines.length = 0;
const url = `${HOSTS.cs2}2026-10-31.txt.gz`;
const fetch = async (input, init) => {
  const u = String(input);
  if (u !== url) return new Response(null, { status: 404 });
  const headers = { 'content-length': String(gz.length), 'last-modified': 'Sun, 01 Nov 2026 00:05:02 GMT' };
  if ((init?.method ?? 'GET') === 'HEAD') return new Response(null, { status: 200, headers });
  // 64 KiB chunks, as a socket gives them.
  let at = 0;
  const body = new ReadableStream({
    pull(c) {
      if (at >= gz.length) return c.close();
      c.enqueue(new Uint8Array(gz.subarray(at, at + 65536)));
      at += 65536;
    },
  });
  return new Response(body, { status: 200, headers });
};
const t = {};
const writer = {
  async write(draft, records, raw) {
    const w0 = performance.now();
    let rawBytes = 0;
    for await (const c of raw) rawBytes += c.byteLength;
    let n = 0;
    let prev = '';
    for await (const r of records) {
      if (r.key <= prev) throw new Error('order');
      prev = r.key;
      n++;
    }
    t[draft.dataset] = { ms: Math.round(performance.now() - w0), n, rawBytes };
    return { source: draft.source, dataset: draft.dataset, window: draft.window, cursorBefore: draft.cursorBefore, cursorAfter: draft.cursorAfter, count: n, precision: 'day', bytes: 0, sha256: '0'.repeat(64) };
  },
};
const limits = { ...LIMITS, ...(rkArg ? { runKeys: Number(rkArg) } : {}) };
const t0 = performance.now();
const res = await makeRun(limits, HOSTS)({ next: '2026-10-31', open: [] }, { fetch, connect: () => { throw new Error('no'); }, psl, now: '2026-11-01T00:30:00Z', userAgent: 'bench', writer });
const total = performance.now() - t0;
const m = process.memoryUsage();
console.log(JSON.stringify({ total_ms: Math.round(total), names: t.names, domains: t.domains, stats: res.stats, errors: res.errors, rss_mib: Math.round(m.rss / 2 ** 20), heap_mib: Math.round(m.heapUsed / 2 ** 20) }));
