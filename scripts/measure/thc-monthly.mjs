// scripts/measure/thc-monthly.mjs — DOM-010: stream THC's whole monthly CSV
// once, and measure its columns, whether it carries CNAME targets, and how fast
// it streams.
//
// The CSV is read by `curl`, decompressed by `gzip -dc` and counted by one
// `awk -F,` pass. This script sits between them: it strips and checks curl's
// response heads (`curl -i`), counts and hashes the compressed bytes, resumes a
// dropped connection with a Range request, counts the uncompressed bytes, and
// reads each process's exit code from that process (AGENTS.md absolute 5).
// Nothing is written to disk but the result.
//
// Passes, in this order, each written to the result as it ends:
//   head     with --head-url: the first --head-bytes of another month's CSV,
//            read the same way, for its shape. gzip reports an unexpected end
//            of file at the cut; that is expected and recorded as `truncated`.
//   network  with --network-pass: the whole --url with no decompression, so
//            the speed is the network's alone. In the stream pass the speed is
//            that of the slowest stage, because a pipe carries back-pressure.
//   stream   the whole --url (or its --range A-B) through gzip and awk.
//
// Usage:
//   node scripts/measure/thc-monthly.mjs --url URL --out FILE [--range A-B]
//        [--network-pass [true|false]] [--head-url URL] [--head-bytes N]
//        [--awk BIN] [--deadline-min N] [--max-resumes N]
//   node scripts/measure/thc-monthly.mjs --verdict FILE
//
// A URL is https, or http to a loopback address (the tests' local server).
// --deadline-min (default 330) ends the passes in time to write the result
// inside a 360-minute job: curl is stopped and awk counts what it got.
//
// Exit codes, run: 0 every pass read all its bytes, and gzip and awk exited 0
//   on the whole stream (a --range read is a smoke test and never a pass, since
//   gzip is cut); 1 a pass was cut, refused or failed (the result says which);
//   2 could not run.
// Exit codes, --verdict: 0 the stream pass ended complete with gzip and awk
//   exit 0, the network pass read the same sha256, and the head pass read in
//   full; 1 any of these did not hold; 2 the file could not be read.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';

export const SCHEMA = 'thc-monthly/1';
// READ https://ip.thc.org/docs/bulk-data-access (2026-10-27): "Records: 6.36
// Billion" for September 2026. The oracle the record count is held against.
export const PAGE_RECORDS = 6.36e9;
// Decimal units throughout: MB is 10^6 B, "the first 2 GB" is 2 * 10^9 B.
export const MB = 1e6;
export const FIRST_SPAN = 2e9;
const HEAD_LIMIT = 64 * 1024;
const TEXT_CAP = 8 * 1024;
const AWK_OUT_CAP = 1024 * 1024;
// A line longer than this is passed to awk even when a cut gzip stream ends
// inside it; only a shorter partial last line is held back and dropped.
const CARRY_LIMIT = 1024 * 1024;
const CPU_INTERVAL_MS = 2000;
const RETRY_CAP_MS = 120_000;
// curl exit codes that a second request cannot change: unsupported protocol,
// failed to initialise, malformed URL, too many redirects.
const PERMANENT_CURL = new Set([1, 2, 3, 47]);

// One pass of awk over `address,name` lines. LC_ALL=C gives byte semantics to
// length, ranges and regexes. A line number goes through %.0f because some awks
// print an integer past 2^31 in exponent form. Keys are read by name.
//   suspect   a line with three or more fields, or a non-empty line whose first
//             field is not an IPv4 or IPv6 address: the CNAME verdict's input
//   name_odd  a second field with a byte outside [A-Za-z0-9._*-]
// A line that matches one of the two whole-line patterns is an IPv4 or IPv6
// address, a comma and a name of those bytes, so it is counted without
// splitting fields; every other line takes the field-by-field path. The fast
// path gives the same output and is 2.3 times faster: 1.15 s against 2.6 s
// over 1,353,216 lines with GNU Awk 5.3.2 on Linux (MEASURED 2026-10-28 in
// WSL on the operator's i7-12700H). The test holds it equal to the
// field-by-field program.
export const AWK_PROGRAM = String.raw`BEGIN { FS = ","; prev = -1 }
/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+,[-A-Za-z0-9._*]+$/ { v4++; f2++; if (prev != 4) { runs++; prev = 4 }; if (fa == "") fa = $0; la = $0; next }
/^[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*,[-A-Za-z0-9._*]+$/ { v6++; f2++; if (prev != 6) { runs++; prev = 6 }; if (fa == "") fa = $0; la = $0; next }
{
  nf[NF]++
  a = $1
  if (a ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) fam = 4
  else if (index(a, ":") > 0 && a ~ /^[0-9A-Fa-f:.]+$/) fam = 6
  else fam = 0
  if (fam == 4) v4++
  else if (fam == 6) v6++
  else if (NF > 0) bad++
  if (fam != prev) { runs++; prev = fam }
  if (fam != 0) { if (fa == "") fa = a; la = a }
  if (NF != 2 && fo == "") fo = sprintf("%.0f", NR) "\t" NF "\t" substr($0, 1, 300)
  if (NF > 2 || (NF > 0 && fam == 0)) { sc++; if (sc <= 20) s[sc] = sprintf("%.0f", NR) "\t" substr($0, 1, 300) }
  if (NF > 1 && $2 ~ /[^-A-Za-z0-9._*]/) { oc++; if (oc <= 20) o[oc] = sprintf("%.0f", NR) "\t" substr($0, 1, 300) }
}
END {
  nf[2] += f2
  printf "records\t%.0f\n", NR
  for (k in nf) if (nf[k] > 0) printf "fields\t%s\t%.0f\n", k, nf[k]
  printf "ipv4\t%.0f\nipv6\t%.0f\nnot_address\t%.0f\nfamily_runs\t%.0f\n", v4, v6, bad, runs
  i = index(fa, ","); if (i > 0) fa = substr(fa, 1, i - 1)
  i = index(la, ","); if (i > 0) la = substr(la, 1, i - 1)
  printf "first_address\t%s\nlast_address\t%s\n", fa, la
  if (fo != "") printf "first_other_field_count\t%s\n", fo
  printf "suspect_count\t%.0f\n", sc
  for (i = 1; i <= sc && i <= 20; i++) printf "suspect\t%s\n", s[i]
  printf "name_odd_count\t%.0f\n", oc
  for (i = 1; i <= oc && i <= 20; i++) printf "name_odd\t%s\n", o[i]
  printf "end\tok\n"
}
`;

