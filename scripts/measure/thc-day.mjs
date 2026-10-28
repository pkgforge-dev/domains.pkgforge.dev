// scripts/measure/thc-day.mjs — one THC daily dump through the whole job on one
// machine, timed by stage, and the verdict over a run's result (DOM-009,
// TODO/ingest.md). It grew from design A's thc-day.mjs
// (docs/research/2026-10-27-design-a/scripts/thc-day.mjs).
//
// The stages, each run alone so that its seconds and its peak resident memory
// are its own:
//   download   the day's file from cs2.ip.thc.org or the Hugging Face bucket, to
//              disk; its size must equal the listing's and the Content-Length
//   normalise  gunzip, lowercase, strip `*.` into a flag, reverse the labels
//              (revlabel.mjs); the raw-line counts of thcstat.mjs
//   sort       `LC_ALL=C sort -u` of the records (GNU sort)
//   split      the registrable domain and the site of every name (regdoms.mjs,
//              psl.mjs), names a domain (groups.mjs), and the sampled hash
//              files of the names and the domains (f64cmp.mjs)
//   encode     4,096 names a block, front coded, deflate-raw (blockenc.mjs)
//   verify     decode every block and compare it with the sorted records
// A stage that is not GNU sort runs as a child process of this script, which
// reports its own peak resident memory; sort's comes from GNU time when the
// machine has /usr/bin/time, and is null otherwise.
//
// The stages run one after another from disk, so the sum of their seconds is an
// upper bound of a job that streams the download into the normaliser. The
// reversal happens before the one sort, so the sorted file is already in key
// order (design B sorted twice: names, then reversed names).
//
// Each run writes DAY.stat.json (format domains.measure.thc-day.v1), DAY.names.f64
// and DAY.regs.f64 into --out. thc-union.mjs merges the days of a run into
// result.json, and --verdict reads that.
//
// Usage:
//   node scripts/measure/thc-day.mjs --day DAY --psl FILE --work DIR --out DIR
//        (--path HF_PATH --size BYTES [--prefer cs2|hf] | --input FILE.txt.gz)
//        [--sample-bits 4] [--per-block 4096] [--sort-buffer 50%] [--sort sort] [--keep]
//   node scripts/measure/thc-day.mjs --verdict RESULT.json
//   node scripts/measure/thc-day.mjs --stage normalise|split|encode|verify ...   (one stage; the run starts these)
// Exit codes, a run: 0 measured and verified; 1 a stage failed (no source served
//   the file, a gzip stream that does not check, a pack that does not verify);
//   2 could not run (a flag, the list, sort is not GNU sort).
// Exit codes, --verdict: 0 PASS; 1 FAIL; 2 the result cannot be read.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { BlockError, verifyPack, writePack } from './blockenc.mjs';
import { F64Error, writeF64 } from './f64cmp.mjs';
import { groupHistogram } from './groups.mjs';
import { loadPsl, PslError } from './psl.mjs';
import { createSplitter } from './regdoms.mjs';
import { normaliseFile, RecordError, readRecords } from './revlabel.mjs';
import { cs2Url, hfUrl, isDay } from './thc-list.mjs';

export const STAT_FORMAT = 'domains.measure.thc-day.v1';
export const RESULT_FORMAT = 'domains.measure.thc.v1';
export const STAGES = ['download', 'normalise', 'sort', 'split', 'encode', 'verify'];
// The pass rule of DOM-009: one day under 30 minutes of wall time on a runner.
export const PASS_SECONDS = 30 * 60;

const SCRIPT = fileURLToPath(import.meta.url);

export class StageError extends Error {
  constructor(stage, message) {
    super(`${stage}: ${message}`);
    this.name = 'StageError';
    this.stage = stage;
  }
}

const secs = (t0) => +((performance.now() - t0) / 1000).toFixed(3);

// The stages of one day agree: split read the list the run read (by its
// sha256), and each later stage in `counted` ({encode, verify}) counted the
// names split counted. Throws a StageError naming the stage that disagrees.
export function checkAgreement({ runPsl, splitPsl, names, counted = {} }) {
  if (typeof runPsl !== 'string' || splitPsl !== runPsl) throw new StageError('split', 'read another list than the run');
  if (!Number.isSafeInteger(names)) throw new StageError('split', `counted ${names} names`);
  const off = Object.entries(counted).filter(([, n]) => n !== names);
  if (off.length)
    throw new StageError(
      'verify',
      `split counted ${names} names, ${Object.entries(counted)
        .map(([stage, n]) => `${stage} ${n}`)
        .join(', ')}`,
    );
}

