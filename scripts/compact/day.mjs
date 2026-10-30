// scripts/compact/day.mjs — the daily compaction of one UTC day (DOM-023,
// docs/architecture.md sections 4.5, 5.3 and 5.8 step 5): the domains day
// pack, the exact feed of the day, and the ledger's daily rebuild.
//
// The root is root:latest (or --ref), read with no credential, or a root.json
// file (--root). The packs are read from --inputs DIR (DIR/<tag>/idx,
// part.NNN, as `oras pull` names a pack's layers), each index held to the
// digest the root names, or from GHCR with no credential, each blob by its
// digest (openInputs of scripts/compact/range.mjs).
//
//   1. domains-d-DAY: planTier of packages/compact for the day of `domains`.
//      Ready: the inputs (the hour packs and segments of the day, THC's day
//      segment among them) merged in one process (mergeSpan), held to them by
//      the second pass (checkMerged), written to --out/domains with
//      manifest.json and blobs.json. Present: the live pack is read. Wait:
//      exit 3, nothing is written. Skip (a day every source lacks, ruling 24):
//      exit 0, nothing is written.
//   2. feed-d-DAY: the exact join (exactNew of @domains/ledger, `since` the
//      day's start and the precision of each source) of the day's records
//      against every live domains pack that ends by the day's start; a pack
//      the root marks quarantined is no input of the join (ruling 23). The rows
//      (buildFeedDay of @domains/feed) take the suspect bit and its reasons from
//      the day's hour packs of feed, merged by key. Written with its time copy
//      (writeFeedPack) and the layer summary.json (docs/format.md section 16)
//      to --out/feed, with manifest.json and blobs.json. The pack replaces
//      every live feed pack of the day (planTier of feed); it does not wait on
//      them, since its rows come from the join.
//   3. The ledger, unless --no-ledger: the filter of every domains pack
//      through the day's end, as of that end, and the live delta rebased onto
//      it, to --out/ledger/filter.dlbf (ledger-filter-YYYYMMDD) and
//      delta.dlbd (ledger-delta), docs/format.md section 15. The live filter
//      and delta are --filter FILE and --delta FILE, read and held to each
//      other before anything is built; --first-ledger starts the ledger with
//      an empty delta. A live filter of this day already is `present`; a
//      newer one is refused.
// A pack whose tag the package holds is `present` (tagDecision, ruling 25;
// --rebuild domains,feed takes the next tag): nothing of it is written. Its
// records are still merged again for the join when the root does not name it
// yet, since a merge of the same inputs gives the same records. A rebuild
// whose bytes a build of the day holds is `present` too (D3 of DOM-023): once
// the pack is built, the manifest of each build the tag list names is read
// with no credential (decideRebuild of scripts/compact/plan.mjs), and a build
// whose dev.pkgforge.domains.sha256 is the pack's is present. Its part files
// stay in --out; no manifest.json or blobs.json of it is written, and of the
// feed pack no index, time index or summary.json either. A build whose
// manifest GHCR does not give is a fault, exit 1.
// It writes --out/day.json (domains.compact-day.v1): every tag written, its
// manifest digest, the manifests it replaces, and the counts of the join, the
// carry, the summary and the ledger. It runs no aggregateToDomains: THC's day
// enters `domains` as the domains segment its adapter writes (DOM-029). It
// pushes nothing. The workflow, .github/workflows/compact-daily.yml, verifies
// each pack this script wrote, then pushes it, and promotes the packs pushed
// or found present. Its job push pushes the day's
// ledger filter when the day's domains pack verified and pushed in the run,
// or was live before it. It does not move ledger-delta, which moves under the
// state guard of DOM-024: until DOM-024 builds the guard, the step after the
// filters moves nothing and fails the job when a filter it pushed came with a
// delta.
//
// --out is checked before anything is read: a file, or a path under a file,
// is exit 2, and so is an output that cannot be written. Every blob it reads
// from GHCR is one the validated root names (openInputs of
// scripts/compact/range.mjs), so a blob GHCR does not give with no credential
// is a fault, exit 1: the pack is lost, or its package went private since.
// Exit 4 is left to the root's own read. A tag list that does not read with
// no credential is no build of the day: a package not pushed yet answers so.
//
// Usage:
//   node scripts/compact/day.mjs --day YYYY-MM-DD --out DIR (--filter FILE --delta FILE | --first-ledger | --no-ledger) [flags]
//     --root FILE          a root.json file, in place of root:latest
//     --ref REF            the root to read from GHCR: latest (the default), r-..., or sha256:DIGEST
//     --inputs DIR         the packs' layers on disk, DIR/<tag>/idx and part.NNN
//     --sources FILE       the source registry (default config/sources.json)
//     --tags FILE          the tags of the packages names and feed, a JSON object
//                          { "names": [...], "feed": [...] } (default: read from GHCR)
//     --rebuild LIST       domains, feed or domains,feed: take the next tag of the day,
//                          or find the build that holds the same bytes (present)
//     --run ID             the workflow run (default GITHUB_RUN_ID)
//     --records-per-block N, --page-entries N   the writer (defaults 4096 and 64)
// stdout: `verdict DATASET VERDICT PACKAGE:TAG`, `reason ...`, one line for
// each input and missing span, `check ...` lines, then for each pack
// `present PACKAGE:TAG ...` or `wrote PACKAGE:TAG sha256:DIGEST records N`,
// `replace PACKAGE:TAG MANIFEST...`, `exact ...`, `carry ...`, `summary ...`
// and `ledger ...`.
// Exit codes: 0 written, present or skip · 1 a fault: a live pack crosses the
// day's edge, the root does not validate, an index that does not hash to the
// digest the root names, a blob the root names that GHCR does not give with
// no credential, a merge whose check fails, inputs built under two PSL
// hashes, a live filter newer than the day or a delta of another filter, a
// row outside the day, an hour row the day's records lack, a time copy that
// does not bind to its key copy, a tag list GHCR cut short, a build of the
// day that the tag list names and whose manifest GHCR does not give or
// carries no sha256 · 2 could not run (bad arguments, a file that does not
// read, an output file that exists, an output path that is a file, lies
// under a file or cannot be written, GHCR unreachable) · 3 wait: the day of
// `domains` is not whole · 4 PRIVATE PACKAGE: the root did not read with no
// credential · 70 an internal error, a defect of this script (its stack goes
// to stderr).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  basePacks,
  bindFault,
  buildDay,
  CompactError,
  checkLedger,
  checkMerged,
  DELTA_TITLE,
  dayOf,
  EMPTY_CONFIG,
  FILTER_TITLE,
  isQuarantined,
  joinInputs,
  mergeSpan,
  packManifest,
  planTier,
  rebuildLedger,
  SUMMARY_MEDIA_TYPE,
  SUMMARY_TITLE,
  tagDecision,
} from '@domains/compact';
import { DirPartsSink, fileDigest, openCopy, titlesOf } from '@domains/compact/node';
import { FeedError } from '@domains/feed';
import { checkRef, GhcrError, LATEST, LayoutError, LEDGER_DELTA_TAG, NAMESPACE, packageOfDataset } from '@domains/ghcr';
import { LedgerError } from '@domains/ledger';
import { DOMAINS_CODEC, FEED_CODEC, IDX_TITLE, mergePacks, PackError, TIME_IDX_TITLE } from '@domains/pack';
import { nodeCompress, writerId } from '@domains/pack/node';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { RateLimitError } from '../ghcr/rate.mjs';
import { parseArgs } from '../lib/args.mjs';
import { Fault } from '../root/lib.mjs';
import { DEFAULT_SOURCES } from '../verify-pack.mjs';
import { registryOf } from './hour.mjs';
import { buildTags, checkOutDir, decideRebuild, freshDir, onOutput, rootOf, writeOut } from './plan.mjs';
import { openInputs, UsageError } from './range.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, wait: 3, private: 4, internal: 70 });
export const DAY_FORMAT = 'domains.compact-day.v1';
const USAGE =
  'usage: node scripts/compact/day.mjs --day YYYY-MM-DD --out DIR (--filter FILE --delta FILE | --first-ledger | --no-ledger) [--root FILE | --ref REF] [--inputs DIR] [--sources FILE] [--tags FILE] [--rebuild domains,feed] [--run ID] [--records-per-block N] [--page-entries N]';
