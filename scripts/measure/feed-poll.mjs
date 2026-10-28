// scripts/measure/feed-poll.mjs — at what UTC time does each daily new-domain
// feed publish, and when does a day's file stop changing? (DOM-012,
// TODO/ingest.md.) This is the poller; feed-times.mjs reads what it writes.
//
// One poll is one look at every feed, its requests sent at once:
//   - ISC: a HEAD of `domaindata.json.gz` and of the dated file of today and of
//     each of the six days before it, recording status, length, ETag and
//     Last-Modified. Six, not one: ISC rewrites a day's file until the evening
//     four days after that day (MEASURED 2026-10-28T10:30:02Z: the file of 10-20
//     was last written 10-24 23:54, of 10-23 on 10-27 23:36, and 10-24's on
//     10-28 09:38), and the two days after its last write show it settled.
//   - WhoisDS: a HEAD of the dated path of today and of the two days before,
//     recording status, length and type. The path of one date can serve the
//     list of another (MEASURED 2026-10-28T10:31:09Z: the 2026-10-27 path served
//     the 2026-10-26 list, same CRC-32 and the same 566,869 B), so the length
//     alone cannot say which list a path holds. When a path's answer changes,
//     and at least once an hour, its zip is read and the CRC-32, sizes, name
//     and time of each entry are recorded from the central directory.
//   - cenk and hagezi: the first 4 KiB of the raw file with If-None-Match (304
//     while unchanged; on a change the leading comment lines carry the list's
//     own timestamp, and Content-Range its full size), and the last commit of
//     the file from `gh api` (GH_TOKEN from the environment).
//
// Every request sends the project's User-Agent with its contact address
// (TODO/RULES.md section 5, ruling 11) and asks for the identity encoding, so
// a length is the file's own. A failed request is a field of its poll (`error`)
// and never stops the loop. Each line is appended as soon as its poll ends, so a
// job that is ended keeps every poll it took.
//
// Usage:
//   node scripts/measure/feed-poll.mjs --out FILE [--polls 34] [--interval-min 10] [--start ISO]
//
// Poll i runs at start + i * interval (start defaults to now; the workflow
// passes the job's own start). A slot is skipped when the next slot has already
// come, so a late start never sends polls back to back. FILE gets one `start`
// line, one `poll` line per poll and one `end` line, each with the schema
// `dom-012-poll/1`.
//
// Exit codes: 0 every poll ran and each one had at least one answer · 1 a poll
// had no answer at all (the runner had no network) · 2 bad arguments, or FILE
// cannot be written.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { USER_AGENT } from '../lib/user-agent.mjs';

export const SCHEMA = 'dom-012-poll/1';
export { USER_AGENT };
export const ISC_BASE = 'https://isc.sans.edu/feeds/';
export const ISC_LAGS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
// The file of the current day is an empty JSON array of 55 B (MEASURED
// 2026-10-27T08:22:56Z and 2026-10-28T10:29:18Z); a day with names is megabytes.
export const ISC_EMPTY_MAX_BYTES = 64;
export const WHOISDS_BASE = 'https://www.whoisds.com/whois-database/newly-registered-domains/';
export const WHOISDS_LAGS = Object.freeze([0, 1, 2]);
export const ROLLING = Object.freeze({
  cenk: Object.freeze({ url: 'https://raw.githubusercontent.com/cenk/nrd/main/nrd-last-10-days.txt', repo: 'cenk/nrd', path: 'nrd-last-10-days.txt' }),
  hagezi: Object.freeze({ url: 'https://raw.githubusercontent.com/hagezi/nrd/main/domains/nrd7.txt', repo: 'hagezi/nrd', path: 'domains/nrd7.txt' }),
});
export const PREFIX_BYTES = 4096;
const HEADER_LINES_MAX = 16;
const TEXT_MAX = 200;
const TIMEOUT_MS = 30_000;
const ZIP_TIMEOUT_MS = 120_000;
// A WhoisDS zip is about 0.6 MB; a body past this is not the list.
const ZIP_MAX_BYTES = 64 * 1024 * 1024;
const ZIP_TAIL_BYTES = 64 * 1024;
const ZIP_ENTRIES_MAX = 16;
const ZIP_REFRESH_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

