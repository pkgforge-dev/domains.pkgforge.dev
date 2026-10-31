// scripts/measure/decode-cpu.mjs — the CPU time of a probe invocation of
// /decode (DOM-008, TODO/storage.md; the route is probes/worker/src/decode.ts),
// read from the platform's own trace of each invocation.
//
// The source of the CPU numbers is the tail: the script starts
// `wrangler tail domains-probe --format json` with the wrangler 4.150.0 of
// node_modules, run by node from probes/worker under the operator's own local
// login, and reads `cpuTime` of each trace event it prints: the invocation's CPU
// time as the platform counts it, read as milliseconds. `wallTime` of the same
// event is its wall time, and the client's own timing is wall time seen from
// this machine. Neither wall figure is ever read as CPU: a run whose events
// carry no cpuTime is refused. @cloudflare/workers-types 5.20261013.1 declares
// cpuTime and wallTime on a Tail Worker's TraceItem; that wrangler tail's JSON
// carries them too, and in milliseconds, is first seen on a live run, so the
// result keeps each event's raw value. Workers Logs shows each invocation's CPU
// time as $workers.cpuTimeMs in the dashboard; this script does not read it
// (its API needs a token, AGENTS.md absolutes 4 and 14).
//
// A live run: start the tail; send marker requests until one shows in the tail
// (the tail is connected); send --requests requests to each combination of
// PLAN (blocks=1, 4, 16 of per=1024, 4096, 16384, and rows=1000), round robin,
// --concurrency at a time, each with tag=<run>.<combination>.<n>, and with
// --interval-ms at least that long between the starts of two requests, by the
// monotonic clock (pool); wait for their trace events; stop the tail by its
// PID. Each answer's count and CRC-32 must agree within a combination, and with
// --manifest (the manifest.json of make-sample-pack.mjs) they must be the
// manifest's. The run and the result, from a live run or from --input, keep the
// probe's URL without the account's workers.dev subdomain, which names the
// account (keptUrl), and so does the error text a request keeps (keptText). The
// tail's stderr is printed, never written, and printed without an account's
// name or id (tailText).
//
// The tail samples. On 2026-10-30 it printed about one event a second under a
// load of about ten requests a second (DOM-008, the Found of
// 2026-10-30T18:39Z). A run that must trace 90% of its requests paces them, so
// the defaults are 1 request at a time, 1,000 ms apart: on 2026-10-30 they
// traced 1,992 of 2,000.
//
// The criteria are the Decision of DOM-008: the p99 CPU time of
// /decode?blocks=1&per=4096 is at most 3 ms (a whole invocation: two R2 gets,
// one block inflated, checked and scanned, and the answer, so an upper bound on
// one block's decode), and the p99 CPU time of /decode?rows=1000 is at most
// 15 ms. A criterion also fails when an invocation of its combination did not
// answer 200 or did not end `ok`.
//
// Usage:
//   node scripts/measure/decode-cpu.mjs --url "$PROBE_URL/decode" --requests 200 [--concurrency 1] [--interval-ms 1000] [--manifest .tmp/measure/DOM-008/sample/manifest.json] [--out docs/research/measure/DOM-008/result.json]
//   node scripts/measure/decode-cpu.mjs --input <a saved run, the .run.json beside a result> [--manifest FILE] [--out FILE]
// --out writes the result there and, after a live run, the run itself beside it
// as <name>.run.json (the requests and their trace events), which --input reads
// to compute the result again offline.
// stdout: one line per combination, one per criterion, and a verdict= line.
// Exit codes: 0 measured and every criterion PASS · 1 measured and a criterion
// FAIL · 2 could not run (usage, an --out that cannot be written or that is the
// --input, the tail or the probe unreachable, events with no cpuTime, fewer than
// 90% of a combination's requests traced, answers that disagree).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { quantile, WORKER } from '../../probes/worker/src/gaps.ts';
import { ROOT } from '../files.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { MANIFEST_FORMAT } from './make-sample-pack.mjs';
import { redactHost } from './range-load.mjs';

