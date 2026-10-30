// scripts/compact/plan.mjs — plan one compaction (DOM-023, docs/architecture.md
// section 4.5): the input packs of one tier unit from the live root, whether
// the unit is whole, and the cut of its merge into key ranges for the matrix.
//
// The root is root:latest (or --ref), read with no credential through
// scripts/root/lib.mjs (readRoot: each layer held to its digest, root.json
// validated as a writer validates it), or a root.json file (--root). The unit
// is planned by planTier of packages/compact: ready, wait, present or skip.
// For a ready unit the plan reads the whole index of every input, from
// --inputs DIR (DIR/<tag>/idx, as `oras pull` names a pack's layers) or from
// GHCR by digest, each held to the digest the root names, and cuts the key
// space at index page keys into ranges of about equal input bytes
// (planRanges). A feed or new-name unit of tier d to y also cuts the time copy
// (docs/format.md section 14) when every input carries one, into no more
// ranges than the key copy, and marks the copy to sort otherwise. The ranges
// are held to rangeCeiling of packages/compact, so that the pack's parts and
// indexes fit one manifest of MAX_LAYERS layers, the most scripts/ghcr/push.mjs
// pushes: 255 ranges, or 127 for a pack with a time copy.
//
// The output files are checked before anything is read: a --out or --matrix
// that is a directory, or whose directory is not there, is exit 2. An index
// that the validated root names and GHCR does not give with no credential is
// exit 1: a pack the root names is lost, or its package no longer reads
// publicly. Exit 4 is the root's own read.
//
// Usage:
//   node scripts/compact/plan.mjs --dataset DATASET --tier d|w|m|y --span START [flags]
//     --root FILE          a root.json file, in place of root:latest
//     --ref REF            the root to read from GHCR: latest (the default), r-..., or sha256:DIGEST
//     --inputs DIR         the inputs' layers on disk, DIR/<tag>/idx and DIR/<tag>/time.idx
//     --ranges N           the ranges of the key copy, 1 to the ceiling (default: the input bytes over --target-bytes)
//     --target-bytes N     the input bytes a range aims at (default 536870912)
//     --records-per-block N, --page-entries N   the output's writer (defaults 4096 and 64)
//     --out FILE           write the plan, JSON (domains.compact-plan.v1)
//     --matrix FILE        write the matrix, JSON: { "include": [{ "range": 0 }, ...] }
//     --json               print the plan as JSON instead of lines
// stdout: `verdict VERDICT PACKAGE:TAG START END`, `reason ...`, one line for
// each input (`input PACKAGE:TAG ...`), excluded pack (`excluded PACKAGE:TAG
// MANIFEST REASON`, the package its own: a quarantined segment is of obs),
// missing span and gap day, `ranges key N ...`, `ranges time N MODE`,
// `plan ID` and `matrix JSON`.
// Exit codes: 0 the plan is ready, present or skip · 1 a fault: a live pack
// crosses the unit's edge, the root does not validate, an index does not hash
// to the digest the root names or does not read as one, an index the root
// names that GHCR does not give · 2 could not run (bad arguments, --ranges
// above the ceiling, an output path that cannot be written, GHCR unreachable
// or answering another error, the 429 pauses past their cap) · 3 wait: the
// unit is not whole · 4 PRIVATE PACKAGE: the root does not read with no
// credential · 70 an internal error, a defect of this script (its stack goes
// to stderr).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPACT_TIERS, CompactError, DEFAULT_RANGE_BYTES, MAX_RANGES, planFile, planRanges, planTier, rangeCeiling, tagDecision, timeCodecFor } from '@domains/compact';
import { checkRef, GhcrError, LATEST, MANIFEST_LIMIT_BYTES, NAMESPACE, packageOfDataset, repoOf } from '@domains/ghcr';
import { PackError, readIdx, TIME_IDX_TITLE, VERIFY_ANNOTATIONS } from '@domains/pack';
import { RootError, validateRoot } from '@domains/root';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { RateLimitError, readPaused } from '../ghcr/rate.mjs';
import { parseArgs } from '../lib/args.mjs';
import { Fault, readBlob, readRoot, UsageError } from '../root/lib.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, wait: 3, private: 4, internal: 70 });
// An index is about 46 B a block (docs/format.md section 6.5): 1 GiB is an
// index of about 23 million blocks, far above a year pack's [E].
export const IDX_MAX_BYTES = 1024 * 1024 * 1024;
const USAGE =
  'usage: node scripts/compact/plan.mjs --dataset DATASET --tier d|w|m|y --span START [--root FILE | --ref REF] [--inputs DIR] [--ranges N | --target-bytes N] [--out FILE] [--matrix FILE] [--json]';