// A guard fired: the answer is not the bytes that were asked for. `retry` marks
// the statuses worth asking again (429 and 5xx), with the delay to honour.
export class Refused extends Error {
  constructor(message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'Refused';
    this.status = status;
    this.retry = status === 429 || (status !== null && status >= 500);
    this.retryAfterMs = retryAfterMs;
  }
}

// The reader of the bytes (gzip) closed its input.
class SinkClosed extends Error {
  constructor(message) {
    super(message);
    this.name = 'SinkClosed';
  }
}

class Usage extends Error {
  constructor(message) {
    super(message);
    this.name = 'Usage';
  }
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
// Data from the file is untrusted: it is printed as a JSON string, so no control
// byte reaches a terminal.
const shown = (text) => JSON.stringify(text);
// A signed redirect URL in curl's message keeps its host and path only.
const masked = (text) => text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?<query>');

// The curl --proto value for a URL: https only, or http to a loopback address.
export function protoFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Usage(`not a URL: ${shown(url)}`);
  }
  if (u.protocol === 'https:') return '=https';
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return '=http,https';
  throw new Usage(`a URL is https, or http to a loopback address: ${shown(url)}`);
}

export function parseRange(text) {
  const m = /^(\d+)-(\d+)$/.exec(String(text));
  if (!m || Number(m[1]) > Number(m[2]) || !Number.isSafeInteger(Number(m[2]))) throw new Usage(`--range takes A-B with A <= B: ${shown(text)}`);
  return { from: Number(m[1]), to: Number(m[2]) };
}

// One response head as curl -i prints it: a status line and header lines.
export function parseHead(text) {
  const lines = text.split('\r\n');
  const m = /^HTTP\/[0-9.]+ ([0-9]{3})\b/.exec(lines[0]);
  if (!m) throw new Refused(`not an HTTP status line: ${shown(lines[0].slice(0, 80))}`);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) throw new Refused(`not a header line: ${shown(masked(line).slice(0, 80))}`);
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(m[1]), headers };
}

// Splits curl -i -L output into the heads and the body. curl prints the head of
// each redirect it follows and then the next head, so a 3xx with a Location (or
// a 1xx) is followed by another head; the first other head is the final one.
export class HeadReader {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.heads = [];
    this.done = false;
  }

  // Bytes of curl's output in; the body bytes after the final head out (maybe
  // none), or null while that head is incomplete.
  push(chunk) {
    if (this.done) return chunk;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    for (;;) {
      const end = this.pending.indexOf('\r\n\r\n');
      if (end === -1) {
        if (this.pending.length > HEAD_LIMIT) throw new Refused(`no end of a response head within ${HEAD_LIMIT} B`);
        return null;
      }
      const head = parseHead(this.pending.subarray(0, end).toString('latin1'));
      this.heads.push(head);
      this.pending = this.pending.subarray(end + 4);
      if (head.status < 200 || (head.status >= 300 && head.status < 400 && head.headers.location)) continue;
      this.done = true;
      const body = this.pending;
      this.pending = Buffer.alloc(0);
      return body;
    }
  }

  get final() {
    return this.done ? this.heads.at(-1) : null;
  }
}

function intHeader(value, name) {
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Refused(`${name} is not a byte count: ${shown(value ?? '(absent)')}`);
  return Number(value);
}

function retryAfterMs(value) {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value) * 1000, RETRY_CAP_MS);
}