const VALUED = ['day', 'out', 'filter', 'delta', 'root', 'ref', 'inputs', 'sources', 'tags', 'rebuild', 'run', 'records-per-block', 'page-entries'];
const SWITCHES = ['first-ledger', 'no-ledger'];
const FLAGS = [...VALUED, ...SWITCHES];
const REBUILDS = ['domains', 'feed'];

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const pkgTag = (p) => `${p.repo.slice(NAMESPACE.length + 1)}:${p.tag}`;

const whole = (v, name, min, max) => {
  if (v === undefined) return undefined;
  if (!/^[0-9]+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min || Number(v) > max) throw new UsageError(`--${name} is ${JSON.stringify(v)}, not a whole number of ${min} to ${max}`);
  return Number(v);
};

function parse(argv, env) {
  const a = parseArgs(argv);
  for (const k of SWITCHES) if (typeof a[k] === 'string') throw new UsageError(`${JSON.stringify(a[k])} is not a flag`);
  for (const k of Object.keys(a)) if (k !== '_' && !FLAGS.includes(k)) throw new UsageError(`unknown flag --${k}`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  for (const k of ['day', 'out']) if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  // The ledger is named every run: a delta left out would be emptied, and the
  // next hours would judge the domains it held new again.
  const given = [a.filter !== undefined || a.delta !== undefined, a['first-ledger'] === true, a['no-ledger'] === true].filter(Boolean).length;
  if (given !== 1) throw new UsageError('name the ledger once: --filter FILE --delta FILE, --first-ledger or --no-ledger');
  if ((a.filter === undefined) !== (a.delta === undefined)) throw new UsageError('--filter and --delta are given together');
  if (a.root !== undefined && a.ref !== undefined) throw new UsageError('--root and --ref are two roots; give one');
  checkOutDir(a.out, '--out');
  const ref = a.ref ?? LATEST;
  try {
    checkRef(ref);
  } catch (e) {
    throw new UsageError(e.message);
  }
  const rebuild = a.rebuild === undefined ? [] : a.rebuild.split(',');
  for (const r of rebuild) if (!REBUILDS.includes(r)) throw new UsageError(`--rebuild ${JSON.stringify(a.rebuild)} names ${JSON.stringify(r)}, not domains or feed`);
  const run = a.run ?? env.GITHUB_RUN_ID;
  if (run === undefined || !/^[1-9][0-9]{0,19}$/.test(run)) throw new UsageError(`the run ${JSON.stringify(run ?? null)} is not a workflow run id: give --run or GITHUB_RUN_ID`);
  return {
    day: a.day,
    out: a.out,
    filter: a.filter,
    delta: a.delta,
    ledger: a['no-ledger'] === true ? 'none' : a['first-ledger'] === true ? 'first' : 'live',
    rootFile: a.root,
    ref,
    inputs: a.inputs,
    sources: a.sources,
    tags: a.tags,
    rebuild,
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

// The tags of `pkg`: --tags FILE, or every page of its tag list in GHCR.
async function tagsOf(args, pkg, reader, deps) {
  if (args.tags !== undefined) {
    let v;
    try {
      v = JSON.parse(readFileSync(args.tags, 'utf8'));
    } catch (e) {
      throw new UsageError(`--tags ${args.tags} does not read as JSON: ${e.message}`);
    }
    const list = v?.[pkg];
    if (!Array.isArray(list) || list.some((t) => typeof t !== 'string')) throw new UsageError(`--tags ${args.tags} holds no JSON list of tags under ${JSON.stringify(pkg)}`);
    return list;
  }
  return buildTags(pkg, 'day', reader, deps);
}

// A directory of --out for one pack or the ledger, made with those above it.
function subDir(path) {
  onOutput(path, 'the output directory', () => mkdirSync(path, { recursive: true }));
  return path;
}

// The precision of the one source of a pack, from the registry.
function precisionOf(registry, sources) {
  if (sources.length !== 1) return {};
  const row = registry.find((r) => r.id === sources[0] && r.bit !== null);
  if (row === undefined) throw new Fault(`the source ${sources[0]} has no row with a bit in the registry`);
  return { precision: row.precision };
}

function planLines(dataset, plan) {
  const out = [`verdict ${dataset} ${plan.verdict} ${packageOfDataset(dataset)}:${plan.tag}`, `reason ${dataset} ${plan.reason}`];
  for (const p of plan.inputs) out.push(`input ${dataset} ${pkgTag(p)} ${p.tier} ${p.span.start} ${p.span.end} ${p.count}${isQuarantined(p) ? ' quarantined' : ''}`);
  for (const m of plan.missing) out.push(`missing ${dataset} ${m.start} ${m.end} ${m.why}`);
  return out;
}

// The blobs of a pack written to `dir`: the config, the parts, idx, the time
// copy's, and any extra layer, each with its file, for the push by
// scripts/ghcr/push.mjs.
async function blobsOf(dir, files, idx, time, extra = []) {
  const keyTitles = titlesOf('key');
  const timeTitles = titlesOf('time');
  const out = [{ title: 'config', file: null, data: EMPTY_CONFIG.data, digest: EMPTY_CONFIG.digest, size: EMPTY_CONFIG.size }];
  for (const [i, f] of files.entries()) out.push({ title: keyTitles.part(i), file: f, ...(await fileDigest(f)) });
  out.push({ title: IDX_TITLE, file: join(dir, IDX_TITLE), digest: sha(idx), size: idx.length });
  if (time !== null) {
    for (const [i, f] of time.files.entries()) out.push({ title: timeTitles.part(i), file: f, ...(await fileDigest(f)) });
    out.push({ title: TIME_IDX_TITLE, file: join(dir, TIME_IDX_TITLE), digest: sha(time.idx), size: time.idx.length });
  }
  for (const x of extra) out.push({ title: x.title, file: join(dir, x.title), digest: sha(x.bytes), size: x.bytes.length });
  return out;
}

// An error day does not know is a defect, exit 70: never 1, 2, 3 or 4.
export async function main(argv, deps = {}) {
  try {
    return await dayJob(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`day: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

// `build` is buildDay of packages/compact. A test gives a double that returns
// a time copy of another span: writeFeedPack binds the two copies by
// construction, so no input makes the bind check below refuse
// (docs/conventions/code.md, "Mocks exist for determinism").
// `readRoot` is rootOf of plan.mjs. A test gives a double that returns a root
// whose entry carries the field `quarantine`: validateRoot refuses that field
// until DOM-029 adds it, so no root file reaches the wiring of ruling 23 below.
async function dayJob(argv, { reader = anonymousReader(), out = console.log, err = console.error, env = process.env, sleep, random, build = buildDay, readRoot = rootOf }) {
  const deps = { sleep, random, log: (l) => err(`day: ${l}`) };
  let inputsDir;
  const opened = [];
  const open = async (entries, codec) => {
    const o = await openInputs({ inputs: entries, by: 'the root' }, 'key', codec, inputsDir, reader, deps);
    opened.push(o);
    return o.readers;
  };
  try {
    const args = parse(argv, env);
    inputsDir = args.inputs;
    const day = dayOf(args.day);
    const registry = registryOf(args.sources ?? DEFAULT_SOURCES);
    // The live ledger is read and held to the day before any pack is read.
    const ledger = args.ledger === 'none' ? null : checkLedger(args.ledger === 'first' ? null : { filter: readFile(args.filter, '--filter'), delta: readFile(args.delta, '--delta') }, day);
    const { root, ref } = await readRoot(args, reader, deps);
    const dPlan = planTier(root, 'domains', 'd', day.start);
    const fPlan = planTier(root, 'feed', 'd', day.start);
    for (const l of planLines('domains', dPlan)) out(l);
    if (dPlan.verdict === 'skip') {
      out(`skip ${day.date}: nothing is written`);
      return EXIT.ok;
    }
    if (dPlan.verdict === 'wait') return EXIT.wait;
    for (const l of planLines('feed', fPlan)) out(l);

    const psls = dPlan.verdict === 'present' ? [dPlan.present.psl] : dPlan.psl;
    if (psls.length !== 1) throw new CompactError('psl', `the domains inputs were built under ${psls.join(' and ')}; their keys depend on the list, and recomputing them under one list is not built`);
    const psl = psls[0];
    const report = { format: DAY_FORMAT, day: day.date, root: ref, domains: null, feed: null, exact: null, carry: null, summary: null, ledger: null };
    freshDir(args.out, 'day');

    // 1. The day's domain records.
    let dayReader;
    let records;
    let daySources;
    if (dPlan.verdict === 'present') {
      [dayReader] = await open([dPlan.present], DOMAINS_CODEC);
      daySources = dPlan.present.sources;
      records = () => dayReader.scan();
      out(`present names:${dPlan.present.tag}: the live pack is the day's records`);
      report.domains = { action: 'present', tag: dPlan.present.tag, manifest: dPlan.present.manifest, replaces: [] };
    } else {
      const tags = await tagsOf(args, 'names', reader, deps);
      const first = tagDecision('domains', 'd', day.start, tags, args.rebuild.includes('domains'));
      const inputs = await open(dPlan.inputs, DOMAINS_CODEC);
      const dir = subDir(join(args.out, 'domains'));
      const sink = new DirPartsSink(dir, 'key');
      let merged;
      try {
        merged = await mergeSpan(inputs, DOMAINS_CODEC, sink, { compress: nodeCompress, recordsPerBlock: args.recordsPerBlock, pageEntries: args.pageEntries });
      } finally {
        await sink.close();
      }
      writeOut(join(dir, IDX_TITLE), merged.idx, 'day');
      const copy = await openCopy(dir, 'key', DOMAINS_CODEC);
      opened.push({ close: copy.close });
      dayReader = copy.reader;
      const check = await checkMerged(
        inputs.map((r) => r.scan()),
        dayReader.scan(),
        DOMAINS_CODEC,
      );
      out(`check domains: ${check.records} records, the inputs' ${check.distinct} distinct keys of ${check.inputRecords} records`);
      const join0 = joinInputs(dPlan.inputs, inputs);
      // The sources the join read: a quarantined input gives the feed no row (absolute 11).
      daySources = join0.sources;
      if (join0.left.length === 0) records = () => dayReader.scan();
      else {
        records = () => mergePacks(join0.readers, DOMAINS_CODEC);
        out(`exact domains: ${join0.left.length} quarantined input(s) left out of the join (ruling 23): ${join0.left.map(pkgTag).join(' ')}`);
      }
      const decision = await decideRebuild(first, 'domains', 'd', day.start, tags, merged.sha256, reader, deps);
      if (decision.action === 'present') {
        const held = first.action === 'present' ? '' : `it holds the bytes of this rebuild, sha256 ${merged.sha256}, and `;
        out(`present names:${decision.tag} (${decision.builds.join(', ')}): ${held}the root does not name it yet; its records are merged again for the join, and nothing of it is written`);
        report.domains = { action: 'present', tag: decision.tag, manifest: null, replaces: dPlan.replaces };
      } else {
        const blobs = await blobsOf(dir, sink.files, merged.idx, null);
        const manifest = packManifest({
          dataset: 'domains',
          tier: 'd',
          span: { start: day.start, end: day.end },
          tag: decision.tag,
          sources: dPlan.sources,
          ...precisionOf(registry, dPlan.sources),
          psl,
          run: args.run,
          summary: merged,
          writer: writerId(),
          parts: blobs.slice(1, -1).map((b) => ({ digest: b.digest, size: b.size })),
          idx: { digest: sha(merged.idx), size: merged.idx.length },
        });
        writeOut(join(dir, 'manifest.json'), manifest.text, 'day');
        writeOut(join(dir, 'blobs.json'), `${JSON.stringify(blobs)}\n`, 'day');
        out(`wrote names:${decision.tag} ${manifest.digest} records ${merged.records} parts ${merged.parts.length}`);
        out(`replace names:${decision.tag} ${dPlan.replaces.join(' ')}`);
        report.domains = { action: 'write', tag: decision.tag, manifest: manifest.digest, replaces: dPlan.replaces, records: merged.records, sha256: merged.sha256 };
      }
    }

    // 2. The earlier domains packs: the join's base, and with the day the filter's table.
    const baseEntries = basePacks(root, day);
    const base = await open(baseEntries, DOMAINS_CODEC);
    out(`base ${baseEntries.length} domains pack(s) end by ${day.start}`);

    // 3. The exact feed of the day.
    if (fPlan.verdict === 'present') {
      out(`present feed:${fPlan.present.tag}: the day's feed is live`);
      report.feed = { action: 'present', tag: fPlan.present.tag, manifest: fPlan.present.manifest, replaces: [] };
    } else {
      const tags = await tagsOf(args, 'feed', reader, deps);
      const first = tagDecision('feed', 'd', day.start, tags, args.rebuild.includes('feed'));
      if (first.action === 'present') {
        out(`present feed:${first.tag} (${first.builds.join(', ')}): nothing is written`);
        report.feed = { action: 'present', tag: first.tag, manifest: null, replaces: fPlan.replaces };
      } else {
        const hours = await open(fPlan.inputs, FEED_CODEC);
        const dir = subDir(join(args.out, 'feed'));
        const sink = new DirPartsSink(dir, 'key');
        const timeSink = new DirPartsSink(dir, 'time');
        let built;
        try {
          built = await build({
            day,
            records,
            base,
            carry: mergePacks(hours, FEED_CODEC),
            registry,
            compress: nodeCompress,
            sink,
            time: { sink: timeSink },
            recordsPerBlock: args.recordsPerBlock,
            pageEntries: args.pageEntries,
          });
        } finally {
          await sink.close();
          await timeSink.close();
        }
        // The two copies are held to each other before an index or a manifest is written.
        const fault = bindFault(built.summary.idx, built.time.idx, { start: day.start, end: day.end });
        if (fault !== null) throw new CompactError('time', fault);
        const decision = await decideRebuild(first, 'feed', 'd', day.start, tags, built.summary.sha256, reader, deps);
        if (decision.action === 'present') {
          out(`present feed:${decision.tag} (${decision.builds.join(', ')}): it holds the bytes of this rebuild, sha256 ${built.summary.sha256}; no index, manifest or blobs.json of it is written`);
          report.feed = { action: 'present', tag: decision.tag, manifest: null, replaces: fPlan.replaces };
        } else {
          writeOut(join(dir, IDX_TITLE), built.summary.idx, 'day');
          writeOut(join(dir, TIME_IDX_TITLE), built.time.idx, 'day');
          writeOut(join(dir, SUMMARY_TITLE), built.summaryBytes, 'day');
          const sources = [...new Set([...daySources, ...fPlan.sources])].sort();
          const blobs = await blobsOf(dir, sink.files, built.summary.idx, { files: timeSink.files, idx: built.time.idx }, [{ title: SUMMARY_TITLE, bytes: built.summaryBytes }]);
          const blob = (title) => {
            const b = blobs.find((x) => x.title === title);
            return { digest: b.digest, size: b.size };
          };
          const keyTitles = titlesOf('key');
          const timeTitles = titlesOf('time');
          const manifest = packManifest({
            dataset: 'feed',
            tier: 'd',
            span: { start: day.start, end: day.end },
            tag: decision.tag,
            sources,
            ...precisionOf(registry, sources),
            psl,
            run: args.run,
            summary: built.summary,
            writer: writerId(),
            parts: sink.files.map((_, i) => blob(keyTitles.part(i))),
            idx: blob(IDX_TITLE),
            time: { idxBytes: built.time.idx, parts: timeSink.files.map((_, i) => blob(timeTitles.part(i))), idx: blob(TIME_IDX_TITLE) },
            extra: [{ title: SUMMARY_TITLE, mediaType: SUMMARY_MEDIA_TYPE, bytes: built.summaryBytes }],
          });
          writeOut(join(dir, 'manifest.json'), manifest.text, 'day');
          writeOut(join(dir, 'blobs.json'), `${JSON.stringify(blobs)}\n`, 'day');
          const e = built.exact;
          const c = built.carry;
          out(`exact day ${e.day} new ${e.new} early ${e.early} blocks ${e.blocksRead}`);
          out(`carry hour rows ${c.hourRows} matched ${c.matched} carried ${c.carried} retracted ${c.retracted}`);
          out(`summary rows ${built.daySummary.rows} suffixes ${Object.keys(built.daySummary.suffixes).length}`);
          out(`wrote feed:${decision.tag} ${manifest.digest} records ${built.rows} parts ${built.summary.parts.length} time ${built.time.parts.length}`);
          out(`replace feed:${decision.tag} ${fPlan.replaces.join(' ')}`);
          report.feed = { action: 'write', tag: decision.tag, manifest: manifest.digest, replaces: fPlan.replaces, records: built.rows, sha256: built.summary.sha256 };
          report.exact = { ...e };
          report.carry = { ...c };
          report.summary = { rows: built.daySummary.rows, suffixes: Object.keys(built.daySummary.suffixes).length };
        }
      }
    }

    // 4. The ledger.
    if (ledger === null) out('ledger not asked (--no-ledger): no filter and no delta is written');
    else if (ledger.action === 'present') {
      out(`present state:${day.filterTag}: the live filter holds the table through ${day.end} already; no filter and no delta is written`);
      report.ledger = { action: 'present', tag: day.filterTag };
    } else {
      const next = await rebuildLedger([...base, dayReader], day, ledger);
      const dir = subDir(join(args.out, 'ledger'));
      writeOut(join(dir, FILTER_TITLE), next.filter, 'day');
      writeOut(join(dir, DELTA_TITLE), next.delta, 'day');
      out(`wrote state:${day.filterTag} ${join(dir, FILTER_TITLE)} ${sha(next.filter)} keys ${next.keys} bytes ${next.filter.length}`);
      out(`wrote state:${LEDGER_DELTA_TAG} ${join(dir, DELTA_TITLE)} ${sha(next.delta)} hashes ${next.before} to ${next.kept}`);
      report.ledger = { action: 'write', tag: day.filterTag, filter: sha(next.filter), delta: sha(next.delta), keys: next.keys, before: next.before, kept: next.kept };
    }
    writeOut(join(args.out, 'day.json'), `${JSON.stringify(report)}\n`, 'day');
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`day: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof CompactError) {
      err(`day: FAIL ${e.code} ${e.message}`);
      return e.code === 'usage' ? EXIT.usage : EXIT.fault;
    }
    if (e instanceof LedgerError || e instanceof FeedError || e instanceof PackError || e instanceof Fault) {
      err(`day: FAIL ${e.code ?? 'fault'} ${e.message}`);
      return EXIT.fault;
    }
    // Every other read turns a refusal into its own answer: a blob the root
    // names and a build's manifest into a Fault, a tag list into no build.
    if (isNotPublic(e)) {
      out(PRIVATE_LINE);
      err(`day: the root did not read with no credential: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError || e instanceof LayoutError) {
      err(`day: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  } finally {
    await Promise.all(opened.map((o) => o.close()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
