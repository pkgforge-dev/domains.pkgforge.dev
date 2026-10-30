// scripts/compact/fixture.mjs — the inputs of a compaction on disk, for the
// tests of scripts/compact/: real DPK1 packs of synthetic records written as
// `oras pull` names a pack's layers (DIR/<tag>/idx, part.NNN, time.idx,
// time.part.NNN), their root entries built through packManifest and
// packFromManifest (the promotion's own reading), and a root.json that
// buildRoot of packages/root validates. Every key, time and source is
// synthetic. The PSL hash is the sha256 of the names package's test copy of
// the list, which scripts/verify-pack.mjs reads by default.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packManifest } from '@domains/compact';
import { DirPartsSink, fileDigest } from '@domains/compact/node';
import { writeFeedPack } from '@domains/feed';
import { FEED_CODEC, IDX_TITLE, NAMES_CODEC, NEW_NAME_CODEC, parseHead, TIME_IDX_TITLE, writePack } from '@domains/pack';
import { nodeCompress, writerId } from '@domains/pack/node';
import { buildRoot, packFromManifest } from '@domains/root';
import { packageOfDataset, repoOf } from '@domains/ghcr';
import { DEFAULT_PSL } from '../verify-pack.mjs';
import { EXIT as PLAN_EXIT, main as planMain } from './plan.mjs';

export const PSL = createHash('sha256').update(readFileSync(DEFAULT_PSL)).digest('hex');
export const EPOCH_MS = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;

// A seeded generator of whole numbers below n (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n;
  };
}

// `n` distinct reversed names from `seed`, ascending; two seeds share some.
export function keysOf(seed, n, space = 300, suffix = '') {
  const r = rng(seed);
  const out = new Set();
  // No wildcard suffix (*.np): a name under one at the second level is itself
  // a public suffix, which the verifier's name check refuses.
  const tlds = ['com', 'net', 'org', 'io', 'de'];
  while (out.size < n) {
    const i = Math.floor(r(space));
    out.add(`${tlds[i % 5]}.example${i}${suffix}`);
  }
  return [...out].sort();
}

export const dayIso = (d) => new Date(d).toISOString().replace('.000Z', 'Z');

// One input pack of `dataset` and `tier` from `start` in DIR/<tag>/, and its root entry.
export async function writeInput(dir, dataset, tier, start, { seed, n = 40, shared = null, recordsPerBlock = 8, sources = ['oi-cs', 'thc-ct'] }) {
  const end = dayIso(Date.parse(start) + DAY_MS);
  const tag = `${dataset}-${tier}-${start.slice(0, 10).replaceAll('-', '')}`;
  const at = join(dir, tag);
  mkdirSync(at, { recursive: true });
  const day = (Date.parse(start) - EPOCH_MS) / DAY_MS;
  let ks = keysOf(seed, n, 300, dataset === 'names' ? '' : `.d${seed}`);
  if (shared !== null) ks = [...new Set([...ks, ...shared])].sort();
  const keySink = new DirPartsSink(at, 'key');
  let summary;
  let time = null;
  if (dataset === 'names') {
    const records = ks.map((key, i) => ({ key, flags: 1, sources: [{ bit: i % 2, first: day, last: day }] }));
    summary = await writePack(records, { codec: NAMES_CODEC, compress: nodeCompress, sink: keySink, recordsPerBlock, pageEntries: 2 });
    await keySink.close();
  } else {
    const r = rng(seed);
    const t0 = day * 86_400;
    const rows = ks.map((key) => ({ key, flags: 0, firstSeen: t0 + Math.floor(r(86_400)), sources: [1], basis: 4, confidence: 0, feedFlags: 0 }));
    const timeSink = new DirPartsSink(at, 'time');
    const pack = await writeFeedPack(rows, {
      codec: dataset === 'feed' ? FEED_CODEC : NEW_NAME_CODEC,
      compress: nodeCompress,
      sink: keySink,
      recordsPerBlock,
      pageEntries: 2,
      time: { sink: timeSink, recordsPerBlock, pageEntries: 2 },
    });
    await keySink.close();
    await timeSink.close();
    summary = pack.summary;
    writeFileSync(join(at, TIME_IDX_TITLE), pack.time.idx);
    const parts = [];
    for (const f of timeSink.files) parts.push(await fileDigest(f));
    time = { idxBytes: pack.time.idx, parts, idx: { digest: `sha256:${createHash('sha256').update(pack.time.idx).digest('hex')}`, size: pack.time.idx.length } };
  }
  writeFileSync(join(at, IDX_TITLE), summary.idx);
  const parts = [];
  for (const f of keySink.files) parts.push(await fileDigest(f));
  const m = packManifest({
    dataset,
    tier,
    span: { start, end },
    tag,
    sources,
    psl: PSL,
    run: '1',
    summary,
    writer: writerId(),
    parts,
    idx: { digest: `sha256:${createHash('sha256').update(summary.idx).digest('hex')}`, size: summary.idx.length },
    time,
  });
  return { tag, dir: at, manifest: m, summary, keys: ks, time };
}