// Checks the final head against the request. `want`: { from, to, total, etag },
// `to` null for the end of the file, `total` and `etag` null until the first
// answer gives them. Returns { total, length, etag }: the file's size, the bytes
// this response must carry, and its ETag.
export function checkFinal(head, want) {
  const h = head.headers;
  const whole = want.from === 0 && want.to === null;
  const expected = whole ? 200 : 206;
  if (head.status !== expected) {
    const asked = whole ? 'the whole file' : `a Range from byte ${want.from}`;
    throw new Refused(`HTTP ${head.status} for ${asked}; expected ${expected}`, { status: head.status, retryAfterMs: retryAfterMs(h['retry-after']) });
  }
  const enc = h['content-encoding'];
  if (enc !== undefined && enc.toLowerCase() !== 'identity') throw new Refused(`the body is ${shown(enc)}-encoded, not the file's own bytes`);
  let total;
  let start;
  let end;
  if (whole) {
    total = intHeader(h['content-length'], 'content-length');
    start = 0;
    end = total - 1;
  } else {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(h['content-range'] ?? '');
    if (!m) throw new Refused(`content-range is not bytes A-B/TOTAL: ${shown(h['content-range'] ?? '(absent)')}`);
    [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const wantEnd = Math.min(want.to ?? total - 1, total - 1);
    if (start !== want.from || end !== wantEnd) throw new Refused(`content-range ${shown(h['content-range'])} does not answer the Range ${want.from}-${want.to ?? ''}`);
    if (h['content-length'] !== undefined && intHeader(h['content-length'], 'content-length') !== end - start + 1) throw new Refused('content-length does not match content-range');
  }
  if (want.total !== null && total !== want.total) throw new Refused(`the file is ${total} B and was ${want.total} B: it changed between requests`);
  const etag = h.etag ?? null;
  if (want.etag !== null && etag !== want.etag) throw new Refused(`the ETag is ${shown(etag)} and was ${shown(want.etag)}: the file changed between requests`);
  return { total, length: end - start + 1, etag };
}

// Bytes over time from `start` (ms, performance.now()): the whole span, the
// first FIRST_SPAN bytes, and each minute.
export class Meter {
  constructor(start, span = FIRST_SPAN) {
    this.start = start;
    this.span = span;
    this.bytes = 0;
    this.firstByte = null;
    this.spanAt = null;
    this.minutes = [];
  }

  add(n, now) {
    if (this.firstByte === null) this.firstByte = now;
    this.bytes += n;
    const m = Math.floor((now - this.start) / 60_000);
    while (this.minutes.length <= m) this.minutes.push(0);
    this.minutes[m] += n;
    if (this.spanAt === null && this.bytes >= this.span) this.spanAt = { bytes: this.bytes, at: now };
  }

  summary(end) {
    const seconds = (end - this.start) / 1000;
    const spanSeconds = this.spanAt ? (this.spanAt.at - this.start) / 1000 : null;
    return {
      bytes: this.bytes,
      seconds: r3(seconds),
      mb_per_s: seconds > 0 ? r3(this.bytes / MB / seconds) : null,
      seconds_to_first_byte: this.firstByte === null ? null : r3((this.firstByte - this.start) / 1000),
      first_2gb: this.spanAt ? { bytes: this.spanAt.bytes, seconds: r3(spanSeconds), mb_per_s: r3(this.spanAt.bytes / MB / spanSeconds) } : null,
      per_minute_mb_per_s: this.minutes.map((b, i) => r3(b / MB / Math.max(0.001, Math.min(60, seconds - 60 * i)))),
    };
  }
}

// utime and stime of /proc/PID/stat, in clock ticks. The command name sits in
// parentheses and may hold spaces, so fields are counted after the last ')':
// field 3 (state) is index 0, utime (field 14) index 11, stime (field 15) 12.
export function parseProcStat(text) {
  const rest = text
    .slice(text.lastIndexOf(')') + 2)
    .trim()
    .split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) throw new Error('unreadable /proc stat line');
  return { utime, stime };
}

function clockTicks() {
  if (process.platform !== 'linux' || !existsSync('/proc/self/stat')) return null;
  const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 6000 });
  const ticks = Number(String(r.stdout ?? '').trim());
  return r.status === 0 && Number.isInteger(ticks) && ticks > 0 ? ticks : null;
}

// CPU seconds of child processes, by name, from /proc. Each figure is the last
// sample before the process ended, so it undercounts by at most the interval.
// A process is no longer read once it has exited, so a reused PID is never read.
class CpuSampler {
  constructor(ticks) {
    this.ticks = ticks;
    this.procs = [];
    this.timer = null;
  }

  get enabled() {
    return this.ticks !== null;
  }

  track(name, child) {
    if (!this.enabled || child.pid === undefined) return;
    const p = { name, pid: child.pid, ended: false, utime: 0, stime: 0 };
    this.procs.push(p);
    child.once('exit', () => {
      p.ended = true;
    });
    this.read(p);
  }

  read(p) {
    if (p.ended) return;
    try {
      Object.assign(p, parseProcStat(readFileSync(`/proc/${p.pid}/stat`, 'utf8')));
    } catch {
      // The process ended between samples: its last sample stands.
    }
  }

  start() {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      for (const p of this.procs) this.read(p);
    }, CPU_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  report(nodeStart, seconds) {
    const share = (user, sys) => ({ user_s: r3(user), sys_s: r3(sys), utilization: seconds > 0 ? r3((user + sys) / seconds) : null });
    const node = process.cpuUsage(nodeStart);
    const out = { sample_interval_s: CPU_INTERVAL_MS / 1000, node: share(node.user / 1e6, node.system / 1e6) };
    if (!this.enabled) return { ...out, children: null, note: 'children not measured: no /proc on this machine' };
    const by = {};
    for (const p of this.procs) {
      by[p.name] ??= { user: 0, sys: 0 };
      by[p.name].user += p.utime / this.ticks;
      by[p.name].sys += p.stime / this.ticks;
    }
    out.children = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, share(v.user, v.sys)]));
    out.note = 'utilization is CPU seconds over the pass wall seconds; each child figure undercounts by at most the interval';
    return out;
  }
}

