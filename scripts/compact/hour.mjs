// scripts/compact/hour.mjs — the hour pack of the feed, feed-h-YYYYMMDDHH, and
// the next ledger-delta (DOM-023, docs/architecture.md sections 4.5 and 5.8
// step 5, docs/format.md section 15). Its rows are provisional.
//
// The segments of the hour come from --segments DIR, one directory a
// segment: DIR/<tag>/manifest.json, the manifest as the registry holds it
// (`oras manifest fetch`), and its layers idx and part.NNN, as `oras pull`
// names them. Or, with --obs-tags TAG,TAG,..., from the package obs of GHCR
// with no credential: each manifest by its tag, each blob by its digest.
// planHour of packages/compact reads the domains segments of second-precision
// sources and names each segment it leaves: a quarantined one (ruling 23), one
// of a day source, whose rows enter the feed through the day pack, and a names
// segment. A segment that crosses an edge of the hour, lies outside it or
// overlaps another of its source is refused; a source whose segments leave a
// hole in the hour is `wait`, exit 3, and nothing is written.
//
// The filter and its delta are --filter FILE, the layer of ledger-filter-DATE
// (DLBF), and --delta FILE, the layer of ledger-delta (DLBD): the delta must
// pair with the filter, and the filter must hold the table through no later
// than the hour's start. Each domain record of the segments, merged by key,
// is asked of the filter and the delta (buildFeedHour of @domains/feed): one
// neither holds is a row, `provisional`, and is added to the delta.
//
// It builds no hour pack of new-name: new-name enters the package feed only
// through the exact day pack of DOM-041, whose Decision rules out a
// name-level filter, which an hour pack would need (TODO/storage.md, DOM-041).
//
// The tag (docs/architecture.md section 4.7 rule 1, ruling 25): the feed
// package's tags, from --tags FILE (a JSON list) or read from GHCR with no
// credential. A build of the hour is there: `present`, exit 0, nothing is
// written, the delta neither. --rebuild takes the next tag, -r2 then -r3,
// unless a build of the hour holds the bytes of this rebuild (D3 of DOM-023):
// once the pack is built, the manifest of each build the tag list names is
// read with no credential (decideRebuild of scripts/compact/plan.mjs), and a
// build whose dev.pkgforge.domains.sha256 is the pack's is `present`, exit 0.
// The part files written by then stay in --out; no index, manifest,
// blobs.json or delta is written. So a re-run of a rebuild whose push succeeded pushes no
// second copy of its bytes. A build whose manifest GHCR does not give is a
// fault, exit 1: the tag list names it, so it is lost, or its package no
// longer reads publicly.
//
// It writes to --out DIR, which must not hold these files: part.NNN, idx,
// time.part.NNN and time.idx (the time copy, docs/format.md section 14),
// manifest.json (packManifest of packages/compact, read back as the promotion
// reads it), blobs.json (every blob the manifest names: title, file, digest
// and size, the empty config among them, for the push by
// scripts/ghcr/push.mjs), and delta.dlbd, the next ledger-delta. --out is
// checked before anything is read: a file, or a path under a file, is exit 2,
// and so is an output that cannot be written. It pushes nothing:
// scripts/state/hours.mjs, in the job push of ingest-live.yml, runs it for
// each closed hour (DOM-024). ⚠ That script pushes the pack before the delta,
// the delta under the state guard of DOM-024: a delta pushed first would
// hold the hour's domains, and a re-run would judge them all old and write an
// empty pack under the hour's write-once tag.
//
// Usage:
//   node scripts/compact/hour.mjs --hour YYYYMMDDHH --filter FILE --delta FILE --out DIR (--segments DIR | --obs-tags TAG,...) [flags]
//     --sources FILE       the source registry (default config/sources.json)
//     --tags FILE          the feed package's tags, a JSON list (default: read from GHCR)
//     --rebuild            take the next tag of the hour when a build is there, or
//                          find the build that holds the same bytes (present)
//     --run ID             the workflow run (default GITHUB_RUN_ID)
//     --records-per-block N, --page-entries N   the writer (defaults 4096 and 64)
// stdout: `verdict VERDICT feed:TAG START END`, `reason ...`, one line for
// each segment read (`input`) or left (`skip`), each hole (`missing`), then
// `present feed:TAG ...`, or the files written and
// `hour feed:TAG sha256:DIGEST rows N domains N delta N to N`.
// Exit codes: 0 written, present, or skip (no segment to read) · 1 a fault: a
// segment that crosses an edge of the hour, lies outside it or overlaps one of
// its source, a segment of a dataset other than names and domains, an idx
// that is not its manifest's, a manifest the promotion refuses, segments
// built under two PSL hashes, a filter newer than the hour, a delta of
// another filter, a row outside the hour, a tag list GHCR cut short, a build
// of the hour that the tag list names and whose manifest GHCR does not give
// or carries no sha256 · 2 could not run (bad arguments, a file that does not
// read, an output file that exists, an output path that is a file, lies under
// a file or cannot be written, GHCR unreachable) · 3 wait: a source's
// segments leave a hole in the hour · 4 PRIVATE PACKAGE: a segment did not
// read with no credential · 70 an internal error, a defect of this script
// (its stack goes to stderr).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildHour, CompactError, DELTA_TITLE, EMPTY_CONFIG, hourOf, membershipOf, packManifest, planHour, tagDecision, WORKFLOW_RUN_ID } from '@domains/compact';
import { DirPartsSink, fileDigest, titlesOf } from '@domains/compact/node';
import { FeedError } from '@domains/feed';
import { checkRef, GhcrError, LayoutError, LEDGER_DELTA_TAG, packageOfDataset, repoOf } from '@domains/ghcr';
import { LedgerError } from '@domains/ledger';
import { DOMAINS_CODEC, IDX_TITLE, PackError, TIME_IDX_TITLE } from '@domains/pack';
import { nodeCompress, writerId } from '@domains/pack/node';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { RateLimitError, readPaused } from '../ghcr/rate.mjs';
import { parseArgs } from '../lib/args.mjs';
import { Fault, readBlob } from '../root/lib.mjs';
import { DEFAULT_SOURCES } from '../verify-pack.mjs';
import { buildTags, checkOutDir, decideRebuild, freshDir, IDX_MAX_BYTES, writeOut } from './plan.mjs';
import { openInputs, UsageError } from './range.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, wait: 3, private: 4, internal: 70 });
// The file of the next ledger-delta: the layer title daily.ts names (docs/format.md section 15).
export const DELTA_FILE = DELTA_TITLE;
const USAGE =
  'usage: node scripts/compact/hour.mjs --hour YYYYMMDDHH --filter FILE --delta FILE --out DIR (--segments DIR | --obs-tags TAG,...) [--sources FILE] [--tags FILE] [--rebuild] [--run ID] [--records-per-block N] [--page-entries N]';