// Downloads the first source that serves the whole file. Each source is tried
// once; a status other than 200, a size other than the listing's or the
// Content-Length, or a broken stream fails that attempt and the next is tried.
// Returns { ok, source, bytes, seconds, mb_per_s, final_host, attempts }.
export async function download({ sources, dest, size = null, timeoutMs = 30 * 60 * 1000 }) {
  const attempts = [];
  for (const { source, url } of sources) {
    const t0 = performance.now();
    const attempt = { source, url_host: new URL(url).host };
    attempts.push(attempt);
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(timeoutMs) });
      attempt.status = res.status;
      attempt.final_host = new URL(res.url).host;
      if (res.status !== 200 || res.body === null) {
        await res.body?.cancel();
        attempt.seconds = secs(t0);
        continue;
      }
      const declared = res.headers.get('content-length');
      attempt.declared_bytes = declared === null ? null : Number(declared);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      attempt.bytes = statSync(dest).size;
      attempt.seconds = secs(t0);
      attempt.mb_per_s = +(attempt.bytes / 1e6 / Math.max(attempt.seconds, 0.001)).toFixed(2);
      const sizeOk = (size === null || attempt.bytes === size) && (attempt.declared_bytes === null || attempt.bytes === attempt.declared_bytes);
      if (!sizeOk) {
        attempt.error = `got ${attempt.bytes} B, the listing says ${size} and Content-Length ${attempt.declared_bytes}`;
        continue;
      }
      return { ok: true, source, bytes: attempt.bytes, seconds: attempt.seconds, mb_per_s: attempt.mb_per_s, final_host: attempt.final_host, attempts };
    } catch (err) {
      attempt.seconds = secs(t0);
      attempt.error = err.message;
    }
  }
  return { ok: false, attempts };
}

// --- the stages a child process runs -------------------------------------

async function stageNormalise(a) {
  return normaliseFile(a.input, a.out, { gzip: true });
}

async function stageSplit(a) {
  const psl = loadPsl(a.psl);
  const splitter = createSplitter(psl, { capacity: Number(a.capacity) || 1 << 20, sampleBits: Number(a['sample-bits']) });
  const read = await readRecords(a.input, (key, flags) => splitter.add(key, flags));
  const { sortedRegs, named, nameSample, regSample, ...counts } = splitter.finish();
  const groups = groupHistogram(sortedRegs, named);
  const files = { names: { file: `${a.day}.names.f64`, count: nameSample.length }, regs: { file: `${a.day}.regs.f64`, count: regSample.length } };
  writeF64(join(a['out-dir'], files.names.file), nameSample);
  writeF64(join(a['out-dir'], files.regs.file), regSample);
  return { sorted_lines: read.lines, psl_sha256: psl.sha256, ...counts, groups, files };
}

async function stageEncode(a) {
  return writePack(a.input, a.pack, { perBlock: Number(a['per-block']) });
}

async function stageVerify(a) {
  return verifyPack(a.pack, a.input);
}

const STAGE_FNS = { normalise: stageNormalise, split: stageSplit, encode: stageEncode, verify: stageVerify };

async function childMain(args) {
  const fn = STAGE_FNS[args.stage];
  if (!fn) {
    console.error(`thc-day: no stage ${args.stage}`);
    return 2;
  }
  try {
    const result = await fn(args);
    const ru = process.resourceUsage();
    console.log(JSON.stringify({ result, peak_rss_kib: ru.maxRSS, cpu_user_s: +(ru.userCPUTime / 1e6).toFixed(3), cpu_system_s: +(ru.systemCPUTime / 1e6).toFixed(3) }));
    return 0;
  } catch (err) {
    console.error(`thc-day: stage ${args.stage}: ${err.message}`);
    return err instanceof RecordError || err instanceof BlockError || err instanceof PslError || err instanceof F64Error || err.code === 'Z_BUF_ERROR' || err.code === 'Z_DATA_ERROR' ? 1 : 2;
  }
}

// --- the run ---------------------------------------------------------------

