// scripts/root/size.mjs — the bytes of root.json as layerBytes writes it
// (compact JSON, one final newline), over synthetic pack entries
// (packages/root/test/helpers.ts): the [E] figures of docs/architecture.md
// section 4.6 and the comment on LAYER_MAX_BYTES of scripts/root/lib.mjs. Every
// entry is synthetic, so the figures are an estimate; the first real roots
// replace them.
//
// It prints one JSON object, each value in bytes:
//   entry       what one names hour pack of one part and three sources adds:
//               root.json of 200 such packs less root.json of 50, over 150
//   part        what each further part adds: one pack of 25 parts less one of
//               1 part, over 24
//   withdrawn   what each withdrawn entry adds: 50 packs rolled back to the
//               first 26, less a root of those 26 alone, over the 24 entries
//   one         root.json of 50 such packs of one dataset (the fan-out of
//               section 4.5 for names)
//   five        root.json of 50 such packs in each of the five datasets of a root
//   time        what a time copy of one part adds to a feed pack's entry:
//               50 feed hour packs with one, less 50 without, over 50 (an
//               hour pack may have none; a day pack that holds records may not)
//
// Usage: node scripts/root/size.mjs
// Exit codes: 0 printed · 70 an internal error, a defect of this script (its
// stack goes to stderr).
import { pathToFileURL } from 'node:url';
import { buildRoot, DATASETS, layerBytes, rollbackRoot } from '@domains/root';
import { live, PSL_LIVE, pack } from '../../packages/root/test/helpers.ts';

const SOURCES = ['ct-le', 'oi-cs', 'thc-ct'];
const NOW = '2026-12-01T00:00:00Z';
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const hourOf = (i) => iso(Date.UTC(2026, 9, 1) + i * 3_600_000);
const bytesOf = (root) => layerBytes(root).length;
const first = () => buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-28T00:00:00Z' });

// `n` hour packs of `dataset` from 2026-10-01, each of `parts` parts of 1,000 B
// and three sources.
function hourPacks(dataset, n, parts = 1) {
  return Array.from({ length: n }, (_, i) => {
    const np = pack(dataset, 'h', hourOf(i), { sources: SOURCES });
    const blobs = Array.from({ length: parts }, (_, k) => ({ digest: `sha256:${String(k).padStart(64, '0')}`, size: 1000 }));
    return { ...np, pack: { ...np.pack, parts: blobs, pack: { ...np.pack.pack, bytes: np.pack.idx.size + 1000 * parts } } };
  });
}

const rootOf = (add, now = NOW) => buildRoot({ live: live(first()), psl: PSL_LIVE, now, add });

export function sizes() {
  const fifty = bytesOf(rootOf(hourPacks('names', 50)));
  const entry = (bytesOf(rootOf(hourPacks('names', 200))) - fifty) / 150;
  const part = (bytesOf(rootOf(hourPacks('names', 1, 25))) - bytesOf(rootOf(hourPacks('names', 1)))) / 24;
  const all = hourPacks('names', 50);
  const target = rootOf(all.slice(0, 26));
  const full = buildRoot({ live: live(target), psl: PSL_LIVE, now: '2026-12-01T01:00:00Z', add: all.slice(26) });
  const back = rollbackRoot({ live: live(full), target, between: [], psl: PSL_LIVE, now: '2026-12-01T02:00:00Z' });
  const withdrawn = (bytesOf(back) - bytesOf(rootOf(all.slice(0, 26), '2026-12-01T02:00:00Z'))) / back.withdrawn.length;
  const five = bytesOf(rootOf(DATASETS.flatMap((ds) => hourPacks(ds, 50))));
  const feedHours = (time) => bytesOf(buildRoot({ live: null, psl: PSL_LIVE, now: NOW, add: Array.from({ length: 50 }, (_, i) => pack('feed', 'h', hourOf(i), { sources: ['oi-nrd'], time })) }));
  const time = (feedHours(true) - feedHours(false)) / 50;
  const tenth = (x) => Math.round(x * 10) / 10;
  return { entry: tenth(entry), part: tenth(part), withdrawn: tenth(withdrawn), one: fifty, five, time: tenth(time), datasets: DATASETS.length };
}

export function main(_argv = [], deps = {}) {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  try {
    out(JSON.stringify(sizes()));
    return 0;
  } catch (e) {
    err(`size: internal error: ${e?.stack ?? e}`);
    return 70;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
