// scripts/compact/range.mjs — one range of a planned compaction (DOM-023,
// docs/architecture.md section 4.5): stage 1 counts it, stage 2 writes its
// part, and `all` runs both stages for every range in one process.
//
// The plan is the file scripts/compact/plan.mjs writes. The inputs are read
// from --inputs DIR (DIR/<tag>/idx and part.NNN, and time.idx and
// time.part.NNN, as `oras pull` names a pack's layers), each index held to the
// digest the plan names and each part to its size, or from GHCR with no
// credential, each blob by its digest, read ahead in chunks of
// READ_AHEAD_BYTES so a scan costs one request a chunk, not one a block.
//
//   count   countRange of packages/compact for the key copy and, when the plan
//           merges the time copy, for the time copy: count.<copy>.NNN.json.
//   write   the window of the range from every range's count (--counts DIR;
//           one range alone needs none), the part it owns, written to a new
//           file part.PPP or time.part.PPP (PPP its part number), its own
//           index range.<copy>.NNN.idx, and range.<copy>.NNN.json with the
//           part's digest and size, to which assemble.mjs holds the part
//           file. The time copy is
//           written only when no key of the merge is in two inputs (the key
//           counts say); otherwise assemble.mjs sorts it.
//   all     count and write every range, into one directory.
// After it writes a part, it reads it back and walks it beside the inputs
// over the same keys (checkRange of packages/compact): the part holds exactly
// the inputs' distinct keys from its first (from the start of the key space
// for part 0) to the key after its last, each record their merge. With the
// chain assembly holds (each part's first key is the next of the part before
// it), the checks of all parts cover the whole key space. A part that drops
// one input key fails here, FAIL count, exit 1.
// The workflow uploads these files as an artifact of the run, and its job
// assemble pushes the parts with the rest of the pack through
// scripts/ghcr/push.mjs, which builds the pushed manifest itself. This script
// writes nothing remote.
//
// Usage:
//   node scripts/compact/range.mjs count --plan FILE --range I --out DIR [--inputs DIR]
//   node scripts/compact/range.mjs write --plan FILE --range I --out DIR [--counts DIR] [--inputs DIR]
//   node scripts/compact/range.mjs all --plan FILE --out DIR [--inputs DIR]
// stdout: one line a count (`count COPY I of N: ...`), a part (`range COPY I
// of N: ...`) and a check (`check COPY I: ...`), and `time sort ...` when
// the time copy is left to assemble.mjs.
// Every blob it reads from GHCR is one the plan names, from a root that was
// promoted only after each package read publicly, so a blob GHCR does not
// give with no credential is a fault (exit 1): the pack is lost, or its
// package went private since. The output directory is checked before
// anything is read.
// Exit codes: 0 counted or written, and checked · 1 a fault: an input that
// is not the plan's, a count or a window the inputs do not meet, a range
// whose part passes 1 GiB, a check that fails, an input with no time copy
// to merge, a blob the plan names that GHCR does not give · 2 could not run
// (bad arguments, a range the plan does not cut, a plan whose verdict is not
// ready, a plan or count file that does not read, an output file that exists
// or an output path that cannot be written, GHCR unreachable) · 70 an
// internal error, a defect of this script (its stack goes to stderr).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompactError, checkPlanFile, checkRange, codecOf, countFile, countRange, countsOf, rangeFile, timeCodecFor, WHOLE_WINDOW, windowOf, writeRange } from '@domains/compact';
import { FileSink, fileDigest, filesSource, openCopy, titlesOf } from '@domains/compact/node';
import { GhcrError, NAMESPACE } from '@domains/ghcr';
import { PackError, PackReader } from '@domains/pack';
import { nodeCompress, writerId } from '@domains/pack/node';
import { anonymousReader, isNotPublic } from '../ghcr/check-public.mjs';
import { RateLimitError } from '../ghcr/rate.mjs';
import { parseArgs } from '../lib/args.mjs';
import { Fault, readBlob, UsageError } from '../root/lib.mjs';
import { blobSource } from '../verify-pack.mjs';
import { checkOutDir, IDX_MAX_BYTES, lostBlob, onOutput } from './plan.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, internal: 70 });
// The bytes one read of a GHCR blob asks for: a scan reads a part in order.
export const READ_AHEAD_BYTES = 16 * 1024 * 1024;
const USAGE = 'usage: node scripts/compact/range.mjs count|write|all --plan FILE --out DIR [--range I] [--counts DIR] [--inputs DIR]';
const VALUED = ['plan', 'range', 'out', 'counts', 'inputs'];

