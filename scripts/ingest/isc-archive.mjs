// DOM-027: archive exact dated ISC gzip files from before the pack epoch.
// One dispatch covers an inclusive window of up to MAX_DAYS days. A later
// window verifies its immediate predecessor in obs before fetching anything.
// Each day is verified, pushed and read anonymously before the next is read.
// A changed body at an archived tag is a conflict and keeps the original.
// Use --no-push to verify publisher bytes without a credential or GHCR IO.
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIsoUtc, liveFetch } from '@domains/adapter';
import { GhcrError, rawTag, repoOf, SOURCE_URL as REPOSITORY_URL, WORKFLOW_RUN_ID } from '@domains/ghcr';
import { datedUrl, fetchSnapshot, isDay, IscFault, MAX_GZIP_BYTES, PARSER, parseSnapshot, SOURCE } from '../../adapters/isc-new/src/index.ts';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { CREATED, EXIT as PUSH_EXIT, SOURCE as OCI_SOURCE, TITLE } from '../ghcr/push.mjs';
import { RateLimitError, readPaused } from '../ghcr/rate.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { Fault, readBlob, tempDir, UsageError } from '../root/lib.mjs';
import { blobSource } from '../verify-pack.mjs';
import { pushFiles } from './pack.mjs';
import { nowIso } from './plan.mjs';
import { MEMBERS_TITLE, RAW_MEDIA_TYPE, RAW_TYPE, rawMembersJson, writeRaw } from './writer.mjs';

export const FIRST_DAY = '2025-10-26';
export const LAST_DAY = '2025-12-31';
export const MAX_DAYS = 7;
export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, private: 4, internal: 70 });

const USAGE = 'usage: node scripts/ingest/isc-archive.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--no-push]';
const P = 'dev.pkgforge.domains.';
const OBS = repoOf('obs');
const RAW_PART_TITLE = 'raw.000';
const JSON_MEDIA_TYPE = 'application/json';
const BLOB_BLOCK_BYTES = 8 * 1024 ** 2;
const DAY_MS = 86_400_000;
const shift = (day, delta) => new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
const windowOf = (day) => ({ start: `${day}T00:00:00Z`, end: `${shift(day, 1)}T00:00:00Z` });
const indexOf = (day, url, length, sha256) => rawMembersJson(SOURCE, windowOf(day), [{ day, url, length, offset: 0, sha256 }]);

export function archiveTag(day) {
  const { start, end } = windowOf(day);
  return rawTag(SOURCE, start, end);
}

function parse(argv) {
  const args = parseArgs(argv);
  const repeated = repeatedFlag(args);
  if (repeated !== null) throw new UsageError(`--${repeated} is given twice`);
  if (args._.length !== 0) throw new UsageError('give the window with --from and --to');
  for (const key of Object.keys(args)) if (!['_', 'from', 'to', 'no-push'].includes(key)) throw new UsageError(`unknown flag --${key}`);
  const { from, to } = args;
  if (!isDay(from) || !isDay(to) || from < FIRST_DAY || to > LAST_DAY || from > to) throw new UsageError(`--from and --to must give ordered calendar days within ${FIRST_DAY} through ${LAST_DAY}`);
  if (to >= shift(from, MAX_DAYS)) throw new UsageError(`an archive window spans at most ${MAX_DAYS} days`);
  if (args['no-push'] !== undefined && args['no-push'] !== true) throw new UsageError('--no-push takes no value');
  return { from, to, publish: args['no-push'] !== true };
}

async function verifyArchive(day, d, expected = null) {
  const tag = archiveTag(day);
  const { start, end } = windowOf(day);
  const { digest, json } = await readPaused(`archive manifest ${tag}`, () => d.reader.getManifest(OBS, tag), d);
  const a = json.annotations ?? {};
  const sha256 = a[`${P}sha256`];
  const url = a[`${P}url`];
  const fetched = a[`${P}fetched`];
  const run = a[`${P}run`];
  const [raw, index] = json.layers ?? [];
  if (
    (expected !== null && (digest !== expected.digest || sha256 !== expected.sha256 || raw?.size !== expected.bytes)) ||
    json.artifactType !== RAW_TYPE ||
    json.layers?.length !== 2 ||
    a[OCI_SOURCE] !== REPOSITORY_URL ||
    a[CREATED] !== end ||
    a[`${P}source`] !== SOURCE ||
    a[`${P}adapter`] !== SOURCE ||
    !a[`${P}parser`] ||
    a[`${P}span.start`] !== start ||
    a[`${P}span.end`] !== end ||
    a[`${P}members`] !== '1' ||
    url !== datedUrl(day) ||
    !isIsoUtc(fetched) ||
    fetched < end ||
    !WORKFLOW_RUN_ID.test(run ?? '') ||
    !/^[0-9a-f]{64}$/.test(sha256 ?? '') ||
    raw.annotations?.[TITLE] !== RAW_PART_TITLE ||
    raw.mediaType !== RAW_MEDIA_TYPE ||
    raw.size < 1 ||
    raw.size > MAX_GZIP_BYTES ||
    String(raw.size) !== a[`${P}bytes`] ||
    raw.digest !== `sha256:${sha256}` ||
    index.annotations?.[TITLE] !== MEMBERS_TITLE ||
    index.mediaType !== JSON_MEDIA_TYPE
  ) {
    throw new Fault(`obs:${tag} did not read back with the expected raw archive manifest`);
  }

  const members = Buffer.from(indexOf(day, url, raw.size, sha256));
  if (!members.equals(await readBlob(d.reader, OBS, index, d, members.length))) throw new Fault(`obs:${tag} does not hold the canonical ${MEMBERS_TITLE}`);
  const source = blobSource(d.reader, OBS, raw, d);
  const hash = createHash('sha256');
  for (let at = 0; at < raw.size; at += BLOB_BLOCK_BYTES) hash.update(await source.read(at, Math.min(BLOB_BLOCK_BYTES, raw.size - at)));
  if (hash.digest('hex') !== sha256) throw new Fault(`obs:${tag} did not read back with the source gzip's SHA-256`);
  return { tag, digest, sha256 };
}

