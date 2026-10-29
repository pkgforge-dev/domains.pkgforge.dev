// scripts/measure/kafka-worker.mjs — DOM-005: can a Worker read OpenINTEL's Kafka
// broker over connect(), decode it, and stay inside its CPU? (TODO/ingest.md)
//
// Drives the probe Worker's /kafka route (probes/worker/src/kafka.ts) and reads
// the CPU time of each of its invocations from `wrangler tail --format json`,
// then judges the entry's pass rule. A fetch answer carries no CPU time, and the
// route's own decode_ms is documented to read 0 when deployed (Cloudflare's
// performance page: a deployed Worker's clock advances only across I/O;
// probes/worker/src/kafka.ts; not yet seen on a live run, and locally it
// advances), so the CPU figure is Cloudflare's account of each invocation:
// the `cpuTime` of
// its tail event, joined to the call by the `call` label the script puts in the
// query. Without that figure the verdict is FAIL, never a guess.
//
// The steps:
//   0. GET <url>/ must list /kafka, or the script cannot run (exit 2).
//   1. Start `node node_modules/wrangler/bin/wrangler.js tail domains-probe
//      --format json` from probes/worker (wrangler 4.150.0 of package.json, the
//      operator's login), and wait until it shows a request of this run
//      (GET /?tail_ready=<id>), at most 90 s.
//   2. Sockets: one call with sockets=2 and one with sockets=6 (certstream_domains
//      at latest, max_bytes 1 KiB): does a socket open, and a second at once?
//   3. The loop: --minutes of wall time, round robin over certstream_domains from
//      now - --cert-back-min (default 15) and the three NRD topics from now -
//      --nrd-back-min (default 1440), each call from its topic's last
//      next_offset, max_bytes --max-bytes (default 1 MiB). A topic that fails 3
//      calls in a row leaves the loop.
//   4. The memory sweep, only with --sweep: certstream_domains from earliest at
//      max_bytes 1 MiB, 2 MiB, ... up to the route's cap (64 MiB), stopping at
//      the first answer that is not 200: the largest max_bytes a Worker holds
//      under its 128 MB. It looks for the memory kill, and whether a kill also
//      drops a cron tick of the same Worker is not known, so it is off unless
//      asked, and is run only once DOM-002's 48 hours have ended and the probe
//      is deployed with crons = [] (a lost tick is a clock gap of DOM-002).
//   5. Wait until the tail has an event for every call, at most 60 s, stop it by
//      its PID, and join each call to its event.
// result.json is rewritten after every step and every 30 s of the loop, so a run
// cut short keeps what it measured. It records no URL and no raw tail event: both
// carry the probe's workers.dev hostname, and an event carries the caller's
// address. The tail's stderr is printed, never written.
//
// Pass rule (--verdict): a socket opened; every call of the loop answered 200;
// no batch failed to decode; at least one snappy batch and one codec-none batch
// decoded; each of the four topics read messages; the tail gave a CPU figure for
// a full call of each topic (one that ended before the head), and each
// topic's CPU per 1,000 messages (the sum of cpuTime over those calls, divided by
// their messages) is at most 50 ms; no invocation
// ended other than ok; no step recorded an error. The second socket, the p50 and
// p99 per call, the CPU over every call and of an empty call, the rates and the
// sweep are recorded, not judged.
//
// Usage:
//   node scripts/measure/kafka-worker.mjs --url "$PROBE_URL" [--minutes 10] [--max-bytes 1048576]
//        [--cert-back-min 15] [--nrd-back-min 1440] [--sweep] [--no-tail | --tail-file FILE]
//        [--out docs/research/measure/DOM-005/result.json] [--verdict]
//   node scripts/measure/kafka-worker.mjs --verdict FILE
// --tail-file reads a `wrangler tail domains-probe --format json` captured in
// another terminal during the run, instead of starting one.
// Exit codes, measuring: 0 the result is written (with --verdict: 0 PASS, 1 FAIL),
// 2 bad arguments, the probe does not serve /kafka, or the run failed (the result
// keeps what was measured until then, when it could be written).
// Exit codes, --verdict FILE: 0 PASS, 1 FAIL, 2 the file cannot be read, is not a
// DOM-005 result, or its summary differs from its calls.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { quantile, round, WORKER } from '../../probes/worker/src/gaps.ts';
import { ANSWER_VERSION, CODEC_NONE, CODEC_SNAPPY, DEFINITIONS as ROUTE_DEFINITIONS, LIMITS, PATH } from '../../probes/worker/src/kafka.ts';
import { ROOT } from '../files.mjs';
import { parseArgs } from '../lib/args.mjs';
import { intArg, isMain, positiveArg, run, UsageError, writeJson } from './kafka-cli.mjs';
import { CERTSTREAM, CONSUMED } from './kafka-runner.mjs';

