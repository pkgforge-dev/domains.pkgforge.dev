// Staging turns a verified batch into immutable obs identities. A confirmed
// prefix is useful after failure, but only a completed batch can be adopted.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, jsonEqual } from '@domains/adapter';
import { fileTag, repoOf } from '@domains/ghcr';
import { DAY_MS } from '../../adapters/isc-new/src/cursor.ts';
import { datedUrl, isVerifiedEmptyDay, SOURCE } from '../../adapters/isc-new/src/snapshot.ts';
import { writeOut } from '../compact/plan.mjs';
import { TITLE } from '../ghcr/push.mjs';
import { readPaused } from '../ghcr/rate.mjs';
import { Fault, runAttempt, UsageError } from '../root/lib.mjs';
import { blobSource } from '../verify-pack.mjs';
import { QUARANTINE } from './pack.mjs';
import { RAW_TITLE } from './writer.mjs';

export { stageDays } from '../../adapters/isc-new/src/backfill.ts';
export const ISC_STAGE_FORMAT = 'domains.isc-stage.v1';
export const ISC_STAGE_FILE = 'stage.jsonl';
const OBS = repoOf('obs');
const P = 'dev.pkgforge.domains.';
const FILE_TAG = /^isc-new\.(\d{4})(\d{2})(\d{2})\.[0-9a-f]{12}-d$/;
const VOLATILE = new Set([`${P}fetched`, `${P}run`]);
const BLOCK = 8 * 1024 ** 2;

function stageLine(row) {
  return `${canonicalJson(row)}\n`;
}

function layerKey(layer) {
  return [layer.annotations?.[TITLE], layer.mediaType, layer.digest, layer.size];
}

function checkManifest(candidate, remote) {
  const { w, verdict } = candidate;
  const expected = w.manifest.json;
  const got = remote.json;
  const annotations = got.annotations ?? {};
  const stable = Object.entries(expected.annotations).filter(([name]) => !VOLATILE.has(name));
  if (
    got.artifactType !== expected.artifactType ||
    annotations[QUARANTINE] !== (verdict === 'quarantine' ? '1' : undefined) ||
    stable.some(([key, value]) => annotations[key] !== value) ||
    !jsonEqual((got.layers ?? []).map(layerKey), expected.layers.map(layerKey))
  ) {
    throw new Fault(`obs:${w.tag} at ${remote.digest} conflicts with the verified ISC pack or raw layer for ${w.segment.window.start.slice(0, 10)}`);
  }
}

function candidateOf(day, candidate) {
  const w = candidate?.w;
  const segment = w?.segment;
  const raw = segment?.raw;
  const start = `${day}T00:00:00Z`;
  const verifiedEmpty = raw !== undefined && isVerifiedEmptyDay(day, raw.bytes, raw.sha256);
  if (
    segment?.source !== SOURCE ||
    segment.dataset !== 'domains' ||
    segment.precision !== 'day' ||
    segment.window.start !== start ||
    Date.parse(segment.window.end) - Date.parse(start) !== DAY_MS ||
    raw === undefined ||
    raw.bytes < 1 ||
    (segment.count === 0) !== verifiedEmpty ||
    (verifiedEmpty && candidate.verdict !== 'ok') ||
    w.tag !== fileTag(SOURCE, start, raw.sha256, 'd') ||
    w.manifest.annotations[`${P}url`] !== datedUrl(day)
  ) {
    throw new Fault(`ISC staging has no verified dated domains pack for ${day}`);
  }
  return { type: 'segment', day, ref: `obs:${w.tag}`, rawSha256: raw.sha256, rawBytes: raw.bytes, count: segment.count, verdict: candidate.verdict, url: datedUrl(day) };
}

export function checkStagePath(out) {
  const file = join(out, ISC_STAGE_FILE);
  if (existsSync(file)) throw new UsageError(`${file} exists: stage writes into a new directory`);
  return file;
}

