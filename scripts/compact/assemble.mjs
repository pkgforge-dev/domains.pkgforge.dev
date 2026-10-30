// scripts/compact/assemble.mjs — the pack of a planned compaction from the
// parts its ranges wrote (DOM-023, docs/architecture.md sections 4.2 and 4.5):
// its index, its time copy, its identity and its OCI manifest. The workflow
// takes the artifact type, the annotations and the layers from that manifest
// and gives them to scripts/ghcr/push.mjs, which builds the pushed manifest
// itself, so its digest differs from the one printed here.
//
// First the tag (docs/architecture.md section 4.7 rule 1, ruling 25): the
// package's tags, from --tags FILE (a JSON list) or read from GHCR with no
// credential. A build of the unit is there: `present`, exit 0, and nothing is
// written, so a re-run of the job skips. With --rebuild the pack takes the
// next tag of its span, -r2 then -r3 (tagDecision of packages/compact),
// unless a build already holds its bytes (D3 of DOM-023): once the key copy
// is assembled, the manifest of each build of the span is read from GHCR with
// no credential (decideRebuild of scripts/compact/plan.mjs, which day.mjs and
// hour.mjs call too), and a build whose dev.pkgforge.domains.sha256 is the
// pack's is `present`, exit 0, and nothing is written. So a re-run of a
// rebuild whose push succeeded pushes nothing again.
//
// Then, from DIR, where the range jobs' files are (range.<copy>.NNN.json,
// range.<copy>.NNN.idx and the part files part.PPP and time.part.PPP):
//   - every range of the plan once, each file of this plan (its id), each
//     part file and range index held to the digest its range file names;
//   - the index of all parts (assembleRanges): the parts in range order with
//     no number skipped, each range's first key the key after the last of the
//     range before it, its count its index's;
//   - the identity, the SHA-256 of every raw block in order, each block read
//     from its part, inflated and held to its CRC-32 (hashParts), and each
//     part header held to the index;
//   - the merge's count: the inputs' records exactly when no key was in two
//     inputs, fewer otherwise;
//   - with --inputs DIR, the second pass of the whole pack: it holds exactly
//     the inputs' distinct keys, each record their merge (checkMerged). A pack
//     that drops one input key fails here, FAIL count, exit 1;
//   - for feed and new-name of tier d to y, the time copy: the ranges' time
//     parts assembled the same way when the merge moved no row, else sorted
//     here from the assembled rows (sortTimeCopy) into time.part.NNN of
//     --out; then held to the key copy (timeBindFault).
// It writes to --out: idx, time.idx, the sorted time parts, manifest.json
// (packManifest: held to what the promotion accepts), and blobs.json, every
// blob the manifest names (title, file, digest, size; the empty config with
// no file). The workflow moves each blob that has a file into one directory,
// named by its title, for scripts/ghcr/push.mjs. It pushes nothing.
//
// Usage:
//   node scripts/compact/assemble.mjs --plan FILE --dir DIR --out DIR [flags]
//     --tags FILE          the package's tags, a JSON list (default: read from GHCR)
//     --rebuild            take the next tag of the span when a build is there and none holds the pack's bytes
//     --run ID             the workflow run (default GITHUB_RUN_ID)
//     --psl HEX            the PSL the pack is built under (default: the inputs' one list)
//     --precision day|second   the precision of the one source, when there is one
//     --inputs DIR         the inputs' layers on disk, for the second pass of the whole pack
// stdout: `present PACKAGE:TAG ...` or `assembled PACKAGE:TAG DIGEST ...`, and a
// line a check.
// The output directory is checked before anything is read; a present unit
// leaves it unmade.
// Exit codes: 0 assembled, or present · 1 a fault: a range missing or twice,
// parts out of order, a count that disagrees, a file whose digest differs, a
// part that reads corrupt, a check that fails, a time copy that does not
// bind, inputs built under two PSL hashes for a dataset whose keys depend on
// the list, a blob the plan names that GHCR does not give (with --inputs
// read from GHCR), a build of the span whose manifest GHCR does not give with
// no credential or whose sha256 is not 64 lowercase hex digits (with
// --rebuild) · 2 could not run (bad arguments, a file that does not read, an
// output path that cannot be written, GHCR unreachable) · 70 an internal
// error, a defect of this script (its stack goes to stderr).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleRanges, bindFault, CompactError, checkMerged, codecOf, EMPTY_CONFIG, hashParts, packManifest, rangesOf, sortTimeCopy, tagDecision, timeCodecFor } from '@domains/compact';
import { DirPartsSink, fileDigest, filesSource, readIdxFile, titlesOf } from '@domains/compact/node';
import { GhcrError, packageOfDataset } from '@domains/ghcr';
import { DEFAULT_CODEC, IDX_TITLE, PackError, PackReader, TIME_IDX_TITLE } from '@domains/pack';
import { nodeCompress } from '@domains/pack/node';
import { anonymousReader } from '../ghcr/check-public.mjs';
import { RateLimitError } from '../ghcr/rate.mjs';
import { parseArgs } from '../lib/args.mjs';
import { Fault } from '../root/lib.mjs';
import { buildTags, checkOutDir, decideRebuild, onOutput, writeOut } from './plan.mjs';
import { jsonFiles, openInputs, readPlan, UsageError } from './range.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, internal: 70 });
const USAGE = 'usage: node scripts/compact/assemble.mjs --plan FILE --dir DIR --out DIR [--tags FILE] [--rebuild] [--run ID] [--psl HEX] [--precision day|second] [--inputs DIR]';
const VALUED = ['plan', 'dir', 'out', 'tags', 'run', 'psl', 'precision', 'inputs'];
const FLAGS = [...VALUED, 'rebuild'];
// The datasets whose keys the PSL gives: a registrable domain (docs/architecture.md section 3.3).
const PSL_KEYED = ['domains', 'feed'];

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function parse(argv, env) {
  const a = parseArgs(argv);
  if (typeof a.rebuild === 'string') throw new UsageError(`${JSON.stringify(a.rebuild)} is not a flag`);
  for (const k of Object.keys(a)) if (k !== '_' && !FLAGS.includes(k)) throw new UsageError(`unknown flag --${k}`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  for (const k of ['plan', 'dir', 'out']) if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  const run = a.run ?? env.GITHUB_RUN_ID;
  if (run === undefined || !/^[1-9][0-9]{0,19}$/.test(run)) throw new UsageError(`the run ${JSON.stringify(run ?? null)} is not a workflow run id: give --run or GITHUB_RUN_ID`);
  if (a.psl !== undefined && !/^[0-9a-f]{64}$/.test(a.psl)) throw new UsageError('--psl is not 64 lowercase hex digits');
  if (a.precision !== undefined && a.precision !== 'day' && a.precision !== 'second') throw new UsageError('--precision is day or second');
  return { planPath: a.plan, dir: a.dir, out: a.out, tags: a.tags, rebuild: a.rebuild === true, run, psl: a.psl, precision: a.precision, inputs: a.inputs };
}

// The package's tags: --tags FILE, or every page of its tag list in GHCR. A
// package that does not exist yet holds no tag: the first push creates it.
async function tagsOf(args, plan, reader, deps) {
  if (args.tags !== undefined) {
    let v;
    try {
      v = JSON.parse(readFileSync(args.tags, 'utf8'));
    } catch (e) {
      throw new UsageError(`--tags ${args.tags} does not read as JSON: ${e.message}`);
    }
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) throw new UsageError(`--tags ${args.tags} is not a JSON list of tags`);
    return v;
  }
  return buildTags(packageOfDataset(plan.dataset), 'unit', reader, deps);
}