export const RUN_FORMAT = 'domains.measure.decode-cpu-run.v1';
export const RESULT_FORMAT = 'domains.measure.decode-cpu.v1';
export const WRANGLER_VERSION = '4.150.0';
export const COVERAGE = 0.9;
export const QUANTILE = 'the value at index floor(n * q) of the ascending list, as probes/worker/src/gaps.ts quantile()';
const USAGE = 'usage: node scripts/measure/decode-cpu.mjs (--url <probe>/decode --requests N [--concurrency C] [--interval-ms MS] | --input <run.json>) [--manifest FILE] [--out FILE]';
const FETCH_TIMEOUT_MS = 60_000;
const MAX_INTERVAL_MS = 60_000;
export const DEFAULT_CONCURRENCY = 1;
export const DEFAULT_INTERVAL_MS = 1000;
const MAX_REQUESTS = 2000;
const MAX_CONCURRENCY = 16;

export const PLAN = Object.freeze([
  ...[1024, 4096, 16384].flatMap((per) => [1, 4, 16].map((blocks) => Object.freeze({ mode: 'blocks', per, blocks }))),
  Object.freeze({ mode: 'rows', per: 4096, rows: 1000 }),
]);

export const RULES = Object.freeze([
  Object.freeze({
    name: 'decode-4096-p99-at-most-3ms',
    combo: { mode: 'blocks', per: 4096, blocks: 1 },
    p99_max_ms: 3,
    what: 'p99 CPU time of /decode?blocks=1&per=4096, the whole invocation: an upper bound on one block of 4,096 names',
  }),
  Object.freeze({ name: 'rows-1000-p99-at-most-15ms', combo: { mode: 'rows', per: 4096, rows: 1000 }, p99_max_ms: 15, what: 'p99 CPU time of /decode?rows=1000, the whole invocation' }),
]);

export class UsageError extends Error {}
export class CouldNotRun extends Error {}

export const comboName = (c) => (c.mode === 'blocks' ? `blocks=${c.blocks} per=${c.per}` : `rows=${c.rows} per=${c.per}`);
export const blocksOf = (c) => (c.mode === 'blocks' ? c.blocks : Math.ceil(c.rows / c.per));