export const SCHEMA = 'domains.pkgforge.dev/measure/DOM-005/kafka-worker@1';
export const DEFAULT_OUT = 'docs/research/measure/DOM-005/result.json';
// The entry's Decision: above this, the Kafka lane stays on Actions.
export const CPU_PER_1000_MAX_MS = 50;
export const SOCKET_PROBE_BYTES = 1024;
export const SWEEP_FROM = 1 << 20;
// A topic that fails this many calls in a row leaves the loop.
const FAILS_IN_A_ROW = 3;
const MIB = 1 << 20;

export const DEFINITIONS = {
  ...ROUTE_DEFINITIONS,
  cpu_ms: "the invocation's cpuTime in its `wrangler tail --format json` event, joined to the call by the call label in its URL; null when the tail gave no event or no cpuTime",
  tail_wall_ms: "the invocation's wallTime in the same event",
  outcome: "the invocation's outcome in the same event: ok, exception, exceededCpu, exceededMemory, canceled, ...",
  client_ms: 'the wall time of the call as this script saw it, from the request to the end of the answer',
  'topics.seconds': 'the sum of client_ms over the loop calls of the topic',
  'topics.messages_per_second': 'messages / seconds',
  'topics.mb_per_second': 'bytes / seconds / 1e6 (bytes off the broker socket)',
  'topics.raw_mb_per_second': 'raw_bytes / seconds / 1e6',
  'topics.cpu.full_calls':
    'the loop calls of the topic that answered 200 with messages and a lag above 0 after them: the answer ended before the head (at max_bytes, or at the end of a log segment), so the call read from a backlog',
  'topics.cpu.per_1000_ms': 'the sum of cpu_ms over the full calls with a figure, divided by their messages, times 1,000: the figure the pass rule judges',
  'topics.cpu.p50_per_1000_ms':
    'the quantile at index floor(n * q) of the ascending cpu_ms / messages * 1000 of each full call with a figure (probes/worker/src/gaps.ts quantile); p99 and max the same',
  'topics.cpu.all_per_1000_ms': 'the same sum over every loop call with a figure, the calls at the head included: what a lane that reads at the head pays',
  'topics.cpu.empty_call_cpu_ms': 'the cpu_ms of the calls that read no message: the fixed cost of an invocation that opens a socket and asks once',
  'sweep.largest_ok_max_bytes': 'the largest max_bytes of the sweep whose call answered 200',
};

// ---- the tail ----------------------------------------------------------------

// Splits a stream of JSON objects printed one after another into values:
// `wrangler tail --format json` prints each event as JSON.stringify(event, null, 4).
// Text outside a top-level object (a warning line) is skipped.
export class JsonStream {
  constructor(onValue, onError = () => {}) {
    this.onValue = onValue;
    this.onError = onError;
    this.buf = '';
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.start = -1;
    this.scan = 0;
  }

  push(text) {
    this.buf += text;
    for (let i = this.scan; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (this.depth === 0) {
        if (ch === '{') {
          this.start = i;
          this.depth = 1;
        }
        continue;
      }
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (ch === '\\') this.escape = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === '{' || ch === '[') this.depth += 1;
      else if (ch === '}' || ch === ']') {
        this.depth -= 1;
        if (this.depth === 0) {
          const text = this.buf.slice(this.start, i + 1);
          try {
            this.onValue(JSON.parse(text));
          } catch (err) {
            this.onError(err);
          }
          this.buf = this.buf.slice(i + 1);
          i = -1;
          this.start = -1;
        }
      }
    }
    if (this.depth === 0) this.buf = '';
    this.scan = this.buf.length;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The fields this script reads from a tail event, by name. A request event gives
// its path and its call or tail_ready label; any other event gives kind 'other',
// and Cloudflare's overload notice gives kind 'overload' (the tail is sampling).
export function eventRow(event) {
  if (event?.event?.type === 'overload') return { kind: 'overload' };
  const url = event?.event?.request?.url;
  if (typeof url !== 'string') return { kind: 'other' };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'other' };
  }
  return {
    kind: 'request',
    path: u.pathname,
    call: u.searchParams.get('call'),
    ready: u.searchParams.get('tail_ready'),
    outcome: typeof event.outcome === 'string' ? event.outcome : null,
    cpu_ms: num(event.cpuTime),
    wall_ms: num(event.wallTime),
    status: num(event.event?.response?.status),
  };
}

