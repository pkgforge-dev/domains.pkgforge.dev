// scripts/compact/measure.mjs — the runner measurement of DOM-023
// (TODO/storage.md, its Measure bullet; docs/architecture.md section 4.5): the
// runtime, the peak memory and the disk of one range merge of
// scripts/compact/range.mjs on a GitHub-hosted runner, which design A listed as
// unmeasured (its section 11 step 6). .github/workflows/measure-compact.yml runs
// it. ⚠ Both are temporary: they are deleted when DOM-023 closes, and the
// result goes to docs/research/measure/DOM-023/.
//
//   inputs   K synthetic input packs of DATASET, ROWS records each, in
//            DIR/in/<tag>/ as `oras pull` names a pack's layers (idx, part.NNN,
//            and for feed and new-name day packs time.idx, time.part.NNN), and
//            DIR/root.json, a root whose live packs of the dataset are those K
//            and make one unit whole (fixture.mjs rootOf: packManifest, then
//            packFromManifest and buildRoot, as the promotion reads them).
//            K is a fan-in a compaction meets: 7 day packs make a week (the
//            ISO week from 2026-10-19), 24 hour packs a day (2026-10-26), 30 day
//            packs a month (2026-09). Input j holds the indexes i = b * K + j for
//            b below ROWS, and also the index of input j - 1 in the same b
//            when a hash of it falls below OVERLAP, so a share of the keys is in
//            two inputs and the merge folds them. The distinct keys are ROWS * K.
//            Writes DIR/inputs.json (domains.measure-compact-inputs.v1).
//   free     the bytes free to this user on the file system of DIR
//            (statfs: available blocks times the block size), one number.
//   result   one JSON line (domains.measure-compact.v1) from the inputs file,
//            the plan, the range files of --out-dir, the output of
//            `/usr/bin/time -v -o FILE` for the count and the write stage, and
//            the free bytes before and after the merge.
//
// Every key, time and source is synthetic: a key is com.m<i, 10 digits> and a
// label of 6 base-36 characters from a hash of i, so the keys ascend by i and
// do not compress as a counter alone would. Nothing here reads or writes GHCR.
//
// Usage:
//   node scripts/compact/measure.mjs inputs --dataset DATASET --inputs 7|24|30 --rows N --out DIR [--overlap F] [--seed N] [--records-per-block N]
//   node scripts/compact/measure.mjs free --dir DIR
//   node scripts/compact/measure.mjs result --inputs FILE --plan FILE --out-dir DIR --count-time FILE --write-time FILE --free-before N --free-after N
// DATASET is names, domains, feed or new-name. ROWS is at most MAX_ROWS a
// pack, and at most MAX_FEED_ROWS for feed and new-name: writeFeedPack holds
// every row of a pack in memory to sort its time copy (TODO/storage.md,
// DOM-023's Found of 2026-10-29T15:30Z). OVERLAP is 0 to 1 (default 0).
// stdout: `inputs ...` (one line), the free bytes, or the JSON line.
// Exit codes: 0 written or printed · 1 a fault: a time output that lacks a
// field it must give, a stage that did not exit 0, a merge whose records are
// not the inputs' distinct keys, a range file of another plan or none ·
// 2 could not run (bad arguments, an output directory that is not empty, a
// file that does not read) · 70 an internal error, a defect of this script
// (its stack goes to stderr).
import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompactError, checkPlanFile, packManifest } from '@domains/compact';
import { DirPartsSink, fileDigest } from '@domains/compact/node';
import { writeFeedPack } from '@domains/feed';
import { tierTag } from '@domains/ghcr';
import { DEFAULT_RECORDS_PER_BLOCK, DOMAINS_CODEC, FEED_CODEC, IDX_TITLE, NAMES_CODEC, NEW_NAME_CODEC, sha256Hex, TIME_IDX_TITLE, writePack } from '@domains/pack';
import { nodeCompress, writerId } from '@domains/pack/node';
import { parseArgs } from '../lib/args.mjs';
import { EPOCH_MS, PSL, rootOf } from './fixture.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, internal: 70 });
export const INPUTS_FORMAT = 'domains.measure-compact-inputs.v1';
export const RESULT_FORMAT = 'domains.measure-compact.v1';
// The key holds i in 10 digits, so ROWS * K stays below 10^10.
export const MAX_ROWS = 300_000_000;
export const MAX_FEED_ROWS = 10_000_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WIDTH = 10;
// The fan-ins a compaction meets, each the unit it makes whole: the tier and
// start of the unit, and the tier and length of each input.
export const SHAPES = Object.freeze({
  7: Object.freeze({ tier: 'w', start: '2026-10-19T00:00:00Z', slot: 'd', stepMs: DAY_MS }),
  24: Object.freeze({ tier: 'd', start: '2026-10-26T00:00:00Z', slot: 'h', stepMs: HOUR_MS }),
  30: Object.freeze({ tier: 'm', start: '2026-09-01T00:00:00Z', slot: 'd', stepMs: DAY_MS }),
});
const CODECS = Object.freeze({ names: NAMES_CODEC, domains: DOMAINS_CODEC, feed: FEED_CODEC, 'new-name': NEW_NAME_CODEC });
const FEEDS = ['feed', 'new-name'];
// The sources each synthetic pack names, as scripts/compact/fixture.mjs names them.
const SOURCES = ['oi-cs', 'thc-ct'];
// The fields of `/usr/bin/time -v` (GNU time) the result reads, by label.
export const TIME_FIELDS = Object.freeze({
  user_s: 'User time (seconds)',
  sys_s: 'System time (seconds)',
  cpu_percent: 'Percent of CPU this job got',
  wall: 'Elapsed (wall clock) time (h:mm:ss or m:ss)',
  max_rss_kib: 'Maximum resident set size (kbytes)',
  exit: 'Exit status',
});
const USAGE = [
  'usage: node scripts/compact/measure.mjs inputs --dataset DATASET --inputs 7|24|30 --rows N --out DIR [--overlap F] [--seed N] [--records-per-block N]',
  '       node scripts/compact/measure.mjs free --dir DIR',
  '       node scripts/compact/measure.mjs result --inputs FILE --plan FILE --out-dir DIR --count-time FILE --write-time FILE --free-before N --free-after N',
].join('\n');
const VERBS = Object.freeze({
  inputs: ['dataset', 'inputs', 'rows', 'out', 'overlap', 'seed', 'records-per-block'],
  free: ['dir'],
  result: ['inputs', 'plan', 'out-dir', 'count-time', 'write-time', 'free-before', 'free-after'],
});
const NEEDED = Object.freeze({
  inputs: ['dataset', 'inputs', 'rows', 'out'],
  free: ['dir'],
  result: VERBS.result,
});