function runChild(stage, args) {
  const argv = [SCRIPT, '--stage', stage];
  for (const [k, v] of Object.entries(args)) argv.push(`--${k}`, String(v));
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => {
      out += s;
    });
    child.on('error', (err) => fail(new StageError(stage, err.message)));
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new StageError(stage, `exited ${code}`));
        return;
      }
      const last = out.trim().split('\n').pop();
      try {
        ok(JSON.parse(last));
      } catch {
        fail(new StageError(stage, 'printed no result'));
      }
    });
  });
}

// The first line of `sort --version`, or null when it is not GNU sort.
export function gnuSortVersion(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const first = r.stdout.split('\n')[0];
  return /GNU coreutils/.test(first) ? first : null;
}

function runSort({ cmd, input, output, tmp, buffer }) {
  const sortArgs = ['-u', '-S', buffer, `--parallel=${Math.max(1, cpus().length)}`, '-T', tmp, '-o', output, input];
  const timeFile = join(tmp, 'sort.time');
  const gnuTime = existsSync('/usr/bin/time');
  const [exe, argv] = gnuTime ? ['/usr/bin/time', ['-f', '%M %U %S', '-o', timeFile, cmd, ...sortArgs]] : [cmd, sortArgs];
  return new Promise((ok, fail) => {
    const child = spawn(exe, argv, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, LC_ALL: 'C' } });
    child.on('error', (err) => fail(new StageError('sort', err.message)));
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new StageError('sort', `exited ${code}`));
        return;
      }
      if (!gnuTime) {
        ok({ peak_rss_kib: null, rss_source: 'none: no /usr/bin/time' });
        return;
      }
      const [rss, user, sys] = readFileSync(timeFile, 'utf8').trim().split('\n').pop().split(' ').map(Number);
      ok({ peak_rss_kib: rss, cpu_user_s: user, cpu_system_s: sys, rss_source: 'GNU time' });
    });
  });
}