const iso = (ms) => new Date(ms).toISOString();
const clip = (s) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}...` : s);

// The UTC date `lagDays` days before the instant `ms`, as YYYY-MM-DD.
export const utcDate = (ms, lagDays = 0) => iso(ms - lagDays * DAY_MS).slice(0, 10);
export const iscUrl = (date) => `${ISC_BASE}${date ? `domaindata.${date}.json.gz` : 'domaindata.json.gz'}`;
export const whoisdsUrl = (date) => `${WHOISDS_BASE}${Buffer.from(`${date}.zip`).toString('base64')}/nrd`;

// Present: the publisher has put a day's names there. feed-times.mjs judges
// with these same two functions.
export const iscPresent = (o) => o.status === 200 && typeof o.length === 'number' && o.length > ISC_EMPTY_MAX_BYTES;
// An unpublished WhoisDS path answers 200 with an empty text/html body
// (MEASURED 2026-10-27T08:23:18Z and 2026-10-28T10:30:41Z).
export const whoisdsPresent = (o) => o.status === 200 && (typeof o.length === 'number' ? o.length > 0 : /octet-stream|zip/i.test(o.type ?? ''));

const baseHeaders = () => ({ 'user-agent': USER_AGENT, 'accept-encoding': 'identity' });

function errorText(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const code = e?.cause?.code;
  return clip(code ? `${code}: ${e.message}` : String(e?.message ?? e));
}

function lengthOf(h) {
  const v = h.get('content-length');
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
}

// The full size from `Content-Range: bytes 0-4095/11900223`, else the length.
function totalOf(res) {
  const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
  return m ? Number(m[1]) : res.status === 200 ? lengthOf(res.headers) : null;
}

function pickHeaders(h) {
  const out = { length: lengthOf(h), etag: h.get('etag'), last_modified: h.get('last-modified'), type: h.get('content-type') };
  const disposition = h.get('content-disposition');
  if (disposition) out.disposition = clip(disposition);
  return out;
}

export async function observeHead(url, fetchFn = globalThis.fetch, clock = Date.now) {
  const at = clock();
  try {
    const res = await fetchFn(url, { method: 'HEAD', headers: baseHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { at: iso(at), ms: clock() - at, status: res.status, ...pickHeaders(res.headers) };
  } catch (e) {
    return { at: iso(at), ms: clock() - at, error: errorText(e) };
  }
}

// At most `max` bytes from the start of a body; the rest is never read.
export async function readPrefix(body, max) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    n += value.byteLength;
  }
  await reader.cancel();
  return Buffer.concat(chunks).subarray(0, max);
}

// The leading comment block of a list, where its publisher writes the date.
export function commentLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line.startsWith('#') || out.length >= HEADER_LINES_MAX) break;
    out.push(clip(line));
  }
  return out;
}

export async function observeRolling(url, etag, fetchFn = globalThis.fetch, clock = Date.now) {
  const at = clock();
  // No accept-encoding here: fetch adds `identity` itself to a request with a
  // Range header (the Fetch standard, HTTP-network-or-cache fetch), and a second
  // one would send `identity, identity`.
  const headers = { 'user-agent': USER_AGENT, range: `bytes=0-${PREFIX_BYTES - 1}` };
  if (etag) headers['if-none-match'] = etag;
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const out = { at: iso(at), ms: 0, status: res.status, etag: res.headers.get('etag'), total: totalOf(res) };
    if (res.status === 304) {
      out.etag = out.etag ?? etag ?? null;
      await res.body?.cancel();
    } else if (res.ok) {
      out.header = commentLines((await readPrefix(res.body, PREFIX_BYTES)).toString('utf8'));
    } else {
      await res.body?.cancel();
    }
    out.ms = clock() - at;
    return out;
  } catch (e) {
    return { at: iso(at), ms: clock() - at, error: errorText(e) };
  }
}

const keepTail = (tail, chunk, max) => {
  const all = Buffer.concat([tail, chunk]);
  return all.length > max ? all.subarray(all.length - max) : all;
};

// An MS-DOS date and time as the zip stores it: local time with no zone.
export function dosTime(date, time) {
  const p = (n) => String(n).padStart(2, '0');
  return `${1980 + (date >> 9)}-${p((date >> 5) & 15)}-${p(date & 31)}T${p(time >> 11)}:${p((time >> 5) & 63)}:${p((time & 31) * 2)}`;
}

// The entries of a zip's central directory, read from the last `tail.length`
// bytes of a body of `total` bytes. Throws when the tail holds no valid one.
export function zipEntries(tail, total) {
  const base = total - tail.length;
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0 && i >= tail.length - 22 - 0xffff; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end of central directory record');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('a zip64 archive is not read');
  let p = cdOffset - base;
  if (p < 0 || p + cdSize > eocd) throw new Error('the central directory is outside the bytes read');
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > eocd || tail.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory entry ${k} is malformed`);
    const n = tail.readUInt16LE(p + 28);
    const m = tail.readUInt16LE(p + 30);
    const c = tail.readUInt16LE(p + 32);
    if (p + 46 + n > eocd) throw new Error(`central directory entry ${k} runs past the directory`);
    if (entries.length < ZIP_ENTRIES_MAX) {
      entries.push({
        name: clip(tail.toString('utf8', p + 46, p + 46 + n)),
        crc32: tail
          .readUInt32LE(p + 16)
          .toString(16)
          .padStart(8, '0'),
        size: tail.readUInt32LE(p + 24),
        csize: tail.readUInt32LE(p + 20),
        mtime: dosTime(tail.readUInt16LE(p + 14), tail.readUInt16LE(p + 12)),
      });
    }
    p += 46 + n + m + c;
  }
  return { count, entries };
}