const VALUED = ['hour', 'filter', 'delta', 'out', 'segments', 'obs-tags', 'sources', 'tags', 'run', 'records-per-block', 'page-entries'];
const FLAGS = [...VALUED, 'rebuild'];
const TITLE = 'org.opencontainers.image.title';
// The manifests of the obs package are small: a segment has one part or a few.
const MANIFEST_MAX_BYTES = 64 * 1024;

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const whole = (v, name, min, max) => {
  if (v === undefined) return undefined;
  if (!/^[0-9]+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min || Number(v) > max) throw new UsageError(`--${name} is ${JSON.stringify(v)}, not a whole number of ${min} to ${max}`);
  return Number(v);
};

function parse(argv, env) {
  const a = parseArgs(argv);
  if (typeof a.rebuild === 'string') throw new UsageError(`${JSON.stringify(a.rebuild)} is not a flag`);
  for (const k of Object.keys(a)) if (k !== '_' && !FLAGS.includes(k)) throw new UsageError(`unknown flag --${k}`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  for (const k of ['hour', 'filter', 'delta', 'out']) if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  if ((a.segments === undefined) === (a['obs-tags'] === undefined)) throw new UsageError('give the segments once: --segments DIR or --obs-tags TAG,...');
  checkOutDir(a.out, '--out');
  const run = a.run ?? env.GITHUB_RUN_ID;
  if (run === undefined || !WORKFLOW_RUN_ID.test(run)) throw new UsageError(`the run ${JSON.stringify(run ?? null)} is not a workflow run id: give --run or GITHUB_RUN_ID`);
  let obsTags;
  if (a['obs-tags'] !== undefined) {
    obsTags = a['obs-tags'].split(',');
    for (const t of obsTags) {
      try {
        checkRef(t);
      } catch (e) {
        throw new UsageError(`--obs-tags: ${e.message}`);
      }
    }
  }
  return {
    hour: a.hour,
    filter: a.filter,
    delta: a.delta,
    out: a.out,
    segments: a.segments,
    obsTags,
    sources: a.sources ?? DEFAULT_SOURCES,
    tags: a.tags,
    rebuild: a.rebuild === true,
    run,
    recordsPerBlock: whole(a['records-per-block'], 'records-per-block', 1, 0xffff),
    pageEntries: whole(a['page-entries'], 'page-entries', 1, 0xffff),
  };
}

function readFile(path, what) {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (e) {
    throw new UsageError(`${what} ${path} does not read: ${e.message}`);
  }
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`${what} ${path} does not read as JSON: ${e.message}`);
  }
}