// The flags, checked. Throws UsageError.
export function parseFlags(argv) {
  const a = parseArgs(argv);
  const known = ['url', 'input', 'requests', 'concurrency', 'interval-ms', 'manifest', 'out'];
  for (const k of Object.keys(a)) if (k !== '_' && !known.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given more than once`);
  if (a._.length > 0) throw new UsageError(`unexpected argument ${keptArg(a._[0])}`);
  for (const k of known) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if ((a.url === undefined) === (a.input === undefined)) throw new UsageError('give exactly one of --url and --input');
  const whole = (k, min, max, fallback) => {
    if (a[k] === undefined) return fallback;
    if (!/^\d{1,6}$/.test(a[k]) || Number(a[k]) < min || Number(a[k]) > max) throw new UsageError(`--${k} must be a whole number from ${min} to ${max}`);
    return Number(a[k]);
  };
  if (a.url !== undefined) {
    let url;
    try {
      url = new URL(a.url);
    } catch {
      throw new UsageError('--url must be the probe URL ending in /decode');
    }
    if (!/^https?:$/.test(url.protocol) || !url.pathname.endsWith('/decode') || url.search !== '') throw new UsageError('--url must be an http or https URL ending in /decode, with no query');
    if (url.username !== '' || url.password !== '') throw new UsageError('--url must carry no user name or password');
    if (a.requests === undefined) throw new UsageError('--requests N is required with --url');
  } else if (a.requests !== undefined || a.concurrency !== undefined || a['interval-ms'] !== undefined) throw new UsageError('--requests, --concurrency and --interval-ms go with --url');
  if (a.out !== undefined) {
    if (a.out.endsWith('.run.json')) throw new UsageError('--out names the result, never a .run.json: a live run keeps its run beside the result as <name>.run.json');
    if (a.input !== undefined && samePath(a.out, a.input)) throw new UsageError('--out must not be the --input: the saved run is the only copy of its requests and events');
  }
  return {
    url: a.url,
    input: a.input,
    requests: whole('requests', 1, MAX_REQUESTS, null),
    concurrency: whole('concurrency', 1, MAX_CONCURRENCY, DEFAULT_CONCURRENCY),
    intervalMs: whole('interval-ms', 0, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    manifest: a.manifest,
    out: a.out,
  };
}

const samePath = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

// The probe's URL as a run and its result keep it: the scheme, the host with a
// workers.dev account subdomain replaced by ACCOUNT (range-load.mjs redactHost,
// which reads the host without its port and its final dot), and the path. No
// user name, password or query.
export function keptUrl(base) {
  const url = new URL(base);
  return `${url.protocol}//${redactHost(url.host)}${url.pathname}`;
}

// A workers.dev host in a text, in any case, with any port or final dot after
// it: WORKER.ACCOUNT.workers.dev, as redactHost gives.
const WORKERS_DEV_HOST = /\b([a-z0-9-]+)\.(?:[a-z0-9-]+\.)+workers\.dev\b/gi;

// An error body or message as a run keeps it: it may name the request's host.
export function keptText(text) {
  return text.replace(WORKERS_DEV_HOST, (_host, worker) => `${worker.toLowerCase()}.ACCOUNT.workers.dev`);
}

// The tail's stderr as a message prints it; it is never written. wrangler names
// each account of a login that holds more than one, one `name`: `id` line each,
// when it cannot ask which (wrangler 4.150.0, getOrSelectAccountId). Those lines
// are left out, a 32-hex-digit id reads ACCOUNT_ID, and a host is keptText's.
export function tailText(text) {
  return keptText(text)
    .split('\n')
    .filter((line) => !/^\s*`[^`]*`:\s*`[^`]*`\s*$/.test(line))
    .join('\n')
    .replace(/\b[0-9a-f]{32}\b/gi, 'ACCOUNT_ID');
}

// A typed argument as a usage message prints it: an http or https URL as
// keptUrl keeps it, any other text as keptText.
const keptArg = (text) => (/^https?:\/\//i.test(text) && URL.canParse(text) ? keptUrl(text) : keptText(text));

// The /decode URL of one request of a combination.
export function requestUrl(base, combo, tag) {
  const url = new URL(base);
  if (combo.mode === 'blocks') url.searchParams.set('blocks', String(combo.blocks));
  else url.searchParams.set('rows', String(combo.rows));
  url.searchParams.set('per', String(combo.per));
  url.searchParams.set('tag', tag);
  return url.href;
}

// ---- the tail

// Splits text that holds JSON objects back to back, as `wrangler tail --format
// json` prints them (JSON.stringify(event, null, 4), one after another), and
// calls onValue with each parsed object. Text between objects is counted as
// skipped; an object that does not parse is counted as bad.
export function createJsonSplitter(onValue) {
  let buf = '';
  let at = 0;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const stats = { objects: 0, skipped_chars: 0, bad: 0 };
  return {
    push(text) {
      buf += text;
      for (; at < buf.length; at += 1) {
        const ch = buf[at];
        if (depth === 0) {
          if (ch === '{') {
            depth = 1;
            start = at;
          } else if (ch.trim() !== '') stats.skipped_chars += 1;
          continue;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ']') {
          depth -= 1;
          if (depth === 0) {
            let value;
            try {
              value = JSON.parse(buf.slice(start, at + 1));
            } catch {
              stats.bad += 1;
              continue;
            }
            stats.objects += 1;
            onValue(value);
          }
        }
      }
      // Keep only the object being read, so the buffer never grows past one event.
      if (depth === 0) {
        buf = '';
        at = 0;
      } else {
        buf = buf.slice(start);
        at -= start;
        start = 0;
      }
    },
    stats,
  };
}

// One trace event reduced to what the run keeps, or null when it is not a
// fetch of /decode carrying a tag of this run (a cron tick, another caller, an
// info message).
export function eventRecord(event, runId) {
  const url = event?.event?.request?.url;
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const tag = parsed.searchParams.get('tag');
  if (!parsed.pathname.endsWith('/decode') || tag === null || !tag.startsWith(`${runId}.`)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    tag,
    outcome: typeof event.outcome === 'string' ? event.outcome : null,
    cpu_ms: num(event.cpuTime),
    wall_ms: num(event.wallTime),
    status: num(event.event?.response?.status),
    at: num(event.eventTimestamp),
  };
}

// The wrangler of node_modules, pinned: the tail command of a live run.
export function wranglerTailCommand(root = ROOT) {
  const pkgPath = join(root, 'node_modules', 'wrangler', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.version !== WRANGLER_VERSION) throw new CouldNotRun(`node_modules holds wrangler ${pkg.version}, not ${WRANGLER_VERSION}`);
  return { command: process.execPath, args: [join(dirname(pkgPath), pkg.bin.wrangler), 'tail', WORKER, '--format', 'json'], cwd: join(root, 'probes', 'worker') };
}

// Ends one process and what it started, by its PID: on Windows a child's
// children outlive it, so the tree is ended by taskkill /PID. Never by image name.
function endByPid(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGINT');
}

// Starts a tail process and feeds each JSON object of its stdout to onEvent.
// stop() ends it by its PID (SIGINT first off Windows, so wrangler deletes its
// tail session; SIGKILL after 5 s) and resolves once it has exited.
export function spawnTail({ command, args, cwd, onEvent }) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  const splitter = createJsonSplitter(onEvent);
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => splitter.push(text));
  child.stderr.setEncoding('utf8');
  // The last 4,000 characters or fewer, cut at a line's start, so tailText reads
  // whole lines.
  child.stderr.on('data', (text) => {
    stderr += text;
    if (stderr.length > 4000) {
      const cut = stderr.indexOf('\n', stderr.length - 4000);
      stderr = cut === -1 ? '' : stderr.slice(cut + 1);
    }
  });
  let exitedNow = false;
  const exited = new Promise((done) => {
    child.on('error', (err) => {
      exitedNow = true;
      done({ code: null, error: err.message });
    });
    child.on('close', (code, signal) => {
      exitedNow = true;
      done({ code, signal });
    });
  });
  return {
    pid: child.pid,
    exited,
    hasExited: () => exitedNow,
    stderr: () => stderr,
    stats: splitter.stats,
    async stop() {
      endByPid(child);
      const late = setTimeout(() => {
        if (!exitedNow) child.kill('SIGKILL');
      }, 5000);
      await exited;
      clearTimeout(late);
    },
  };
}