export class UsageError extends Error {}
export class Fault extends Error {}

function whole(v, name, min, max) {
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min || Number(v) > max)
    throw new UsageError(`--${name} is ${JSON.stringify(v)}, not a whole number of ${min} to ${max}`);
  return Number(v);
}

function parse(argv) {
  const a = parseArgs(argv);
  const verb = a._[0];
  if (!Object.hasOwn(VERBS, verb ?? '')) throw new UsageError(`the first word is ${JSON.stringify(verb ?? null)}, not inputs, free or result`);
  if (a._.length > 1) throw new UsageError(`${JSON.stringify(a._[1])} is not a flag`);
  for (const k of Object.keys(a)) if (k !== '_' && !VERBS[verb].includes(k)) throw new UsageError(`--${k} is not a flag of ${verb}`);
  for (const k of VERBS[verb]) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  for (const k of NEEDED[verb]) if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  return { verb, a };
}

// ---------------------------------------------------------------- the keys

// A 32-bit mix of a whole number (two rounds of xorshift-multiply).
const mix = (x) => {
  let h = Math.imul((x >>> 0) ^ (x >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
};
// The hash of index i under a seed; i may pass 2^32.
const hashOf = (i, seed) => mix((i % 0x1_0000_0000) ^ mix(Math.floor(i / 0x1_0000_0000) + seed * 0x9e3779b1));

// The key of index i: a reversed name for names and new-name, a reversed
// registrable domain for domains and feed. The digits of i come first, so the
// keys ascend by i.
export function keyOf(dataset, i, seed = 1) {
  const n = String(i).padStart(WIDTH, '0');
  const label = hashOf(i, seed).toString(36).padStart(7, '0').slice(-6);
  return dataset === 'domains' || dataset === 'feed' ? `com.m${n}${label}` : `com.m${n}.${label}`;
}

// Whether the index i of input j - 1 is also in input j.
const sharedOf = (i, seed, overlap) => overlap > 0 && hashOf(i, seed + 1) / 0x1_0000_0000 < overlap;

// The indexes of input j of k, ascending: its own, and the shared ones of input j - 1.
export function* indexesOf(j, k, rows, overlap, seed) {
  const prev = (j + k - 1) % k;
  for (let b = 0; b < rows; b += 1) {
    const own = b * k + j;
    const borrowed = b * k + prev;
    const takes = sharedOf(borrowed, seed, overlap);
    if (takes && borrowed < own) yield borrowed;
    yield own;
    if (takes && borrowed > own) yield borrowed;
  }
}

// The records of input j, from the span start `startMs` of `stepMs`.
function* recordsOf(dataset, j, k, rows, overlap, seed, startMs, stepMs) {
  const day = Math.floor((startMs - EPOCH_MS) / DAY_MS);
  const t0 = Math.floor((startMs - EPOCH_MS) / 1000);
  const spanS = stepMs / 1000;
  for (const i of indexesOf(j, k, rows, overlap, seed)) {
    const key = keyOf(dataset, i, seed);
    if (dataset === 'names') yield { key, flags: 1, sources: [{ bit: j % 2, first: day, last: day }] };
    else if (dataset === 'domains') yield { key, flags: 0, sources: [{ bit: j % 2, first: day, last: day }], evidence: [] };
    else yield { key, flags: 0, firstSeen: t0 + (hashOf(i, seed + 2) % spanS), sources: [1], basis: 4, confidence: 0, feedFlags: 0 };
  }
}

const isoOf = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const shaOf = (bytes) => `sha256:${sha256Hex(bytes)}`;

// Writes input j into DIR/<tag>/ and returns what rootOf of fixture.mjs reads.
async function writeInput(dir, dataset, shape, j, k, rows, overlap, seed, recordsPerBlock) {
  const startMs = Date.parse(shape.start) + j * shape.stepMs;
  const span = { start: isoOf(startMs), end: isoOf(startMs + shape.stepMs) };
  const tag = tierTag(dataset, shape.slot, span.start);
  const at = join(dir, tag);
  mkdirSync(at, { recursive: true });
  const records = recordsOf(dataset, j, k, rows, overlap, seed, startMs, shape.stepMs);
  const keySink = new DirPartsSink(at, 'key');
  let summary;
  let time = null;
  try {
    if (FEEDS.includes(dataset)) {
      // A day pack of feed and new-name carries its time copy; an hour pack need not (TIME_COPY_TIERS of packages/root).
      const timeSink = shape.slot === 'h' ? null : new DirPartsSink(at, 'time');
      let pack;
      try {
        pack = await writeFeedPack(records, {
          codec: CODECS[dataset],
          compress: nodeCompress,
          sink: keySink,
          recordsPerBlock,
          ...(timeSink === null ? {} : { time: { sink: timeSink, recordsPerBlock } }),
        });
      } finally {
        await timeSink?.close();
      }
      summary = pack.summary;
      if (timeSink !== null) {
        writeFileSync(join(at, TIME_IDX_TITLE), pack.time.idx);
        const parts = [];
        for (const f of timeSink.files) parts.push(await fileDigest(f));
        time = { idxBytes: pack.time.idx, parts, idx: { digest: shaOf(pack.time.idx), size: pack.time.idx.length } };
      }
    } else {
      summary = await writePack(records, { codec: CODECS[dataset], compress: nodeCompress, sink: keySink, recordsPerBlock });
    }
  } finally {
    await keySink.close();
  }
  writeFileSync(join(at, IDX_TITLE), summary.idx);
  const parts = [];
  for (const f of keySink.files) parts.push(await fileDigest(f));
  const manifest = packManifest({
    dataset,
    tier: shape.slot,
    span,
    tag,
    sources: SOURCES,
    psl: PSL,
    run: '1',
    summary,
    writer: writerId(),
    parts,
    idx: { digest: shaOf(summary.idx), size: summary.idx.length },
    time,
  });
  const bytes = parts.reduce((n, p) => n + p.size, 0) + summary.idx.length + (time === null ? 0 : time.parts.reduce((n, p) => n + p.size, 0) + time.idx.size);
  return { tag, manifest, summary, time, records: summary.records, bytes };
}

async function inputs(a, io) {
  const dataset = a.dataset;
  if (!Object.hasOwn(CODECS, dataset)) throw new UsageError(`--dataset is ${JSON.stringify(dataset)}, not one of ${Object.keys(CODECS).join(', ')}`);
  if (!Object.hasOwn(SHAPES, a.inputs)) throw new UsageError(`--inputs is ${JSON.stringify(a.inputs)}, not one of ${Object.keys(SHAPES).join(', ')}`);
  const k = Number(a.inputs);
  const rows = whole(a.rows, 'rows', 1, FEEDS.includes(dataset) ? MAX_FEED_ROWS : MAX_ROWS);
  let overlap = 0;
  if (a.overlap !== undefined) {
    overlap = Number(a.overlap);
    if (!/^(?:0|1|0?\.[0-9]+)$/.test(a.overlap) || !(overlap >= 0 && overlap <= 1)) throw new UsageError(`--overlap is ${JSON.stringify(a.overlap)}, not a number of 0 to 1`);
  }
  const seed = a.seed === undefined ? 1 : whole(a.seed, 'seed', 0, 0xffff_ffff);
  const recordsPerBlock = a['records-per-block'] === undefined ? DEFAULT_RECORDS_PER_BLOCK : whole(a['records-per-block'], 'records-per-block', 1, 0xffff);
  if (existsSync(a.out) && readdirSync(a.out).length > 0) throw new UsageError(`--out ${a.out} is not empty: the inputs go into a new directory`);
  const shape = SHAPES[a.inputs];
  const inDir = join(a.out, 'in');
  mkdirSync(inDir, { recursive: true });
  const written = [];
  for (let j = 0; j < k; j += 1) written.push(await writeInput(inDir, dataset, shape, j, k, rows, overlap, seed, recordsPerBlock));
  const root = await rootOf(dataset, written);
  writeFileSync(join(a.out, 'root.json'), `${JSON.stringify(root)}\n`);
  const file = {
    format: INPUTS_FORMAT,
    dataset,
    tier: shape.tier,
    span: shape.start,
    inputs: k,
    rows,
    overlap,
    seed,
    records_per_block: recordsPerBlock,
    records: written.reduce((n, w) => n + w.records, 0),
    distinct: rows * k,
    bytes: written.reduce((n, w) => n + w.bytes, 0),
    time_copies: written.every((w) => w.time !== null),
    tags: written.map((w) => w.tag),
  };
  writeFileSync(join(a.out, 'inputs.json'), `${JSON.stringify(file)}\n`);
  io.out(
    `inputs ${dataset} ${k} packs of tier ${shape.slot} for the ${shape.tier} unit from ${shape.start}: ${file.records} records, ${file.distinct} distinct, ${file.bytes} B${file.time_copies ? ', with time copies' : ''}`,
  );
}

// ---------------------------------------------------------------- free

export function freeBytes(dir) {
  let s;
  try {
    s = statfsSync(dir, { bigint: true });
  } catch (e) {
    throw new UsageError(`--dir ${dir} does not read: ${e.message}`);
  }
  const free = s.bavail * s.bsize;
  if (free > BigInt(Number.MAX_SAFE_INTEGER)) throw new Fault(`${dir}: ${free} B free is past a safe whole number`);
  return Number(free);
}

// ---------------------------------------------------------------- result

// Seconds from GNU time's `h:mm:ss` or `m:ss.ss`.
export function elapsedSeconds(text) {
  const m = /^(?:([0-9]+):)?([0-9]+):([0-9]+(?:\.[0-9]+)?)$/.exec(text);
  if (m === null) throw new Fault(`the elapsed time ${JSON.stringify(text)} is not h:mm:ss or m:ss.ss`);
  return Math.round(((m[1] === undefined ? 0 : Number(m[1]) * 3600) + Number(m[2]) * 60 + Number(m[3])) * 100) / 100;
}

// The fields of one `/usr/bin/time -v -o FILE` output. Each label must be
// there once, and the timed command must have exited 0: a measurement of a
// merge that failed is no measurement.
export function parseTime(text, what) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const value = (label) => {
    const found = lines.filter((l) => l.startsWith(`${label}: `));
    if (found.length !== 1) throw new Fault(`the ${what} time output holds ${found.length === 0 ? 'no' : found.length} line(s) of ${JSON.stringify(label)}: it is not the output of /usr/bin/time -v`);
    return found[0].slice(label.length + 2).trim();
  };
  const number = (label) => {
    const v = value(label);
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(v)) throw new Fault(`the ${what} time output gives ${JSON.stringify(label)} as ${JSON.stringify(v)}, not a number`);
    return Number(v);
  };
  const exit = number(TIME_FIELDS.exit);
  if (exit !== 0) throw new Fault(`the ${what} stage exited ${exit}: a merge that failed is no measurement`);
  const cpu = value(TIME_FIELDS.cpu_percent);
  return {
    wall_s: elapsedSeconds(value(TIME_FIELDS.wall)),
    user_s: number(TIME_FIELDS.user_s),
    sys_s: number(TIME_FIELDS.sys_s),
    // GNU time prints `?%` when the elapsed time rounds to zero.
    cpu_percent: /^[0-9]+%$/.test(cpu) ? Number(cpu.slice(0, -1)) : null,
    max_rss_kib: number(TIME_FIELDS.max_rss_kib),
    exit,
  };
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`${what} ${path} does not read: ${e.message}`);
  }
}