// The source registry's rows (config/sources.json).
export function registryOf(path) {
  const v = readJson(path, 'the source registry');
  if (v === null || typeof v !== 'object' || !Array.isArray(v.sources)) throw new UsageError(`${path} is not a source registry: it lacks a list "sources"`);
  return v.sources;
}

// The segments of --segments DIR: each DIR/<tag>/manifest.json and its idx.
function localSegments(dir) {
  if (!existsSync(dir)) throw new UsageError(`--segments ${dir} does not exist`);
  const out = [];
  for (const tag of readdirSync(dir).sort()) {
    const at = join(dir, tag);
    const manifestPath = join(at, 'manifest.json');
    if (!existsSync(manifestPath)) throw new UsageError(`--segments: ${manifestPath} does not exist`);
    const bytes = readFile(manifestPath, 'the manifest');
    let json;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      throw new Fault(`${manifestPath} is not JSON: ${e.message}`);
    }
    out.push({ tag, digest: sha(bytes), json, idx: readFile(join(at, IDX_TITLE), 'the index') });
  }
  return out;
}

// The segments of --obs-tags, read from the package obs with no credential.
async function ghcrSegments(tags, reader, deps) {
  const repo = repoOf('obs');
  const out = [];
  for (const tag of tags) {
    const m = await readPaused(`the manifest ${tag} of ${repo}`, () => reader.getManifest(repo, tag, { maxBytes: MANIFEST_MAX_BYTES }), deps);
    const idxLayer = (m.json.layers ?? []).find((l) => l.annotations?.[TITLE] === IDX_TITLE);
    if (idxLayer === undefined) throw new Fault(`obs:${tag} holds no idx layer`);
    out.push({ tag, digest: m.digest, json: m.json, idx: await readBlob(reader, repo, idxLayer, deps, IDX_MAX_BYTES) });
  }
  return out;
}

// The feed package's tags: --tags FILE, or every page of its tag list in GHCR.
// A package that does not exist yet holds no tag: the first push creates it.
async function tagsOf(args, reader, deps) {
  if (args.tags !== undefined) {
    const v = readJson(args.tags, '--tags');
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) throw new UsageError(`--tags ${args.tags} is not a JSON list of tags`);
    return v;
  }
  return buildTags(packageOfDataset('feed'), 'hour', reader, deps);
}

function lines(plan) {
  const out = [`verdict ${plan.verdict} feed:${plan.hour.tag} ${plan.hour.start} ${plan.hour.end}`, `reason ${plan.reason}`];
  for (const p of plan.inputs) out.push(`input obs:${p.tag} ${p.span.start} ${p.span.end} ${p.count} ${p.sources.join(',')}`);
  for (const s of plan.skipped) out.push(`skip obs:${s.tag} ${s.why}`);
  for (const m of plan.missing) out.push(`missing ${m.source} ${m.start} ${m.end}`);
  return out;
}