// The tail's tally, written into the result: counts only, never an event.
const newTailStats = (source) => ({
  source,
  ready: null,
  ready_s: null,
  events: 0,
  requests: 0,
  kafka_events: 0,
  with_cpu: 0,
  matched: 0,
  duplicates: 0,
  overload: 0,
  parse_errors: 0,
  stderr_lines: 0,
  exit: null,
});

// A tail's tally and its request rows, fed one event at a time by add(). Every
// tail source (spawnTail, fileTail) is one of these.
export function tailOf(source, live) {
  const stats = newTailStats(source);
  const rows = [];
  const add = (event) => {
    stats.events += 1;
    const row = eventRow(event);
    if (row.kind === 'overload') stats.overload += 1;
    if (row.kind !== 'request') return;
    stats.requests += 1;
    if (row.path === PATH) stats.kafka_events += 1;
    if (row.cpu_ms !== null) stats.with_cpu += 1;
    rows.push(row);
  };
  return { stats, rows, add, onError: () => (stats.parse_errors += 1), live, alive: () => true, async stop() {} };
}

// The command of the default tail: the pinned wrangler of node_modules, run
// with node itself (no shell, no npx), from probes/worker.
export function wranglerTailCommand(root = ROOT) {
  const bin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return { command: process.execPath, args: [bin, 'tail', WORKER, '--format', 'json'], cwd: join(root, 'probes', 'worker'), bin };
}

export function wranglerVersion(root = ROOT) {
  const pkg = join(root, 'node_modules', 'wrangler', 'package.json');
  return existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).version : null;
}

// A tail that runs `command` and parses its stdout. stop() ends the process by
// its PID: SIGINT first, so that wrangler deletes its tail session (on Windows
// any signal ends the process at once), then SIGKILL after 10 s.
export function spawnTail({ command, args, cwd }, { stderr = process.stderr } = {}) {
  const tail = tailOf('wrangler tail', true);
  const { stats } = tail;
  const stream = new JsonStream(tail.add, tail.onError);
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, windowsHide: true });
  let exited = false;
  const exit = new Promise((done) => {
    child.on('exit', (code, signal) => {
      exited = true;
      stats.exit = code ?? signal;
      done();
    });
    child.on('error', (err) => {
      exited = true;
      stats.exit = `spawn failed: ${err.message}`;
      done();
    });
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => stream.push(text));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    stats.stderr_lines += text.split('\n').filter((line) => line.trim() !== '').length;
    stderr.write(`wrangler tail: ${text}`);
  });
  tail.pid = child.pid;
  tail.alive = () => !exited;
  tail.stop = async () => {
    if (!exited) child.kill('SIGINT');
    const timer = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, 10_000);
    await exit;
    clearTimeout(timer);
  };
  return tail;
}

// A tail captured to a file in another terminal, parsed when the run ends.
export function fileTail(path) {
  const tail = tailOf('file', false);
  tail.stop = async () => new JsonStream(tail.add, tail.onError).push(readFileSync(path, 'utf8'));
  return tail;
}

export const noTail = () => tailOf('none', false);

// ---- the calls ---------------------------------------------------------------

// The fields of an answer a call row keeps, by name.
const PICK = [
  'offset',
  'next_offset',
  'messages',
  'bytes',
  'wire_bytes',
  'raw_bytes',
  'decoded_bytes',
  'batches',
  'control_batches',
  'by_codec',
  'failed_batches',
  'failures',
  'first_failure',
  'partial_bytes',
  'high_watermark',
  'lag',
  'decode_ms',
  'ms',
  'sockets',
  'stage',
];

export function callRow({ label, phase, topic, offsetQuery, maxBytes, socketsAsked, status, clientMs, body, error }) {
  const row = { label, phase, topic, offset_query: offsetQuery, max_bytes: maxBytes, sockets_asked: socketsAsked, status, client_ms: round(clientMs, 1) };
  // An answer that is JSON but not an object gives no field.
  const answer = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null;
  for (const key of PICK) row[key] = answer !== null && key in answer ? answer[key] : null;
  row.error = error ?? (answer !== null && typeof answer.error === 'string' ? answer.error : answer === null && body !== null ? `answered ${status} with JSON that is not an object` : null);
  row.cpu_ms = null;
  row.tail_wall_ms = null;
  row.outcome = null;
  return row;
}