const defaultStartTail = (onEvent) => spawnTail({ ...wranglerTailCommand(), onEvent });

// ---- the live run

// Starts fn(0) to fn(count - 1) in order, at most concurrency running at once.
// With intervalMs above 0, a start waits until intervalMs have passed on now()
// since the start before it, and reads now() again after each wait: a timer
// that fires early waits again, and one that fires late delays only its own
// start, so no two starts are less than intervalMs apart. A test gives now and
// wait.
export async function pool(count, concurrency, intervalMs, fn, { now = () => performance.now(), wait = sleep } = {}) {
  const running = new Set();
  let last = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    while (running.size >= concurrency) await Promise.race(running);
    if (intervalMs > 0) for (let t = now(); t - last < intervalMs; t = now()) await wait(intervalMs - (t - last));
    last = now();
    const task = Promise.resolve(fn(i)).finally(() => running.delete(task));
    running.add(task);
  }
  await Promise.all(running);
}

const round = (value, digits) => (value === null ? null : Number(value.toFixed(digits)));

async function sendOne(fetchImpl, base, combo, comboIndex, tag) {
  const url = requestUrl(base, combo, tag);
  const t0 = performance.now();
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await response.text();
    const ms = round(performance.now() - t0, 1);
    if (response.status !== 200) return { tag, combo: comboIndex, status: response.status, client_wall_ms: ms, answer: null, error: keptText(text).slice(0, 300) };
    const body = JSON.parse(text);
    if (body.tag !== tag) return { tag, combo: comboIndex, status: 200, client_wall_ms: ms, answer: null, error: `the answer echoes tag ${JSON.stringify(body.tag)}` };
    const answer = { names: body.names, crc32: body.crc32, per: body.per, blocks: body.blocks, raw_bytes: body.raw_bytes, packed_bytes: body.packed_bytes, rows_count: body.rows_count ?? null };
    return { tag, combo: comboIndex, status: 200, client_wall_ms: ms, answer, error: null };
  } catch (err) {
    return { tag, combo: comboIndex, status: null, client_wall_ms: round(performance.now() - t0, 1), answer: null, error: keptText(err.message) };
  }
}

