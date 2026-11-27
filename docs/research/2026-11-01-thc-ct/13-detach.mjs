// DOM-029 instrument 13, copied from .tmp/dom029/challenge/detach.mjs as it ran on 2026-11-01T08:29Z.
// The question: whether feeding held chunks to a byte stream detaches them, so a second write reads nothing (design M28).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/13-detach.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Challenge probe: does feeding the same Uint8Array chunks to a DecompressionStream detach or alter them, so a
// second pass (the domains write re-reads `chunks` as raw, design section 4.4 steps 3 and 4) sees a different file?
// Three ways of feeding: writer.write(chunk); ReadableStream (default) pipeThrough; Blob([chunks]).stream().
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const text = Buffer.from('a.example.com\n'.repeat(500000));
const gz = gzipSync(text);
// 8 chunks, as the reader coalesces them
const chunks = [];
for (let at = 0; at < gz.length; at += Math.ceil(gz.length / 8)) chunks.push(new Uint8Array(gz.subarray(at, at + Math.ceil(gz.length / 8))));
const sha = (cs) => {
  const h = createHash('sha256');
  for (const c of cs) h.update(c);
  return h.digest('hex').slice(0, 12);
};
const before = sha(chunks);
const lens = () => chunks.map((c) => `${c.byteLength}/${c.buffer.byteLength}`).join(' ');
console.log('before', before, lens());

async function drain(readable) {
  let n = 0;
  const r = readable.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) return n;
    n += value.length;
  }
}

// 1. writer.write
{
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  const out = drain(ds.readable);
  for (const c of chunks) await w.write(c);
  await w.close();
  console.log('writer.write      ->', await out, 'bytes out; after', sha(chunks), lens());
}
// 2. default ReadableStream.pipeThrough
{
  let i = 0;
  const rs = new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); } });
  console.log('ReadableStream    ->', await drain(rs.pipeThrough(new DecompressionStream('gzip'))), 'bytes out; after', sha(chunks), lens());
}
// 3. byte stream (type: 'bytes') enqueue transfers the buffer
{
  let i = 0;
  const rs = new ReadableStream({ type: 'bytes', pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); } });
  let outcome;
  try {
    outcome = await drain(rs.pipeThrough(new DecompressionStream('gzip')));
  } catch (e) {
    outcome = `threw ${e.message}`;
  }
  console.log('byte ReadableStream ->', outcome, 'bytes out; after', sha(chunks), lens());
}
// 4. Response / Blob
{
  console.log('Blob.stream       ->', await drain(new Blob(chunks).stream().pipeThrough(new DecompressionStream('gzip'))), 'bytes out; after', sha(chunks), lens());
}
console.log(`node ${process.version}`);