async function call(ctx, { phase, topic, offset, maxBytes, sockets = 1 }) {
  const label = `${ctx.runId}-${ctx.result.calls.length + 1}`;
  const url = new URL(PATH.slice(1), ctx.base);
  url.searchParams.set('topic', topic);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('max_bytes', String(maxBytes));
  if (sockets !== 1) url.searchParams.set('sockets', String(sockets));
  url.searchParams.set('call', label);
  const t0 = performance.now();
  let status = null;
  let body = null;
  let error = null;
  try {
    const res = await ctx.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ctx.callTimeoutMs) });
    status = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      error = `answered ${status} with a body that is not JSON`;
    }
  } catch (err) {
    error = `the call failed: ${err.message}`;
  }
  if (status === 200 && body !== null && body.v !== ANSWER_VERSION)
    throw new CannotRun(`the probe answers /kafka version ${body.v}; this script reads version ${ANSWER_VERSION}: deploy probes/worker from this tree`);
  const row = callRow({ label, phase, topic, offsetQuery: String(offset), maxBytes, socketsAsked: sockets, status, clientMs: performance.now() - t0, body, error });
  ctx.result.calls.push(row);
  if (status === 200 && ctx.result.route.limits === null) ctx.result.route.limits = body.limits;
  return row;
}

export class CannotRun extends Error {}

async function checkProbe(ctx) {
  let listing;
  try {
    const res = await ctx.fetch(new URL('./', ctx.base), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (res.status !== 200) throw new Error(`answered ${res.status}`);
    listing = await res.json();
  } catch (err) {
    throw new CannotRun(`the probe's route list could not be read: ${err.message}`);
  }
  const row = Array.isArray(listing?.routes) ? listing.routes.find((r) => r.path === PATH) : undefined;
  if (row === undefined) throw new CannotRun(`the probe does not list ${PATH}: deploy probes/worker with the route first`);
  ctx.result.route.summary = row.summary ?? null;
}

// The marker of the ready request. It has the shape of a call label (eight hex
// characters and a suffix): the tail showed a full UUID in a query value as
// REDACTED (MEASURED 2026-10-29T00:17Z, `wrangler tail` 4.150.0 on the probe),
// while the call labels came through whole.
export const readyLabel = (runId) => `${runId}-ready`;

// Waits until the tail shows a request of this run, re-sending it every poll.
async function waitReady(ctx, tail) {
  if (!tail.live) return;
  const id = readyLabel(ctx.runId);
  const t0 = performance.now();
  while (performance.now() - t0 < ctx.readyCapMs && tail.alive()) {
    try {
      const u = new URL('./', ctx.base);
      u.searchParams.set('tail_ready', id);
      await (await ctx.fetch(u, { signal: AbortSignal.timeout(30_000) })).text();
    } catch (err) {
      ctx.log(`tail: the ready request failed: ${err.message}`);
    }
    await sleep(ctx.pollMs);
    if (tail.rows.some((r) => r.ready === id)) {
      tail.stats.ready = true;
      tail.stats.ready_s = round((performance.now() - t0) / 1000, 1);
      return;
    }
  }
  tail.stats.ready = false;
  ctx.result.errors.push(tail.alive() ? `the tail showed no request of this run in ${ctx.readyCapMs / 1000} s` : `the tail ended before it was ready (exit ${tail.stats.exit})`);
}

// Joins each call to its tail event by its label.
export function joinTail(calls, rows, stats) {
  const byLabel = new Map();
  for (const r of rows) {
    if (r.path !== PATH || r.call === null) continue;
    if (byLabel.has(r.call)) stats.duplicates += 1;
    else byLabel.set(r.call, r);
  }
  stats.matched = 0;
  for (const c of calls) {
    const r = byLabel.get(c.label);
    if (r === undefined) continue;
    stats.matched += 1;
    c.cpu_ms = r.cpu_ms;
    c.tail_wall_ms = r.wall_ms;
    c.outcome = r.outcome;
  }
}

// ---- the summary and the verdict ---------------------------------------------

const add = (into, from) => {
  for (const [k, v] of Object.entries(from ?? {})) into[k] = (into[k] ?? 0) + v;
};
const sum = (rows, key) => rows.reduce((a, r) => a + (typeof r[key] === 'number' ? r[key] : 0), 0);

function spreadOf(values, digits) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: round(quantile(sorted, 0.5), digits), p99: round(quantile(sorted, 0.99), digits), max: round(sorted.length === 0 ? null : sorted[sorted.length - 1], digits) };
}

