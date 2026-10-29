// scripts/verify-pack.mjs — verify a pack before it counts (DOM-018,
// docs/architecture.md section 5.8), with verifyPack of
// packages/pack/src/verify.ts: the one verifier. The pack is local files, or
// a manifest in GHCR read with no credential (--repo PACKAGE --tag TAG,
// DOM-020): its layers part.NNN and idx are read by range through
// packages/ghcr's reader, and its annotations are the expectation. Both forms
// read through one ranged reader, readRanged: a file by its handle, a blob by
// readRange through its signed URL, in chunks of at most RANGE_MAX_BYTES.
//
// Each PATH is a part (a file name ending `part.NNN`: part.000, clean.part.000),
// the index (a name ending `idx`: idx, clean.idx), a layer of the time copy (a
// name ending `time.part.NNN` or `time.idx`, docs/format.md section 14), or a
// directory, whose files of those names are taken. One index and the parts 0
// to n-1 make a pack; one time.idx and the time parts 0 to n-1 make its time
// copy. A part the index names past the last one given fails the length check;
// a part given twice, a gap in the part numbers, a second index or none, time
// parts with no time.idx or a time.idx with no time part is a usage error. Each
// file is read by range through its own handle, never whole.
//
// The expectation is the manifest's annotations, --annotations FILE (a JSON
// object of strings, read by expectFromAnnotations), and the --expect-* flags,
// which override them. A check with nothing to compare against prints SKIP and
// why; it neither passes nor fails. So a run with no annotation, no --expect-*
// flag, no --source and no --history skips dataset, length, count, sha256, psl,
// sources, precision and volume, and is ok. A pack of no record also skips
// inflate, crc, record, order, unique, name and refind. --require names the
// checks that must not skip, and one of them that skipped makes the verdict
// unverified and exits 1. The job that writes a pack runs this before it calls
// the promotion (docs/architecture.md section 4.7, rule 2) and passes the
// checks it needs compared, such as --require dataset,length,count,sha256,psl.
//
// The names are checked against the pinned Public Suffix List: --psl FILE,
// by default the copy of the names package's tests,
// packages/names/test/fixtures/psl-2026-10-27.dat, as
// packages/names/bin/split.mjs reads it (DOM-019 is to hold the live copy in
// its ref package). When the pack names its sources (--source, or the source
// annotation), they are checked against the registry: --sources FILE, by
// default config/sources.json, validated with config/source-bits.json by
// @domains/adapter. --history FILE runs the volume check: checkBand of
// @domains/adapter, with the band and precision of the one source's registry
// row, on the count the verifier decoded, or on --raw-bytes when the band
// measures the bytes of the raw file.
//
// The GHCR form takes no PATH and no --annotations: the manifest's own
// annotations are the expectation, and the sizes of its layers are the bytes
// each part holds as stored. Its artifact type is pack or segment, its part
// layers are titled part.000 up in order, and it has one idx. Its time copy,
// when it carries one, is the layers time.idx and time.part.000 up in order;
// other layers (summary.json, raw, txt.gz) are not read.
//
// The time check (CHECK time) holds the time copy to its key copy: SKIP when
// no time copy is given, so the job that writes a feed or new-name pack of a
// tier that carries one names it: --require time.
//
// Usage:
//   node scripts/verify-pack.mjs [flags] PATH...
//   node scripts/verify-pack.mjs [flags] --repo PACKAGE --tag TAG
//     --repo PACKAGE --tag TAG   a pack of ghcr.io/pkgforge-dev/domains.pkgforge.dev/PACKAGE, read anonymously
//     --annotations FILE   the manifest's annotations
//     --expect-count N  --expect-bytes N  --expect-sha256 HEX  --expect-dataset NAME  --expect-psl HEX
//     --source IDS         the sources the records may carry, separated by commas
//     --span START,END     the pack's window, ISO 8601 UTC to the second
//     --psl FILE  --sources FILE  --history FILE  --raw-bytes N
//     --seed N             the seed of the re-find draw (default 1)
//     --now TIME           the clock that bounds the times when no span is given (default: this machine's)
//     --require CHECKS     the checks that must not skip, separated by commas (CHECKS of verify.ts)
//     --json               the result as one JSON object instead of lines
// stdout: one line a check, `PASS CHECK DETAIL`, `FAIL CHECK DETAIL` (one a
// failure) or `SKIP CHECK WHY`, then `VERDICT ok|fail|unverified|hold|quarantine
// (N skipped)`, which after `;` names the checks of --require that skipped. No
// line shows more than 80 bytes of a key (quoteKey of verify.ts).
// Exit codes: 0 no check failed and none of --require skipped · 1 a check
// failed, a hold or a quarantine of the volume check included, or a check of
// --require skipped · 2 could not run (usage, a file that cannot be read, a
// list, registry, annotation or history that does not validate, a read that
// fails, a GHCR manifest that is not a pack or does not read with no
// credential) · 70 an error this script does not know, a defect: never 1 or
// 2, which are verdicts and inputs; its stack goes to stderr.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BandError, ContractError, checkBand, JsonError, SourceError, validateBits, validateRegistry } from '@domains/adapter';
import { artifactType, checkRef, GhcrError, ghcrReader, LayoutError, MANIFEST_LIMIT_BYTES, memoryCache, RANGE_MAX_BYTES, REGISTRY_HOST, repoOf } from '@domains/ghcr';
import { loadPsl, PslError } from '@domains/names';
import { IDX_TITLE, PackError, partTitle, TIME_IDX_TITLE, timePartTitle } from '../packages/pack/src/index.ts';
import { CHECKS, expectFromAnnotations, verifyPack } from '../packages/pack/src/verify.ts';
import { ROOT } from './files.mjs';
import { RateLimitError, readPaused } from './ghcr/rate.mjs';
import { parseArgs } from './lib/args.mjs';
import { USER_AGENT } from './lib/user-agent.mjs';