// Bad arguments or a file that does not read: exit 2. The one class of
// scripts/root/lib.mjs, which every compaction CLI throws and catches.
export { UsageError };

const pad = (n) => String(n).padStart(3, '0');
export const countName = (copy, r) => `count.${copy}.${pad(r)}.json`;
export const rangeName = (copy, r) => `range.${copy}.${pad(r)}.json`;
export const rangeIdxName = (copy, r) => `range.${copy}.${pad(r)}.idx`;
const shown = (k) => (k === null ? 'none' : JSON.stringify(k.length > 80 ? `${k.slice(0, 80)}...` : k));
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function parse(argv) {
  const a = parseArgs(argv);
  const verb = a._[0];
  if (!['count', 'write', 'all'].includes(verb)) throw new UsageError(`the first word is ${JSON.stringify(verb ?? null)}, not count, write or all`);
  if (a._.length > 1) throw new UsageError(`${JSON.stringify(a._[1])} is not a flag`);
  for (const k of Object.keys(a)) if (k !== '_' && !VALUED.includes(k)) throw new UsageError(`unknown flag --${k}`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a.plan === undefined || a.out === undefined) throw new UsageError('--plan and --out are needed');
  if (verb === 'all' ? a.range !== undefined : a.range === undefined) throw new UsageError(verb === 'all' ? '`all` writes every range; --range belongs to count and write' : '--range is needed');
  if (verb !== 'write' && a.counts !== undefined) throw new UsageError('--counts belongs to write');
  let range;
  if (a.range !== undefined) {
    if (!/^[0-9]{1,3}$/.test(a.range)) throw new UsageError(`--range ${JSON.stringify(a.range)} is not a whole number`);
    range = Number(a.range);
  }
  return { verb, planPath: a.plan, out: a.out, range, counts: a.counts, inputs: a.inputs };
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`${what} ${path} does not read as JSON: ${e.message}`);
  }
}

export function readPlan(path) {
  return checkPlanFile(readJson(path, 'the plan'));
}

// Every file of `dir` named `<kind>.*.json` (count or range), read.
export function jsonFiles(dir, kind) {
  if (!existsSync(dir)) throw new UsageError(`${dir} does not exist`);
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${kind}.`) && n.endsWith('.json'))
    .sort()
    .map((n) => readJson(join(dir, n), `the ${kind} file`));
}

// A RangeSource over GHCR blobs, one a part, each read ahead in order.
function readAhead(sources) {
  const held = new Map();
  return {
    read: async (part, offset, length) => {
      const src = sources[part];
      if (src === undefined) throw new PackError('short-read', `no blob holds part ${part}`);
      const h = held.get(part);
      if (h !== undefined && offset >= h.start && offset + length <= h.start + h.bytes.length) return h.bytes.subarray(offset - h.start, offset - h.start + length);
      const want = Math.max(0, Math.min(Math.max(length, READ_AHEAD_BYTES), src.size - offset));
      const bytes = await src.read(offset, want);
      held.set(part, { start: offset, bytes });
      return bytes.subarray(0, length);
    },
  };
}

const pkgTag = (p) => `${p.repo.slice(NAMESPACE.length + 1)}:${p.tag}`;

// A source over one blob that the plan names: a read GHCR does not give with
// no credential is the fault lostBlob names, not PRIVATE PACKAGE.
function namedSource(src, named, desc) {
  return {
    size: src.size,
    read: async (offset, length) => {
      try {
        return await src.read(offset, length);
      } catch (e) {
        if (isNotPublic(e)) throw lostBlob(e, named, desc);
        throw e;
      }
    },
  };
}

// The readers of `copy` of every input of the plan, in the plan's order; each
// held to the digests the plan names. `plan.by` names who names the inputs in
// a fault, `the plan` unless given (day.mjs gives `the root`). `close`
// releases the files.
export async function openInputs(plan, copy, codec, inputs, reader, deps) {
  const by = plan.by ?? 'the plan';
  const opened = [];
  const readers = [];
  try {
    for (const p of plan.inputs) {
      const layers = copy === 'key' ? { idx: p.idx, parts: p.parts } : p.time;
      if (layers === undefined) throw new Fault(`${pkgTag(p)} carries no time copy`);
      if (inputs !== undefined) {
        const dir = join(inputs, p.tag);
        if (!existsSync(dir)) throw new UsageError(`--inputs: ${dir} does not exist`);
        const o = await openCopy(dir, copy, codec);
        opened.push(o);
        const titles = titlesOf(copy);
        // The index the plan names, whose parts table the root held to the
        // part layers' sizes (packFromManifest); openCopy held the files to it.
        if (sha(o.idxBytes) !== layers.idx.digest) throw new Fault(`${join(dir, titles.idx)} hashes to ${sha(o.idxBytes)}; ${by} names ${pkgTag(p)}'s as ${layers.idx.digest}`);
        readers.push(o.reader);
      } else {
        const titles = titlesOf(copy);
        let idx;
        try {
          idx = await readBlob(reader, p.repo, layers.idx, deps, IDX_MAX_BYTES);
        } catch (e) {
          if (isNotPublic(e)) throw lostBlob(e, `${by} names ${pkgTag(p)}'s ${titles.idx} as`, layers.idx);
          throw e;
        }
        const source = readAhead(layers.parts.map((b, i) => namedSource(blobSource(reader, p.repo, b, deps), `${by} names ${pkgTag(p)}'s ${titles.part(i)} as`, b)));
        readers.push(await PackReader.open(idx, source, codec, { partSizes: layers.parts.map((b) => b.size) }));
      }
    }
  } catch (e) {
    await Promise.all(opened.map((o) => o.close()));
    throw e;
  }
  return { readers, close: () => Promise.all(opened.map((o) => o.close())) };
}