// A full call: its answer ended before the head (the lag after it is above 0:
// max_bytes or the end of a log segment ended it), so its CPU is the cost of a
// read from a backlog. A call at the head reads the few messages that arrived
// since the last one, and its CPU is mostly the fixed cost of an invocation
// (empty_call_cpu_ms), which says little of the decode.
const isFull = (r) => r.messages > 0 && typeof r.lag === 'number' && r.lag > 0;

export function summarizeTopic(rows) {
  const ok = rows.filter((r) => r.status === 200);
  const statuses = {};
  for (const r of rows) statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
  const failures = {};
  const byCodec = {};
  const outcomes = {};
  for (const r of ok) {
    add(failures, r.failures);
    add(byCodec, r.by_codec);
  }
  for (const r of rows) if (r.outcome !== null) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const seconds = sum(rows, 'client_ms') / 1000;
  const withCpu = ok.filter((r) => r.cpu_ms !== null);
  const full = withCpu.filter(isFull);
  const fullMessages = sum(full, 'messages');
  const fullCpu = sum(full, 'cpu_ms');
  const allMessages = sum(withCpu, 'messages');
  const allCpu = sum(withCpu, 'cpu_ms');
  const per1000 = (cpu, messages) => (messages > 0 ? round((cpu / messages) * 1000, 3) : null);
  const perCall = full.map((r) => (r.cpu_ms / r.messages) * 1000);
  const last = ok.at(-1);
  const rate = (n) => (seconds > 0 ? n / seconds : null);
  return {
    calls: rows.length,
    statuses,
    outcomes,
    messages: sum(ok, 'messages'),
    bytes: sum(ok, 'bytes'),
    wire_bytes: sum(ok, 'wire_bytes'),
    raw_bytes: sum(ok, 'raw_bytes'),
    batches: sum(ok, 'batches'),
    failed_batches: sum(ok, 'failed_batches'),
    failures,
    by_codec: byCodec,
    seconds: round(seconds, 3),
    messages_per_second: round(rate(sum(ok, 'messages')), 0),
    mb_per_second: round(rate(sum(ok, 'bytes') / 1e6), 3),
    raw_mb_per_second: round(rate(sum(ok, 'raw_bytes') / 1e6), 3),
    first_offset: ok[0]?.offset ?? null,
    last_next_offset: last?.next_offset ?? null,
    last_lag: last?.lag ?? null,
    cpu: {
      full_calls: ok.filter(isFull).length,
      full_calls_with_cpu: full.length,
      cpu_ms: round(fullCpu, 3),
      messages: fullMessages,
      per_1000_ms: per1000(fullCpu, fullMessages),
      ...Object.fromEntries(Object.entries(spreadOf(perCall, 3)).map(([k, v]) => [`${k}_per_1000_ms`, v])),
      calls_with_cpu: withCpu.length,
      all_per_1000_ms: per1000(allCpu, allMessages),
      empty_call_cpu_ms: spreadOf(
        withCpu.filter((r) => r.messages === 0).map((r) => r.cpu_ms),
        3,
      ),
    },
    tail_wall_ms: spreadOf(
      ok.filter((r) => r.tail_wall_ms !== null).map((r) => r.tail_wall_ms),
      0,
    ),
  };
}

export function summarize(calls) {
  const loop = calls.filter((r) => r.phase === 'loop');
  const topics = {};
  for (const topic of CONSUMED) topics[topic] = summarizeTopic(loop.filter((r) => r.topic === topic));
  const steps = calls.filter((r) => r.phase === 'sweep');
  const ok = steps.filter((r) => r.status === 200);
  const largest = ok.reduce((best, r) => (best === null || r.max_bytes > best.max_bytes ? r : best), null);
  const failed = steps.find((r) => r.status !== 200) ?? null;
  return {
    topics,
    sweep: {
      steps: steps.map((r) => ({ max_bytes: r.max_bytes, status: r.status, bytes: r.bytes, messages: r.messages, cpu_ms: r.cpu_ms, tail_wall_ms: r.tail_wall_ms, outcome: r.outcome, error: r.error })),
      largest_ok_max_bytes: largest?.max_bytes ?? null,
      largest_ok_bytes: largest?.bytes ?? null,
      first_failure: failed === null ? null : { max_bytes: failed.max_bytes, status: failed.status, outcome: failed.outcome, error: failed.error },
    },
  };
}

const mib = (n) => (n === null ? 'null' : `${round(n / MIB, 2)} MiB`);