export const DEFAULT_PSL = join(ROOT, 'packages', 'names', 'test', 'fixtures', 'psl-2026-10-27.dat');
export const DEFAULT_SOURCES = join(ROOT, 'config', 'sources.json');
export const BITS = join(ROOT, 'config', 'source-bits.json');

const VALUED = [
  'annotations',
  'expect-count',
  'expect-bytes',
  'expect-sha256',
  'expect-dataset',
  'expect-psl',
  'source',
  'span',
  'psl',
  'sources',
  'history',
  'raw-bytes',
  'seed',
  'now',
  'require',
  'repo',
  'tag',
];
const PACK_TYPES = [artifactType('pack'), artifactType('segment')];
const TITLE = 'org.opencontainers.image.title';
const FLAGS = [...VALUED, 'json'];
// Layer titles: part.000 and up, and idx (docs/format.md section 2), and the
// time copy's time.part.000 and up, and time.idx (section 14), with any prefix
// before a dot. The time copy's names are tried first: `time.idx` also ends in
// `idx`.
const PART_NAME = /(?:^|\.)part\.(\d{3,})$/;
const IDX_NAME = /(?:^|\.)idx$/;
const TIME_PART_NAME = /(?:^|\.)time\.part\.(\d{3,})$/;
const TIME_IDX_NAME = /(?:^|\.)time\.idx$/;
const TIME_PART_TITLE = /^time\.part\.\d{3,}$/;

export class UsageError extends Error {}