// Writes `bytes` to a new file; an existing file is a usage error: a range
// writes into a new directory. A path that cannot be written is one too.
function writeNew(path, bytes) {
  try {
    writeFileSync(path, bytes, { flag: 'wx' });
  } catch (e) {
    if (e?.code === 'EEXIST') throw new UsageError(`${path} exists: a range writes into a new directory`);
    onOutput(path, 'the output file', () => {
      throw e;
    });
  }
}

async function count(plan, r, out, io, opener) {
  if (r >= plan.key.ranges) throw new UsageError(`--range ${r} is not one of the plan's ${plan.key.ranges} ranges`);
  const copies = [['key', plan.key]];
  if (plan.time !== null && plan.time.mode === 'merge') copies.push(['time', plan.time]);
  for (const [copy, cut] of copies) {
    if (r >= cut.ranges) continue;
    const { codec, readers, close } = await opener(copy);
    try {
      const c = await countRange(readers, codec, cut.cuts, r);
      writeNew(join(out, countName(copy, r)), `${JSON.stringify(countFile(plan, copy, c))}\n`);
      io.out(`count ${copy} ${r} of ${c.of}: ${c.count} records (${c.inputRecords} input records), first ${shown(c.first)}, last ${shown(c.last)}`);
    } finally {
      await close();
    }
  }
}

// Writes the part of `copy` range r, and checks it against the inputs.
// `disjointOf` says, from the range's output, whether no key of the merge is
// in two inputs.
async function writeCopy(plan, copy, r, window, out, io, opener, disjointOf) {
  const { codec, readers, close } = await opener(copy);
  try {
    const cut = plan[copy];
    const titles = titlesOf(copy);
    const path = window.part === null ? null : join(out, titles.part(window.part));
    if (path !== null && existsSync(path)) throw new UsageError(`${path} exists: a range writes into a new directory`);
    const sink = path === null ? null : new FileSink(path);
    let o;
    try {
      o = await io.merge(readers, codec, cut.cuts, window, sink ?? { write: () => undefined }, { compress: nodeCompress, recordsPerBlock: plan.records_per_block, pageEntries: plan.page_entries });
    } finally {
      await sink?.close();
    }
    let part = null;
    let idx = null;
    if (o.part !== null) {
      const idxName = rangeIdxName(copy, r);
      writeNew(join(out, idxName), o.summary.idx);
      part = { file: titles.part(o.part), ...(await fileDigest(path)) };
      idx = { file: idxName, digest: sha(o.summary.idx), size: o.summary.idx.length };
      // The second pass: the part read back, beside the inputs over its keys.
      const f = filesSource([path]);
      try {
        const written = await PackReader.open(o.summary.idx, f.source, codec, { partSizes: f.sizes });
        const check = await checkRange(readers, written.scan(), o, codec);
        io.out(
          `check ${copy} ${r}: ${check.records} records, the inputs' ${check.distinct} distinct keys from ${o.part === 0 ? 'the start' : shown(o.first)} to ${o.next === null ? 'the end' : shown(o.next)}`,
        );
      } finally {
        await f.close();
      }
    }
    const file = rangeFile(plan, copy, { out: o, disjoint: disjointOf(o), writer: writerId(), part, idx });
    writeNew(join(out, rangeName(copy, r)), `${JSON.stringify(file)}\n`);
    io.out(
      `range ${copy} ${r} of ${o.of}: ${o.part === null ? 'no block starts in it, no part' : `part ${o.part}, ${o.records} records, ${part.file} ${part.digest} ${part.size} B, next ${shown(o.next)}`}`,
    );
    return o;
  } finally {
    await close();
  }
}

