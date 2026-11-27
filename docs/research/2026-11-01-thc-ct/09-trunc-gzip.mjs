// DOM-029 instrument 09, copied from .tmp/dom029/challenge/trunc-gzip.mjs as it ran on 2026-11-01T08:22Z.
// The question: whether DecompressionStream throws on a truncated gzip and on trailing bytes (design M21).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/09-trunc-gzip.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Challenge probe: does DecompressionStream('gzip') throw on a truncated gzip (a file still being written)?
// Also: a gzip whose last member is complete but with bytes of a second, zero-length / padding tail.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

async function drain(bytes) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  const writing = (async () => {
    try {
      await w.write(bytes);
      await w.close();
    } catch (e) {
      return `writer: ${e.name}: ${e.message}`;
    }
    return 'writer ok';
  })();
  let total = 0;
  let outcome = 'read ok';
  try {
    const r = ds.readable.getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      total += value.length;
    }
  } catch (e) {
    outcome = `read: ${e.name}: ${e.message}`;
  }
  return `${outcome}; ${await writing}; ${total} bytes out`;
}

const full = gzipSync(Buffer.from('a.example.com\n'.repeat(200000)));
console.log('full file', full.length, 'B:', await drain(full));
console.log('truncated by 1 byte (trailer cut):', await drain(full.subarray(0, full.length - 1)));
console.log('truncated by 8 bytes (no trailer):', await drain(full.subarray(0, full.length - 8)));
console.log('truncated in half:', await drain(full.subarray(0, full.length >> 1)));
console.log('trailing zero bytes (4 KiB tar-like padding):', await drain(Buffer.concat([full, Buffer.alloc(4096)])));
console.log('trailing one zero byte:', await drain(Buffer.concat([full, Buffer.alloc(1)])));
const head = readFileSync(process.argv[2]);
console.log('real head (64 MiB of a 324 MB file):', head.length, 'B:', await drain(head));
console.log(`node ${process.version}`);