// Sends the plan to the probe while the tail runs, and returns the run: every
// request with its answer, and every trace event of the run. timing holds the
// waits, which a test shortens.
export async function runLive({ url, requests, concurrency = DEFAULT_CONCURRENCY, intervalMs = DEFAULT_INTERVAL_MS, startTail = defaultStartTail, fetchImpl = fetch, timing = {}, log = () => {} }) {
  const { readyMs = 90_000, readyEachMs = 3000, quietMs = 20_000, drainMaxMs = 120_000, pollMs = 250 } = timing;
  const runId = randomBytes(4).toString('hex');
  const events = new Map();
  const counts = { seen: 0, duplicate: 0 };
  const tail = await startTail((event) => {
    counts.seen += 1;
    const record = eventRecord(event, runId);
    if (record === null) return;
    if (events.has(record.tag)) counts.duplicate += 1;
    else events.set(record.tag, record);
  });
  const started = new Date().toISOString();
  const results = [];
  try {
    const waitFor = async (tags, maxMs, quiet) => {
      const t0 = Date.now();
      let last = events.size;
      let lastChange = t0;
      while (tags.some((tag) => !events.has(tag))) {
        if (tail.hasExited()) throw new CouldNotRun(`the tail exited: ${tailText(tail.stderr()).trim().slice(-500)}`);
        const now = Date.now();
        if (events.size !== last) {
          last = events.size;
          lastChange = now;
        }
        if (now - t0 >= maxMs || (quiet !== null && now - lastChange >= quiet)) return false;
        await sleep(pollMs);
      }
      return true;
    };
    let ready = false;
    for (let k = 0, t0 = Date.now(); !ready && Date.now() - t0 < readyMs; k += 1) {
      const tag = `${runId}.ready.${k}`;
      const marker = await sendOne(fetchImpl, url, PLAN[0], -1, tag);
      if (marker.status !== 200) throw new CouldNotRun(`the probe answered the marker request ${marker.status ?? 'nothing'}: ${marker.error}`);
      ready = await waitFor([tag], readyEachMs, null);
    }
    if (!ready) throw new CouldNotRun(`no marker request showed in the tail within ${readyMs / 1000} s: ${tailText(tail.stderr()).trim().slice(-500)}`);
    log(`decode-cpu: the tail is connected; sending ${requests} requests to each of ${PLAN.length} combinations, ${concurrency} at a time, ${intervalMs} ms or more apart`);
    const total = requests * PLAN.length;
    await pool(total, concurrency, intervalMs, async (i) => {
      const c = i % PLAN.length;
      results[i] = await sendOne(fetchImpl, url, PLAN[c], c, `${runId}.${c}.${Math.floor(i / PLAN.length)}`);
    });
    await waitFor(
      results.map((r) => r.tag),
      drainMaxMs,
      quietMs,
    );
  } finally {
    await tail.stop();
  }
  return {
    format: RUN_FORMAT,
    entry: 'DOM-008',
    url: keptUrl(url),
    run_id: runId,
    started,
    ended: new Date().toISOString(),
    requests_per_combination: requests,
    concurrency,
    interval_ms: intervalMs,
    plan: PLAN,
    cpu_source: 'tail',
    tail: { command: `wrangler ${WRANGLER_VERSION} tail ${WORKER} --format json`, events_seen: counts.seen, events_of_run: events.size, duplicate: counts.duplicate, ...tail.stats },
    requests: results,
    events: [...events.values()],
  };
}

