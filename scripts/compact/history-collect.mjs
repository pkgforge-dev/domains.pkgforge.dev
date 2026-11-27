// Anonymous materialization of the files an offline history build reads.
// The first pass verifies every manifest and counts missing bytes and ranges.
// Each file then appears at its archive path only after its bytes verify.
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readFile, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FACTS_MAX_BYTES, FACTS_TITLE } from '@domains/adapter';
import { dayOf, QUARANTINED_INPUTS_ANNOTATION } from '@domains/compact';
import { fileDigest } from '@domains/compact/node';
import { artifactType, DIGEST, MANIFEST_LIMIT_BYTES, parseManifest, TITLE } from '@domains/ghcr';
import { IDX_TITLE, partTitle, VERIFY_ANNOTATIONS } from '@domains/pack';
import { QUARANTINE_ANNOTATION, TIER_ANNOTATION, validatePack } from '@domains/root';
import { readPaused } from '../ghcr/rate.mjs';
import { Fault } from '../root/lib.mjs';
import { blobSource } from '../verify-pack.mjs';
import { HISTORY_PLAN_FORMAT } from './history-plan.mjs';
import { IDX_MAX_BYTES } from './plan.mjs';

export const HISTORY_CHUNK_BYTES = 4 * 1024 * 1024;
const MANIFEST = 'manifest.json';
const UNSAFE_PATH = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const DATASETS = ['domains', 'feed'];
const sameSpan = (a, b) => a.start === b.start && a.end === b.end;
const isDigest = (value) => typeof value === 'string' && DIGEST.test(value);
const describe = (bytes) => ({ digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.byteLength });

// A tag is the complete archive directory key, including on Windows.
// Duplicates of the same pack may add a role; conflicting packs cannot.
function archivePacks(plan) {
  if (
    plan?.format !== HISTORY_PLAN_FORMAT ||
    !isDigest(plan.root?.digest) ||
    !Number.isSafeInteger(plan.root.seq) ||
    plan.root.seq < 1 ||
    typeof plan.root.psl !== 'string' ||
    !/^[0-9a-f]{64}$/.test(plan.root.psl) ||
    !['earlier', 'replay', 'targets', 'tags', 'downstream'].every((field) => Array.isArray(plan[field]))
  ) {
    throw new Fault('the input is not a complete historical compaction plan');
  }
  if (plan.replay.length < 1 || plan.replay.length > 366 || !plan.span) throw new Fault('the historical replay must span 1 to 366 days');
  const entries = new Map();
  function add(dataset, entry, role) {
    const pack = validatePack(dataset, entry, `historical ${role} ${dataset} pack`);
    if (UNSAFE_PATH.test(pack.tag) || pack.tag.endsWith('.')) throw new Fault(`${pack.tag}: unsafe archive path`);
    const old = entries.get(pack.tag);
    if (old !== undefined && (old.dataset !== dataset || !isDeepStrictEqual(old.pack, pack))) throw new Fault(`${pack.tag}: conflicting immutable archive references`);
    const item = old ?? { dataset, pack, key: false, facts: false };
    item.key ||= role !== 'target';
    item.facts ||= role === 'day domains';
    entries.set(pack.tag, item);
    return pack;
  }
  let at = plan.span.start;
  const dates = new Map();
  for (const saved of plan.replay) {
    const day = dayOf(saved?.date);
    if (day.start !== at || !Array.isArray(saved.domains)) throw new Fault(`${day.date}: replay dates and domains inputs do not form the planned span`);
    const domains = saved.domains.map((p) => add('domains', p, 'day domains'));
    if (
      domains.filter((p) => p.tier === 'd').length !== 1 ||
      domains.some((p) => !['d', 'seg'].includes(p.tier) || p.span.start < day.start || p.span.end > day.end) ||
      new Set(domains.map((p) => p.tag)).size !== domains.length
    ) {
      throw new Fault(`${day.date}: unsupported historical domains inputs`);
    }
    const carry = add('feed', saved.carry, 'carry');
    if (carry.tier !== 'd' || !sameSpan(carry.span, day)) throw new Fault(`${day.date}: its archived carry must cover the exact feed day`);
    dates.set(day.date, day);
    at = day.end;
  }
  if (at !== plan.span.end) throw new Fault('replay days do not exhaust the historical span');
  for (const entry of plan.earlier) {
    const pack = add('domains', entry, 'earlier');
    if (pack.span.end > plan.span.start) throw new Fault(`${pack.tag}: earlier domains input crosses into the replay`);
  }
  const covered = new Set();
  for (const target of plan.targets) {
    if (!DATASETS.includes(target?.dataset) || !Array.isArray(target.days) || target.days.length === 0) throw new Fault('unsupported historical target');
    const pack = add(target.dataset, target.pack, 'target');
    if (!['d', 'w', 'm'].includes(pack.tier)) throw new Fault(`${pack.tag}: unsupported historical target tier`);
    let next = pack.span.start;
    for (const date of target.days) {
      const day = dates.get(date);
      const key = `${target.dataset}:${date}`;
      if (day === undefined || day.start !== next || covered.has(key)) throw new Fault(`${pack.tag}: target days overlap or do not cover the original span`);
      covered.add(key);
      next = day.end;
    }
    if (next !== pack.span.end) throw new Fault(`${pack.tag}: target days do not cover the original span`);
  }
  if (covered.size !== DATASETS.length * dates.size) throw new Fault('targets do not cover every replay day');
  if (new Set([...entries.values()].filter((item) => item.key).map((item) => item.pack.psl)).size !== 1) throw new Fault('historical inputs do not share a PSL');
  return entries.values();
}

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function directory(path, create = false) {
  if (create) await mkdir(path, { recursive: true });
  const info = await statIfPresent(path);
  if (info !== null && !info.isDirectory()) throw new Fault(`${path}: archive path must be a real directory`);
}