const VALUED = ['dataset', 'tier', 'span', 'root', 'ref', 'inputs', 'ranges', 'target-bytes', 'records-per-block', 'page-entries', 'out', 'matrix'];
const FLAGS = [...VALUED, 'json'];

const whole = (v, name, min, max) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min || Number(v) > max)
    throw new UsageError(`--${name} is ${JSON.stringify(v)}, not a whole number of ${min} to ${max}`);
  return Number(v);
};

// The codes of a file-system call on an output path that mean the path cannot
// be written as given: the operator's argument, exit 2, never a defect.
export const OUTPUT_CODES = Object.freeze(['ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EROFS']);

// `fn` on the output `path`; an error of OUTPUT_CODES is a UsageError that names `what`.
export function onOutput(path, what, fn) {
  try {
    return fn();
  } catch (e) {
    if (OUTPUT_CODES.includes(e?.code)) throw new UsageError(`${what} ${path} cannot be written: ${e.code} ${e.message}`);
    throw e;
  }
}

// An output file, checked before anything is read: not a directory, and in a
// directory that is there. It may exist: plan.mjs writes it again.
export function checkOutFile(path, what) {
  if (existsSync(path) && statSync(path).isDirectory()) throw new UsageError(`${what} ${path} is a directory, not a file`);
  const parent = dirname(resolve(path));
  if (!existsSync(parent)) throw new UsageError(`${what} ${path}: its directory ${parent} is not there`);
  if (!statSync(parent).isDirectory()) throw new UsageError(`${what} ${path}: ${parent} is a file, not a directory`);
}

// An output directory, checked before anything is read: a directory, or not
// there yet under a directory that is (it is made with every directory above
// it). The nearest path above it that exists must be a directory.
export function checkOutDir(path, what) {
  let at = resolve(path);
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  if (existsSync(at) && !statSync(at).isDirectory()) throw new UsageError(`${what} ${path}: ${at} is a file, not a directory`);
}

// --out of `who` (assemble, hour or day) is a new directory, or an empty one:
// every file of a run is new, and one run's files are never mixed with
// another's. A path that cannot be made a directory is exit 2 (onOutput).
export function freshDir(path, who) {
  onOutput(path, '--out', () => {
    if (existsSync(path) && readdirSync(path).length > 0) throw new UsageError(`${path} holds files: ${who} writes into a new directory`);
    mkdirSync(path, { recursive: true });
  });
}

// Writes `bytes` to a new file for `who`: one that exists, or a path that
// cannot be written, is exit 2.
export function writeOut(path, bytes, who) {
  try {
    writeFileSync(path, bytes, { flag: 'wx' });
  } catch (e) {
    if (e?.code === 'EEXIST') throw new UsageError(`${path} exists: ${who} writes into a new directory`);
    onOutput(path, 'the output file', () => {
      throw e;
    });
  }
}

// Every page of the tag list of `pkg` in GHCR, read with no credential, for
// the builds of a `what` (unit, hour or day). A package that does not exist
// yet, or does not read publicly, holds no tag: the first push creates it. A
// list cut short is a fault, exit 1: a build of the `what` may be among the
// tags not read, and its tag would be named again. assemble.mjs, day.mjs and
// hour.mjs read their tag lists through it alone; each reads --tags itself.
export async function buildTags(pkg, what, reader, deps) {
  const repo = repoOf(pkg);
  try {
    const list = await readPaused(`the tags of ${repo}`, () => reader.listTags(repo), deps);
    if (list.truncated) throw new Fault(`the tag list of ${repo} was cut at ${list.pages} pages: a build of the ${what} may be among the tags not read`);
    return list.tags;
  } catch (e) {
    if (isNotPublic(e)) {
      deps.log(`${repo} lists no tag with no credential (${e.message}): no build of the ${what} is there`);
      return [];
    }
    throw e;
  }
}