// The root entries of written inputs, read as the promotion reads them, and a root of them.
export async function rootOf(dataset, inputs, { gaps = {}, now = '2026-10-29T08:00:00Z' } = {}) {
  const facts = (bytes) => {
    const h = parseHead(bytes, bytes.length);
    return { dataset: h.header.dataset, records: h.header.records, keyMin: h.keyMin, keyMax: h.keyMax, parts: h.parts.map((p) => p.bytes) };
  };
  const add = inputs.map((i) =>
    packFromManifest({
      repo: repoOf(packageOfDataset(dataset)),
      tag: i.tag,
      digest: i.manifest.digest,
      json: i.manifest.json,
      head: facts(i.summary.idx),
      timeHead: i.time === null ? null : facts(i.time.idxBytes),
    }),
  );
  return buildRoot({ live: null, psl: PSL, now, add, gaps });
}

// A week of `dataset` on disk (the Monday 2026-10-19) and its plan of
// `ranges` ranges, 4 records a block, 2 index entries a page, by plan.mjs.
export async function plannedWeek(dir, dataset = 'names', ranges = 3, options = {}) {
  const monday = options.monday ?? '2026-10-19T00:00:00Z';
  const w = await week(join(dir, 'in'), dataset, monday, options);
  const planPath = join(dir, 'plan.json');
  const lines = [];
  const code = await planMain(
    [
      '--dataset',
      dataset,
      '--tier',
      'w',
      '--span',
      monday,
      '--root',
      w.rootPath,
      '--inputs',
      w.inputsDir,
      '--ranges',
      String(ranges),
      '--records-per-block',
      '4',
      '--page-entries',
      '2',
      '--out',
      planPath,
    ],
    { out: (l) => lines.push(l), err: (l) => lines.push(l) },
  );
  if (code !== PLAN_EXIT.ok) throw new Error(`plan.mjs exited ${code}:\n${lines.join('\n')}`);
  return { ...w, planPath, plan: JSON.parse(readFileSync(planPath, 'utf8')) };
}

// Seven day packs of `dataset` from `monday`, and the root of them.
export async function week(dir, dataset, monday, { skip = [], gaps = {}, sharedKey = false } = {}) {
  const inputs = [];
  for (let d = 0; d < 7; d += 1) {
    if (skip.includes(d)) continue;
    const start = dayIso(Date.parse(monday) + d * DAY_MS);
    // With sharedKey, day 3 also holds a key of day 0.
    const shared = sharedKey && d === 3 ? [keysOf(0, 40, 300, dataset === 'names' ? '' : '.d0')[7]] : null;
    inputs.push(await writeInput(dir, dataset, 'd', start, { seed: d, shared }));
  }
  const root = await rootOf(dataset, inputs, { gaps });
  const rootPath = join(dir, 'root.json');
  writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
  return { inputs, root, rootPath, inputsDir: dir };
}