// ---- the result

function spread(values) {
  return { p50: round(quantile(values, 0.5), 3), p99: round(quantile(values, 0.99), 3), max: round(values.length === 0 ? null : Math.max(...values), 3) };
}

function tally(values) {
  const out = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

function checkRun(run) {
  if (typeof run !== 'object' || run === null) throw new CouldNotRun('the run is not a JSON object');
  if (run.format !== RUN_FORMAT) throw new CouldNotRun(`the run is ${JSON.stringify(run.format)}, not ${RUN_FORMAT}`);
  if (run.cpu_source !== 'tail') throw new CouldNotRun(`the run's CPU source is ${JSON.stringify(run.cpu_source)}, not tail`);
  if (!Array.isArray(run.plan) || !Array.isArray(run.requests) || !Array.isArray(run.events)) throw new CouldNotRun('the run lacks its plan, requests or events');
  if (typeof run.url !== 'string' || !URL.canParse(run.url)) throw new CouldNotRun("the run lacks the probe's URL");
}

function expectedOf(manifest, combo) {
  const pack = manifest.packs.find((p) => p.per === combo.per);
  if (pack === undefined) throw new CouldNotRun(`the manifest has no pack of ${combo.per} names a block`);
  const blocks = blocksOf(combo);
  if (blocks > pack.blocks) throw new CouldNotRun(`the manifest's pack of ${combo.per} holds ${pack.blocks} blocks, fewer than ${blocks}`);
  return { names: Math.min(blocks * combo.per, pack.records), crc32: pack.crc_through[blocks - 1] };
}

function summariseCombo(run, combo, index, byTag, manifest) {
  const name = comboName(combo);
  const reqs = run.requests.filter((r) => r.combo === index);
  if (reqs.length === 0) throw new CouldNotRun(`${name}: the run holds no request of it`);
  const traced = reqs.map((r) => ({ r, e: byTag.get(r.tag) })).filter((x) => x.e !== undefined && x.e.cpu_ms !== null);
  if (traced.length < Math.ceil(COVERAGE * reqs.length)) throw new CouldNotRun(`${name}: ${traced.length} of ${reqs.length} requests have a trace event with cpuTime, fewer than ${COVERAGE * 100}%`);
  const answers = reqs.filter((r) => r.status === 200 && r.answer !== null).map((r) => r.answer);
  const distinct = [...new Set(answers.map((a) => `${a.names} names, crc32 ${a.crc32}`))];
  if (distinct.length > 1) throw new CouldNotRun(`${name}: the probe's answers disagree (${distinct.join('; ')}): the sample changed during the run or the decode is not deterministic`);
  const ref = answers[0] ?? null;
  if (manifest !== null && ref !== null) {
    const want = expectedOf(manifest, combo);
    if (ref.names !== want.names || ref.crc32 !== want.crc32)
      throw new CouldNotRun(`${name}: the probe answered ${ref.names} names, crc32 ${ref.crc32}; the manifest says ${want.names}, ${want.crc32}`);
  }
  const blocks = blocksOf(combo);
  const cpu = traced.map((x) => x.e.cpu_ms);
  const names = ref?.names ?? null;
  const failed = reqs.filter((r) => r.status !== 200 || (byTag.get(r.tag)?.outcome ?? 'ok') !== 'ok');
  return {
    name,
    ...combo,
    blocks,
    requests: reqs.length,
    traced: traced.length,
    names,
    crc32: ref?.crc32 ?? null,
    // The bytes the blocks hold, from the answer: CPU time scales with them, and a
    // sample block may hold fewer or more than a mean block of a whole day.
    raw_bytes: ref?.raw_bytes ?? null,
    packed_bytes: ref?.packed_bytes ?? null,
    errors: failed.length,
    status: tally(reqs.map((r) => r.status)),
    outcome: tally(traced.map((x) => x.e.outcome)),
    cpu_ms: spread(cpu),
    cpu_ms_per_block: spread(cpu.map((c) => c / blocks)),
    cpu_ms_per_1000_names: names === null || names === 0 ? null : spread(cpu.map((c) => (c * 1000) / names)),
    wall_ms: spread(traced.map((x) => x.e.wall_ms).filter((v) => v !== null)),
    client_wall_ms: spread(reqs.map((r) => r.client_wall_ms).filter((v) => typeof v === 'number')),
  };
}

// The result of a run: per combination, the CPU time's p50, p99 and max, per
// invocation, per block and per 1,000 names, the wall times beside them, and
// the criteria. Throws CouldNotRun when the run cannot be judged.
export function summarise(run, { manifest = null } = {}) {
  checkRun(run);
  if (manifest !== null && manifest.format !== MANIFEST_FORMAT) throw new CouldNotRun(`the manifest is ${JSON.stringify(manifest.format)}, not ${MANIFEST_FORMAT}`);
  if (run.events.length === 0) throw new CouldNotRun('no trace event matched a request of the run');
  const cpuValues = run.events.map((e) => e.cpu_ms).filter((v) => v !== null);
  if (cpuValues.length === 0)
    throw new CouldNotRun("the tail's trace events carry no cpuTime, so this source gives no CPU time: read $workers.cpuTimeMs in Workers Logs, or run the limit probe (DOM-008, CPU)");
  const byTag = new Map(run.events.map((e) => [e.tag, e]));
  const combinations = run.plan.map((combo, i) => summariseCombo(run, combo, i, byTag, manifest));
  const criteria = RULES.map((rule) => {
    const combo = combinations.find((c) => isDeepStrictEqual(Object.fromEntries(Object.keys(rule.combo).map((k) => [k, c[k]])), rule.combo));
    if (combo === undefined) throw new CouldNotRun(`the run's plan has no ${comboName(rule.combo)}, which ${rule.name} judges`);
    const p99 = combo.cpu_ms.p99;
    const verdict = p99 !== null && p99 <= rule.p99_max_ms && combo.errors === 0 ? 'PASS' : 'FAIL';
    return { name: rule.name, rule: rule.what, p99_max_ms: rule.p99_max_ms, p99_ms: p99, errors: combo.errors, verdict };
  });
  return {
    format: RESULT_FORMAT,
    entry: 'DOM-008',
    // A saved run may hold the URL as it was given, so --input keeps it as a live run does.
    url: keptUrl(run.url),
    run_id: run.run_id,
    started: run.started,
    ended: run.ended,
    requests_per_combination: run.requests_per_combination,
    concurrency: run.concurrency,
    interval_ms: run.interval_ms ?? null,
    cpu_source: 'tail',
    cpu_field: 'cpuTime of each invocation trace event that wrangler tail --format json prints: CPU time in ms, the platform account',
    wall_field: 'wall_ms is wallTime of the same event, and client_wall_ms is the request time seen by this script: both wall time, never CPU time',
    cpu_whole_ms: cpuValues.every((v) => Number.isInteger(v)),
    quantile: QUANTILE,
    tail: run.tail,
    combinations,
    criteria,
    verdict: criteria.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL',
  };
}

const fmt = (s) => `p50=${s.p50} p99=${s.p99}`;

export function lines(result) {
  const out = result.combinations.map(
    (c) =>
      `${c.name.padEnd(19)} traced=${c.traced}/${c.requests} cpu_ms ${fmt(c.cpu_ms)} max=${c.cpu_ms.max} per_block ${fmt(c.cpu_ms_per_block)}` +
      `${c.cpu_ms_per_1000_names === null ? '' : ` per_1000_names ${fmt(c.cpu_ms_per_1000_names)}`} wall_ms ${fmt(c.wall_ms)} errors=${c.errors}`,
  );
  for (const c of result.criteria) out.push(`${c.verdict} ${c.name}: p99 ${c.p99_ms} ms, at most ${c.p99_max_ms} ms; errors=${c.errors} (${c.rule})`);
  out.push(`verdict=${result.verdict} cpu_source=${result.cpu_source} cpu_whole_ms=${result.cpu_whole_ms}`);
  return out;
}

// The saved run beside a result: x.json -> x.run.json.
export const runPathFor = (out) => (out.endsWith('.json') ? `${out.slice(0, -'.json'.length)}.run.json` : `${out}.run.json`);

// A file error as a message prints it: its code, never the path, which is typed.
const fsReason = (err) => err?.code ?? 'an error with no code';

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Before a run: each path can be written, so a run of half an hour is never
// lost to an --out that is a directory or under a file. Throws CouldNotRun.
function checkWritable(paths) {
  for (const path of paths) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && statSync(path).isDirectory()) throw Object.assign(new Error('a directory'), { code: 'EISDIR' });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, '');
      rmSync(tmp, { force: true });
    } catch (err) {
      throw new CouldNotRun(`${basename(path)} cannot be written: ${fsReason(err)}`);
    }
  }
}