// Anonymous pagination is deliberate. A new provider gzip makes a different
// file tag, so probing the locally derived tag alone cannot find a conflict.
async function tagsFor(days, d) {
  const list = await readPaused('ISC staging obs tag list', () => d.reader.listTags(OBS), d);
  if (list.truncated) throw new Fault(`ISC staging obs tag list was truncated after ${list.pages} pages`);
  const byDay = new Map(days.map((day) => [day, []]));
  for (const tag of list.tags) {
    const match = FILE_TAG.exec(tag);
    if (match !== null) byDay.get(`${match[1]}-${match[2]}-${match[3]}`)?.push(tag);
  }
  return byDay;
}

export async function prepareIscStage({ args, days, stateDigest, list, file, verified, writer }, d) {
  if (verified.length !== days.length || writer.raws.length !== 0) throw new Fault('ISC staging needs one verified pack and one embedded raw layer per requested day');
  const rows = days.map((day, i) => candidateOf(day, verified[i]));
  const byDay = await tagsFor(days, d);
  const manifests = new Map();
  const readManifest = (ref) => readPaused(`ISC staging obs:${ref}`, () => d.reader.getManifest(OBS, ref), d);
  for (const [i, day] of days.entries()) {
    const tags = byDay.get(day);
    if (tags.length === 0) continue;
    const candidate = verified[i];
    if (tags.length !== 1 || tags[0] !== candidate.w.tag) {
      throw new Fault(`ISC staging conflict for ${day}: obs holds ${tags.join(', ')}; the verified candidate is ${candidate.w.tag}`);
    }
    const remote = await readManifest(candidate.w.tag);
    checkManifest(candidate, remote);
    manifests.set(candidate.w.tag, remote.digest);
  }
  writeOut(
    file,
    stageLine({
      type: 'stage',
      format: ISC_STAGE_FORMAT,
      rootDigest: list.rootDigest,
      stateDigest,
      domainsSince: list.domainsSince,
      psl: list.sha256,
      window: args.window,
      run: args.run,
      attempt: runAttempt(d.env),
      at: args.now,
    }),
    'ISC stage',
  );
  let confirmed = 0;
  const confirmedDigests = new Map();

  async function record(candidate, digest) {
    const row = rows[confirmed];
    const tag = candidate.w.tag;
    const [tagged, immutable] = await Promise.all([readManifest(tag), readManifest(digest)]);
    if (tagged.digest !== digest || immutable.digest !== digest) throw new Fault(`obs:${tag} does not read anonymously at the expected manifest digest ${digest}`);
    checkManifest(candidate, immutable);
    const raw = immutable.json.layers.find((layer) => layer.annotations?.[TITLE] === RAW_TITLE);
    if (raw?.digest !== `sha256:${row.rawSha256}` || raw.size !== row.rawBytes) throw new Fault(`obs:${tag} does not describe the verified dated gzip bytes at ${digest}`);
    const source = blobSource(d.reader, OBS, raw, d);
    const hash = createHash('sha256');
    for (let at = 0; at < raw.size; at += BLOCK) hash.update(await source.read(at, Math.min(BLOCK, raw.size - at)));
    if (hash.digest('hex') !== row.rawSha256) throw new Fault(`obs:${tag} does not serve the verified dated gzip bytes at ${digest}`);
    appendFileSync(file, stageLine({ ...row, digest }));
    confirmedDigests.set(tag, digest);
    confirmed += 1;
  }

  async function finish() {
    if (confirmed !== rows.length) throw new Fault(`ISC staging verified ${confirmed} of ${rows.length} manifest identities`);
    const finalTags = await tagsFor(days, d);
    for (const row of rows) {
      const tag = row.ref.slice('obs:'.length);
      const tags = finalTags.get(row.day);
      if (tags.length !== 1 || tags[0] !== tag) throw new Fault(`ISC staging expected only ${row.ref} for ${row.day}, found ${tags.join(', ') || 'none'}`);
      const remote = await readManifest(tag);
      if (remote.digest !== confirmedDigests.get(tag)) throw new Fault(`${row.ref} changed after anonymous verification`);
    }
    appendFileSync(file, stageLine({ type: 'complete', segments: confirmed }));
    d.out(`ISC stage ${file} complete: ${confirmed} verified immutable segment(s)`);
  }

  return { manifests, record, finish };
}