function parse(argv) {
  const a = parseArgs(argv);
  if (typeof a.json === 'string') throw new UsageError(`${JSON.stringify(a.json)} is not a flag`);
  for (const k of Object.keys(a)) if (k !== '_' && !FLAGS.includes(k)) throw new UsageError(`unknown flag --${k}`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  for (const k of ['dataset', 'tier', 'span']) if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  if (!COMPACT_TIERS.includes(a.tier)) throw new UsageError(`--tier is ${JSON.stringify(a.tier)}, not one of ${COMPACT_TIERS.join(', ')}`);
  if (a.root !== undefined && a.ref !== undefined) throw new UsageError('--root and --ref are two roots; give one');
  if (a.ranges !== undefined && a['target-bytes'] !== undefined) throw new UsageError('--ranges and --target-bytes both set the ranges; give one');
  const ref = a.ref ?? LATEST;
  try {
    checkRef(ref);
  } catch (e) {
    throw new UsageError(e.message);
  }
  const ranges = whole(a.ranges, 'ranges', 1, MAX_RANGES);
  const ceiling = rangeCeiling(a.dataset, a.tier);
  if (ranges !== undefined && ranges > ceiling)
    throw new UsageError(`--ranges ${ranges} is above ${ceiling}, the most ranges of a ${a.dataset} pack of tier ${a.tier} whose parts and indexes fit one manifest`);
  if (a.out !== undefined) checkOutFile(a.out, '--out');
  if (a.matrix !== undefined) checkOutFile(a.matrix, '--matrix');
  return {
    dataset: a.dataset,
    tier: a.tier,
    span: a.span,
    rootFile: a.root,
    ref,
    inputs: a.inputs,
    ranges,
    ceiling,
    targetBytes: whole(a['target-bytes'], 'target-bytes', 1, Number.MAX_SAFE_INTEGER) ?? DEFAULT_RANGE_BYTES,
    recordsPerBlock: whole(a['records-per-block'], 'records-per-block', 1, 0xffff),
    pageEntries: whole(a['page-entries'], 'page-entries', 1, 0xffff),
    out: a.out,
    matrix: a.matrix,
    json: a.json === true,
  };
}

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const pkgTag = (p) => `${p.repo.slice(NAMESPACE.length + 1)}:${p.tag}`;

// The root: a root.json file validated as a writer validates it, or a root
// of GHCR read with no credential (readRoot of scripts/root/lib.mjs).
// day.mjs reads its root through it too.
export async function rootOf(args, reader, deps) {
  if (args.rootFile === undefined) {
    const read = await readRoot(reader, args.ref, deps);
    return { root: read.root, ref: read.digest };
  }
  let bytes;
  try {
    bytes = readFileSync(args.rootFile);
  } catch (e) {
    throw new UsageError(`--root ${args.rootFile} does not read: ${e.message}`);
  }
  let json;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new Fault(`--root ${args.rootFile} is not JSON: ${e.message}`);
  }
  try {
    return { root: validateRoot(json), ref: sha(bytes) };
  } catch (e) {
    if (e instanceof RootError) throw new Fault(`--root ${args.rootFile}: ${e.message}`);
    throw e;
  }
}

// A blob that a validated root (or a plan of one) names and GHCR does not give
// with no credential: a fault, exit 1, never PRIVATE PACKAGE. The root was
// promoted only after each package read publicly (docs/architecture.md section
// 4.7 rule 7), so the pack is lost or its package went private since; GHCR
// answers both alike to a reader with no credential (scripts/ghcr/check-public.mjs).
export function lostBlob(e, named, desc) {
  return new Fault(`${named} ${desc.digest} (${desc.size} B), which GHCR does not give with no credential (${e.message}): a pack it names is lost, or its package no longer reads publicly`);
}