function readJson(path, what) {
  const text = readText(path, what);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what} ${path} is not JSON: ${e.message}`);
  }
}

export function result(a, now = new Date()) {
  const inputsFile = readJson(a.inputs, '--inputs');
  if (inputsFile?.format !== INPUTS_FORMAT) throw new UsageError(`--inputs ${a.inputs} is not ${INPUTS_FORMAT}`);
  const plan = checkPlanFile(readJson(a.plan, '--plan'));
  if (plan.verdict !== 'ready') throw new Fault(`the plan's verdict is ${plan.verdict}: no merge ran`);
  const freeBefore = whole(a['free-before'], 'free-before', 0, Number.MAX_SAFE_INTEGER);
  const freeAfter = whole(a['free-after'], 'free-after', 0, Number.MAX_SAFE_INTEGER);
  const count = parseTime(readText(a['count-time'], '--count-time'), 'count');
  const write = parseTime(readText(a['write-time'], '--write-time'), 'write');
  if (!existsSync(a['out-dir'])) throw new UsageError(`--out-dir ${a['out-dir']} does not exist`);
  const names = readdirSync(a['out-dir']).sort();
  const ranges = names.filter((n) => /^range\.key\.[0-9]{3}\.json$/.test(n)).map((n) => readJson(join(a['out-dir'], n), 'the range file'));
  if (ranges.length === 0) throw new Fault(`--out-dir ${a['out-dir']} holds no range.key.NNN.json: the write stage wrote nothing`);
  for (const r of ranges) if (r.plan !== plan.id) throw new Fault(`range ${r.range} is of the plan ${r.plan}, not ${plan.id}`);
  const records = ranges.reduce((n, r) => n + r.records, 0);
  // The merge of one range of a one-range plan holds every distinct key of the inputs.
  if (plan.key.ranges === 1 && records !== inputsFile.distinct) throw new Fault(`the merge wrote ${records} records; the inputs hold ${inputsFile.distinct} distinct keys`);
  const timeRanges = names.filter((n) => /^range\.time\.[0-9]{3}\.json$/.test(n)).map((n) => readJson(join(a['out-dir'], n), 'the range file'));
  return {
    format: RESULT_FORMAT,
    at: now.toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
    run: process.env.GITHUB_RUN_ID ?? null,
    dataset: plan.dataset,
    tier: plan.tier,
    span: plan.span,
    inputs: inputsFile.inputs,
    rows_per_input: inputsFile.rows,
    overlap: inputsFile.overlap,
    input_records: inputsFile.records,
    distinct: inputsFile.distinct,
    input_bytes: inputsFile.bytes,
    ranges: plan.key.ranges,
    time_copy: plan.time === null ? null : timeRanges.length > 0 ? 'merged' : 'left to assemble.mjs',
    output: {
      records,
      part_bytes: ranges.reduce((n, r) => n + r.size, 0),
      idx_bytes: ranges.reduce((n, r) => n + (r.idx?.size ?? 0), 0),
      time_part_bytes: timeRanges.reduce((n, r) => n + r.size, 0),
    },
    count,
    write,
    disk: { free_before_bytes: freeBefore, free_after_bytes: freeAfter, used_bytes: freeBefore - freeAfter },
    runner: { cpus: cpus().length, mem_bytes: totalmem(), node: process.version },
  };
}

// An error this script does not know is a defect, exit 70: never 1 or 2.
export async function main(argv, deps = {}) {
  try {
    return await run(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`measure: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function run(argv, { out = console.log, err = console.error, now }) {
  try {
    const { verb, a } = parse(argv);
    if (verb === 'inputs') await inputs(a, { out });
    else if (verb === 'free') out(String(freeBytes(a.dir)));
    else out(JSON.stringify(result(a, now)));
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`measure: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof Fault) {
      err(`measure: FAIL ${e.message}`);
      return EXIT.fault;
    }
    if (e instanceof CompactError) {
      err(`measure: FAIL ${e.code} ${e.message}`);
      return e.code === 'usage' ? EXIT.usage : EXIT.fault;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
