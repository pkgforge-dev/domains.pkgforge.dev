// DOM-029 instrument 17, copied from .tmp/dom029/challenge/root-lens/bench-exact.mjs as it ran on 2026-11-01T10:24Z.
// The question: what exactNew costs a day key a base pack (design M19).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/17-bench-exact.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// root-lens (scratch): exactNew over K base packs, for the first daily after the backfill.
// The day keys are the real pack's keys + "!" (absent from every base pack, so every key visits every cursor:
// the worst case of exactNew's loop, and the case of a domain no earlier day holds).
import { performance } from 'node:perf_hooks';
import { DOMAINS_CODEC, PackReader } from '@domains/pack';
import { openPackFiles } from '@domains/pack/node';
import { exactNew, newExactStats } from '@domains/ledger';

const DIR = process.env.PACK_DIR ?? '.tmp/dom029/pack-bench/domains';
const handles = [];
const open = async () => {
  const f = await openPackFiles(DIR);
  handles.push(f);
  return PackReader.open(f.idx, f.parts, DOMAINS_CODEC, { partSizes: f.partSizes });
};
const K = Number(process.argv[2] ?? 16);
const r1 = await open();
const day = [];
for await (const r of r1.scan()) day.push({ ...r, key: `${r.key}!` });
const keys = day.filter((r, i) => i === 0 || r.key > day[i - 1].key);
const readers = [];
for (let i = 0; i < K; i++) readers.push(await open());
const stats = newExactStats();
const a = performance.now();
let got = 0;
for await (const _ of exactNew(keys, readers, { stats })) got += 1;
const s = (performance.now() - a) / 1000;
console.log(`exactNew: ${keys.length} day keys over ${K} base packs (${keys.length * K} has() calls): ${s.toFixed(1)} s = ${((s * 1e6) / (keys.length * K)).toFixed(3)} us per (day key x pack); blocks read ${stats.blocksRead}; new ${got}`);
const perCall = (s * 1e6) / (keys.length * K);
for (const [label, keysN, packs] of [['an October day (11.6M keys) over 59 packs', 11_600_000, 59], ['a September-size day (40M keys) over 59 packs', 40_000_000, 59]]) {
  console.log(`extrapolated ${label}: ${((keysN * packs * perCall) / 1e6 / 60).toFixed(1)} min on this desktop (blocks read stay cached per cursor; [E])`);
}
await Promise.all(handles.map((h) => h.close()));