// The pass rule over a result. Returns {pass, failures, lines}.
export function verdict(result) {
  const failures = [];
  const lines = [];
  const { topics, sweep } = summarize(result.calls);
  const sockets = result.calls.filter((r) => r.phase === 'socket');
  const opened = sockets.filter((r) => r.status === 200 && r.sockets?.opened >= 1);
  if (opened.length === 0) {
    const first = sockets[0];
    failures.push(`the socket did not open: ${first ? `${first.status} ${first.error ?? ''}`.trim() : 'no socket call was made'}`);
  }
  lines.push(`socket: ${sockets.map((r) => `${r.sockets?.opened ?? 0} of ${r.sockets_asked} opened at once (${r.status})`).join('; ') || 'not measured'}`);
  const loop = result.calls.filter((r) => r.phase === 'loop');
  const not200 = loop.filter((r) => r.status !== 200);
  if (loop.length === 0) failures.push('the loop made no call');
  if (not200.length > 0) failures.push(`${not200.length} of ${loop.length} loop call(s) did not answer 200; the first: ${not200[0].status} ${not200[0].error ?? ''}`.trim());
  const byCodec = {};
  const decodeFailures = {};
  let batches = 0;
  for (const t of Object.values(topics)) {
    add(byCodec, t.by_codec);
    add(decodeFailures, t.failures);
    batches += t.batches;
  }
  const failed = Object.values(decodeFailures).reduce((a, n) => a + n, 0);
  if (failed > 0) failures.push(`${failed} batch(es) failed to decode: ${JSON.stringify(decodeFailures)}`);
  if (!(byCodec[CODEC_SNAPPY] > 0)) failures.push('no snappy batch was decoded');
  if (!(byCodec[CODEC_NONE] > 0)) failures.push('no codec-none batch was decoded');
  lines.push(`decode: ${batches} batch(es), by codec ${JSON.stringify(byCodec)}, failures ${failed}`);
  const tail = result.tail;
  if (tail.with_cpu === 0) failures.push(`no CPU figure: the tail (${tail.source}, ready ${tail.ready}) gave ${tail.events} event(s), ${tail.kafka_events} of /kafka, and none carried cpuTime`);
  for (const topic of CONSUMED) {
    const t = topics[topic];
    if (t.messages === 0) failures.push(`${topic}: no message was read`);
    const cpu = t.cpu;
    if (tail.with_cpu > 0 && t.messages > 0 && cpu.per_1000_ms === null) failures.push(`${topic}: no full call (one that ended before the head) has a CPU figure`);
    if (cpu.per_1000_ms !== null && cpu.per_1000_ms > CPU_PER_1000_MAX_MS) failures.push(`${topic}: ${cpu.per_1000_ms} ms of CPU per 1,000 messages, above ${CPU_PER_1000_MAX_MS}`);
    const bad = Object.entries(t.outcomes).filter(([o]) => o !== 'ok');
    if (bad.length > 0) failures.push(`${topic}: invocation outcomes ${JSON.stringify(Object.fromEntries(bad))}`);
    lines.push(
      `${topic}: ${t.messages} messages in ${t.calls} call(s), ${t.messages_per_second} messages/s, ${t.mb_per_second} MB/s off the socket; CPU per 1,000 messages ${cpu.per_1000_ms} ms over ${cpu.full_calls_with_cpu} full call(s) (per call p50 ${cpu.p50_per_1000_ms}, p99 ${cpu.p99_per_1000_ms}), ${cpu.all_per_1000_ms} ms over all ${cpu.calls_with_cpu} with a figure, an empty call ${cpu.empty_call_cpu_ms.p50} ms; last lag ${t.last_lag}`,
    );
  }
  for (const error of result.errors) failures.push(`error: ${error}`);
  if (sweep.steps.length === 0) lines.push('max_bytes: not measured');
  else {
    const ff = sweep.first_failure;
    lines.push(
      `max_bytes: the largest that answered 200 is ${mib(sweep.largest_ok_max_bytes)} (the broker returned ${sweep.largest_ok_bytes} bytes)${ff === null ? `; every step to ${mib(sweep.steps.at(-1).max_bytes)} answered 200` : `; ${mib(ff.max_bytes)} answered ${ff.status}, outcome ${ff.outcome}`}`,
    );
  }
  lines.push(`tail: ${tail.events} event(s), ${tail.kafka_events} of /kafka, ${tail.matched} joined, ${tail.with_cpu} with cpuTime, overload ${tail.overload}`);
  return { pass: failures.length === 0, failures, lines };
}

export function printVerdict(result, out = process.stdout) {
  const v = verdict(result);
  out.write(`${v.pass ? 'PASS' : 'FAIL'} DOM-005 Kafka from a Worker connect() (started ${result.started}, loop of ${result.minutes} min)\n`);
  for (const f of v.failures) out.write(`  FAIL ${f}\n`);
  for (const line of v.lines) out.write(`  ${line}\n`);
  return v.pass ? 0 : 1;
}

