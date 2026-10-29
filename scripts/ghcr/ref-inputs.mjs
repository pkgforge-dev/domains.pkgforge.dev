// scripts/ghcr/ref-inputs.mjs — one input of the `ref` package, fetched or
// read, checked well formed, and written under DIR for scripts/ghcr/push.mjs
// (DOM-019, TODO/storage.md; .github/workflows/ref-refresh.yml runs it).
//
//   psl      https://publicsuffix.org/list/public_suffix_list.dat, checked by
//            scripts/ref/fetch-psl.mjs (the names package's own loader, and its
//            rule floors). `created` is the list's own `// VERSION:` line.
//   ctlogs   https://www.gstatic.com/ct/log_list/v3/log_list.json (62,375 B,
//            version 95.15, log_list_timestamp 2026-10-28T13:37:58Z: 11
//            operators, 26 logs and 59 tiled logs, MEASURED
//            2026-10-29T00:38:50Z). Checked by checkLogList below. `created` is
//            its log_list_timestamp.
//   sources  config/sources.json as committed (DOM-016 writes it), checked for
//            its format, then by packages/adapter's validateRegistry against
//            config/source-bits.json, the check a reader makes, so the copy
//            published is a valid registry with no credential in a URL.
//            `created` is given with --created: the time of the commit it was
//            read from.
//
// A download is fetch-psl.mjs's: the contact User-Agent (ruling 11), no
// content coding, no redirect, a size cap while it streams, a time limit. --url
// is an https URL on the kind's own origin (https://publicsuffix.org,
// https://www.gstatic.com) unless --allow-other-url is given, so a manual run
// cannot publish another host's file under a psl- or ctlogs- tag by mistake;
// the url printed is the one fetched. `created` is the
// source's own time, never the fetch time, so the same bytes give the same
// annotation in every run. The file is written through a temporary file and a
// rename, only after every check passed.
//
// Usage:
//   node scripts/ghcr/ref-inputs.mjs psl --out DIR [--url URL [--allow-other-url]]
//   node scripts/ghcr/ref-inputs.mjs ctlogs --out DIR [--url URL [--allow-other-url]]
//   node scripts/ghcr/ref-inputs.mjs sources --out DIR --created ISO [--file PATH] [--commit SHA]
// Prints one JSON line: { kind, tag, title, file, mediaType, bytes, sha256,
// created, url, facts }, where tag is ref:<kind>-<sha12> and url where the
// bytes came from.
// Exit codes: 0 written · 1 the input failed a check · 2 could not run (bad
// arguments, the download failed, redirected or did not answer 200, the body is
// over its cap, a file that cannot be read or written, config/source-bits.json
// not valid) · 70 an internal error, a defect of this script (its stack goes to
// stderr), never a verdict on the input.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SourceError, validateBits, validateRegistry } from '../../packages/adapter/src/validate.ts';
import { PslError } from '../../packages/names/src/psl.ts';
import { refTag, SOURCE_URL } from '../../packages/ghcr/src/layout.ts';
import { ROOT } from '../files.mjs';
import { parseArgs } from '../lib/args.mjs';
import { checkList, DEFAULT_URL as PSL_URL, download, FetchError } from '../ref/fetch-psl.mjs';

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, internal: 70 });
export const LOG_LIST_URL = 'https://www.gstatic.com/ct/log_list/v3/log_list.json';
// The list was 62,375 B on 2026-10-29; 64 times that is not it.
export const LOG_LIST_MAX_BYTES = 4 * 1024 * 1024;
// Floors under the measured 11 operators and 85 logs (2026-10-29T00:38:50Z), so
// a list cut short or emptied fails here before anything pins its hash.
export const MIN_OPERATORS = 5;
export const MIN_LOGS = 20;
export const SOURCES_FORMAT = 'domains.sources.v1';
export const SOURCES_MAX_BYTES = 1024 * 1024;
export const BITS_FILE = join(ROOT, 'config', 'source-bits.json');

// `url`: the kind's own list, whose origin --url keeps to unless --allow-other-url.
export const KINDS = Object.freeze({
  psl: { title: 'public_suffix_list.dat', mediaType: 'text/plain', url: PSL_URL },
  ctlogs: { title: 'log_list.json', mediaType: 'application/json', url: LOG_LIST_URL },
  sources: { title: 'sources.json', mediaType: 'application/json', url: null },
});

// Whether `url` is an https URL on the origin of `own`.
export function onOrigin(url, own) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.origin === new URL(own).origin;
  } catch {
    return false;
  }
}

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

// An ISO 8601 UTC time cut to its whole second, `YYYY-MM-DDTHH:MM:SSZ`.
export function wholeSecond(text, what) {
  const m = typeof text === 'string' ? ISO_UTC.exec(text) : null;
  const t = m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : Number.NaN;
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 19) !== `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)
    throw new InputError(`${what} ${JSON.stringify(text)} is not an ISO 8601 UTC time`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// The time of the list's `// VERSION: 2026-10-22_08-36-41_UTC` line.
