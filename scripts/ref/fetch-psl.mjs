// scripts/ref/fetch-psl.mjs — download the Public Suffix List, check it with the
// names package's own loader (packages/names/src/psl.ts), and print its sha256.
//
// The checks are the loader's (UTF-8, each of the four section markers once and
// in order, every rule readable, IDN rules converted) and two of this script's:
// more than 9,000 rules in all, and at least one in each section. The list of
// 2026-10-22 (VERSION 2026-10-22_08-36-41_UTC, 338,012 B) holds 6,949 ICANN
// rules and 3,448 private ones (packages/names/test/fixtures/psl-2026-10-27.dat),
// so a list cut short or emptied fails here before anything pins its hash.
//
// The hash is of the body as the server sends it with no content coding (the
// request asks for `identity`), the bytes `sha256sum` of a plain download gives.
// With --out, the file is written only after every check passed, through a
// temporary file in the same directory and a rename, so a failed run never
// leaves a partial list at FILE. DOM-019's ref-refresh.yml, not yet written,
// is to run it.
//
// Usage:
//   node scripts/ref/fetch-psl.mjs [--url URL] [--out FILE]
// Prints one line: `sha256 HEX rules N`.
// Exit codes: 0 fetched and checked (and written with --out) · 1 the list
// failed a check · 2 could not run (bad arguments, the request failed or did
// not answer 200, the body is over MAX_BYTES, FILE cannot be written).
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadPsl, PslError } from '../../packages/names/src/psl.ts';
import { parseArgs } from '../lib/args.mjs';
import { USER_AGENT } from '../lib/user-agent.mjs';

export const DEFAULT_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
// TODO/RULES.md section 5, ruling 11: every reader sends the contact address.
export { USER_AGENT };
export const MIN_RULES = 9000;
// The list is 338,012 B (2026-10-28T15:34:24Z); a body twelve times that is not it.
export const MAX_BYTES = 4 * 1024 * 1024;
export const TIMEOUT_MS = 60_000;

export class FetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FetchError';
  }
}

// The body of url as bytes, refused past MAX_BYTES while it streams.
export async function download(url, { maxBytes = MAX_BYTES } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new FetchError(`request failed: ${err.cause?.message ?? err.message}`);
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new FetchError(`${url} answered ${res.status}`);
  }
  const chunks = [];
  let total = 0;
  let over = false;
  try {
    // Leaving the loop early cancels the body stream.
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        over = true;
        break;
      }
      chunks.push(chunk);
    }
  } catch (err) {
    throw new FetchError(`${url}: the body broke off after ${total} bytes: ${err.cause?.message ?? err.message}`);
  }
  if (over) throw new FetchError(`${url} sent more than ${maxBytes} bytes`);
  return Buffer.concat(chunks, total);
}

// The checks of a downloaded list: the loader's, then the rule counts.
// Returns the Psl, or throws PslError.
export async function checkList(bytes) {
  const psl = await loadPsl(bytes);
  const rules = psl.rules.icann + psl.rules.private;
  if (psl.rules.icann === 0 || psl.rules.private === 0) throw new PslError(`a section holds no rule: icann ${psl.rules.icann} private ${psl.rules.private}`);
  if (rules <= MIN_RULES) throw new PslError(`${rules} rules, not more than ${MIN_RULES}`);
  return psl;
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

async function main(argv) {
  const args = parseArgs(argv);
  if (args._.length > 0 || args.url === true || args.out === true) {
    console.error('usage: node scripts/ref/fetch-psl.mjs [--url URL] [--out FILE]');
    return 2;
  }
  const url = typeof args.url === 'string' ? args.url : DEFAULT_URL;
  let bytes;
  try {
    bytes = await download(url);
  } catch (err) {
    if (!(err instanceof FetchError)) throw err;
    console.error(`fetch-psl: ${err.message}`);
    return 2;
  }
  let psl;
  try {
    psl = await checkList(bytes);
  } catch (err) {
    if (!(err instanceof PslError)) throw err;
    console.error(`fetch-psl: ${url}: ${err.message}`);
    return 1;
  }
  if (typeof args.out === 'string') {
    try {
      writeAtomic(args.out, bytes);
    } catch (err) {
      console.error(`fetch-psl: cannot write ${args.out}: ${err.message}`);
      return 2;
    }
  }
  console.log(`sha256 ${psl.sha256} rules ${psl.rules.icann + psl.rules.private}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
