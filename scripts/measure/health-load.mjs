// DOM-062's warm /healthz proof. The only remote target is the public Worker.
// Exit codes: 0 PASS, 1 an incomplete or unhealthy run, 2 a usage or output error.
import { resolve } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { spread, writeAtomic } from './range-load.mjs';

const TARGET = 'https://domains.pkgforge.dev/healthz';
const USAGE = `usage: node scripts/measure/health-load.mjs --url ${TARGET} [--rps 100] [--seconds 60] [--out FILE]`;
const PREFILL = 5;
const MAX_IN_FLIGHT = 64;
const BODY_BYTES = 4096;
const TIMEOUT_MS = 5000;
const TIMER_SLACK_MS = process.platform === 'win32' ? 20 : 2;
const ROOT_TIERS = ['cache', 'ghcr', 'r2'];
const CACHE_STATES = ['hit', 'ghcr', 'mixed', 'r2'];
const options = { url: { type: 'string' }, rps: { type: 'string' }, seconds: { type: 'string' }, out: { type: 'string' } };

function countOption(value, max) {
  if (value === undefined) return max;
  return /^[1-9][0-9]{0,2}$/.test(value) && Number(value) <= max ? Number(value) : null;
}

export function parseFlags(args) {
  const { values, tokens } = parseArgs({ args, options, tokens: true });
  if (new Set(tokens.map((token) => token.name)).size !== tokens.length) throw new Error('each option takes one value');
  const url = new URL(values.url);
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.href === `${url.origin}/healthz`;
  if (url.href !== values.url || (url.href !== TARGET && !loopback)) throw new Error('invalid health target');
  const rps = countOption(values.rps, 100);
  const seconds = countOption(values.seconds, 60);
  if (rps === null || seconds === null || values.out === '') throw new Error('invalid run options');
  return { url: url.href, rps, seconds, out: values.out };
}

function headerValue(headers, name, known) {
  const value = headers.get(name);
  if (value === null) return 'absent';
  return known.includes(value) ? value : 'unrecognized';
}

// Keep a short health body in memory. Discard every other response body.
async function healthBody(res) {
  if (res.body === null) return null;
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BODY_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    return null;
  }
}

async function getHealth(url, lag, onFailure) {
  const started = performance.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const result = { status: null, error: null, rootTier: null, cache: null, version: null, lag, ms: null };
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, redirect: 'manual', signal });
    result.status = res.status;
    if (res.headers.has('cf-mitigated')) result.error = 'challenge';
    else if (res.status !== 200) result.error = 'http-status';
    else if (res.headers.has('x-domains-degraded')) result.error = 'degraded';
    else if (!res.headers.has('access-control-expose-headers') || !/^sha256:[0-9a-f]{64}$/.test(res.headers.get('x-domains-root'))) result.error = 'unexpected-worker-headers';
    if (result.error === null) {
      const data = await healthBody(res);
      if (data?.ok !== true || typeof data.version !== 'string' || !/^[0-9a-f]{12}$/.test(data.version) || !Number.isSafeInteger(data.root_age_s) || data.root_age_s < 0 || data.root_age_s > 21600) {
        result.error = 'invalid-health-body';
      } else {
        result.version = data.version;
        result.rootTier = headerValue(res.headers, 'x-domains-root-tier', ROOT_TIERS);
        result.cache = headerValue(res.headers, 'x-domains-cache', CACHE_STATES);
      }
    }
  } catch {
    result.error ??= signal.aborted ? 'timeout' : 'connection';
  }
  if (result.error !== null) {
    onFailure?.(result);
    // Abort the fetch without waiting for its response body to finish.
    controller.abort();
  }
  result.ms = performance.now() - started;
  return result;
}