// An error hour does not know is a defect, exit 70: never 1, 2, 3 or 4.
export async function main(argv, deps = {}) {
  try {
    return await hourJob(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`hour: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function hourJob(argv, { reader = anonymousReader(), out = console.log, err = console.error, env = process.env, sleep, random }) {
  const deps = { sleep, random, log: (l) => err(`hour: ${l}`) };
  try {
    const args = parse(argv, env);
    const hour = hourOf(args.hour);
    const registry = registryOf(args.sources);
    const filterBytes = readFile(args.filter, '--filter');
    const deltaBytes = readFile(args.delta, '--delta');
    // The pairing and the age of the filter are checked before any segment is read.
    const membership = membershipOf(filterBytes, deltaBytes, hour);
    const segments = args.segments !== undefined ? localSegments(args.segments) : await ghcrSegments(args.obsTags, reader, deps);
    const plan = planHour(segments, hour, registry);
    for (const l of lines(plan)) out(l);
    if (plan.verdict === 'wait') return EXIT.wait;
    if (plan.verdict === 'skip') return EXIT.ok;
    if (plan.psl.length !== 1) throw new CompactError('psl', `the segments were built under ${plan.psl.join(' and ')}; a feed key is a registrable domain under one list`);

    const tags = await tagsOf(args, reader, deps);
    const first = tagDecision('feed', 'h', hour.start, tags, args.rebuild);
    if (first.action === 'present') {
      out(`present feed:${first.tag} (${first.builds.join(', ')}): nothing is written, the delta neither`);
      return EXIT.ok;
    }

    freshDir(args.out, 'hour');
    const opened = await openInputs({ inputs: plan.inputs }, 'key', DOMAINS_CODEC, args.segments, reader, deps);
    const keySink = new DirPartsSink(args.out, 'key');
    const timeSink = new DirPartsSink(args.out, 'time');
    let built;
    try {
      built = await buildHour(opened.readers, membership, {
        registry,
        hour,
        compress: nodeCompress,
        sink: keySink,
        time: { sink: timeSink },
        recordsPerBlock: args.recordsPerBlock,
        pageEntries: args.pageEntries,
      });
    } finally {
      await keySink.close();
      await timeSink.close();
      await opened.close();
    }
    const decision = await decideRebuild(first, 'feed', 'h', hour.start, tags, built.summary.sha256, reader, deps);
    if (decision.action === 'present') {
      out(
        `present feed:${decision.tag} (${decision.builds.join(', ')}): that build holds the bytes of this rebuild, sha256 ${built.summary.sha256}; no index, manifest, blobs.json or delta is written`,
      );
      return EXIT.ok;
    }
    writeOut(join(args.out, IDX_TITLE), built.summary.idx, 'hour');
    writeOut(join(args.out, TIME_IDX_TITLE), built.time.idx, 'hour');
    const parts = [];
    for (const f of keySink.files) parts.push(await fileDigest(f));
    const timeParts = [];
    for (const f of timeSink.files) timeParts.push(await fileDigest(f));
    const idx = { digest: sha(built.summary.idx), size: built.summary.idx.length };
    const timeIdx = { digest: sha(built.time.idx), size: built.time.idx.length };
    const sources = plan.sources;
    // packManifest's input names the tiers d to y; an hour pack's manifest has
    // the same layers and annotations, and packFromManifest reads tier h.
    const manifest = packManifest({
      dataset: 'feed',
      tier: 'h',
      span: { start: hour.start, end: hour.end },
      tag: decision.tag,
      sources,
      ...(sources.length === 1 ? { precision: 'second' } : {}),
      psl: plan.psl[0],
      run: args.run,
      summary: built.summary,
      writer: writerId(),
      parts,
      idx,
      time: { idxBytes: built.time.idx, parts: timeParts, idx: timeIdx },
    });
    writeOut(join(args.out, 'manifest.json'), manifest.text, 'hour');
    const keyTitles = titlesOf('key');
    const timeTitles = titlesOf('time');
    const blobs = [
      { title: 'config', file: null, data: EMPTY_CONFIG.data, digest: EMPTY_CONFIG.digest, size: EMPTY_CONFIG.size },
      ...parts.map((b, i) => ({ title: keyTitles.part(i), file: keySink.files[i], ...b })),
      { title: IDX_TITLE, file: join(args.out, IDX_TITLE), ...idx },
      ...timeParts.map((b, i) => ({ title: timeTitles.part(i), file: timeSink.files[i], ...b })),
      { title: TIME_IDX_TITLE, file: join(args.out, TIME_IDX_TITLE), ...timeIdx },
    ];
    writeOut(join(args.out, 'blobs.json'), `${JSON.stringify(blobs)}\n`, 'hour');
    const delta = membership.delta.encode();
    writeOut(join(args.out, DELTA_FILE), delta, 'hour');
    out(`wrote ${join(args.out, 'manifest.json')} ${join(args.out, 'blobs.json')}: feed:${decision.tag}, ${blobs.length - 1} blob(s) and the config`);
    out(`wrote ${join(args.out, DELTA_FILE)}: state:${LEDGER_DELTA_TAG}, ${membership.delta.size} hash(es), ${delta.length} B, pushed after feed:${decision.tag}`);
    out(`hour feed:${decision.tag} ${manifest.digest} rows ${built.rows} domains ${built.domains} delta ${built.deltaBefore} to ${built.deltaAfter}`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`hour: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof CompactError) {
      err(`hour: FAIL ${e.code} ${e.message}`);
      return e.code === 'usage' ? EXIT.usage : EXIT.fault;
    }
    if (e instanceof LedgerError || e instanceof FeedError || e instanceof PackError || e instanceof Fault) {
      err(`hour: FAIL ${e.code ?? 'fault'} ${e.message}`);
      return EXIT.fault;
    }
    if (isNotPublic(e)) {
      out(PRIVATE_LINE);
      err(`hour: a segment did not read with no credential: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError || e instanceof LayoutError) {
      err(`hour: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