// The dev.pkgforge.domains.sha256 of each build of a span, by its tag: the
// opts.buildSha256 of tagDecision (D3 of DOM-023), each build's manifest read
// with no credential, one after another (a span has a few builds). The tag
// list named each build, so a manifest GHCR does not give is a fault, exit 1,
// never PRIVATE PACKAGE: the build is lost, or its package no longer reads
// publicly. A manifest whose sha256 is not 64 lowercase hex digits is a fault
// too: packManifest never writes one, and its bytes cannot be compared.
// assemble.mjs, day.mjs and hour.mjs read their builds through it alone.
export async function buildSha256s(pkg, builds, reader, deps) {
  const repo = repoOf(pkg);
  const out = new Map();
  for (const tag of builds) {
    let m;
    try {
      m = await readPaused(`the manifest ${tag} of ${repo}`, () => reader.getManifest(repo, tag, { maxBytes: MANIFEST_LIMIT_BYTES }), deps);
    } catch (e) {
      if (isNotPublic(e))
        throw new Fault(
          `the tag list of ${repo} names the build ${tag}, whose manifest GHCR does not give with no credential (${e.message}): the build is lost, or its package no longer reads publicly`,
        );
      throw e;
    }
    const sha256 = m.json?.annotations?.[VERIFY_ANNOTATIONS.sha256];
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
      throw new Fault(`the build ${pkg}:${tag} carries ${VERIFY_ANNOTATIONS.sha256} ${JSON.stringify(sha256 ?? null)}, not 64 lowercase hex digits: its bytes cannot be compared with this build's`);
    out.set(tag, sha256);
  }
  return out;
}

// The tag of a built pack whose identity is `sha256` (D3 of DOM-023).
// `first` is tagDecision's answer before the build, with no opts: a `write`
// that lists builds of the span is a rebuild, so each build's manifest is
// read (buildSha256s) and a build that holds `sha256` answers `present`.
// Any other `first` is the answer as it stands, and nothing is read.
export async function decideRebuild(first, dataset, tier, start, tags, sha256, reader, deps) {
  if (first.action !== 'write' || first.builds.length === 0) return first;
  const buildSha256 = await buildSha256s(packageOfDataset(dataset), first.builds, reader, deps);
  return tagDecision(dataset, tier, start, tags, true, { sha256, buildSha256 });
}

// The bytes of one index of an input (`title` idx or time.idx), held to `desc`, the digest the root names.
async function indexBytes(args, p, title, desc, reader, deps) {
  if (args.inputs === undefined) {
    try {
      return await readBlob(reader, p.repo, desc, deps, IDX_MAX_BYTES);
    } catch (e) {
      if (isNotPublic(e)) throw lostBlob(e, `the root names ${pkgTag(p)}'s ${title} as`, desc);
      throw e;
    }
  }
  const path = join(args.inputs, p.tag, title);
  if (!existsSync(path)) throw new UsageError(`--inputs: ${path} does not exist`);
  const bytes = readFileSync(path);
  if (bytes.length !== desc.size || sha(bytes) !== desc.digest)
    throw new Fault(`${path} is ${bytes.length} B hashing to ${sha(bytes)}; the root names ${pkgTag(p)}'s ${title} as ${desc.size} B, ${desc.digest}`);
  return new Uint8Array(bytes);
}