export function parseFlags(argv) {
  const a = parseArgs(argv);
  // parseArgs takes the word after a flag as its value; --json has none, so a
  // word after it is a PATH.
  if (typeof a.json === 'string') {
    a._.push(a.json);
    a.json = true;
  }
  for (const k of Object.keys(a)) if (k !== '_' && !FLAGS.includes(k)) throw new UsageError(`unknown flag --${k}`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  let ghcr = null;
  if (a.repo !== undefined || a.tag !== undefined) {
    if (a.repo === undefined || a.tag === undefined) throw new UsageError('--repo and --tag come together');
    if (a._.length > 0) throw new UsageError('the GHCR form (--repo, --tag) takes no PATH');
    if (a.annotations !== undefined) throw new UsageError("the GHCR form reads the manifest's own annotations; --annotations is for local files");
    ghcr = { pkg: a.repo, tag: a.tag };
  } else if (a._.length === 0) throw new UsageError('give the index and the parts of a pack, or --repo and --tag');
  const whole = (k) => {
    if (a[k] === undefined) return undefined;
    if (!/^\d{1,15}$/.test(a[k])) throw new UsageError(`--${k} must be a whole number`);
    return Number(a[k]);
  };
  let span;
  if (a.span !== undefined) {
    const [start, end, ...rest] = a.span.split(',');
    if (!start || !end || rest.length > 0) throw new UsageError('--span takes START,END');
    span = { start, end };
  }
  const require = a.require === undefined ? [] : a.require.split(',');
  for (const c of require) if (!CHECKS.includes(c)) throw new UsageError(`--require names ${JSON.stringify(c)}, which is not a check; the checks are ${CHECKS.join(', ')}`);
  return {
    paths: a._,
    ghcr,
    annotations: a.annotations ?? null,
    expect: {
      count: whole('expect-count'),
      bytes: whole('expect-bytes'),
      sha256: a['expect-sha256'],
      dataset: a['expect-dataset'],
      psl: a['expect-psl'],
      sources: a.source === undefined ? undefined : a.source.split(','),
      span,
    },
    psl: a.psl ?? DEFAULT_PSL,
    sources: a.sources ?? DEFAULT_SOURCES,
    history: a.history ?? null,
    rawBytes: whole('raw-bytes'),
    seed: whole('seed'),
    now: a.now ?? null,
    require,
    json: a.json === true,
  };
}

// The parts in order, 0 to n-1 with no gap.
function inOrder(parts, what) {
  const ordered = [];
  for (let n = 0; n < parts.size; n += 1) {
    if (!parts.has(n)) throw new UsageError(`${what} ${n} is not given, and ${what} ${Math.max(...parts.keys())} is`);
    ordered.push(parts.get(n));
  }
  return ordered;
}

// The index and the parts in order, from the PATHs, and the time copy's
// time.idx and time parts, or null when none is given.
export function packFiles(paths) {
  let idx = null;
  let timeIdx = null;
  const parts = new Map();
  const timeParts = new Map();
  const take = (path) => {
    const name = basename(path);
    const t = TIME_PART_NAME.exec(name);
    if (t !== null) {
      const n = Number(t[1]);
      if (timeParts.has(n)) throw new UsageError(`time part ${n} is given twice: ${timeParts.get(n)} and ${path}`);
      timeParts.set(n, path);
      return true;
    }
    if (TIME_IDX_NAME.test(name)) {
      if (timeIdx !== null) throw new UsageError(`two time indexes are given: ${timeIdx} and ${path}`);
      timeIdx = path;
      return true;
    }
    const m = PART_NAME.exec(name);
    if (m !== null) {
      const n = Number(m[1]);
      if (parts.has(n)) throw new UsageError(`part ${n} is given twice: ${parts.get(n)} and ${path}`);
      parts.set(n, path);
      return true;
    }
    if (IDX_NAME.test(name)) {
      if (idx !== null) throw new UsageError(`two indexes are given: ${idx} and ${path}`);
      idx = path;
      return true;
    }
    return false;
  };
  for (const path of paths) {
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      throw new UsageError(`cannot read ${path}: ${error.message}`);
    }
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) take(join(path, name));
    else if (!take(path)) throw new UsageError(`${path} is named neither as a part (part.NNN) nor as an index (idx), nor as a layer of a time copy (time.part.NNN, time.idx)`);
  }
  if (idx === null) throw new UsageError('no index is given: a file whose name ends in idx');
  if ((timeIdx === null) !== (timeParts.size === 0))
    throw new UsageError(
      timeIdx === null ? 'time parts are given with no time index: a file whose name ends in time.idx' : 'a time index is given with no time part: a file whose name ends in time.part.NNN',
    );
  return { idx, parts: inOrder(parts, 'part'), time: timeIdx === null ? null : { idx: timeIdx, parts: inOrder(timeParts, 'time part') } };
}

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`${what} ${path}: ${error.message}`);
  }
};

