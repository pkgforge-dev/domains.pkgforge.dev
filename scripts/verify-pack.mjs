// scripts/verify-pack.mjs — verify a pack held in local files before it counts
// (DOM-018, docs/architecture.md section 5.8), with verifyPack of
// packages/pack/src/verify.ts: the one verifier, which later entries call with
// a GHCR source.
//
// Each PATH is a part (a file name ending `part.NNN`: part.000, clean.part.000),
// the index (a name ending `idx`: idx, clean.idx), or a directory, whose files
// of those names are taken. One index and the parts 0 to n-1 make a pack. A
// part the index names past the last one given fails the length check; a part
// given twice, a gap in the part numbers, a second index or none is a usage
// error. Each file is read by range through its own handle, never whole.
//
// The expectation is the manifest's annotations, --annotations FILE (a JSON
// object of strings, read by expectFromAnnotations), and the --expect-* flags,
// which override them. A check with nothing to compare against prints SKIP and
// why; it neither passes nor fails. So a run with no annotation, no --expect-*
// flag, no --source and no --history skips dataset, length, count, sha256, psl,
// sources, precision and volume, and is ok. A pack of no record also skips
// inflate, crc, record, order, unique, name and refind. --require names the
// checks that must not skip, and one of them that skipped makes the verdict
// unverified and exits 1. A promote job passes the checks it needs compared,
// such as --require dataset,length,count,sha256,psl.
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
// Usage:
//   node scripts/verify-pack.mjs [flags] PATH...
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
// fails).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBand, validateBits, validateRegistry } from '@domains/adapter';
import { loadPsl } from '@domains/names';
import { PackError } from '../packages/pack/src/index.ts';
import { CHECKS, expectFromAnnotations, verifyPack } from '../packages/pack/src/verify.ts';
import { ROOT } from './files.mjs';
import { parseArgs } from './lib/args.mjs';

export const DEFAULT_PSL = join(ROOT, 'packages', 'names', 'test', 'fixtures', 'psl-2026-10-27.dat');
export const DEFAULT_SOURCES = join(ROOT, 'config', 'sources.json');
export const BITS = join(ROOT, 'config', 'source-bits.json');

const VALUED = ['annotations', 'expect-count', 'expect-bytes', 'expect-sha256', 'expect-dataset', 'expect-psl', 'source', 'span', 'psl', 'sources', 'history', 'raw-bytes', 'seed', 'now', 'require'];
const FLAGS = [...VALUED, 'json'];
// Layer titles: part.000 and up, and idx (docs/format.md section 2), with any
// prefix before a dot.
const PART_NAME = /(?:^|\.)part\.(\d{3,})$/;
const IDX_NAME = /(?:^|\.)idx$/;

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
  if (a._.length === 0) throw new UsageError('give the index and the parts of a pack');
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

// The index and the parts in order, from the PATHs.
export function packFiles(paths) {
  let idx = null;
  const parts = new Map();
  const take = (path) => {
    const name = basename(path);
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
    else if (!take(path)) throw new UsageError(`${path} is named neither as a part (part.NNN) nor as an index (idx)`);
  }
  if (idx === null) throw new UsageError('no index is given: a file whose name ends in idx');
  const ordered = [];
  for (let n = 0; n < parts.size; n += 1) {
    if (!parts.has(n)) throw new UsageError(`part ${n} is not given, and part ${Math.max(...parts.keys())} is`);
    ordered.push(parts.get(n));
  }
  return { idx, parts: ordered };
}

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`${what} ${path}: ${error.message}`);
  }
};

// The annotations file, then the --expect-* flags over it.
export function expectation(flags) {
  const out = flags.annotations === null ? {} : { ...expectFromAnnotations(readJson(flags.annotations, 'the annotations')) };
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

// The bytes of `handle` from `offset`: at most `length`, and never past
// `size`, the file's size at open. A length comes from the index, so the buffer
// is sized by what the file holds, never by what the index claims. A file
// shorter than the range answers what it holds, and the verifier counts what
// arrived ("short-read"). handle.read may answer part of a range, so it is
// asked again until the range is read or the file ends.
export async function readAt(handle, size, offset, length) {
  const want = Math.max(0, Math.min(length, size - offset));
  const out = new Uint8Array(want);
  let at = 0;
  while (at < want) {
    const { bytesRead } = await handle.read(out, at, want - at, offset + at);
    if (bytesRead === 0) break;
    at += bytesRead;
  }
  return out.subarray(0, at);
}

// The index as a ByteSource and the parts as a PartSource, with the size of
// each file as it stands.
export async function openPack(files) {
  const handles = [];
  try {
    const idxHandle = await open(files.idx, 'r');
    handles.push(idxHandle);
    const partHandles = [];
    for (const path of files.parts) {
      const h = await open(path, 'r');
      handles.push(h);
      partHandles.push(h);
    }
    const sizes = [];
    for (const h of partHandles) sizes.push((await h.stat()).size);
    const idxSize = (await idxHandle.stat()).size;
    return {
      idx: { size: idxSize, read: (offset, length) => readAt(idxHandle, idxSize, offset, length) },
      parts: {
        sizes,
        read: async (part, offset, length) => {
          const h = partHandles[part];
          if (h === undefined) throw new PackError('short-read', `part ${part} is not given`);
          return readAt(h, sizes[part], offset, length);
        },
      },
      close: () => Promise.all(handles.map((h) => h.close())),
    };
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

async function main(argv) {
  let flags;
  let files;
  let expect;
  try {
    flags = parseFlags(argv);
    files = packFiles(flags.paths);
    expect = expectation(flags);
  } catch (error) {
    console.error(`verify-pack: ${error.message}`);
    return 2;
  }
  let pack = null;
  try {
    const psl = await loadPsl(readFileSync(flags.psl));
    const registry = expect.sources !== undefined || flags.history !== null ? loadRegistry(flags.sources) : undefined;
    const volume = volumeCheck(flags, expect, registry);
    pack = await openPack(files);
    const result = await verifyPack(pack.idx, pack.parts, expect, { psl, registry, volume, now: flags.now ?? nowIso(), seed: flags.seed, require: flags.require });
    process.stdout.write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : `${lines(result, flags.require).join('\n')}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`verify-pack: could not run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    if (pack !== null) await pack.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