// The parts and index of `copy` from the range files in `dir`: assembled, each
// file held to its digest, every block read and hashed.
async function assembleCopy(plan, copy, codec, dir) {
  const files = rangesOf(plan, copy, jsonFiles(dir, 'range'));
  const cut = plan[copy];
  const writers = new Set(files.map((f) => f.writer));
  if (writers.size > 1) throw new Fault(`the ranges of the ${copy} copy were written by ${[...writers].join(' and ')}: one zlib build writes one pack`);
  for (const f of files) if (f.of !== cut.ranges) throw new Fault(`range ${f.range} of the ${copy} copy is of ${f.of} ranges; the plan cuts ${cut.ranges}`);
  const facts = [];
  for (const f of files) {
    let entries = [];
    if (f.part !== null) {
      const idxPath = join(dir, f.idx.file);
      const partPath = join(dir, f.file);
      if (!existsSync(idxPath) || !existsSync(partPath)) throw new UsageError(`range ${f.range} of the ${copy} copy: ${existsSync(idxPath) ? partPath : idxPath} does not exist`);
      const idxBytes = readFileSync(idxPath);
      if (sha(idxBytes) !== f.idx.digest) throw new Fault(`${idxPath} hashes to ${sha(idxBytes)}; its range file says ${f.idx.digest}`);
      const got = await fileDigest(partPath);
      if (got.digest !== f.digest || got.size !== f.size) throw new Fault(`${partPath} is ${got.size} B hashing to ${got.digest}; its range file says ${f.size} B, ${f.digest}`);
      entries = readIdxFile(idxPath).entries;
    }
    facts.push({ range: f.range, of: f.of, part: f.part, records: f.records, first: f.first, last: f.last, next: f.next, partBytes: f.size, entries });
  }
  const format = { dataset: codec.id, codec: DEFAULT_CODEC, recordsPerBlock: plan.records_per_block, pageEntries: plan.page_entries };
  const asm = assembleRanges(facts, format);
  const owning = files.filter((f) => f.part !== null).sort((a, b) => a.part - b.part);
  const partPaths = owning.map((f) => join(dir, f.file));
  const blobs = owning.map((f) => ({ digest: f.digest, size: f.size }));
  const src = filesSource(partPaths);
  let digest;
  try {
    digest = await hashParts(asm.idx, src.source, src.sizes, codec);
  } finally {
    await src.close();
  }
  const partBytes = asm.parts.reduce((n, p) => n + p.bytes, 0);
  const summary = {
    dataset: codec.id,
    codec: format.codec,
    recordsPerBlock: format.recordsPerBlock,
    pageEntries: format.pageEntries,
    records: asm.records,
    blocks: asm.entries.length,
    parts: asm.parts,
    entries: asm.entries,
    idx: asm.idx,
    sha256: digest.sha256,
    rawBytes: digest.rawBytes,
    partBytes,
    bytes: partBytes + asm.idx.length,
    keyMin: asm.keyMin,
    keyMax: asm.keyMax,
  };
  return { summary, partPaths, blobs, writer: [...writers][0], disjoint: files.every((f) => f.disjoint) };
}