// The annotations (the file, or a GHCR manifest's own), then the --expect-* flags over them.
export function expectation(flags, annotations = null) {
  const given = annotations ?? (flags.annotations === null ? null : readJson(flags.annotations, 'the annotations'));
  const out = given === null ? {} : { ...expectFromAnnotations(given) };
  for (const [k, v] of Object.entries(flags.expect)) if (v !== undefined) out[k] = v;
  return out;
}

export function loadRegistry(path) {
  const bits = validateBits(readJson(BITS, 'the bit map'));
  return validateRegistry(readJson(path, 'the registry'), bits).sources;
}

// The volume rule of the one source the pack names, or undefined without --history.
export function volumeCheck(flags, expect, registry) {
  if (flags.history === null) {
    if (flags.rawBytes !== undefined) throw new UsageError('--raw-bytes needs --history');
    return undefined;
  }
  if (expect.sources === undefined || expect.sources.length !== 1) throw new UsageError('--history needs the pack to name exactly one source');
  const id = expect.sources[0];
  const row = registry.find((r) => r.id === id);
  if (row === undefined) throw new UsageError(`--history: the source ${id} is not in the registry`);
  let value;
  if (row.band.metric === 'bytes') {
    if (flags.rawBytes === undefined) throw new UsageError(`the band of ${id} measures the bytes of the raw file: give --raw-bytes`);
    value = flags.rawBytes;
  } else if (flags.rawBytes !== undefined) throw new UsageError(`the band of ${id} measures the record count, so --raw-bytes does not apply`);
  const history = readJson(flags.history, 'the history');
  const options = { precision: row.precision };
  // checkBand refuses a history or a band that does not validate; asked once
  // here, it refuses them before the pass reads a block.
  checkBand(0, history, row.band, options);
  return { source: id, ...(value === undefined ? {} : { value }), judge: (v) => checkBand(v, history, row.band, options) };
}

// The one ranged reader of both forms: the bytes from `offset`, at most
// `length`, and never past `size`, the object's size as the store holds it (a
// file's at open, a layer's in its manifest). A length comes from the index,
// so the buffer is sized by what the object holds, never by what the index
// claims. `fill(target, position)` puts at most target.length bytes from
// `position` into `target` and answers how many; it is asked again, at most
// `chunk` bytes at a time, until the range is read or it answers 0. An object
// shorter than the range answers what it holds, and the verifier counts what
// arrived ("short-read").
export async function readRanged(size, offset, length, chunk, fill) {
  const want = Math.max(0, Math.min(length, size - offset));
  const out = new Uint8Array(want);
  let at = 0;
  while (at < want) {
    const n = await fill(out.subarray(at, Math.min(want, at + chunk)), offset + at);
    if (n === 0) break;
    at += n;
  }
  return out.subarray(0, at);
}

// A file's bytes through its handle. handle.read may answer part of a range,
// so readRanged asks again until the range is read or the file ends.
export const readAt = (handle, size, offset, length) =>
  readRanged(size, offset, length, Number.MAX_SAFE_INTEGER, async (target, position) => (await handle.read(target, 0, target.length, position)).bytesRead);

// A blob of `repo` as a ByteSource: its bytes by range through packages/ghcr's
// reader (the signed URL of its 307), at most RANGE_MAX_BYTES a request, a 429
// paused for as scripts/ghcr/rate.mjs pauses. readRange answers exactly the
// bytes asked for or throws, so nothing short is taken as whole.
export function blobSource(reader, repo, blob, deps = {}) {
  const fill = async (target, position) => {
    const { bytes } = await readPaused(`bytes ${position} to ${position + target.length - 1} of ${blob.digest}`, () => reader.readRange(repo, blob.digest, position, position + target.length), deps);
    target.set(bytes);
    return bytes.length;
  };
  return { size: blob.size, read: (offset, length) => readRanged(blob.size, offset, length, RANGE_MAX_BYTES, fill) };
}