// The lines plan.mjs prints for the plan file `file`, as the header states them.
export function lines(file) {
  const out = [`verdict ${file.verdict} ${packageOfDataset(file.dataset)}:${file.tag} ${file.span.start} ${file.span.end}`, `reason ${file.reason}`];
  for (const p of file.inputs) out.push(`input ${pkgTag(p)} ${p.tier} ${p.span.start} ${p.span.end} ${p.count} ${p.sources.join(',')}`);
  for (const e of file.excluded) out.push(`excluded ${pkgTag(e)} ${e.manifest} ${e.reason}`);
  for (const m of file.missing) out.push(`missing ${m.start} ${m.end} ${m.why}${m.found.length > 0 ? `; found ${m.found.join(' ')}` : ''}`);
  for (const d of file.gap_days) out.push(`gap ${d}`);
  if (file.key !== null) out.push(`ranges key ${file.key.ranges} bytes ${file.key.bytes.join(',')}`);
  if (file.time !== null) out.push(`ranges time ${file.time.ranges} ${file.time.mode}`);
  out.push(`plan ${file.id}`, `matrix ${JSON.stringify(file.matrix)}`);
  return out;
}

// An error plan does not know is a defect, exit 70: never 1, 2, 3 or 4.
export async function main(argv, deps = {}) {
  try {
    return await plan(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`plan: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function plan(argv, { reader = anonymousReader(), out = console.log, err = console.error, sleep, random }) {
  const deps = { sleep, random, log: (l) => err(`plan: ${l}`) };
  try {
    const args = parse(argv);
    const { root, ref } = await rootOf(args, reader, deps);
    const tier = planTier(root, args.dataset, args.tier, args.span);
    let key = null;
    let time = null;
    if (tier.verdict === 'ready') {
      const keyIdx = [];
      for (const p of tier.inputs) keyIdx.push(readIdx(await indexBytes(args, p, 'idx', p.idx, reader, deps)));
      const most = { maxRanges: args.ceiling };
      key = args.ranges === undefined ? planRanges(keyIdx, { targetBytes: args.targetBytes, ...most }) : planRanges(keyIdx, { ranges: args.ranges, ...most });
      if (timeCodecFor(args.dataset, args.tier) !== null) {
        // Every input's time copy, or none of them: an hour pack carries none,
        // nor need a pack of no record (docs/format.md section 14.5, the
        // validateRoot row), and then the assembly sorts.
        if (tier.inputs.every((p) => p.time !== undefined)) {
          const timeIdx = [];
          for (const p of tier.inputs) timeIdx.push(readIdx(await indexBytes(args, p, TIME_IDX_TITLE, p.time.idx, reader, deps)));
          let t = args.ranges === undefined ? planRanges(timeIdx, { targetBytes: args.targetBytes, ...most }) : planRanges(timeIdx, { ranges: args.ranges, ...most });
          // The time copy is 0.982 to 1.104 of the key copy's bytes
          // (docs/format.md section 14.6), so by bytes it may want one range
          // more: never more than the key copy's, which the matrix runs.
          if (t.ranges > key.ranges) t = planRanges(timeIdx, { ranges: key.ranges, ...most });
          time = { ...t, mode: 'merge' };
        } else time = { cuts: [], ranges: 1, bytes: [0], total: 0, mode: 'sort' };
      }
    }
    const file = planFile({ plan: tier, root: ref, key, time, recordsPerBlock: args.recordsPerBlock, pageEntries: args.pageEntries });
    if (args.out !== undefined) onOutput(args.out, '--out', () => writeFileSync(args.out, `${JSON.stringify(file)}\n`));
    if (args.matrix !== undefined) onOutput(args.matrix, '--matrix', () => writeFileSync(args.matrix, `${JSON.stringify(file.matrix)}\n`));
    if (args.json) out(JSON.stringify(file));
    else for (const l of lines(file)) out(l);
    return tier.verdict === 'wait' ? EXIT.wait : EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`plan: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof CompactError) {
      err(`plan: FAIL ${e.code} ${e.message}`);
      return e.code === 'usage' ? EXIT.usage : EXIT.fault;
    }
    // An index that hashes to the digest the root names and does not read as
    // an index: the pack was pushed so, a fault of the data, not of this script.
    if (e instanceof PackError) {
      err(`plan: FAIL ${e.code} ${e.message}`);
      return EXIT.fault;
    }
    if (isNotPublic(e)) {
      out(PRIVATE_LINE);
      err(`plan: the root did not read with no credential: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof Fault) {
      err(`plan: FAIL ${e.message}`);
      return EXIT.fault;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`plan: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