// Resolves with how the child ended, from that child: { code, signal, error }.
function exitOf(child) {
  return new Promise((resolve) => {
    child.once('error', (err) => resolve({ code: null, signal: null, error: err.message }));
    child.once('close', (code, signal) => resolve({ code, signal, error: null }));
  });
}

// Reads a stream to its end, keeping at most `cap` bytes.
function capture(stream, cap = TEXT_CAP) {
  const parts = [];
  let kept = 0;
  let seen = 0;
  stream.on('data', (b) => {
    seen += b.length;
    if (kept < cap) {
      const piece = b.subarray(0, cap - kept);
      parts.push(piece);
      kept += piece.length;
    }
  });
  return new Promise((resolve) => {
    stream.once('close', () => resolve({ text: Buffer.concat(parts).toString('utf8'), truncated: seen > kept }));
  });
}

// Writes with back-pressure; rejects when the reader closed its input.
function writeTo(stream, chunk) {
  if (stream.destroyed || stream.writableEnded) return Promise.reject(new SinkClosed('the reader closed its input'));
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('close', onClose);
      stream.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new SinkClosed('the reader closed its input'));
    };
    const onError = (err) => {
      cleanup();
      reject(new SinkClosed(`the reader closed its input: ${err.code ?? err.message}`));
    };
    stream.on('drain', onDrain);
    stream.on('close', onClose);
    stream.on('error', onError);
  });
}

