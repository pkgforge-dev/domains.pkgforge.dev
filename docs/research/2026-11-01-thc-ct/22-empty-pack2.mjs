// DOM-029 instrument 22, copied from .tmp/dom029/challenge/door/empty-pack2.mjs as it ran on 2026-11-01T10:22Z.
// The question: whether the pack writer writes a names pack of no record and the verifier passes it (design M26).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/22-empty-pack2.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Writes a zero-record names pack to a directory and prints the directory.
import { mkdirSync } from 'node:fs';
import { writePackFiles } from '@domains/pack/node';
import { codecOf } from '@domains/compact';
const dir = '.tmp/dom029/challenge/door/empty-names';
mkdirSync(dir, { recursive: true });
async function* none() {}
await writePackFiles(none(), dir, { codec: codecOf('names') });
console.log(dir);
