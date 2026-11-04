// DOM-029 instrument 18, copied from .tmp/dom029/challenge/root-lens/cap-check.mjs as it ran on 2026-11-01T10:16Z.
// The question: whether a filter of the backfill sum passes the 1 GiB a reader of state takes (design M18).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/18-cap-check.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// root-lens (scratch): the filter size the code gives after the backfill, against readLedgerObject's cap.
// readBlob refuses a blob over `max` before any read, so a fake descriptor shows the refusal with no allocation.
import { readBlob } from '../../../scripts/root/lib.mjs';
import { LEDGER_MAX_BYTES } from '../../../../scripts/state/lib.mjs';
import { BloomFilter } from '../../../../packages/ledger/src/index.ts';

const sizeFor = (expected) => {
  const hashes = 7;
  const partition = Math.max(64, Math.ceil((expected * 10) / hashes / 64) * 64);
  return (hashes * partition) / 8;
};
for (const [label, expected] of [
  ['Q1 estimate: 288M distinct', 288_022_432],
  ['sum of records after the backfill (M15 + 5 days + oi-nrd)', 1_504_980_665],
]) {
  const bytes = sizeFor(expected) + 36; // FILTER_HEADER_BYTES
  const desc = { digest: `sha256:${'0'.repeat(64)}`, size: bytes };
  try {
    await readBlob({}, 'pkgforge-dev/domains.pkgforge.dev/state', desc, {}, LEDGER_MAX_BYTES);
    console.log(`${label}: filter file ${bytes} B: readBlob passed the size check (it then tried a read)`);
  } catch (e) {
    console.log(`${label}: filter file ${bytes} B (${(bytes / 2 ** 30).toFixed(2)} GiB): ${e.constructor.name}: ${e.message}`);
  }
}
console.log(`LEDGER_MAX_BYTES = ${LEDGER_MAX_BYTES}; BloomFilter.forKeys sizing by sum of records, checked against the real allocator for 10M keys: ${BloomFilter.forKeys(10_000_000, { asOf: 0 }).bitBytes} B vs formula ${sizeFor(10_000_000)} B`);
