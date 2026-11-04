// DOM-029 instrument 16, copied from .tmp/dom029/challenge/root-lens/bench-filter.mjs as it ran on 2026-11-01T10:12Z.
// The question: what the ledger filter costs a record to build, and how large it is for the sum of the backfill records (design M18, M19).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/16-bench-filter.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// root-lens measurement (scratch, not tracked): the cost of the first filter rebuild after the backfill.
// Opens the real 1.33M-record domains pack of .tmp/dom029/pack-bench K times (the same file, so every key
// repeats K times, like the same domain on K days) and times buildFilter's merge, then computes the size
// the code gives the filter for the real sum of records (BloomFilter.forKeys, no allocation of the bits).
import { performance } from 'node:perf_hooks';
import { DOMAINS_CODEC, PackReader, mergePacks } from '@domains/pack';
import { openPackFiles } from '@domains/pack/node';
import { BloomFilter, buildFilter } from '@domains/ledger';

const DIR = process.env.PACK_DIR ?? '.tmp/dom029/pack-bench/domains';
const handles = [];
const open = async () => {
  const f = await openPackFiles(DIR);
  handles.push(f);
  return PackReader.open(f.idx, f.parts, DOMAINS_CODEC, { partSizes: f.partSizes });
};
const K = Number(process.argv[2] ?? 8);
const readers = [];
for (let i = 0; i < K; i++) readers.push(await open());
const N = readers[0].index.header.records;
console.log(`node ${process.version}; one pack: ${N} records, ${readers[0].index.header.blocks} blocks; K=${K} readers, sum of records ${K * N}`);

const t0 = performance.now();
const f = await buildFilter(readers, { asOf: 0 });
const s = (performance.now() - t0) / 1000;
console.log(`buildFilter over ${K} packs: ${s.toFixed(2)} s for ${K * N} input records = ${((s * 1e6) / (K * N)).toFixed(3)} us per input record; filter keys added ${f.keys}; bits ${f.bitBytes} bytes`);

// the sizes the code gives the filter (forKeys allocates the bit array: do it for one size only)
for (const [label, expected] of [
  ['today (5.33M domains records, root of 2026-11-01)', 5_334_782],
  ['design Q1 estimate (288M distinct)', 288_022_432],
  ['sum of records, 54 days (M15) + oi-nrd', 1_441_645_883 + 5_334_782],
  ['sum of records, 59 days (54 + 5 October days at 11.6M)', 1_441_645_883 + 5 * 11_600_000 + 5_334_782],
]) {
  const hashes = 7;
  const bitsPerKey = 10;
  const partition = Math.max(64, Math.ceil((expected * bitsPerKey) / hashes / 64) * 64);
  const bytes = (hashes * partition) / 8;
  console.log(`forKeys(${expected}) [${label}]: ${bytes} bytes = ${(bytes / 2 ** 20).toFixed(0)} MiB = ${(bytes / 2 ** 30).toFixed(3)} GiB; limits: LEDGER_MAX_BYTES 1 GiB (scripts/state/lib.mjs:57) ${bytes > 2 ** 30 ? 'EXCEEDED' : 'ok'}; fs.readFileSync 2 GiB ${bytes > 2 ** 31 - 1 ? 'EXCEEDED' : 'ok'}`);
}
// where the 1 GiB cap is crossed: the sum of records
const capSum = Math.floor((2 ** 30 * 8) / 10);
console.log(`1 GiB is crossed at a sum of ${capSum} records (about ${(capSum / 1e6).toFixed(0)}M); 2 GiB at ${Math.floor((2 ** 31 * 8) / 10)}; MAX_PARTITION_BITS cap at ${Math.floor(((2 ** 32 - 64) * 7) / 10)}`);
await Promise.all(handles.map((h) => h.close()));
