// adapters/thc-ct/record.mjs — the recorder of the thc-ct fixtures (DOM-029,
// design section 13.2). It reads THC's two hosts once, anonymously, with the
// contact User-Agent, and never a whole file into the tree.
//
//   node adapters/thc-ct/record.mjs --out adapters/thc-ct/fixtures [--day 2026-10-31] [--absent YYYY-MM-DD]
//                                   [--from-line 327501] [--lines 2000] [--head-bytes 8388608]
//                                   [--cs2 URL --listing URL --resolve URL]
//
// In this order:
//   1. the recorded answers, each as the host gave it: GET cs2's index; HEAD
//      cs2's file of --day (a 200) and of --absent (a 404: a day not yet
//      published, by default the clock's own day); GET the bucket's listing
//      (one page, kept whole). The index, the HEAD and the listing must give
//      --day one size, and neither may name --absent;
//   2. the slice: GET the first --head-bytes bytes of --day's file from cs2
//      (Range: bytes=0-N, a 206), gunzipped as far as they go, and its lines
//      --from-line to --from-line + --lines - 1 (1-based) kept: at least one
//      line with upper case, one `*.` line, one with an xn-- label and one
//      address literal (refused numeric-tld under the fixture list), else
//      nothing is written. After them come the synthetic lines, then one blank
//      line:
//        the lower-case twin of the first upper-case line   (one record with it)
//        co.uk                                              (an ICANN public suffix, refused)
//        bücher.example                                     (Unicode: its punycode key)
//   3. the synthetic answers, every size the slice's gzip, never a real size
//      with a synthetic body: HEAD and GET of cs2's file of --day; the
//      listing, one entry, --day's real entry with the slice's size and hash;
//      the resolve URL of that entry, a 302 to a fixed CDN URL; and that URL, a
//      200 with the gzip;
//   4. the check: the harness (runAdapter) runs the live run over the
//      synthetic answers from { next: --day } at --day + 1 00:30Z and must
//      write the two segments of --day; the backfill of --day over them must
//      write the same two segments from the bucket; and the live run over the
//      recorded answers from { next: --absent } at --absent + 1 00:30Z must
//      write nothing and fault nothing. Else nothing is written;
//   5. --out/recorded/*.http.json (origin recorded, recorded_at the clock),
//      --out/*.http.json (origin synthetic), --out/slice-<day>.txt and
//      --out/recorded.json: the time, the command, the User-Agent, the days,
//      the file's size, Last-Modified and listing path, the slice's line and
//      decompressed byte range and the sha256 of its real lines, the synthetic
//      lines, the gzip's size and sha256, the listing's and the index's day
//      counts, and each file's sha256. A file already there is refused: a
//      recording is replaced by deleting it first.
// The 2026-10-31 fixtures hold the lines 327,501 to 329,500 of that day's
// file, its decompressed bytes 16,835,364 to 16,906,335 (end exclusive), read
// from the first 8 MiB of cs2's file; recorded.json names them.
//
// It reads no environment and holds no credential. The tests pass the hosts,
// a fetch and a clock (record.test.mjs), so they reach no network.
//
// stdout, one line each:
//   recorded NAME status N
//   slice DAY lines A-B bytes X-Y
//   wrote FILE (sha256 HEX)
// Exit codes: 0 written · 1 a host answered other than expected, a check
// failed, or the slice lacks a line it needs · 2 bad arguments, or a file of
// --out already exists.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { base64Of, ContractError, checkResult, jsonEqual, memoryWriter, parseRecording, RECORDING_FORMAT, replayFetch, runAdapter, validateSourceFile } from '@domains/adapter';
import { readBits } from '@domains/adapter/node';
import { loadPsl, normalise } from '@domains/names';
import { parseArgs, repeatedFlag } from '../../scripts/lib/args.mjs';
import { oneLine } from '../../scripts/lib/line.mjs';
import { USER_AGENT } from '../../scripts/lib/user-agent.mjs';
import { Fault, UsageError } from '../../scripts/root/lib.mjs';
import { isDay, nextDay, today } from './src/cursor.ts';
import { HOSTS, LIMITS, makeBackfill, makeRun } from './src/index.ts';
import { cs2Index, listingEntries } from './src/locate.ts';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2 });
const ROOT = resolve(import.meta.dirname, '..', '..');
// The list of the names package's tests: the fixtures replay under it.
export const PSL_FILE = join(ROOT, 'packages', 'names', 'test', 'fixtures', 'psl-2026-10-27.dat');
export const SOURCE_FILE = join(import.meta.dirname, 'source.json');
export const RECORDED_DIR = 'recorded';
export const DEFAULTS = Object.freeze({ day: '2026-10-31', fromLine: 327_501, lines: 2000, headBytes: 8 * 1024 * 1024 });
// The synthetic lines after the real ones, the twin first (derived from the slice).
export const SYNTHETIC_TAIL = Object.freeze(['co.uk', 'bücher.example']);
// The CDN URL the synthetic resolve redirects to: no real host signed it.
export const CDN = 'https://us.aws.cdn.hf.co/synthetic/';
// The response headers a recording keeps: no cookie, no request id. A body
// the fetch decoded keeps no Content-Encoding and no Content-Length.
// Each request's deadline: a stalled connection is a fault, never a wait with no end.
const READ_MS = 120_000;
const KEPT = ['content-type', 'last-modified', 'etag', 'accept-ranges', 'link', 'location', 'x-linked-size'];
const FLAGS = ['out', 'day', 'absent', 'from-line', 'lines', 'head-bytes', 'cs2', 'listing', 'resolve'];
const USAGE = 'usage: node adapters/thc-ct/record.mjs --out DIR [--day YYYY-MM-DD] [--absent YYYY-MM-DD] [--from-line N] [--lines N] [--head-bytes N] [--cs2 URL --listing URL --resolve URL]';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The adapter reads HTTP alone: a connection is a defect.
const noConnect = (address) => {
  throw new Error(`thc-ct connected to ${address?.hostname}:${address?.port}; it reads HTTP alone`);
};
const compact = (day) => day.replaceAll('-', '');
const isoSecond = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