async function publishDay(day, file, fetched, d) {
  const tag = archiveTag(day);
  const work = tempDir(d.env.RUNNER_TEMP, 'isc-archive-');
  try {
    const raw = await writeRaw(file.raw, work, { maxParts: 1, what: `obs:${tag}` });
    if (raw.sha256 !== file.sha256 || raw.bytes !== file.raw.byteLength) throw new Fault(`obs:${tag} does not match the bytes parsed from ISC`);
    const members = join(work, MEMBERS_TITLE);
    writeFileSync(members, indexOf(day, file.url, raw.bytes, raw.sha256), { flag: 'wx' });
    const { start, end } = windowOf(day);
    const annotations = {
      source: SOURCE,
      adapter: SOURCE,
      parser: PARSER,
      'span.start': start,
      'span.end': end,
      bytes: String(raw.bytes),
      sha256: raw.sha256,
      members: '1',
      url: file.url,
      fetched,
      run: d.env.GITHUB_RUN_ID,
    };
    const pushed = await pushFiles(
      {
        pkg: 'obs',
        tag,
        artifactType: RAW_TYPE,
        created: end,
        annotations: Object.entries(annotations).map(([key, value]) => [`${P}${key}`, value]),
        files: [
          { path: raw.files[0], mediaType: RAW_MEDIA_TYPE },
          { path: members, mediaType: JSON_MEDIA_TYPE },
        ],
      },
      { ...d, tmp: work },
    );
    if (pushed.line) d.out(pushed.line);
    if (pushed.code === PUSH_EXIT.private) return EXIT.private;
    if (pushed.code === PUSH_EXIT.replaced) throw new Fault(`obs:${tag} conflicts with the downloaded ${raw.sha256}; the archived original was kept`);
    if (pushed.code !== PUSH_EXIT.ok) throw new Fault(`cannot archive obs:${tag}; push exited ${pushed.code}`);
    const proof = await verifyArchive(day, d, { digest: pushed.digest, bytes: raw.bytes, sha256: raw.sha256 });
    d.out(`public obs:${proof.tag} ${proof.digest} gzip sha256:${proof.sha256}`);
    return EXIT.ok;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function main(argv, deps = {}) {
  const env = deps.env ?? { ...process.env };
  if (deps.env === undefined) delete process.env.REGISTRY_TOKEN;
  const err = deps.err ?? console.error;
  const d = { ...deps, env, err, out: deps.out ?? console.log, now: deps.now ?? Date.now, log: (l) => err(`isc-archive: ${l}`), reader: deps.reader ?? anonymousReader() };
  try {
    const { from, to, publish } = parse(argv);
    if (publish && (!env.REGISTRY_TOKEN || !env.GITHUB_ACTOR || !WORKFLOW_RUN_ID.test(env.GITHUB_RUN_ID ?? ''))) {
      throw new UsageError('publishing requires the workflow actor, run id and its own token');
    }
    if (publish && from !== FIRST_DAY) {
      const day = shift(from, -1);
      try {
        const prior = await verifyArchive(day, d);
        d.out(`predecessor obs:${prior.tag} ${prior.digest} verified anonymously`);
      } catch (error) {
        if (isNotPublic(error)) throw new Fault(`cannot start ${from}: first publish and verify its predecessor ${day}`);
        throw error;
      }
    }
    const ctx = { fetch: deps.fetch ?? liveFetch, userAgent: USER_AGENT };
    for (let day = from; day <= to; day = shift(day, 1)) {
      const file = await fetchSnapshot(ctx, { day });
      const fetched = nowIso(d.now());
      if (file.kind !== 'file') throw new Fault(`${day}: the dated file is ${file.kind}`);
      const data = await parseSnapshot(file);
      if (data.day !== day || data.rows === 0) throw new Fault(`${day}: the dated file has no rows for its assigned day`);
      d.out(`verified ${day} ${file.url} ${file.raw.byteLength} B ${data.rows} rows sha256:${file.sha256} fetched ${fetched}`);
      if (publish) {
        const code = await publishDay(day, file, fetched, d);
        if (code !== EXIT.ok) return code;
      }
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      err(`isc-archive: ${error.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (isNotPublic(error)) {
      d.out(PRIVATE_LINE);
      err(`isc-archive: ${error.message}`);
      return EXIT.private;
    }
    if (error instanceof Fault || error instanceof IscFault || error instanceof GhcrError || error instanceof RateLimitError) {
      err(`isc-archive: ${error.message}`);
      return EXIT.fault;
    }
    err(`isc-archive: internal error: ${error?.stack ?? error}`);
    return EXIT.internal;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