function readJson(path, flag) {
  let text;
  try {
    text = readFileSync(resolve(path), 'utf8');
  } catch (err) {
    throw new CouldNotRun(`${flag} cannot be read: ${fsReason(err)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CouldNotRun(`${flag} is not JSON`);
  }
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, startTail, fetchImpl, timing } = {}) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`decode-cpu: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  const out = flags.out === undefined ? null : resolve(flags.out);
  const runPath = out !== null && flags.url ? runPathFor(out) : null;
  let run;
  let result;
  try {
    if (out !== null) checkWritable(runPath === null ? [out] : [runPath, out]);
    const manifest = flags.manifest === undefined ? null : readJson(flags.manifest, '--manifest');
    run = flags.url
      ? await runLive({
          url: flags.url,
          requests: flags.requests,
          concurrency: flags.concurrency,
          intervalMs: flags.intervalMs,
          startTail,
          fetchImpl,
          timing,
          log: (line) => stderr.write(`${line}\n`),
        })
      : readJson(flags.input, '--input');
    result = summarise(run, { manifest });
  } catch (err) {
    // A run that was made but cannot be judged is still kept, so it can be read.
    if (run !== undefined && runPath !== null) {
      try {
        writeAtomic(runPath, `${JSON.stringify(run)}\n`);
      } catch (writeErr) {
        stderr.write(`decode-cpu: could not keep ${basename(runPath)}: ${fsReason(writeErr)}\n`);
      }
    }
    stderr.write(`decode-cpu: could not run: ${err.message}\n`);
    return 2;
  }
  stdout.write(`${lines(result).join('\n')}\n`);
  if (out !== null) {
    // The run first: the result can be computed again from it, never the reverse.
    let writing = runPath ?? out;
    try {
      if (runPath !== null) writeAtomic(runPath, `${JSON.stringify(run)}\n`);
      writing = out;
      writeAtomic(out, `${JSON.stringify(result, null, 2)}\n`);
    } catch (err) {
      stderr.write(`decode-cpu: could not write ${basename(writing)}: ${fsReason(err)}\n`);
      return 2;
    }
    stderr.write(`decode-cpu: wrote ${basename(out)}${runPath !== null ? ` and ${basename(runPath)}` : ''}\n`);
  }
  return result.verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