async function write(plan, r, out, countsDir, io, opener) {
  const R = plan.records_per_block;
  const files = countsDir === undefined ? [] : jsonFiles(countsDir, 'count');
  const keyCounts = countsOf(plan, 'key', files);
  if (r >= plan.key.ranges) throw new UsageError(`--range ${r} is not one of the plan's ${plan.key.ranges} ranges`);
  if (plan.key.ranges > 1 && countsDir === undefined) throw new UsageError(`the plan cuts ${plan.key.ranges} ranges: --counts DIR is needed`);
  // No key in two inputs: the merge's records are the inputs' (the counts, or a range alone).
  let disjoint = null;
  if (plan.key.ranges > 1) {
    const counted = keyCounts.reduce((n, c) => n + c.inputRecords, 0);
    if (counted !== plan.records) throw new Fault(`the counts read ${counted} input records; the plan's inputs hold ${plan.records}`);
    disjoint = keyCounts.reduce((n, c) => n + c.count, 0) === plan.records;
  }
  const keyWindow = plan.key.ranges === 1 ? WHOLE_WINDOW : windowOf(keyCounts, r, R);
  // One range alone: its output is the whole merge, and says it.
  const disjointOf = (o) => {
    if (disjoint !== null) return disjoint;
    if (o.records > plan.records) throw new Fault(`the merge wrote ${o.records} records from inputs of ${plan.records}`);
    disjoint = o.records === plan.records;
    return disjoint;
  };
  await writeCopy(plan, 'key', r, keyWindow, out, io, opener, disjointOf);
  if (plan.time === null || r >= plan.time.ranges) return;
  if (plan.time.mode !== 'merge' || !disjoint) {
    io.out(`time sort: ${plan.time.mode === 'sort' ? 'an input carries no time copy' : 'a key is in two inputs'}; assemble.mjs sorts the time copy`);
    return;
  }
  const timeWindow = plan.time.ranges === 1 ? WHOLE_WINDOW : windowOf(countsOf(plan, 'time', files), r, R);
  await writeCopy(plan, 'time', r, timeWindow, out, io, opener, () => true);
}

// An error range does not know is a defect, exit 70: never 1 or 2.
export async function main(argv, deps = {}) {
  try {
    return await run(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`range: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

// `merge` is writeRange of packages/compact; a test passes a defective one, to
// show that the check of each part catches what it writes.
async function run(argv, { reader = anonymousReader(), out = console.log, err = console.error, sleep, random, merge = writeRange }) {
  const deps = { sleep, random, log: (l) => err(`range: ${l}`) };
  const io = { out, err, merge };
  try {
    const args = parse(argv);
    checkOutDir(args.out, '--out');
    const plan = readPlan(args.planPath);
    if (plan.verdict !== 'ready') throw new UsageError(`the plan's verdict is ${plan.verdict}: there is nothing to merge`);
    onOutput(args.out, '--out', () => mkdirSync(args.out, { recursive: true }));
    const opener = async (copy) => {
      const codec = copy === 'key' ? codecOf(plan.dataset) : timeCodecFor(plan.dataset, plan.tier);
      const opened = await openInputs(plan, copy, codec, args.inputs, reader, deps);
      return { codec, ...opened };
    };
    if (args.verb === 'count') await count(plan, args.range, args.out, io, opener);
    else if (args.verb === 'write') await write(plan, args.range, args.out, args.counts, io, opener);
    else {
      for (let r = 0; r < plan.key.ranges; r += 1) await count(plan, r, args.out, io, opener);
      for (let r = 0; r < plan.key.ranges; r += 1) await write(plan, r, args.out, args.out, io, opener);
    }
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`range: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof CompactError) {
      err(`range: FAIL ${e.code} ${e.message}`);
      return e.code === 'usage' ? EXIT.usage : EXIT.fault;
    }
    if (e instanceof PackError) {
      err(`range: FAIL ${e.code} ${e.message}`);
      return EXIT.fault;
    }
    if (e instanceof Fault) {
      err(`range: FAIL ${e.message}`);
      return EXIT.fault;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`range: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