export function pslCreated(text) {
  const m = /^\/\/ VERSION: (\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_UTC\s*$/m.exec(text);
  if (!m) throw new InputError('the list has no `// VERSION: YYYY-MM-DD_HH-MM-SS_UTC` line');
  return wholeSecond(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, 'the VERSION line');
}

const https = (u) => {
  try {
    return typeof u === 'string' && new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};
const base64Bytes = (s) => (typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0 ? Buffer.from(s, 'base64').length : -1);

// The checks of the CT log list v3: its top-level members, every operator and
// every log, a unique 32-byte log_id, an https URL, exactly one state, and the
// floors. Returns its facts, or throws InputError naming the first fault.
export function checkLogList(bytes) {
  let list;
  try {
    list = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InputError('the log list is not UTF-8 JSON');
  }
  if (!isObj(list)) throw new InputError('the log list is not a JSON object');
  if (typeof list.version !== 'string' || list.version === '') throw new InputError('the log list has no version');
  const timestamp = wholeSecond(list.log_list_timestamp, 'log_list_timestamp');
  if (!Array.isArray(list.operators)) throw new InputError('the log list has no operators array');
  const ids = new Set();
  let logs = 0;
  let tiled = 0;
  for (const [i, op] of list.operators.entries()) {
    const at = `operator ${i}`;
    if (!isObj(op) || typeof op.name !== 'string' || op.name === '') throw new InputError(`${at} has no name`);
    if (!Array.isArray(op.email) || op.email.some((e) => typeof e !== 'string')) throw new InputError(`${op.name}: email is not a list of strings`);
    for (const [key, urlKeys] of [
      ['logs', ['url']],
      ['tiled_logs', ['submission_url', 'monitoring_url']],
    ]) {
      const list2 = op[key] ?? [];
      if (!Array.isArray(list2)) throw new InputError(`${op.name}: ${key} is not a list`);
      for (const [j, log] of list2.entries()) {
        const where = `${op.name} ${key}[${j}]`;
        if (!isObj(log) || typeof log.description !== 'string' || log.description === '') throw new InputError(`${where} has no description`);
        if (base64Bytes(log.log_id) !== 32) throw new InputError(`${where}: log_id is not 32 bytes of base64`);
        if (ids.has(log.log_id)) throw new InputError(`${where}: log_id ${log.log_id} appears twice`);
        ids.add(log.log_id);
        if (base64Bytes(log.key) < 1) throw new InputError(`${where}: key is not base64`);
        for (const u of urlKeys) if (!https(log[u])) throw new InputError(`${where}: ${u} is not an https URL`);
        if (!Number.isSafeInteger(log.mmd) || log.mmd < 0) throw new InputError(`${where}: mmd is not a whole number of seconds`);
        if (!isObj(log.state) || Object.keys(log.state).length !== 1) throw new InputError(`${where}: state holds ${isObj(log.state) ? Object.keys(log.state).length : 'no'} keys, not one`);
        if (key === 'logs') logs += 1;
        else tiled += 1;
      }
    }
  }
  if (list.operators.length < MIN_OPERATORS) throw new InputError(`${list.operators.length} operators, fewer than ${MIN_OPERATORS}`);
  if (logs + tiled < MIN_LOGS) throw new InputError(`${logs + tiled} logs, fewer than ${MIN_LOGS}`);
  return { version: list.version, timestamp, operators: list.operators.length, logs, tiled };
}

// The checks of config/sources.json: its format and its list of sources.
export function checkSources(bytes) {
  let reg;
  try {
    reg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InputError('sources.json is not UTF-8 JSON');
  }
  if (!isObj(reg) || reg.format !== SOURCES_FORMAT) throw new InputError(`sources.json has no format ${SOURCES_FORMAT}`);
  if (!Array.isArray(reg.sources) || reg.sources.some((s) => !isObj(s) || typeof s.id !== 'string')) throw new InputError('sources.json has no list of sources, each with an id');
  return { sources: reg.sources.length };
}

// config/source-bits.json as packages/adapter reads it. Throws FetchError when it
// cannot be read or is not a valid bit map: the run cannot check the registry.
export function readBits(path) {
  try {
    return validateBits(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    if (err instanceof SourceError || err instanceof SyntaxError || typeof err?.code === 'string') throw new FetchError(`cannot read ${path}: ${err.message}`);
    throw err;
  }
}

function writeAtomic(path, bytes) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// The input of `kind`: { bytes, created, url, facts }. Throws InputError on a
// failed check, FetchError on a failed download.
export async function readInput(kind, opts) {
  if (kind === 'psl') {
    const url = opts.url ?? PSL_URL;
    const bytes = await download(url);
    let psl;
    try {
      psl = await checkList(bytes);
    } catch (err) {
      if (err instanceof PslError) throw new InputError(err.message);
      throw err;
    }
    return { bytes, created: pslCreated(bytes.toString('utf8')), url, facts: { rules: psl.rules } };
  }
  if (kind === 'ctlogs') {
    const url = opts.url ?? LOG_LIST_URL;
    const bytes = await download(url, { maxBytes: LOG_LIST_MAX_BYTES });
    const facts = checkLogList(bytes);
    return { bytes, created: facts.timestamp, url, facts };
  }
  if (kind === 'sources') {
    const path = resolve(opts.file ?? join(ROOT, 'config', 'sources.json'));
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch (err) {
      throw new FetchError(`cannot read ${path}: ${err.code ?? err.message}`);
    }
    if (bytes.length > SOURCES_MAX_BYTES) throw new InputError(`sources.json is ${bytes.length} bytes, over ${SOURCES_MAX_BYTES}`);
    const facts = checkSources(bytes);
    const bits = readBits(BITS_FILE);
    try {
      validateRegistry(JSON.parse(bytes.toString('utf8')), bits);
    } catch (err) {
      if (err instanceof SourceError)
        throw new InputError(`sources.json fails packages/adapter's validateRegistry:
${err.message}`);
      throw err;
    }
    const url = opts.commit ? `${SOURCE_URL}/blob/${opts.commit}/config/sources.json` : 'config/sources.json';
    return { bytes, created: wholeSecond(opts.created, '--created'), url, facts };
  }
  throw new InputError(`unknown kind ${kind}`);
}

const USAGE = [
  'usage: node scripts/ghcr/ref-inputs.mjs psl --out DIR [--url URL [--allow-other-url]]',
  '       node scripts/ghcr/ref-inputs.mjs ctlogs --out DIR [--url URL [--allow-other-url]]',
  '       node scripts/ghcr/ref-inputs.mjs sources --out DIR --created ISO [--file PATH] [--commit SHA]',
].join('\n');

// An error run does not know is a defect, exit 70: never 1, which is a verdict
// on the input a caller acts on.
export async function main(argv, deps = {}) {
  try {
    return await run(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`ref-inputs: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function run(argv, { out = console.log, err = console.error }) {
  const args = parseArgs(argv);
  const kind = args._[0];
  const str = (k) => args[k] === undefined || typeof args[k] === 'string';
  const known = new Set(['_', 'out', 'url', 'file', 'created', 'commit', 'allow-other-url']);
  const other = args['allow-other-url'];
  const bad =
    args._.length !== 1 || !Object.hasOwn(KINDS, kind)
      ? 'name one kind: psl, ctlogs or sources'
      : typeof args.out !== 'string'
        ? '--out DIR is required'
        : Object.keys(args).find((k) => !known.has(k))
          ? `unknown flag --${Object.keys(args).find((k) => !known.has(k))}`
          : !['url', 'file', 'created', 'commit'].every(str)
            ? 'a flag is missing its value'
            : kind === 'sources' && typeof args.created !== 'string'
              ? 'sources needs --created ISO, the time of the commit the file is read from'
              : kind !== 'sources' && (args.file !== undefined || args.created !== undefined || args.commit !== undefined)
                ? '--file, --created and --commit go with sources'
                : kind === 'sources' && (args.url !== undefined || other !== undefined)
                  ? '--url and --allow-other-url go with psl and ctlogs'
                  : other !== undefined && other !== true
                    ? '--allow-other-url takes no value'
                    : args.url !== undefined && other !== true && !onOrigin(args.url, KINDS[kind].url)
                      ? `--url ${JSON.stringify(args.url)} is not an https URL on ${new URL(KINDS[kind].url).origin}; give --allow-other-url to read another`
                      : args.commit !== undefined && !/^[0-9a-f]{40}$/.test(args.commit)
                        ? '--commit is a 40-hex commit'
                        : null;
  if (bad !== null) {
    err(`ref-inputs: ${bad}\n${USAGE}`);
    return EXIT.usage;
  }
  let input;
  try {
    input = await readInput(kind, args);
  } catch (e) {
    if (e instanceof FetchError) {
      err(`ref-inputs: ${kind}: ${e.message}`);
      return EXIT.usage;
    }
    if (e instanceof InputError) {
      err(`ref-inputs: ${kind}: ${e.message}`);
      return EXIT.failed;
    }
    throw e;
  }
  const { title, mediaType } = KINDS[kind];
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const file = resolve(args.out, title);
  try {
    mkdirSync(resolve(args.out), { recursive: true });
    writeAtomic(file, input.bytes);
  } catch (e) {
    err(`ref-inputs: cannot write ${file}: ${e.message}`);
    return EXIT.usage;
  }
  out(JSON.stringify({ kind, tag: refTag(kind, sha256), title, file, mediaType, bytes: input.bytes.length, sha256, created: input.created, url: input.url, facts: input.facts }));
  return EXIT.ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