// A reader of an assembled copy: its index in memory, its parts the files.
async function withAssembled(idx, partPaths, codec, fn) {
  const src = filesSource(partPaths);
  try {
    return await fn(await PackReader.open(idx, src.source, codec, { partSizes: src.sizes }));
  } finally {
    await src.close();
  }
}

// An error assemble does not know is a defect, exit 70: never 1 or 2.
export async function main(argv, deps = {}) {
  try {
    return await assemble(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`assemble: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function assemble(argv, { reader = anonymousReader(), out = console.log, err = console.error, env = process.env, sleep, random }) {
  const deps = { sleep, random, log: (l) => err(`assemble: ${l}`) };
  try {
    const args = parse(argv, env);
    checkOutDir(args.out, '--out');
    const plan = readPlan(args.planPath);
    if (plan.verdict !== 'ready') throw new UsageError(`the plan's verdict is ${plan.verdict}: there is nothing to assemble`);
    const pkg = packageOfDataset(plan.dataset);
    if (plan.sources.length === 1 && args.precision === undefined) throw new UsageError(`the pack has the one source ${plan.sources[0]}: give --precision day or second`);
    if (plan.sources.length > 1 && args.precision !== undefined) throw new UsageError('--precision belongs to a pack of one source');
    // The PSL: the inputs' one list, or the one given where the keys do not depend on it.
    let psl = args.psl;
    if (PSL_KEYED.includes(plan.dataset) && (plan.psl.length > 1 || (psl !== undefined && psl !== plan.psl[0]))) {
      throw new CompactError('psl', `the ${plan.dataset} inputs were built under ${plan.psl.join(' and ')}; their keys depend on the list, and recomputing them under one list is not built`);
    }
    if (psl === undefined) {
      if (plan.psl.length !== 1) throw new UsageError(`the inputs were built under ${plan.psl.length} lists: give --psl`);
      psl = plan.psl[0];
    }

    const tags = await tagsOf(args, plan, reader, deps);
    const first = tagDecision(plan.dataset, plan.tier, plan.span.start, tags, args.rebuild);
    if (first.action === 'present') {
      out(`present ${pkg}:${first.tag} (${first.builds.join(', ')}): nothing is written`);
      return EXIT.ok;
    }
    const codec = codecOf(plan.dataset);
    const key = await assembleCopy(plan, 'key', codec, args.dir);
    out(`check key: ${key.summary.records} records in ${key.summary.parts.length} part(s), every block's CRC-32 held, sha256 ${key.summary.sha256}`);
    if (key.disjoint ? key.summary.records !== plan.records : key.summary.records >= plan.records) {
      throw new CompactError('count', `the ranges hold ${key.summary.records} records; the inputs hold ${plan.records}, and the ranges say ${key.disjoint ? 'no key is' : 'a key is'} in two inputs`);
    }
    // A rebuild of a span with builds: a build that holds these bytes is
    // present, so a re-run of a rebuild whose push succeeded writes nothing (D3).
    const decision = await decideRebuild(first, plan.dataset, plan.tier, plan.span.start, tags, key.summary.sha256, reader, deps);
    if (decision.action === 'present') {
      out(`present ${pkg}:${decision.tag} (${decision.builds.join(', ')}): it holds sha256 ${key.summary.sha256}; nothing is written`);
      return EXIT.ok;
    }
    onOutput(args.out, '--out', () => mkdirSync(args.out, { recursive: true }));
    if (args.inputs !== undefined) {
      const opened = await openInputs(plan, 'key', codec, args.inputs, reader, deps);
      try {
        const check = await withAssembled(key.summary.idx, key.partPaths, codec, (r) =>
          checkMerged(
            opened.readers.map((x) => x.scan()),
            r.scan(),
            codec,
          ),
        );
        out(`check count: ${check.records} records, the inputs' ${check.distinct} distinct keys of ${check.inputRecords} records`);
      } finally {
        await opened.close();
      }
    }
    writeOut(join(args.out, IDX_TITLE), key.summary.idx, 'assemble');

    let time = null;
    const timeCodec = timeCodecFor(plan.dataset, plan.tier);
    if (timeCodec !== null) {
      if (plan.time.mode === 'merge' && key.disjoint) {
        const t = await assembleCopy(plan, 'time', timeCodec, args.dir);
        if (t.writer !== key.writer) throw new Fault(`the time copy was written by ${t.writer} and the key copy by ${key.writer}`);
        time = { idxBytes: t.summary.idx, parts: t.blobs, files: t.partPaths, how: 'merged' };
      } else {
        const sink = new DirPartsSink(args.out, 'time');
        let sorted;
        try {
          sorted = await withAssembled(key.summary.idx, key.partPaths, codec, (r) =>
            sortTimeCopy(r.scan(), codec, sink, { compress: nodeCompress, recordsPerBlock: plan.records_per_block, pageEntries: plan.page_entries }),
          );
        } finally {
          await sink.close();
        }
        const parts = [];
        for (const f of sink.files) parts.push(await fileDigest(f));
        time = { idxBytes: sorted.idx, parts, files: sink.files, how: 'sorted' };
      }
      const fault = bindFault(key.summary.idx, time.idxBytes, plan.span);
      if (fault !== null) throw new CompactError('time', fault);
      writeOut(join(args.out, TIME_IDX_TITLE), time.idxBytes, 'assemble');
      out(`check time: ${time.how}, ${time.parts.length} part(s), bound to the key copy`);
    }

    const manifest = packManifest({
      dataset: plan.dataset,
      tier: plan.tier,
      span: plan.span,
      tag: decision.tag,
      sources: plan.sources,
      ...(args.precision === undefined ? {} : { precision: args.precision }),
      psl,
      run: args.run,
      summary: key.summary,
      writer: key.writer,
      parts: key.blobs,
      idx: { digest: sha(key.summary.idx), size: key.summary.idx.length },
      time: time === null ? null : { idxBytes: time.idxBytes, parts: time.parts, idx: { digest: sha(time.idxBytes), size: time.idxBytes.length } },
    });
    writeOut(join(args.out, 'manifest.json'), manifest.text, 'assemble');
    const keyTitles = titlesOf('key');
    const timeTitles = titlesOf('time');
    const blobs = [
      { title: 'config', file: null, data: EMPTY_CONFIG.data, digest: EMPTY_CONFIG.digest, size: EMPTY_CONFIG.size },
      ...key.blobs.map((b, i) => ({ title: keyTitles.part(i), file: key.partPaths[i], ...b })),
      { title: IDX_TITLE, file: join(args.out, IDX_TITLE), digest: sha(key.summary.idx), size: key.summary.idx.length },
      ...(time === null
        ? []
        : [
            ...time.parts.map((b, i) => ({ title: timeTitles.part(i), file: time.files[i], ...b })),
            { title: TIME_IDX_TITLE, file: join(args.out, TIME_IDX_TITLE), digest: sha(time.idxBytes), size: time.idxBytes.length },
          ]),
    ];
    writeOut(join(args.out, 'blobs.json'), `${JSON.stringify(blobs)}\n`, 'assemble');
    out(`assembled ${pkg}:${decision.tag} ${manifest.digest} records ${key.summary.records} parts ${key.summary.parts.length}${time === null ? '' : ` time ${time.how}`}`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`assemble: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof CompactError) {
      err(`assemble: FAIL ${e.code} ${e.message}`);
      return e.code === 'usage' ? EXIT.usage : EXIT.fault;
    }
    if (e instanceof PackError || e instanceof Fault) {
      err(`assemble: FAIL ${e.code ?? 'fault'} ${e.message}`);
      return EXIT.fault;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`assemble: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
