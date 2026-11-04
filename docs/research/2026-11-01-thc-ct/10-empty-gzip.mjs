// DOM-029 instrument 10, copied from .tmp/dom029/challenge/empty-gzip.mjs as it ran on 2026-11-01T08:31Z.
// The question: what DecompressionStream does with an empty input, an HTML page and a valid empty gzip (design M21).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/10-empty-gzip.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Challenge probe: DecompressionStream('gzip') on an empty input, a 10-byte header only, and a valid empty gzip.
import { gzipSync } from 'node:zlib';
async function drain(bytes) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  const writing = (async () => { try { if (bytes.length) await w.write(bytes); await w.close(); return 'writer ok'; } catch (e) { return `writer ${e.name}`; } })();
  let total = 0, outcome = 'read ok';
  try { const r = ds.readable.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; total += value.length; } } catch (e) { outcome = `read ${e.name}: ${JSON.stringify(e.message)}`; }
  return `${outcome}; ${await writing}; ${total} bytes out`;
}
console.log('0 bytes in           :', await drain(new Uint8Array(0)));
console.log('10-byte header only  :', await drain(gzipSync(Buffer.alloc(0)).subarray(0, 10)));
console.log('valid empty gzip (20):', gzipSync(Buffer.alloc(0)).length, 'B', await drain(gzipSync(Buffer.alloc(0))));
console.log('html maintenance page:', await drain(new TextEncoder().encode('<html>503</html>')));