function curlArgs(url, range) {
  const proto = protoFor(url);
  const args = ['-sS', '-L', '-i', '--proto', proto, '--proto-redir', proto, '--max-redirs', '5', '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '300'];
  if (range !== null) args.push('-r', range);
  args.push(url);
  return args;
}

// One curl request. Body bytes are checked against the final head, hashed,
// metered and handed to `sink` in order; nothing past the declared length is.
async function attempt(url, range, want, ctx) {
  const started = performance.now();
  const child = spawn('curl', curlArgs(url, range), { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = exitOf(child);
  ctx.sampler.track('curl', child);
  const stderr = capture(child.stderr);
  const stop = () => child.kill('SIGTERM');
  ctx.signal.addEventListener('abort', stop, { once: true });
  // A listener added to a signal that has already fired never runs.
  if (ctx.signal.aborted) stop();
  const reader = new HeadReader();
  let checked = null;
  let bytes = 0;
  let error = null;
  try {
    for await (const chunk of child.stdout) {
      const body = reader.push(chunk);
      if (body === null) continue;
      checked ??= checkFinal(reader.final, want);
      if (body.length === 0) continue;
      if (bytes + body.length > checked.length) throw new Refused(`more bytes than the ${checked.length} B the response declared`);
      bytes += body.length;
      ctx.hash.update(body);
      ctx.meter.add(body.length, performance.now());
      await ctx.sink(body);
    }
  } catch (err) {
    error = err;
    stop();
  } finally {
    ctx.signal.removeEventListener('abort', stop);
  }
  const exit = await done;
  const err = await stderr;
  const located = reader.heads.filter((h) => h.headers.location).at(-1);
  let finalHost = null;
  if (located) {
    try {
      finalHost = new URL(located.headers.location, url).host;
    } catch {
      finalHost = null; // an unparseable Location names no host
    }
  }
  return {
    checked,
    bytes,
    error,
    exit,
    finalHost,
    lastModified: reader.heads.findLast((h) => h.headers['last-modified'])?.headers['last-modified'] ?? null,
    record: {
      range,
      status: reader.final?.status ?? null,
      exit_code: exit.code,
      signal: exit.signal,
      bytes,
      seconds: r3((performance.now() - started) / 1000),
      error: error ? `${error.name}: ${error.message}` : (exit.error ?? null),
      stderr: masked(err.text.trim()),
    },
  };
}

// Reads `range` ({from, to} or null for the whole file) of `url` to `ctx.sink`,
// resuming a short read from the next byte with a Range request.
async function streamUrl(url, range, ctx) {
  const to = range ? range.to : null;
  const hash = createHash('sha256');
  const meter = new Meter(performance.now());
  ctx.progress.meter = meter;
  const attempts = [];
  let offset = range ? range.from : 0;
  let total = null;
  let etag = null;
  let lastModified = null;
  let finalHost = null;
  let ended = 'incomplete';
  let reason = null;
  const stopped = () => {
    ended = String(ctx.signal.reason);
    reason = `stopped by the ${ended} at byte ${offset}`;
  };
  for (let n = 0; ; n++) {
    if (ctx.signal.aborted) {
      stopped();
      break;
    }
    const asked = offset === 0 && to === null ? null : `${offset}-${to ?? ''}`;
    const a = await attempt(url, asked, { from: offset, to, total, etag }, { ...ctx, hash, meter });
    attempts.push(a.record);
    if (a.checked) {
      total = a.checked.total;
      etag ??= a.checked.etag;
    }
    lastModified ??= a.lastModified;
    finalHost ??= a.finalHost;
    offset += a.bytes;
    const end = total === null ? null : to === null ? total : Math.min(to + 1, total);
    if (end !== null && offset === end && !(a.error instanceof Refused) && !(a.error instanceof SinkClosed)) {
      ended = 'complete';
      break;
    }
    if (ctx.signal.aborted) {
      stopped();
      break;
    }
    if (a.error instanceof SinkClosed) {
      ended = 'sink-closed';
      reason = `gzip closed its input at byte ${offset} (gzip's and awk's records say why)`;
      break;
    }
    if (a.error instanceof Refused && !a.error.retry) {
      ended = 'refused';
      reason = a.error.message;
      break;
    }
    if (a.error === null && a.checked === null && PERMANENT_CURL.has(a.exit.code)) {
      ended = 'refused';
      reason = `curl exit ${a.exit.code}: ${a.record.stderr || 'no message'}`;
      break;
    }
    if (n >= ctx.maxResumes) {
      reason = `short at byte ${offset} after ${n} resumes (curl exit ${a.exit.code})`;
      break;
    }
    const wait = a.error?.retryAfterMs ?? Math.min(2000 * (n + 1), RETRY_CAP_MS);
    ctx.log(`${ctx.progress.label}: short at byte ${offset} (curl exit ${a.exit.code}${a.error ? `, ${a.error.message}` : ''}); resuming in ${wait / 1000} s`);
    await delay(wait, undefined, { signal: ctx.signal }).catch(() => {
      // The deadline or a signal ended the wait: the next turn of the loop records it.
    });
  }
  const now = performance.now();
  const from = range ? range.from : 0;
  return {
    ended,
    reason,
    complete: ended === 'complete',
    expected_bytes: total === null ? null : (to === null ? total : Math.min(to + 1, total)) - from,
    http: { total, etag, last_modified: lastModified, final_host: finalHost, resumes: attempts.length - 1, attempts },
    sha256: hash.digest('hex'),
    ...meter.summary(now),
  };
}

export function gzipStatus(code, stderr) {
  if (code === 0) return 'ok';
  if (/unexpected end of file/i.test(stderr)) return 'truncated';
  if (code === 2) return 'warning';
  return 'error';
}

// awk's key<TAB>value lines into counts. An unknown key, a missing key or no
// closing `end` line refuses the output.
export function parseAwk(text) {
  const counts = {
    records: null,
    fields: {},
    ipv4: null,
    ipv6: null,
    not_address: null,
    family_runs: null,
    first_address: null,
    last_address: null,
    first_other_field_count: null,
    suspect_count: null,
    suspects: [],
    name_odd_count: null,
    name_odd_examples: [],
  };
  const numeric = new Set(['records', 'ipv4', 'ipv6', 'not_address', 'family_runs', 'suspect_count', 'name_odd_count']);
  const example = (rest) => {
    const i = rest.indexOf('\t');
    return { line: Number(rest.slice(0, i)), text: rest.slice(i + 1) };
  };
  let closed = false;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    const key = tab === -1 ? line : line.slice(0, tab);
    const rest = tab === -1 ? '' : line.slice(tab + 1);
    if (numeric.has(key)) counts[key] = Number(rest);
    else if (key === 'fields') {
      const [nf, n] = rest.split('\t');
      counts.fields[nf] = Number(n);
    } else if (key === 'first_address' || key === 'last_address') counts[key] = rest === '' ? null : rest;
    else if (key === 'first_other_field_count') {
      const [nr, nf] = rest.split('\t', 2);
      counts.first_other_field_count = { line: Number(nr), fields: Number(nf), text: rest.split('\t').slice(2).join('\t') };
    } else if (key === 'suspect') counts.suspects.push(example(rest));
    else if (key === 'name_odd') counts.name_odd_examples.push(example(rest));
    else if (key === 'end') closed = true;
    else throw new Error(`awk printed an unknown key ${shown(key)}`);
  }
  if (!closed) throw new Error('awk printed no closing end line');
  for (const k of numeric) if (!Number.isFinite(counts[k])) throw new Error(`awk printed no ${k}`);
  return counts;
}

// The stream pass: curl into gzip -dc into awk, with this process between each.
async function pipelinePass(label, url, range, ctx) {
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const sampler = new CpuSampler(ctx.ticks);
  sampler.start();
  ctx.progress.label = label;
  const env = { ...process.env, LC_ALL: 'C' };
  const gzip = spawn('gzip', ['-dc'], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const awk = spawn(ctx.awk, ['-f', ctx.awkFile], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const gzipDone = exitOf(gzip);
  const awkDone = exitOf(awk);
  sampler.track('gzip', gzip);
  sampler.track('awk', awk);
  // An EPIPE on a reader that died is answered in writeTo; this keeps it from
  // being an unhandled error event.
  gzip.stdin.on('error', () => {});
  awk.stdin.on('error', () => {});
  // A child that exits before its input was ended has its stdin destroyed, so a
  // write waiting on it fails now. Without this, on Windows, a write to an awk
  // that had exited at once was released only after 7.5 s, and the read went
  // on to 270,053 B of a 306,705 B trickle; with it the read stops at 3,813 B
  // in 0.2 s (MEASURED 2026-10-28 on the operator's machine). awk gone means
  // no count can come of the rest, so gzip is stopped with it.
  let gzipFed = false;
  let awkFed = false;
  gzip.once('exit', () => {
    if (!gzipFed) gzip.stdin.destroy();
  });
  awk.once('exit', () => {
    if (awkFed) return;
    awk.stdin.destroy();
    gzip.kill('SIGTERM');
  });
  const gzipErr = capture(gzip.stderr);
  const awkErr = capture(awk.stderr);
  const awkOut = capture(awk.stdout, AWK_OUT_CAP);
  const unz = new Meter(t0);
  ctx.progress.unz = unz;

  const feed = (async () => {
    try {
      return await streamUrl(url, range, { ...ctx, sampler, sink: (b) => writeTo(gzip.stdin, b) });
    } finally {
      gzipFed = true;
      gzip.stdin.end();
    }
  })();

  const drain = (async () => {
    let carry = null;
    let failed = null;
    // awk gone means no count can come of the rest: gzip is stopped, so the
    // feed sees its reader close and curl stops too, rather than reading on.
    const put = async (b) => {
      if (failed !== null) return;
      await writeTo(awk.stdin, b).catch((err) => {
        failed = err;
        gzip.kill('SIGTERM');
      });
    };
    for await (const chunk of gzip.stdout) {
      unz.add(chunk.length, performance.now());
      const nl = chunk.lastIndexOf(10);
      if (nl === -1) {
        carry = carry ? Buffer.concat([carry, chunk]) : chunk;
        if (carry.length > CARRY_LIMIT) {
          await put(carry);
          carry = null;
        }
        continue;
      }
      if (carry) await put(carry);
      await put(chunk.subarray(0, nl + 1));
      carry = nl + 1 < chunk.length ? chunk.subarray(nl + 1) : null;
    }
    const gz = await gzipDone;
    let dropped = 0;
    // A partial last line after a cut stream is not a line of the file.
    if (carry && gz.code === 0) await put(carry);
    else if (carry) dropped = carry.length;
    awkFed = true;
    awk.stdin.end();
    return { dropped, failed };
  })();

  const [stream, drained] = await Promise.all([feed, drain]);
  const [gz, ak, gzText, akText, out] = await Promise.all([gzipDone, awkDone, gzipErr, awkErr, awkOut]);
  sampler.stop();
  const seconds = (performance.now() - t0) / 1000;
  let counts = null;
  let countsError = null;
  try {
    if (out.truncated) throw new Error(`awk printed more than ${AWK_OUT_CAP} B`);
    counts = parseAwk(out.text);
  } catch (err) {
    countsError = err.message;
  }
  return {
    kind: 'pipeline',
    label,
    url,
    range: range ? `${range.from}-${range.to}` : null,
    ...stream,
    uncompressed: { bytes: unz.bytes, mb_per_s: seconds > 0 ? r3(unz.bytes / MB / seconds) : null, dropped_partial_line_bytes: drained.dropped },
    records_per_s: counts && seconds > 0 ? Math.round(counts.records / seconds) : null,
    gzip: { exit_code: gz.code, signal: gz.signal, status: gzipStatus(gz.code, gzText.text), stderr: gzText.text.trim(), spawn_error: gz.error },
    awk: { exit_code: ak.code, signal: ak.signal, stderr: akText.text.trim(), spawn_error: ak.error, write_error: drained.failed ? drained.failed.message : null },
    counts,
    counts_error: countsError,
    cpu: sampler.report(cpu0, seconds),
  };
}

// The whole file with no decompression: the network's own speed.
async function networkPass(url, range, ctx) {
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const sampler = new CpuSampler(ctx.ticks);
  sampler.start();
  ctx.progress.label = 'network';
  ctx.progress.unz = null;
  const stream = await streamUrl(url, range, { ...ctx, sampler, sink: async () => {} });
  sampler.stop();
  return { kind: 'network', label: 'network', url, range: range ? `${range.from}-${range.to}` : null, ...stream, cpu: sampler.report(cpu0, (performance.now() - t0) / 1000) };
}

const notRun = (kind, label, why) => ({ kind, label, ended: 'not-run', reason: why, complete: false });

// The verdict over a result: whether the whole stream ended complete without a
// gzip error, and whether any line carries more than `address,name`.
export function verdictOf(result) {
  const { stream: s, network: n, head: h } = result.passes;
  const reasons = [];
  if (!s || s.ended === 'not-run') reasons.push(`the stream did not run${s?.reason ? `: ${s.reason}` : ''}`);
  else {
    if (s.range !== null) reasons.push(`a --range read (${s.range}) is a smoke test, not a pass`);
    if (!s.complete) reasons.push(`the stream is ${s.ended}: ${s.reason ?? 'no reason recorded'}`);
    if (s.gzip.exit_code !== 0)
      reasons.push(
        s.range !== null && s.gzip.status === 'truncated' ? 'gzip: truncated at the cut of the range read (expected for a partial read)' : `gzip: ${s.gzip.status}, exit ${s.gzip.exit_code}`,
      );
    if (s.awk.exit_code !== 0) reasons.push(`awk: exit ${s.awk.exit_code}`);
    if (!s.counts) reasons.push(`awk's counts are unreadable: ${s.counts_error}`);
  }
  if (n) {
    if (!n.complete) reasons.push(`the network pass is ${n.ended}: ${n.reason ?? 'no reason recorded'}`);
    else if (s?.complete && n.sha256 !== s.sha256) reasons.push('the network pass and the stream read different bytes (sha256 differs)');
  }
  if (h) {
    if (!h.complete) reasons.push(`the head pass is ${h.ended}: ${h.reason ?? 'no reason recorded'}`);
    else if (h.awk.exit_code !== 0 || !h.counts) reasons.push(`the head pass's awk failed: exit ${h.awk.exit_code}${h.counts_error ? `, ${h.counts_error}` : ''}`);
  }
  const suspects = (s?.counts?.suspect_count ?? 0) + (h?.counts?.suspect_count ?? 0);
  const streamOk = Boolean(s && s.complete && s.range === null && s.gzip.exit_code === 0 && s.awk.exit_code === 0 && s.counts);
  const cnames = suspects > 0 ? 'present' : streamOk ? 'absent' : 'unknown';
  return { cnames, stream_ok: streamOk, pass: streamOk && reasons.length === 0, reasons };
}

function histogram(fields) {
  return Object.keys(fields)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => `${k}=${fmt(fields[k])}`)
    .join(' ');
}

function speedLine(name, p) {
  const span = p.first_2gb ? `; first 2 GB ${p.first_2gb.mb_per_s} MB/s` : '';
  return `${name}: ${fmt(p.bytes)} B in ${p.seconds} s, ${p.mb_per_s} MB/s${span}; first byte after ${p.seconds_to_first_byte} s; ${p.http.resumes} resumes`;
}

function cpuLine(cpu) {
  if (!cpu) return null;
  const parts = Object.entries(cpu.children ?? {}).map(([k, v]) => `${k} ${r3(v.user_s + v.sys_s)} s (${v.utilization})`);
  parts.push(`node ${r3(cpu.node.user_s + cpu.node.sys_s)} s (${cpu.node.utilization})`);
  return `cpu: ${parts.join(', ')}${cpu.children ? '' : '; children not measured here'}`;
}

function countLines(prefix, c) {
  const out = [
    `${prefix}records: ${fmt(c.records)}`,
    `${prefix}fields: ${histogram(c.fields)}`,
    `${prefix}ipv4 ${fmt(c.ipv4)}, ipv6 ${fmt(c.ipv6)}, not an address ${fmt(c.not_address)}, family runs ${fmt(c.family_runs)}`,
    `${prefix}first address ${c.first_address ?? '-'}, last address ${c.last_address ?? '-'}`,
    `${prefix}first line with a field count other than 2: ${c.first_other_field_count ? `line ${c.first_other_field_count.line}, ${c.first_other_field_count.fields} fields, ${shown(c.first_other_field_count.text)}` : 'none'}`,
    `${prefix}names with a byte outside [A-Za-z0-9._*-]: ${fmt(c.name_odd_count)}`,
  ];
  for (const e of c.suspects) out.push(`${prefix}suspect line ${e.line}: ${shown(e.text)}`);
  return out;
}

// The lines --verdict prints, and the run prints at its end.
export function verdictLines(result) {
  const v = verdictOf(result);
  const { stream: s, network: n, head: h } = result.passes;
  const lines = [`DOM-010 THC monthly CSV, ${result.args.url}${s?.range ? ` (range ${s.range})` : ''}`];
  if (s && s.ended !== 'not-run') {
    lines.push(`stream: ${s.ended}, ${fmt(s.bytes)} B of ${fmt(s.expected_bytes ?? '-')} B, sha256 ${s.sha256}`);
    lines.push(`gzip: exit ${s.gzip.exit_code} (${s.gzip.status})${s.gzip.stderr ? ` ${shown(s.gzip.stderr)}` : ''}`);
    lines.push(`awk: exit ${s.awk.exit_code} (${result.conditions.awk ?? result.args.awk})`);
    if (s.counts) {
      lines.push(...countLines('', s.counts));
      if (s.range === null) lines.push(`records against the page's 6.36 billion: ratio ${r3(s.counts.records / PAGE_RECORDS)}`);
    }
    lines.push(speedLine('stream (compressed, through gzip and awk)', s));
    lines.push(`stream (uncompressed): ${fmt(s.uncompressed.bytes)} B, ${s.uncompressed.mb_per_s} MB/s, ${fmt(s.records_per_s ?? '-')} records/s`);
    const c = cpuLine(s.cpu);
    if (c) lines.push(c);
  }
  if (n && n.ended !== 'not-run') lines.push(speedLine('network (no decompression)', n));
  if (h && h.ended !== 'not-run') {
    lines.push(`head: ${h.url} bytes ${h.range}, ${h.ended}, gzip ${h.gzip.status}${h.gzip.status === 'truncated' ? ' at the cut (expected)' : ''}`);
    if (h.counts) lines.push(...countLines('head ', h.counts));
  }
  for (const r of v.reasons) lines.push(`not a pass: ${r}`);
  lines.push(`cnames: ${v.cnames}`);
  return { lines, code: v.pass ? 0 : 1 };
}

function save(file, result) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, file);
}

function toolVersion(bin, tries) {
  for (const flags of tries) {
    const r = spawnSync(bin, flags, { encoding: 'utf8', timeout: 6000 });
    if (r.error?.code === 'ENOENT') return null;
    const first = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n')[0].trim();
    if (r.status === 0 && first) return first;
  }
  return null;
}

function options(args) {
  if (typeof args.url !== 'string') throw new Usage('--url URL is required');
  protoFor(args.url);
  if (typeof args.out !== 'string') throw new Usage('--out FILE is required');
  const np = args['network-pass'];
  if (np !== undefined && np !== true && np !== 'true' && np !== 'false') throw new Usage(`--network-pass takes true or false: ${shown(np)}`);
  if (args['head-url'] !== undefined) protoFor(String(args['head-url']));
  const int = (v, name, min) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min) throw new Usage(`${name} takes an integer of at least ${min}: ${shown(v)}`);
    return n;
  };
  const deadlineMin = Number(args['deadline-min'] ?? 330);
  if (!(deadlineMin > 0)) throw new Usage(`--deadline-min takes a positive number: ${shown(args['deadline-min'])}`);
  return {
    url: args.url,
    out: resolve(args.out),
    range: args.range === undefined ? null : parseRange(args.range),
    networkPass: np === true || np === 'true',
    headUrl: args['head-url'] === undefined ? null : String(args['head-url']),
    headBytes: int(args['head-bytes'] ?? 1048576, '--head-bytes', 1),
    awk: typeof args.awk === 'string' ? args.awk : 'awk',
    deadlineMin,
    maxResumes: int(args['max-resumes'] ?? 5, '--max-resumes', 0),
  };
}