function freeBytes(dir) {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

function runnerInfo(sortVersion) {
  const cpu = cpus();
  return {
    os: process.env.RUNNER_OS ?? null,
    arch: process.env.RUNNER_ARCH ?? null,
    image: process.env.ImageOS ?? null,
    image_version: process.env.ImageVersion ?? null,
    platform: process.platform,
    cpus: cpu.length,
    cpu_model: cpu[0]?.model ?? null,
    mem_bytes: totalmem(),
    node: process.version,
    sort: sortVersion,
  };
}

function settingsOf(args) {
  const sampleBits = args['sample-bits'] === undefined ? 4 : Number(args['sample-bits']);
  const perBlock = args['per-block'] === undefined ? 4096 : Number(args['per-block']);
  const prefer = args.prefer ?? 'cs2';
  if (!Number.isInteger(sampleBits) || sampleBits < 0 || sampleBits > 20) throw new Error(`--sample-bits ${args['sample-bits']}`);
  if (!Number.isInteger(perBlock) || perBlock < 1) throw new Error(`--per-block ${args['per-block']}`);
  if (prefer !== 'cs2' && prefer !== 'hf') throw new Error(`--prefer is cs2 or hf, got ${prefer}`);
  return { sample_bits: sampleBits, per_block: perBlock, level: 9, sort_buffer: args['sort-buffer'] ?? '50%', prefer };
}

export async function measure(args) {
  const started = new Date();
  const t0 = performance.now();
  const day = args.day;
  if (!isDay(day)) throw new Error(`--day ${day} is not a date`);
  for (const k of ['psl', 'work', 'out']) if (typeof args[k] !== 'string') throw new Error(`--${k} is required`);
  if (typeof args.input !== 'string' && (typeof args.path !== 'string' || !(Number(args.size) > 0))) throw new Error('give --path and --size, or --input');
  const settings = settingsOf(args);
  const sortCmd = typeof args.sort === 'string' ? args.sort : 'sort';
  const sortVersion = gnuSortVersion(sortCmd);
  if (sortVersion === null) throw new Error(`${sortCmd} is not GNU sort`);
  const psl = loadPsl(args.psl);
  const work = resolve(args.work);
  const outDir = resolve(args.out);
  const tmp = join(work, 'sort-tmp');
  mkdirSync(tmp, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const keep = args.keep === true;
  const stat = {
    format: STAT_FORMAT,
    day,
    started: started.toISOString(),
    runner: runnerInfo(sortVersion),
    settings,
    psl: { sha256: psl.sha256, rules: psl.rules },
    stages: {},
    disk: { work_free_bytes_start: freeBytes(work), work_free_bytes_min: freeBytes(work) },
  };
  const disk = () => {
    stat.disk.work_free_bytes_min = Math.min(stat.disk.work_free_bytes_min, freeBytes(work));
  };
  const timed = async (name, fn) => {
    const t = performance.now();
    disk();
    const r = await fn();
    disk();
    stat.stages[name] = { seconds: secs(t), ...(r.stage ?? {}) };
    return r;
  };
  const gz = typeof args.input === 'string' ? resolve(args.input) : join(work, `${day}.txt.gz`);
  const norm = join(work, `${day}.records`);
  const sorted = join(work, `${day}.sorted`);
  const pack = join(work, `${day}.pack`);
  const fail = (err) => {
    stat.failed = { stage: err.stage ?? null, error: err.message };
    writeFileSync(join(outDir, `${day}.failed.json`), JSON.stringify(stat, null, 1) + '\n');
    return err;
  };
  try {
    if (typeof args.input === 'string') {
      stat.download = { input: basename(gz) };
      stat.stages.download = { seconds: 0, skipped: 'local input' };
    } else {
      const size = Number(args.size);
      const hf = { source: 'hf', url: hfUrl(args.path) };
      const cs2 = { source: 'cs2', url: cs2Url(day) };
      const sources = settings.prefer === 'hf' ? [hf, cs2] : [cs2, hf];
      const d = await timed('download', async () => {
        const r = await download({ sources, dest: gz, size });
        return { ...r, stage: { source: r.source ?? null } };
      });
      const { stage: _d, ...rest } = d;
      stat.download = { listing_bytes: size, ...rest };
      if (!d.ok) throw new StageError('download', 'no source served the whole file');
    }
    stat.gz_bytes = statSync(gz).size;
    const n = await timed('normalise', async () => {
      const r = await runChild('normalise', { input: gz, out: norm });
      return { ...r.result, stage: { peak_rss_kib: r.peak_rss_kib, cpu_user_s: r.cpu_user_s, cpu_system_s: r.cpu_system_s } };
    });
    const { stage: _n, ...normalised } = n;
    stat.normalise = normalised;
    stat.disk.records_bytes = statSync(norm).size;
    if (!keep && typeof args.input !== 'string') rmSync(gz);
    await timed('sort', async () => ({ stage: await runSort({ cmd: sortCmd, input: norm, output: sorted, tmp, buffer: settings.sort_buffer }) }));
    stat.disk.sorted_bytes = statSync(sorted).size;
    if (!keep) rmSync(norm);
    const s = await timed('split', async () => {
      const r = await runChild('split', { input: sorted, psl: args.psl, 'out-dir': outDir, day, 'sample-bits': settings.sample_bits, capacity: normalised.records_written });
      return { ...r.result, stage: { peak_rss_kib: r.peak_rss_kib, cpu_user_s: r.cpu_user_s, cpu_system_s: r.cpu_system_s } };
    });
    const { stage: _s, groups, files, top_suffixes, suffix_counts_selected, psl_sha256, ...counts } = s;
    checkAgreement({ runPsl: psl.sha256, splitPsl: psl_sha256, names: counts.names });
    const e = await timed('encode', async () => {
      const r = await runChild('encode', { input: sorted, pack, 'per-block': settings.per_block });
      return { ...r.result, stage: { peak_rss_kib: r.peak_rss_kib, cpu_user_s: r.cpu_user_s, cpu_system_s: r.cpu_system_s } };
    });
    const v = await timed('verify', async () => {
      const r = await runChild('verify', { input: sorted, pack });
      return { ...r.result, stage: { peak_rss_kib: r.peak_rss_kib, cpu_user_s: r.cpu_user_s, cpu_system_s: r.cpu_system_s } };
    });
    checkAgreement({ runPsl: psl.sha256, splitPsl: psl_sha256, names: counts.names, counted: { encode: e.records, verify: v.records } });
    if (!keep) {
      rmSync(sorted);
      rmSync(pack);
      rmSync(pack + '.idx.json');
    }
    stat.counts = { gz_bytes: stat.gz_bytes, text_bytes: normalised.text_bytes, lines: normalised.raw.lines, ...counts };
    stat.groups = groups;
    stat.suffixes = { top_suffixes, suffix_counts_selected };
    stat.pack = {
      per_block: settings.per_block,
      codec: 'deflate-raw',
      level: settings.level,
      blocks: e.blocks,
      pack_bytes: e.pack_bytes,
      front_bytes: e.front_bytes,
      index_bytes: e.index_bytes,
      bytes_per_name: counts.names === 0 ? 0 : +(e.pack_bytes / counts.names).toFixed(3),
    };
    stat.verify = { ok: true, records: v.records, blocks: v.blocks };
    stat.files = { hash: 'h53 of the reversed key (f64cmp.mjs)', sample_bits: settings.sample_bits, names: files.names, regs: files.regs };
    stat.peak_rss_kib = Math.max(...Object.values(stat.stages).map((x) => x.peak_rss_kib ?? 0), process.resourceUsage().maxRSS);
    stat.finished = new Date().toISOString();
    stat.wall_seconds = secs(t0);
  } catch (err) {
    throw fail(err);
  }
  writeFileSync(join(outDir, `${day}.stat.json`), JSON.stringify(stat, null, 1) + '\n');
  return stat;
}

// --- the verdict -----------------------------------------------------------

const mib = (kib) => (kib === null || kib === undefined ? 'n/a' : `${Math.round(kib / 1024)}MiB`);

// The lines to print and the pass rule over a result.json of thc-union.mjs.
export function verdict(result) {
  if (result?.format !== RESULT_FORMAT) throw new Error(`format is ${result?.format}, not ${RESULT_FORMAT}`);
  if (!Array.isArray(result.per_day) || result.per_day.length === 0) throw new Error('the result holds no day');
  const lines = [];
  const reasons = [];
  for (const d of result.per_day) {
    const st = STAGES.map((s) => `${s}=${d.stages?.[s] ?? 'n/a'}s`).join(' ');
    lines.push(`${d.day} wall=${d.wall_seconds}s ${st} peak_rss=${mib(d.peak_rss_kib)} names=${d.distinct_names} bytes/name=${d.bytes_per_name} source=${d.source}`);
    if (!d.runner_os) reasons.push(`${d.day} was not measured on a runner`);
    if (d.verified !== true) reasons.push(`${d.day} did not verify`);
    if (!(d.wall_seconds < PASS_SECONDS)) reasons.push(`${d.day} took ${d.wall_seconds}s, not under ${PASS_SECONDS}s`);
  }
  const n = result.span?.days;
  lines.push(
    `union days=${n} first=${result.span?.first} last=${result.span?.last} gaps=${(result.span?.gaps ?? []).join(',') || 'none'} distinct_names_${n}d=${result[`distinct_names_${n}d`]} distinct_registrable_${n}d=${result[`distinct_registrable_${n}d`]} bytes_per_name=${result.bytes_per_name}`,
  );
  if (result.slowest_day) lines.push(`slowest ${result.slowest_day.day} ${result.slowest_day.wall_seconds}s`);
  for (const p of result.novelty_curve ?? []) lines.push(`novelty ${p.day} new_names=${p.share_new_names} in_previous=${p.share_names_in_previous_day} new_registrable=${p.share_new_registrable}`);
  return { pass: reasons.length === 0, lines, reasons };
}

function verdictMain(path) {
  let v;
  try {
    v = verdict(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    console.error(`thc-day: ${path}: ${err.message}`);
    return 2;
  }
  for (const line of v.lines) console.log(line);
  console.log(v.pass ? 'PASS' : `FAIL ${v.reasons.join('; ')}`);
  return v.pass ? 0 : 1;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (typeof args.stage === 'string') return childMain(args);
  if (typeof args.verdict === 'string') return verdictMain(args.verdict);
  try {
    const stat = await measure(args);
    const st = STAGES.map((s) => `${s}=${stat.stages[s].seconds}s`).join(' ');
    console.log(
      `${stat.day} wall=${stat.wall_seconds}s ${st} peak_rss=${mib(stat.peak_rss_kib)} names=${stat.counts.names} registrable=${stat.counts.distinct_registrable_icann} pack=${stat.pack.pack_bytes}B bytes/name=${stat.pack.bytes_per_name}`,
    );
    return 0;
  } catch (err) {
    console.error(`thc-day: ${err.message}`);
    return err instanceof StageError ? 1 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