// Start at most once per slot, with at least half a slot between launches
// and no more than rps launches per rolling second. Missed slots expire.
// Near a deadline, yield through I/O instead of waiting a coarse timer tick.
async function load({ url, rps, seconds }) {
  await delay(1000); // Keep serial warm-up requests outside the first rolling second.
  const pending = [];
  const launches = [];
  const interval = 1000 / rps;
  const startedAt = new Date().toISOString();
  const first = performance.now();
  let inFlight = 0;
  let stopped = null;
  let firstInWindow = 0;
  let peakRollingLaunches = 0;
  const skipped = { late: 0, pacing: 0, in_flight_cap: 0 };
  const stop = ({ status, error }) => {
    if (status === 429) stopped = 'http-429';
    else stopped ??= error;
  };
  for (let i = 0; i < rps * seconds && stopped === null; i += 1) {
    const at = first + i * interval;
    const deadline = at + interval;
    const previous = launches.at(-1) ?? -Infinity;
    const rollingLimit = (launches.at(-rps) ?? -Infinity) + 1000;
    const eligible = Math.max(at, previous + interval / 2, rollingLimit);
    if (eligible >= deadline) {
      skipped.pacing += 1;
      continue;
    }
    let now = performance.now();
    while (now < eligible && stopped === null) {
      const wait = eligible - now;
      if (wait > TIMER_SLACK_MS) await delay(wait - TIMER_SLACK_MS);
      else await nextTurn();
      now = performance.now();
    }
    if (stopped !== null) break;
    if (now >= deadline) {
      skipped.late += 1;
      continue;
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      skipped.in_flight_cap += 1;
      continue;
    }
    launches.push(now);
    while (launches[firstInWindow] + 1000 <= now) firstInWindow += 1;
    peakRollingLaunches = Math.max(peakRollingLaunches, launches.length - firstInWindow);
    inFlight += 1;
    pending.push(
      getHealth(url, now - at, stop).then((record) => {
        inFlight -= 1;
        return record;
      }),
    );
  }
  const records = await Promise.all(pending);
  return {
    started_at: startedAt,
    elapsed_ms: Math.round(performance.now() - first),
    launch_span_ms: launches.length === 0 ? null : Math.round(launches.at(-1) - launches[0]),
    peak_rolling_launches: peakRollingLaunches,
    stopped,
    skipped,
    records,
  };
}

function tally(values) {
  const counts = {};
  for (const value of values) if (value !== null) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function summary(records) {
  return {
    requests: records.length,
    healthy: records.filter((record) => record.error === null).length,
    by_status: tally(records.map((record) => record.status)),
    errors: tally(records.map((record) => record.error)),
    root_tiers: tally(records.map((record) => record.rootTier)),
    cache_states: tally(records.map((record) => record.cache)),
    versions: tally(records.map((record) => record.version)),
    latency_ms: spread(records.map((record) => record.ms)),
    client_lag_ms: spread(records.flatMap((record) => (record.lag === null ? [] : [record.lag]))),
  };
}

export async function main(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let flags;
  try {
    flags = parseFlags(args);
  } catch {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  const warmup = [];
  for (let i = 0; i < PREFILL; i += 1) {
    const record = await getHealth(flags.url, null);
    warmup.push(record);
    if (record.error !== null) break;
  }
  const ready = warmup.length === PREFILL && warmup.every((record) => record.error === null);
  const { records, ...timing } = ready
    ? await load(flags)
    : { records: [], started_at: null, elapsed_ms: 0, launch_span_ms: null, peak_rolling_launches: 0, stopped: 'warmup', skipped: { late: 0, pacing: 0, in_flight_cap: 0 } };
  const scheduled = flags.rps * flags.seconds;
  const measured = summary(records);
  const rateLimited = (measured.by_status[429] ?? 0) + warmup.filter((record) => record.status === 429).length;
  const pass = ready && measured.healthy === scheduled && rateLimited === 0;
  const result = {
    schema: 'domains.measure.health-load.v1',
    target: flags.url,
    rps: flags.rps,
    seconds: flags.seconds,
    scheduled,
    ...timing,
    warmup: summary(warmup),
    load: measured,
    http_429: rateLimited,
    verdict: pass ? 'PASS' : 'FAIL',
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  try {
    if (flags.out !== undefined) writeAtomic(flags.out, text);
  } catch {
    stderr.write('health-load: could not write the result\n');
    return 2;
  }
  stdout.write(text);
  return pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