// Reads a result file and checks it is one: exit 2 otherwise.
export function readResult(path) {
  let result;
  try {
    result = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${err.message}`);
  }
  if (result?.schema !== SCHEMA || !Array.isArray(result.calls) || typeof result.tail !== 'object') throw new UsageError(`${path} is not a DOM-005 result (${SCHEMA})`);
  const again = summarize(result.calls);
  if (!isDeepStrictEqual(again.topics, result.topics) || !isDeepStrictEqual(again.sweep, result.sweep)) throw new UsageError(`${path}: its topics or sweep differ from its calls`);
  return result;
}

// ---- the run -----------------------------------------------------------------

export function parseFlags(argv) {
  const a = parseArgs(argv);
  for (const k of ['url', 'out', 'tail-file', 'minutes', 'max-bytes', 'cert-back-min', 'nrd-back-min']) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a.url === undefined) {
    if (typeof a.verdict !== 'string') throw new UsageError('give --url "$PROBE_URL" to measure, or --verdict FILE to judge a result');
    return { mode: 'verdict', file: resolve(a.verdict) };
  }
  if (typeof a.verdict === 'string') throw new UsageError('with --url, --verdict takes no file: the result goes to --out');
  let base;
  try {
    base = new URL(a.url);
  } catch {
    throw new UsageError('--url must be the probe URL, such as https://<worker>.<subdomain>.workers.dev');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new UsageError('--url must be an http or https URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  if (a['no-tail'] === true && a['tail-file'] !== undefined) throw new UsageError('give at most one of --no-tail and --tail-file');
  return {
    mode: 'measure',
    base,
    minutes: a.minutes === undefined ? 10 : positiveArg(a.minutes, '--minutes'),
    maxBytes: a['max-bytes'] === undefined ? LIMITS.default_max_bytes : intArg(a['max-bytes'], '--max-bytes', 1),
    certBackMin: a['cert-back-min'] === undefined ? 15 : positiveArg(a['cert-back-min'], '--cert-back-min'),
    nrdBackMin: a['nrd-back-min'] === undefined ? 1440 : positiveArg(a['nrd-back-min'], '--nrd-back-min'),
    // Off unless asked (step 4); --no-sweep, the default, is still read.
    sweep: a.sweep === true && a['no-sweep'] !== true,
    tail: a['no-tail'] === true ? 'none' : typeof a['tail-file'] === 'string' ? resolve(a['tail-file']) : 'wrangler',
    out: typeof a.out === 'string' ? resolve(a.out) : join(ROOT, DEFAULT_OUT),
    verdict: a.verdict === true,
  };
}

function newResult(flags, nowMs) {
  return {
    schema: SCHEMA,
    entry: 'DOM-005',
    started: new Date(nowMs).toISOString(),
    finished: null,
    minutes: flags.minutes,
    max_bytes: flags.maxBytes,
    cert_back_min: flags.certBackMin,
    nrd_back_min: flags.nrdBackMin,
    rule: { cpu_per_1000_max_ms: CPU_PER_1000_MAX_MS },
    cpu_source: 'the cpuTime of each invocation in `wrangler tail domains-probe --format json`, joined by the call label; a fetch answer carries no CPU time',
    runner: { node: process.version, platform: process.platform, arch: process.arch, wrangler: wranglerVersion() },
    route: { path: PATH, answer_version: ANSWER_VERSION, summary: null, limits: null },
    tail: null,
    topics: null,
    sweep: null,
    loop_seconds: null,
    calls: [],
    errors: [],
    definitions: DEFINITIONS,
  };
}

function save(ctx) {
  Object.assign(ctx.result, summarize(ctx.result.calls));
  ctx.result.tail = ctx.tail.stats;
  writeJson(ctx.out, ctx.result);
}

// Round robin over the four topics for `minutes` of wall time.
async function loop(ctx, flags) {
  const now = Date.now();
  const state = new Map(CONSUMED.map((topic) => [topic, { offset: new Date(now - (topic === CERTSTREAM ? flags.certBackMin : flags.nrdBackMin) * 60_000).toISOString(), fails: 0 }]));
  const t0 = performance.now();
  let saved = t0;
  while (performance.now() - t0 < flags.minutes * 60_000 && state.size > 0) {
    for (const [topic, s] of [...state]) {
      if (performance.now() - t0 >= flags.minutes * 60_000) break;
      const row = await call(ctx, { phase: 'loop', topic, offset: s.offset, maxBytes: flags.maxBytes });
      if (row.status === 200 && typeof row.next_offset === 'number') {
        s.offset = row.next_offset;
        s.fails = 0;
      } else {
        s.fails += 1;
        if (s.fails >= FAILS_IN_A_ROW) {
          ctx.result.errors.push(`${topic} left the loop after ${FAILS_IN_A_ROW} failed calls in a row; the last: ${row.status} ${row.error ?? ''}`.trim());
          state.delete(topic);
        }
        await sleep(ctx.pollMs);
      }
    }
    if (performance.now() - saved >= 30_000) {
      saved = performance.now();
      save(ctx);
      const n = ctx.result.calls.filter((r) => r.phase === 'loop');
      ctx.log(`loop: ${n.length} call(s), ${sum(n, 'messages')} messages, ${round((performance.now() - t0) / 1000, 0)} s`);
    }
  }
  ctx.result.loop_seconds = round((performance.now() - t0) / 1000, 3);
}

// Waits until every call has its tail event, at most flushCapMs.
async function flush(ctx) {
  if (!ctx.tail.live) return;
  const t0 = performance.now();
  const labels = new Set(ctx.result.calls.map((c) => c.label));
  while (performance.now() - t0 < ctx.flushCapMs && ctx.tail.alive()) {
    const seen = new Set(ctx.tail.rows.filter((r) => r.path === PATH).map((r) => r.call));
    if ([...labels].every((l) => seen.has(l))) return;
    await sleep(ctx.pollMs);
  }
}

export async function measure(flags, deps = {}) {
  const log = deps.log ?? ((line) => process.stderr.write(`kafka-worker: ${line}\n`));
  const startTail = deps.startTail ?? ((kind) => (kind === 'none' ? noTail() : kind === 'wrangler' ? spawnTail(wranglerTailCommand()) : fileTail(kind)));
  const ctx = {
    base: flags.base,
    fetch: deps.fetch ?? fetch,
    log,
    out: flags.out,
    runId: randomUUID().slice(0, 8),
    pollMs: deps.pollMs ?? 3000,
    readyCapMs: deps.readyCapMs ?? 90_000,
    flushCapMs: deps.flushCapMs ?? 60_000,
    callTimeoutMs: LIMITS.wall_ms + 60_000,
    result: newResult(flags, Date.now()),
    tail: noTail(),
  };
  await checkProbe(ctx);
  if (flags.tail === 'wrangler' && !existsSync(wranglerTailCommand().bin)) throw new CannotRun('node_modules/wrangler is missing: run npm ci first, or pass --tail-file or --no-tail');
  ctx.tail = startTail(flags.tail);
  try {
    log(`tail: ${ctx.tail.stats.source}`);
    await waitReady(ctx, ctx.tail);
    save(ctx);
    for (const sockets of [2, 6]) await call(ctx, { phase: 'socket', topic: CERTSTREAM, offset: 'latest', maxBytes: SOCKET_PROBE_BYTES, sockets });
    save(ctx);
    log(`loop: ${flags.minutes} min over ${CONSUMED.join(', ')}`);
    await loop(ctx, flags);
    save(ctx);
    if (flags.sweep) {
      for (let maxBytes = SWEEP_FROM; maxBytes <= LIMITS.max_bytes; maxBytes *= 2) {
        const row = await call(ctx, { phase: 'sweep', topic: CERTSTREAM, offset: 'earliest', maxBytes });
        log(`sweep: max_bytes ${maxBytes} answered ${row.status}`);
        if (row.status !== 200) break;
      }
      save(ctx);
    }
    await flush(ctx);
  } finally {
    await ctx.tail.stop();
    joinTail(ctx.result.calls, ctx.tail.rows, ctx.tail.stats);
    ctx.result.finished = new Date().toISOString();
    save(ctx);
  }
  return ctx.result;
}

async function main(argv) {
  const flags = parseFlags(argv);
  if (flags.mode === 'verdict') return printVerdict(readResult(flags.file));
  let result;
  try {
    result = await measure(flags);
  } catch (err) {
    // Exit 2, so that exit 1 always means FAIL. What was measured is in the result.
    throw new UsageError(err instanceof CannotRun ? err.message : `could not run: ${err.message}`);
  }
  process.stderr.write(`kafka-worker: wrote ${flags.out}\n`);
  return flags.verdict ? printVerdict(result) : 0;
}

if (isMain(import.meta.url)) await run('kafka-worker', main);