function whole(v, name, min, max) {
  if (typeof v !== 'string' || !/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new UsageError(`--${name} ${JSON.stringify(v)} is not a whole number from ${min} to ${max}`);
  return Number(v);
}

function parse(argv, nowMs) {
  const a = parseArgs(argv);
  for (const k of Object.keys(a)) if (k !== '_' && !FLAGS.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  for (const k of FLAGS) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  if (a.out === undefined) throw new UsageError('--out is needed');
  const day = a.day ?? DEFAULTS.day;
  const absent = a.absent ?? today(isoSecond(nowMs));
  for (const [k, v] of [
    ['day', day],
    ['absent', absent],
  ])
    if (!isDay(v)) throw new UsageError(`--${k} ${JSON.stringify(v)} is not a calendar day YYYY-MM-DD from 2026-01-01`);
  if (absent <= day) throw new UsageError(`--absent ${absent} is not after --day ${day}`);
  const given = ['cs2', 'listing', 'resolve'].filter((k) => a[k] !== undefined);
  if (given.length !== 0 && given.length !== 3) throw new UsageError('--cs2, --listing and --resolve come together');
  const hosts = given.length === 3 ? { cs2: a.cs2, listing: a.listing, resolve: a.resolve } : HOSTS;
  return {
    out: a.out,
    day,
    absent,
    fromLine: a['from-line'] === undefined ? DEFAULTS.fromLine : whole(a['from-line'], 'from-line', 1, 1e9),
    lines: a.lines === undefined ? DEFAULTS.lines : whole(a.lines, 'lines', 1, 100_000),
    headBytes: a['head-bytes'] === undefined ? DEFAULTS.headBytes : whole(a['head-bytes'], 'head-bytes', 1024, 64 * 1024 * 1024),
    hosts,
  };
}

function kept(headers, decoded) {
  const out = {};
  for (const k of KEPT) {
    const v = headers.get(k);
    if (v !== null) out[k] = v;
  }
  if (!decoded) {
    const n = headers.get('content-length');
    if (n !== null) out['content-length'] = n;
  }
  return out;
}

// One request answered by a host, as a recording's JSON. `decoded` is true for
// a GET whose body the fetch may have decoded: its length is not recorded.
async function record(d, method, url, headers, now, decoded) {
  let res;
  try {
    res = await d.fetch(url, { method, headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(READ_MS) });
  } catch (e) {
    throw new Fault(`${method} ${url} failed: ${e.message}`);
  }
  let body;
  try {
    body = method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new Fault(`${method} ${url}: the body did not read: ${e.message}`);
  }
  return {
    status: res.status,
    body,
    headers: res.headers,
    json: {
      format: RECORDING_FORMAT,
      origin: 'recorded',
      recorded_at: now,
      request: { method, url },
      response: { status: res.status, headers: kept(res.headers, decoded), body_base64: base64Of(body) },
    },
  };
}

const synthetic = (method, url, status, headers, body = new Uint8Array(0)) => ({
  format: RECORDING_FORMAT,
  origin: 'synthetic',
  request: { method, url },
  response: { status, headers, body_base64: base64Of(body) },
});

// The lines of a truncated gzip head, each with its decompressed byte offset,
// until `want` whole lines are read or the bytes end.
async function headLines(gz, want) {
  const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const dec = new TextDecoder('utf-8', { fatal: true });
  const enc = new TextEncoder();
  const lines = [];
  let tail = '';
  let at = 0;
  for (;;) {
    let r;
    try {
      r = await reader.read();
    } catch {
      // The head ends inside the gzip stream: the lines before it are whole.
      break;
    }
    if (r.done) break;
    const parts = (tail + dec.decode(r.value, { stream: true })).split('\n');
    tail = parts.pop();
    for (const text of parts) {
      lines.push({ text, at });
      at += enc.encode(text).length + 1;
      if (lines.length >= want) {
        await reader.cancel().catch(() => undefined);
        return lines;
      }
    }
  }
  return lines;
}

// Step 2: the real lines and their range.
async function sliceOf(args, d, fileBytes, psl) {
  const url = `${args.hosts.cs2}${args.day}.txt.gz`;
  let res;
  try {
    res = await d.fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', range: `bytes=0-${args.headBytes - 1}` }, signal: AbortSignal.timeout(READ_MS) });
  } catch (e) {
    throw new Fault(`GET ${url} (the head) failed: ${e.message}`);
  }
  let gz;
  try {
    gz = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new Fault(`GET ${url} (the head): the body did not read: ${e.message}`);
  }
  const range = res.headers.get('content-range');
  if (res.status !== 206 || range !== `bytes 0-${args.headBytes - 1}/${fileBytes}` || gz.byteLength !== args.headBytes)
    throw new Fault(`GET ${url} with Range bytes=0-${args.headBytes - 1} answered ${res.status}, Content-Range ${JSON.stringify(range)}, ${gz.byteLength} B: not the head of the ${fileBytes} B file`);
  const last = args.fromLine + args.lines - 1;
  const lines = await headLines(gz, last);
  if (lines.length < last) throw new Fault(`the first ${args.headBytes} B of ${url} hold ${lines.length} whole lines, fewer than line ${last}: give a larger --head-bytes`);
  const real = lines.slice(args.fromLine - 1, last);
  const texts = real.map((l) => l.text);
  const has = {
    upper: texts.find((t) => /[A-Z]/.test(t)),
    wild: texts.find((t) => t.startsWith('*.')),
    xn: texts.find((t) => /(^|\.)xn--/.test(t)),
    literal: texts.find((t) => {
      const n = normalise(t, psl);
      return 'refused' in n && n.refused === 'numeric-tld';
    }),
  };
  const lacking = Object.entries(has)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  if (lacking.length > 0) throw new Fault(`the lines ${args.fromLine} to ${last} of ${url} hold no line of: ${lacking.join(', ')}`);
  const end = real.at(-1);
  return { texts, from: real[0].at, to: end.at + new TextEncoder().encode(end.text).length + 1, twin: has.upper.toLowerCase() };
}

export async function main(argv, deps = {}) {
  const d = {
    out: deps.out ?? console.log,
    err: deps.err ?? console.error,
    now: deps.now ?? (() => Date.now()),
    fetch: deps.fetch ?? fetch,
  };
  try {
    const args = parse(argv, d.now());
    const now = isoSecond(d.now());
    const day8 = compact(args.day);
    const names = {
      index: join(RECORDED_DIR, 'cs2-index.http.json'),
      head: join(RECORDED_DIR, `cs2-head-${day8}.http.json`),
      absent: join(RECORDED_DIR, `cs2-head-${compact(args.absent)}.http.json`),
      listing: join(RECORDED_DIR, 'hf-listing.http.json'),
      sHead: `cs2-head-${day8}.http.json`,
      sGet: `cs2-get-${day8}.http.json`,
      sListing: 'hf-listing.http.json',
      sResolve: `hf-resolve-${day8}.http.json`,
      sCdn: `hf-cdn-${day8}.http.json`,
      slice: `slice-${args.day}.txt`,
      meta: 'recorded.json',
    };
    for (const n of Object.values(names)) if (existsSync(join(args.out, n))) throw new UsageError(`${join(args.out, n)} exists: delete it first to record again`);
    const psl = await loadPsl(readFileSync(PSL_FILE));
    // A draft's url lies under its row's urls: the hosts given in place of
    // THC's (a test's double) take the place of the row's urls.
    const rows = validateSourceFile(JSON.parse(readFileSync(SOURCE_FILE, 'utf8')), readBits(ROOT)).sources;
    const sources = args.hosts === HOSTS ? rows : rows.map((r) => ({ ...r, urls: [args.hosts.cs2, args.hosts.resolve] }));
    const fileUrl = (day) => `${args.hosts.cs2}${day}.txt.gz`;

    // 1. The recorded answers.
    const index = await record(d, 'GET', args.hosts.cs2, {}, now, true);
    const head = await record(d, 'HEAD', fileUrl(args.day), { 'accept-encoding': 'identity' }, now, false);
    const gone = await record(d, 'HEAD', fileUrl(args.absent), { 'accept-encoding': 'identity' }, now, false);
    const listing = await record(d, 'GET', args.hosts.listing, { accept: 'application/json' }, now, true);
    for (const [n, r, want] of [
      [names.index, index, 200],
      [names.head, head, 200],
      [names.absent, gone, 404],
      [names.listing, listing, 200],
    ]) {
      d.out(`recorded ${n.replaceAll('\\', '/')} status ${r.status}`);
      if (r.status !== want) throw new Fault(`${r.json.request.method} ${r.json.request.url} answered ${r.status}, not ${want}`);
    }
    if (listing.headers.get('link') !== null) throw new Fault(`the listing ${args.hosts.listing} has a next page (Link: ${listing.headers.get('link')}); one page is recorded`);
    const listed = cs2Index(new TextDecoder().decode(index.body));
    const entries = new Map();
    listingEntries(JSON.parse(new TextDecoder().decode(listing.body)), entries, 'the listing');
    const fileBytes = Number(head.headers.get('content-length'));
    const entry = entries.get(args.day);
    if (listed.get(args.day)?.bytes !== fileBytes || entry?.size !== fileBytes)
      throw new Fault(
        `${args.day}: cs2's HEAD says ${fileBytes} B, its index ${listed.get(args.day)?.bytes ?? 'nothing'}, the listing ${entry?.size ?? 'nothing'}: the hosts do not agree on one file`,
      );
    if (listed.has(args.absent) || entries.has(args.absent)) throw new Fault(`${args.absent} is listed already: --absent names a day not yet published`);

    // 2. The slice.
    const s = await sliceOf(args, d, fileBytes, psl);
    d.out(`slice ${args.day} lines ${args.fromLine}-${args.fromLine + args.lines - 1} bytes ${s.from}-${s.to}`);
    const synthetics = [s.twin, ...SYNTHETIC_TAIL];
    const sliceText = `${[...s.texts, ...synthetics].join('\n')}\n\n`;
    const gz = new Uint8Array(gzipSync(Buffer.from(sliceText, 'utf8'), { level: 9 }));

    // 3. The synthetic answers.
    const lastModified = head.headers.get('last-modified') ?? 'Sun, 01 Nov 2026 00:05:02 GMT';
    const fileHeaders = { 'content-type': 'application/octet-stream', 'content-length': String(gz.byteLength), 'last-modified': lastModified, 'accept-ranges': 'bytes' };
    const realEntry = JSON.parse(new TextDecoder().decode(listing.body)).find((e) => e?.type === 'file' && e.path === entry.path);
    const synthEntry = { ...realEntry, size: gz.byteLength, xetHash: sha256(gz) };
    const resolveUrl = `${args.hosts.resolve}${entry.path}?download=true`;
    const cdnUrl = `${CDN}${args.day}.txt.gz`;
    const synth = {
      [names.sHead]: synthetic('HEAD', fileUrl(args.day), 200, fileHeaders),
      [names.sGet]: synthetic('GET', fileUrl(args.day), 200, fileHeaders, gz),
      [names.sListing]: synthetic('GET', args.hosts.listing, 200, { 'content-type': 'application/json' }, new TextEncoder().encode(JSON.stringify([synthEntry]))),
      [names.sResolve]: synthetic('GET', resolveUrl, 302, { location: cdnUrl, 'x-linked-size': String(gz.byteLength) }),
      [names.sCdn]: synthetic('GET', cdnUrl, 200, { 'content-type': 'application/gzip', 'content-length': String(gz.byteLength), 'accept-ranges': 'bytes' }, gz),
    };

    // 4. The check, in process.
    const synthRecordings = Object.entries(synth).map(([n, j]) => parseRecording(j, n));
    const realRecordings = [
      [names.absent, gone],
      [names.listing, listing],
    ].map(([n, r]) => parseRecording(r.json, n));
    const live = { run: makeRun(LIMITS, args.hosts) };
    const after = `${nextDay(args.day)}T00:30:00Z`;
    let one;
    let quiet;
    let filled;
    try {
      one = await runAdapter(live, { recordings: synthRecordings, psl, cursor: { next: args.day, open: [] }, now: after, userAgent: USER_AGENT, sources });
      quiet = await runAdapter(live, { recordings: realRecordings, psl, cursor: { next: args.absent, open: [] }, now: `${nextDay(args.absent)}T00:30:00Z`, userAgent: USER_AGENT, sources });
      // The backfill moves no cursor, so the harness's continuation does not hold it: one run, its result held to the contract.
      const ctx = Object.freeze({ fetch: replayFetch(synthRecordings).fetch, connect: noConnect, psl, now: after, userAgent: USER_AGENT, writer: memoryWriter({ sources }) });
      filled = checkResult(await makeBackfill(LIMITS, args.hosts)({ start: `${args.day}T00:00:00Z`, end: `${nextDay(args.day)}T00:00:00Z` }, ctx), 'the backfill check');
    } catch (e) {
      if (e instanceof ContractError) throw new Fault(`the recordings do not replay through the harness: ${e.message}`);
      throw e;
    }
    const segs = one.first.result.segments;
    if (segs.length !== 2 || one.first.result.errors.length > 0 || !jsonEqual(filled.segments, segs) || filled.errors.length > 0)
      throw new Fault(`the synthetic answers do not write the two segments of ${args.day} by both hosts: ${JSON.stringify([one.first.result.errors, filled.errors])}`);
    if (quiet.first.result.segments.length > 0 || quiet.first.result.errors.length > 0 || !jsonEqual(quiet.first.result.cursor, { next: args.absent, open: [] }))
      throw new Fault(`the recorded answers of ${args.absent} do not leave the day waiting: ${JSON.stringify(quiet.first.result)}`);

    // 5. The files.
    const sliceBytes = new TextEncoder().encode(sliceText);
    const files = [
      [names.index, `${JSON.stringify(index.json, null, 2)}\n`],
      [names.head, `${JSON.stringify(head.json, null, 2)}\n`],
      [names.absent, `${JSON.stringify(gone.json, null, 2)}\n`],
      [names.listing, `${JSON.stringify(listing.json, null, 2)}\n`],
      ...Object.entries(synth).map(([n, j]) => [n, `${JSON.stringify(j, null, 2)}\n`]),
      [names.slice, sliceBytes],
    ];
    const meta = {
      recorded_at: now,
      command: ['node', relative(ROOT, join(import.meta.dirname, 'record.mjs')).replaceAll('\\', '/'), ...argv].join(' '),
      user_agent: USER_AGENT,
      psl_sha256: psl.sha256,
      day: args.day,
      absent: args.absent,
      file: { url: fileUrl(args.day), bytes: fileBytes, last_modified: lastModified, etag: head.headers.get('etag'), listing_path: entry.path, listing_mtime: entry.mtime },
      slice: {
        from_line: args.fromLine,
        lines: args.lines,
        bytes_from: s.from,
        bytes_to: s.to,
        head_bytes: args.headBytes,
        real_sha256: sha256(new TextEncoder().encode(`${s.texts.join('\n')}\n`)),
        synthetic_lines: synthetics,
        trailing_blank_line: true,
        gzip_bytes: gz.byteLength,
        gzip_sha256: sha256(gz),
      },
      listing: { days: entries.size, bytes: [...entries.values()].reduce((n, e) => n + e.size, 0), first: [...entries.keys()].sort()[0] ?? null, last: [...entries.keys()].sort().at(-1) ?? null },
      index: { days: listed.size, first: [...listed.keys()].sort()[0] ?? null, last: [...listed.keys()].sort().at(-1) ?? null },
      files: Object.fromEntries(files.map(([n, body]) => [n.replaceAll('\\', '/'), sha256(body)])),
    };
    files.push([names.meta, `${JSON.stringify(meta, null, 2)}\n`]);
    mkdirSync(join(args.out, RECORDED_DIR), { recursive: true });
    for (const [n, body] of files) {
      const path = join(args.out, n);
      writeFileSync(path, body, { flag: 'wx' });
      d.out(`wrote ${path} (sha256 ${sha256(body)})`);
    }
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      d.err(`record: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof Fault) {
      d.err(oneLine(`record: FAIL ${e.message}; nothing is written`));
      return EXIT.fault;
    }
    if (e?.name === 'HostFault') {
      d.err(oneLine(`record: FAIL ${e.message}; nothing is written`));
      return EXIT.fault;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