export async function observeZip(url, fetchFn = globalThis.fetch, clock = Date.now) {
  const at = clock();
  try {
    const res = await fetchFn(url, { headers: baseHeaders(), signal: AbortSignal.timeout(ZIP_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return { at: iso(at), ms: clock() - at, status: res.status, error: `status ${res.status}` };
    }
    const hash = createHash('sha256');
    let bytes = 0;
    let tail = Buffer.alloc(0);
    for await (const value of res.body) {
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      bytes += chunk.length;
      if (bytes > ZIP_MAX_BYTES) throw new Error(`the body passed ${ZIP_MAX_BYTES} B`);
      hash.update(chunk);
      tail = keepTail(tail, chunk, ZIP_TAIL_BYTES);
    }
    const out = { at: iso(at), ms: clock() - at, status: res.status, bytes, sha256: hash.digest('hex') };
    try {
      const { count, entries } = zipEntries(tail, bytes);
      out.entry_count = count;
      out.entries = entries;
    } catch (e) {
      out.error = `not a zip: ${errorText(e)}`;
    }
    return out;
  } catch (e) {
    return { at: iso(at), ms: clock() - at, error: errorText(e) };
  }
}

// A command's stdout, or a rejection that names its exit and the start of its
// stderr. `gh` is the production command; a test passes another.
export function makeRunner(cmd) {
  return (args) =>
    new Promise((resolvePromise, reject) => {
      execFile(cmd, args, { timeout: TIMEOUT_MS * 2, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} exited ${err.code ?? err.signal}: ${clip(String(stderr).trim())}`));
        else resolvePromise(String(stdout));
      });
    });
}
const gh = makeRunner('gh');

// The last commit that touched `path`, so a commit to another file of the
// repository does not count as a publication of this one.
export async function observeCommit(repo, path, runGh = gh, clock = Date.now) {
  const at = clock();
  try {
    const list = JSON.parse(await runGh(['api', `repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`]));
    if (!Array.isArray(list) || list.length === 0) throw new Error('no commit touches the path');
    const c = list[0];
    if (typeof c?.sha !== 'string' || typeof c.commit?.committer?.date !== 'string') throw new Error('a commit without sha or committer date');
    return { at: iso(at), ms: clock() - at, sha: c.sha, committed: c.commit.committer.date, authored: c.commit.author?.date ?? null, message: clip(String(c.commit.message ?? '').split('\n')[0]) };
  } catch (e) {
    return { at: iso(at), ms: clock() - at, error: errorText(e) };
  }
}

// A WhoisDS path: the HEAD always; the zip when the HEAD's answer differs from
// the last zip read of this path, or that read is an hour old.
async function observeWhoisds(date, state, fetchFn, clock) {
  const url = whoisdsUrl(date);
  const head = await observeHead(url, fetchFn, clock);
  const out = { head };
  if (head.error || !whoisdsPresent(head)) return out;
  const fp = `${head.status}|${head.length}|${head.type}`;
  const seen = state.whoisds[date];
  if (seen && seen.fp === fp && clock() - seen.at < ZIP_REFRESH_MS) return out;
  out.zip = await observeZip(url, fetchFn, clock);
  if (!out.zip.error) state.whoisds[date] = { fp, at: clock() };
  return out;
}

// Every observation of a poll line, for the request and failure counts.
function observations(line) {
  const all = [...Object.values(line.isc)];
  for (const w of Object.values(line.whoisds)) all.push(w.head, ...(w.zip ? [w.zip] : []));
  for (const feed of Object.keys(ROLLING)) all.push(line[feed].file, line[feed].commit);
  return all;
}

// One poll. `state` carries, between the polls of one process, the ETag of
// each rolling file and the last zip read of each WhoisDS path.
export async function pollOnce(state, { fetchFn = globalThis.fetch, runGh = gh, clock = Date.now } = {}) {
  const started = clock();
  const line = { started: iso(started), isc: {}, whoisds: {} };
  const tasks = [observeHead(iscUrl(null), fetchFn, clock).then((o) => (line.isc.latest = o))];
  for (const lag of ISC_LAGS) {
    const date = utcDate(started, lag);
    tasks.push(observeHead(iscUrl(date), fetchFn, clock).then((o) => (line.isc[date] = o)));
  }
  for (const lag of WHOISDS_LAGS) {
    const date = utcDate(started, lag);
    tasks.push(observeWhoisds(date, state, fetchFn, clock).then((o) => (line.whoisds[date] = o)));
  }
  for (const [feed, f] of Object.entries(ROLLING)) {
    line[feed] = {};
    tasks.push(
      observeRolling(f.url, state.etags[feed], fetchFn, clock).then((o) => {
        line[feed].file = o;
        if (!o.error && o.etag) state.etags[feed] = o.etag;
      }),
    );
    tasks.push(observeCommit(f.repo, f.path, runGh, clock).then((o) => (line[feed].commit = o)));
  }
  await Promise.all(tasks);
  const all = observations(line);
  line.ended = iso(clock());
  line.requests = all.length;
  line.failed = all.filter((o) => o.error).length;
  return line;
}

const sleepFor = (ms) => delay(ms);

export async function runPolls({ out, polls, intervalMs, start, fetchFn = globalThis.fetch, runGh = gh, clock = Date.now, sleep = sleepFor, env = process.env, log = console.log }) {
  mkdirSync(dirname(out), { recursive: true });
  const write = (o) => appendFileSync(out, `${JSON.stringify(o)}\n`);
  const ids = { run_id: env.GITHUB_RUN_ID ?? null, run_attempt: env.GITHUB_RUN_ATTEMPT ?? null };
  write({
    schema: SCHEMA,
    kind: 'start',
    ...ids,
    at: iso(clock()),
    start: iso(start),
    polls,
    interval_min: intervalMs / 60_000,
    node: process.version,
    runner_os: env.RUNNER_OS ?? process.platform,
    runner_arch: env.RUNNER_ARCH ?? process.arch,
    user_agent: USER_AGENT,
    isc_lags: ISC_LAGS,
    whoisds_lags: WHOISDS_LAGS,
    rolling: ROLLING,
  });
  const state = { etags: {}, whoisds: {} };
  let ran = 0;
  let skipped = 0;
  let silent = 0;
  for (let i = 0; i < polls; i++) {
    const slot = start + i * intervalMs;
    if (i + 1 < polls && clock() >= slot + intervalMs) {
      skipped += 1;
      continue;
    }
    const wait = slot - clock();
    if (wait > 0) await sleep(wait);
    let p;
    try {
      p = await pollOnce(state, { fetchFn, runGh, clock });
    } catch (e) {
      // Each observation catches its own failure, so this is a defect of the
      // poller; the poll is recorded as one with no answer and the loop goes on.
      p = { started: iso(clock()), error: errorText(e), requests: 0, failed: 0 };
    }
    write({ schema: SCHEMA, kind: 'poll', ...ids, poll: i, slot: iso(slot), late_ms: Math.max(0, Date.parse(p.started) - slot), ...p });
    ran += 1;
    if (p.requests === 0 || p.failed === p.requests) silent += 1;
    log(`poll ${i + 1}/${polls} ${p.started} answered ${p.requests - p.failed}/${p.requests}`);
  }
  write({ schema: SCHEMA, kind: 'end', ...ids, at: iso(clock()), ran, skipped, silent });
  return { ran, skipped, silent };
}

const USAGE = 'usage: node scripts/measure/feed-poll.mjs --out FILE [--polls 34] [--interval-min 10] [--start ISO]';

// `deps` replaces the network, the clock or the log in a test; the command line
// passes none.
export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const polls = args.polls === undefined ? 34 : Number(args.polls);
  const intervalMin = args['interval-min'] === undefined ? 10 : Number(args['interval-min']);
  const start = typeof args.start === 'string' && args.start !== '' ? Date.parse(args.start) : Date.now();
  if (typeof args.out !== 'string' || !Number.isInteger(polls) || polls < 1 || !(intervalMin > 0) || Number.isNaN(start)) {
    console.error(USAGE);
    return 2;
  }
  const out = resolve(args.out);
  let r;
  try {
    r = await runPolls({ out, polls, intervalMs: intervalMin * 60_000, start, ...deps });
  } catch (e) {
    console.error(`feed-poll: cannot write ${out}: ${errorText(e)}`);
    return 2;
  }
  console.log(`feed-poll: ran=${r.ran} skipped=${r.skipped} silent=${r.silent} out=${out}`);
  return r.silent > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