async function existing(path) {
  const info = await statIfPresent(path);
  if (info !== null && !info.isFile()) throw new Fault(`${path}: archive path must be a regular file`);
  return info;
}

function checkDescription(got, want, label) {
  if (got.size !== want.size || got.digest !== want.digest) throw new Fault(`${label}: expected ${want.size} B at ${want.digest}, read ${got.size} B at ${got.digest}`);
}

async function verifiedFile(path, want) {
  const info = await existing(path);
  if (info === null) return false;
  if (info.size !== want.size) throw new Fault(`${path}: expected ${want.size} B, found ${info.size} B`);
  checkDescription(await fileDigest(path), want, path);
  return true;
}

function manifestLayers(bytes, { dataset, pack, key, facts }) {
  const json = parseManifest(bytes, `${pack.tag} archive manifest`);
  const a = json.annotations ?? {};
  const A = VERIFY_ANNOTATIONS;
  const sources = [...new Set(a[A.source]?.split(',').map((source) => source.trim()))].sort();
  if (
    json.artifactType !== artifactType(pack.tier === 'seg' ? 'segment' : 'pack') ||
    a[A.dataset] !== dataset ||
    a[TIER_ANNOTATION] !== pack.tier ||
    a[A.spanStart] !== pack.span.start ||
    a[A.spanEnd] !== pack.span.end ||
    a[A.psl] !== pack.psl ||
    !isDeepStrictEqual(sources, pack.sources) ||
    a[A.sha256] !== pack.pack.sha256 ||
    a[A.count] !== String(pack.count) ||
    a[A.bytes] !== String(pack.pack.bytes) ||
    a[QUARANTINE_ANNOTATION] !== (pack.quarantine ? '1' : undefined) ||
    json.layers === undefined
  )
    throw new Fault(`${pack.tag}: immutable manifest disagrees with the planned pack`);

  const layers = new Map();
  for (const layer of json.layers) {
    const title = layer.annotations?.[TITLE];
    if (typeof title !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(title) || title.endsWith('.') || UNSAFE_PATH.test(title) || title === MANIFEST || layers.has(title) || layer.size === 0) {
      throw new Fault(`${pack.tag}: invalid or colliding manifest layer title or descriptor`);
    }
    layers.set(title, layer);
  }
  if (facts && a[QUARANTINED_INPUTS_ANNOTATION] !== undefined) throw new Fault(`${pack.tag}: recover separate canonical quarantine inputs before collecting this replay`);
  const keyLayers = [[IDX_TITLE, pack.idx], ...pack.parts.map((p, i) => [partTitle(i), p])];
  for (const [title, want] of keyLayers) {
    const layer = layers.get(title);
    if (layer === undefined) throw new Fault(`${pack.tag}: immutable manifest omits ${title}`);
    checkDescription(layer, want, `${pack.tag}/${title}`);
  }
  if (!key) return [];
  if (pack.idx.size > IDX_MAX_BYTES) throw new Fault(`${pack.tag}/${IDX_TITLE}: layer exceeds the supported input size`);
  const factsLayer = layers.get(FACTS_TITLE);
  if (facts && factsLayer?.size > FACTS_MAX_BYTES) throw new Fault(`${pack.tag}/${FACTS_TITLE}: layer exceeds the supported input size`);
  if (facts && factsLayer !== undefined) keyLayers.push([FACTS_TITLE, factsLayer]);
  return keyLayers;
}