// The GHCR form's reader: no credential, the contact User-Agent, and a cache
// that keeps each blob's signed URL, so a range read after the first asks the
// blob host alone. The re-find of 1,000 keys reads about one block and one
// index page a key, each a range request.
export const ghcrFormReader = () => ghcrReader({ userAgent: USER_AGENT, cache: memoryCache() });

// The pack a GHCR manifest names, read with no credential: the manifest, its
// annotations, and its index and parts as sources over blobSource.
export async function openGhcrPack(reader, pkg, tag, deps = {}) {
  let repo;
  try {
    repo = repoOf(pkg);
    checkRef(tag);
  } catch (error) {
    if (error instanceof LayoutError || (error instanceof GhcrError && error.code === 'usage')) throw new UsageError(error.message);
    throw error;
  }
  const m = await readPaused(`the manifest ${tag} of ${repo}`, () => reader.getManifest(repo, tag, { maxBytes: MANIFEST_LIMIT_BYTES }), deps);
  const at = `${REGISTRY_HOST}/${repo}:${tag}`;
  if (!PACK_TYPES.includes(m.json.artifactType)) throw new UsageError(`${at} is ${JSON.stringify(m.json.artifactType ?? null)}, not a pack or a segment`);
  const parts = [];
  const timeParts = [];
  let idx = null;
  let timeIdx = null;
  for (const layer of m.json.layers ?? []) {
    const title = layer.annotations?.[TITLE];
    if (title === IDX_TITLE) {
      if (idx !== null) throw new UsageError(`${at} holds two idx layers`);
      idx = layer;
    } else if (title === TIME_IDX_TITLE) {
      if (timeIdx !== null) throw new UsageError(`${at} holds two time.idx layers`);
      timeIdx = layer;
    } else if (typeof title === 'string' && /^part\.\d{3,}$/.test(title)) {
      if (title !== partTitle(parts.length)) throw new UsageError(`${at}: the layer ${title} stands where ${partTitle(parts.length)} belongs`);
      parts.push(layer);
    } else if (typeof title === 'string' && TIME_PART_TITLE.test(title)) {
      if (title !== timePartTitle(timeParts.length)) throw new UsageError(`${at}: the layer ${title} stands where ${timePartTitle(timeParts.length)} belongs`);
      timeParts.push(layer);
    }
  }
  if (idx === null) throw new UsageError(`${at} holds no idx layer`);
  if (parts.length === 0) throw new UsageError(`${at} holds no part layer`);
  if ((timeIdx === null) !== (timeParts.length === 0)) throw new UsageError(timeIdx === null ? `${at} holds time parts and no time.idx layer` : `${at} holds a time.idx layer and no time part`);
  const partSource = (layers, what) => {
    const sources = layers.map((p) => blobSource(reader, repo, p, deps));
    return {
      sizes: layers.map((p) => p.size),
      read: async (part, offset, length) => {
        const s = sources[part];
        if (s === undefined) throw new PackError('short-read', `${what} ${part} is not a layer of ${at}`);
        return s.read(offset, length);
      },
    };
  };
  return {
    at,
    digest: m.digest,
    annotations: m.json.annotations ?? {},
    idx: blobSource(reader, repo, idx, deps),
    parts: partSource(parts, 'part'),
    time: timeIdx === null ? null : { idx: blobSource(reader, repo, timeIdx, deps), parts: partSource(timeParts, 'time part') },
    close: async () => undefined,
  };
}