async function run(opts) {
  const conditions = {
    runner_os: process.env.RUNNER_OS ?? null,
    runner_arch: process.env.RUNNER_ARCH ?? null,
    image_os: process.env.ImageOS ?? null,
    image_version: process.env.ImageVersion ?? null,
    platform: `${process.platform} ${process.arch}`,
    cpus: availableParallelism(),
    cpu_model: cpus()[0]?.model ?? null,
    mem_bytes: totalmem(),
    node: process.version,
    curl: toolVersion('curl', [['--version']]),
    gzip: toolVersion('gzip', [['--version']]),
    awk: toolVersion(opts.awk, [['--version'], ['-W', 'version']]),
  };
  for (const tool of ['curl', 'gzip', 'awk']) if (conditions[tool] === null) throw new Usage(`${tool === 'awk' ? opts.awk : tool} is not on the PATH or did not print a version`);
  const result = {
    schema: SCHEMA,
    entry: 'DOM-010',
    started: new Date().toISOString(),
    finished: null,
    units: 'MB is 10^6 B; first_2gb is the first 2 * 10^9 B; seconds are wall time from the first request unless named cpu',
    page_records: PAGE_RECORDS,
    conditions,
    args: {
      url: opts.url,
      range: opts.range ? `${opts.range.from}-${opts.range.to}` : null,
      network_pass: opts.networkPass,
      head_url: opts.headUrl,
      head_bytes: opts.headBytes,
      awk: opts.awk,
      deadline_min: opts.deadlineMin,
      max_resumes: opts.maxResumes,
    },
    passes: { head: null, network: null, stream: null },
    verdict: null,
  };
  save(opts.out, result);

  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort('deadline'), opts.deadlineMin * 60_000);
  deadline.unref();
  const onSignal = () => ctl.abort('signal');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const log = (line) => console.error(`thc-monthly: ${line}`);
  const progress = { label: null, meter: null, unz: null };
  const t0 = performance.now();
  const beat = setInterval(() => {
    const m = progress.meter;
    if (!m) return;
    const secs = (performance.now() - t0) / 1000;
    const unz = progress.unz ? `, uncompressed ${fmt(progress.unz.bytes)} B` : '';
    log(`${Math.round(secs)} s ${progress.label}: ${fmt(m.bytes)} B, ${r3(m.bytes / MB / Math.max(0.001, (performance.now() - m.start) / 1000))} MB/s${unz}`);
  }, 60_000);
  beat.unref();
  const dir = mkdtempSync(join(tmpdir(), 'thc-monthly-'));
  const awkFile = join(dir, 'shape.awk');
  writeFileSync(awkFile, AWK_PROGRAM);
  const ctx = { signal: ctl.signal, maxResumes: opts.maxResumes, ticks: clockTicks(), awk: opts.awk, awkFile, log, progress };
  try {
    if (opts.headUrl) {
      log(`head: first ${opts.headBytes} B of ${opts.headUrl}`);
      result.passes.head = await pipelinePass('head', opts.headUrl, { from: 0, to: opts.headBytes - 1 }, ctx);
      save(opts.out, result);
    }
    if (opts.networkPass) {
      if (ctl.signal.aborted) result.passes.network = notRun('network', 'network', `stopped by the ${ctl.signal.reason}`);
      else {
        log(`network: ${opts.url}`);
        result.passes.network = await networkPass(opts.url, opts.range, ctx);
      }
      save(opts.out, result);
    }
    if (ctl.signal.aborted) result.passes.stream = notRun('pipeline', 'stream', `stopped by the ${ctl.signal.reason}`);
    else {
      log(`stream: ${opts.url}`);
      result.passes.stream = await pipelinePass('stream', opts.url, opts.range, ctx);
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(beat);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    rmSync(dir, { recursive: true, force: true });
  }
  result.verdict = verdictOf(result);
  result.finished = new Date().toISOString();
  save(opts.out, result);
  const { lines, code } = verdictLines(result);
  for (const line of lines) console.log(line);
  console.log(`result: ${opts.out}`);
  return code;
}

function verdictCommand(file) {
  let result;
  try {
    result = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`could not run: cannot read ${file}: ${err.message}`);
    return 2;
  }
  if (result?.schema !== SCHEMA || typeof result.passes !== 'object' || result.passes === null) {
    console.error(`could not run: ${file} is not a ${SCHEMA} result`);
    return 2;
  }
  const { lines, code } = verdictLines(result);
  for (const line of lines) console.log(line);
  return code;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verdict !== undefined) {
    if (typeof args.verdict !== 'string') {
      console.error('could not run: --verdict FILE');
      process.exit(2);
    }
    process.exit(verdictCommand(args.verdict));
  }
  try {
    const opts = options(args);
    process.exitCode = await run(opts);
  } catch (err) {
    console.error(`could not run: ${err.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