async function immutableManifest(path, pack, reader, deps) {
  const info = await existing(path);
  let bytes;
  if (info !== null) {
    if (info.size > MANIFEST_LIMIT_BYTES) throw new Fault(`${path}: archive manifest exceeds ${MANIFEST_LIMIT_BYTES} B`);
    bytes = await readFile(path);
  } else {
    const result = await readPaused(`${pack.tag} manifest ${pack.manifest}`, () => reader.getManifest(pack.repo, pack.manifest, { maxBytes: MANIFEST_LIMIT_BYTES }), deps);
    bytes = result.bytes;
  }
  const desc = describe(bytes);
  if (desc.size > MANIFEST_LIMIT_BYTES || desc.digest !== pack.manifest) throw new Fault(`${pack.tag}: manifest bytes do not match planned immutable digest ${pack.manifest}`);
  return { bytes, desc, present: info !== null };
}

// A hard link installs a verified file atomically on the same filesystem
// with exclusive creation. A concurrent identical install is reusable.
async function install(path, want, write) {
  if (await verifiedFile(path, want)) return false;
  const stage = await mkdtemp(join(dirname(path), '.history-stage-'));
  const temporary = join(stage, 'payload');
  try {
    const handle = await open(temporary, 'wx');
    try {
      await write(handle);
      await handle.sync();
    } finally {
      await handle.close();
    }
    checkDescription(await fileDigest(temporary), want, path);
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST' || !(await verifiedFile(path, want))) throw error;
      return false;
    }
  } finally {
    if ((await statIfPresent(temporary)) !== null) await unlink(temporary);
    await rmdir(stage);
  }
}

export async function collectHistory(plan, output, reader, { preflight = false, log = () => undefined } = {}) {
  const packs = [...archivePacks(plan)];
  const root = resolve(output);
  await directory(root);
  // Finish path and root-descriptor validation before any manifest request.
  for (const { pack } of packs) {
    const dir = join(root, pack.tag);
    await directory(dir);
    await existing(join(dir, MANIFEST));
  }
  const pending = [];
  const report = {
    mode: preflight ? 'preflight' : 'collect',
    packs: packs.length,
    files: 0,
    bytes: 0,
    manifestReads: 0,
    manifestBytesRead: 0,
    missingRanges: 0,
    missingBlobBytes: 0,
    rangeBytes: HISTORY_CHUNK_BYTES,
    installed: 0,
    reused: 0,
  };
  const deps = { log };
  for (const item of packs) {
    const { pack } = item;
    const dir = join(root, pack.tag);
    const manifest = await immutableManifest(join(dir, MANIFEST), pack, reader, deps);
    const layers = manifestLayers(manifest.bytes, item);
    report.files += 1;
    report.bytes += manifest.desc.size;
    if (manifest.present) report.reused += 1;
    else {
      report.manifestReads += 1;
      report.manifestBytesRead += manifest.desc.size;
    }
    const blobs = [];
    for (const [title, desc] of layers) {
      const present = await verifiedFile(join(dir, title), desc);
      report.files += 1;
      report.bytes += desc.size;
      if (present) report.reused += 1;
      else {
        report.missingRanges += Math.ceil(desc.size / HISTORY_CHUNK_BYTES);
        report.missingBlobBytes += desc.size;
        blobs.push({ title, desc });
      }
    }
    if (!preflight && (!manifest.present || blobs.length > 0)) pending.push({ pack, dir, manifest: manifest.present ? null : manifest, blobs });
  }
  if (!Number.isSafeInteger(report.bytes)) throw new Fault('historical archive byte count exceeds the supported integer range');
  if (preflight) return report;

  await directory(root, true);
  for (const { pack, dir, manifest, blobs } of pending) {
    await directory(dir, true);
    if (manifest !== null) {
      if (await install(join(dir, MANIFEST), manifest.desc, (handle) => handle.writeFile(manifest.bytes))) report.installed += 1;
      else report.reused += 1;
    }
    for (const { title, desc } of blobs) {
      const source = blobSource(reader, pack.repo, desc, deps);
      const wrote = await install(join(dir, title), desc, async (handle) => {
        for (let at = 0; at < desc.size; at += HISTORY_CHUNK_BYTES) {
          await handle.writeFile(await source.read(at, Math.min(HISTORY_CHUNK_BYTES, desc.size - at)));
        }
      });
      if (wrote) report.installed += 1;
      else report.reused += 1;
    }
  }
  return report;
}