// The index as a ByteSource and the parts as a PartSource, with the size of
// each file as it stands; the time copy's alike, or null.
export async function openPack(files) {
  const handles = [];
  const openFile = async (path) => {
    const h = await open(path, 'r');
    handles.push(h);
    return h;
  };
  const sourceOf = async (path) => {
    const h = await openFile(path);
    const size = (await h.stat()).size;
    return { size, read: (offset, length) => readAt(h, size, offset, length) };
  };
  const partsOf = async (paths, what) => {
    const sources = [];
    for (const path of paths) sources.push(await sourceOf(path));
    return {
      sizes: sources.map((s) => s.size),
      read: async (part, offset, length) => {
        const s = sources[part];
        if (s === undefined) throw new PackError('short-read', `${what} ${part} is not given`);
        return s.read(offset, length);
      },
    };
  };
  try {
    const idx = await sourceOf(files.idx);
    const parts = await partsOf(files.parts, 'part');
    const time = files.time === null || files.time === undefined ? null : { idx: await sourceOf(files.time.idx), parts: await partsOf(files.time.parts, 'time part') };
    return { idx, parts, time, close: () => Promise.all(handles.map((h) => h.close())) };
  } catch (error) {
    await Promise.all(handles.map((h) => h.close()));
    throw error;
  }
}

// A detail on one line: a control byte, which the verifier never puts there,
// would still not reach the terminal as itself.
const oneLine = (text) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

// The lines of a result; `required` is the --require list.
export function lines(result, required = []) {
  const out = [];
  for (const c of result.checks) {
    if (c.status === 'fail') for (const e of result.errors.filter((x) => x.check === c.check)) out.push(`FAIL ${c.check} ${oneLine(e.detail)}`);
    else out.push(`${c.status.toUpperCase()} ${c.check} ${oneLine(c.detail)}`);
  }
  const missing = required.filter((c) => result.unverified.includes(c));
  out.push(`VERDICT ${result.verdict} (${result.unverified.length} skipped${missing.length > 0 ? `; required and skipped: ${missing.join(', ')}` : ''})`);
  return out;
}

const nowIso = () => `${new Date().toISOString().slice(0, 19)}Z`;

// The errors that mean the run could not go on with its inputs (exit 2): this
// script's usage, a pack, registry, list, history or GHCR answer that does
// not validate, a rate limit past its cap, and a file the system cannot read.
// Anything else is a defect of the script (exit 70).
const KNOWN = [UsageError, PackError, GhcrError, LayoutError, BandError, ContractError, JsonError, SourceError, PslError, RateLimitError];
export const knownError = (error) => KNOWN.some((k) => error instanceof k) || (error instanceof Error && typeof error.code === 'string' && typeof error.syscall === 'string');

// deps: `reader` (the GHCR form's; default packages/ghcr's with no
// credential), `write` (stdout), `err` (stderr), and `sleep` and `random` for
// a 429's pause.
export async function main(argv, deps = {}) {
  const write = deps.write ?? ((text) => process.stdout.write(text));
  const err = deps.err ?? console.error;
  let flags;
  let files = null;
  let expect;
  try {
    flags = parseFlags(argv);
    if (flags.ghcr === null) {
      files = packFiles(flags.paths);
      expect = expectation(flags);
    }
  } catch (error) {
    err(`verify-pack: ${error.message}`);
    return 2;
  }
  let pack = null;
  try {
    if (files === null) {
      pack = await openGhcrPack(deps.reader ?? ghcrFormReader(), flags.ghcr.pkg, flags.ghcr.tag, { sleep: deps.sleep, random: deps.random, log: (line) => err(`verify-pack: ${line}`) });
      err(`verify-pack: ${pack.at} ${pack.digest}, read with no credential`);
      expect = expectation(flags, pack.annotations);
    }
    const psl = await loadPsl(readFileSync(flags.psl));
    const registry = expect.sources !== undefined || flags.history !== null ? loadRegistry(flags.sources) : undefined;
    const volume = volumeCheck(flags, expect, registry);
    if (pack === null) pack = await openPack(files);
    const result = await verifyPack(pack.idx, pack.parts, expect, {
      psl,
      registry,
      volume,
      now: flags.now ?? nowIso(),
      seed: flags.seed,
      require: flags.require,
      ...(pack.time === null || pack.time === undefined ? {} : { time: pack.time }),
    });
    write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : `${lines(result, flags.require).join('\n')}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (!knownError(error)) {
      err(`verify-pack: internal error: ${error instanceof Error ? error.stack : String(error)}`);
      return 70;
    }
    err(`verify-pack: could not run: ${error.message}`);
    return 2;
  } finally {
    if (pack !== null) await pack.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
