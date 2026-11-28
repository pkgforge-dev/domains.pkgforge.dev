import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { main, parseFlags } from './health-load.mjs';

const SCRIPT = fileURLToPath(new URL('./health-load.mjs', import.meta.url));
const TARGET = 'https://domains.pkgforge.dev/healthz';
const BUILD = 'd6269cbf318f';
const HEALTH = { ok: true, version: BUILD, root_age_s: 300 };
const HEADERS = { 'access-control-expose-headers': 'x-domains-root', 'x-domains-root': `sha256:${'a'.repeat(64)}`, 'x-domains-cache': 'hit' };

async function stand(t, respond) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, ua: req.headers['user-agent'], at: performance.now() });
    const { status = 200, headers = HEADERS, body = JSON.stringify(HEALTH) } = respond(requests.length);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  return { requests, url: `http://127.0.0.1:${server.address().port}/healthz` };
}

function run(...args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('health load: only the stable Worker route and a literal loopback stand-in are allowed', async () => {
  assert.deepEqual(parseFlags(['--url', TARGET]), { url: TARGET, rps: 100, seconds: 60, out: undefined });
  const withUserInfo = new URL(TARGET);
  withUserInfo.username = 'fixture-user';
  withUserInfo.password = 'fixture-password';
  for (const args of [
    ['--url', 'https://example.org/healthz'],
    ['--url', 'https://domains.pkgforge.dev/range'],
    ['--url', `${TARGET}?x=1`],
    ['--url', `${TARGET}#frag`],
    ['--url', withUserInfo.href],
    ['--url', 'http://localhost:3000/healthz'],
    ['--url', 'http://2130706433:3000/healthz'],
    ['--url', 'https://domains.pkgforge.dev/x/../healthz'],
    ['--url', TARGET, '--url', TARGET],
    ['--url', TARGET, '--rps', '101'],
    ['--url', TARGET, '--seconds', '61'],
  ])
    assert.throws(() => parseFlags(args));
  const result = await run('--url', `${TARGET}?unsafe=BODY_SENTINEL`);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^usage:/);
  assert.doesNotMatch(result.stderr, /BODY_SENTINEL/);
});

test('health load: five warm-up requests precede a scheduled run and root tiers are tallied literally', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'health-load-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'result.json');
  const s = await stand(t, (n) => {
    const tier = ['cache', 'ghcr', 'r2', null, 'UNTRUSTED_SENTINEL'][n % 5];
    return { headers: tier === null ? HEADERS : { ...HEADERS, 'x-domains-root-tier': tier } };
  });
  const result = await run('--url', s.url, '--rps', '10', '--seconds', '1', '--out', out);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, readFileSync(out, 'utf8'));
  assert.doesNotMatch(result.stdout, /UNTRUSTED_SENTINEL/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.scheduled, 10);
  assert.equal(report.warmup.healthy, 5);
  assert.equal(report.load.healthy, 10);
  assert.equal(report.http_429, 0);
  assert.equal(report.peak_rolling_launches, 10);
  assert.deepEqual(report.load.by_status, { 200: 10 });
  assert.deepEqual(report.load.root_tiers, { cache: 2, ghcr: 2, r2: 2, absent: 2, unrecognized: 2 });
  assert.equal(report.load.latency_ms.n, 10);
  assert.ok(report.load.latency_ms.p95 >= 0);
  assert.equal(s.requests.length, 15);
  assert.ok(s.requests.every((request) => request.method === 'GET' && request.path === '/healthz' && request.ua === USER_AGENT));
  assert.ok(s.requests[5].at - s.requests[4].at >= 950);
  assert.ok(s.requests.at(-1).at - s.requests[5].at >= 800);
});

test('health load: one measured HTTP 429 fails and stops the run, even with a challenge header', async (t) => {
  const s = await stand(t, (n) => (n === 6 ? { status: 429, headers: { 'cf-mitigated': 'challenge-RATE_LIMIT_SENTINEL' }, body: 'RATE_LIMIT_SENTINEL' } : {}));
  const result = await run('--url', s.url, '--rps', '10', '--seconds', '1');
  assert.equal(result.code, 1, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout, /RATE_LIMIT_SENTINEL/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.http_429, 1);
  assert.equal(report.stopped, 'http-429');
  assert.equal(report.load.by_status[429], 1);
  assert.deepEqual(report.load.errors, { challenge: 1 });
  assert.ok(s.requests.length < 15);
});

test('health load: the target rate makes 100 launches without exceeding the rolling cap', async (t) => {
  const s = await stand(t, () => ({}));
  const result = await run('--url', s.url, '--rps', '100', '--seconds', '1');
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.load.requests, 100);
  assert.equal(report.peak_rolling_launches, 100);
  assert.ok(report.launch_span_ms >= 980);
  assert.deepEqual(report.skipped, { late: 0, pacing: 0, in_flight_cap: 0 });
});

test('health load: HTTP 429 stops launches before slow body cleanup', async (t) => {
  let requests = 0;
  let cleanupStarted = false;
  let rejectedSignal;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    requests += 1;
    if (requests !== 6) return new Response(JSON.stringify(HEALTH), { headers: HEADERS });
    rejectedSignal = signal;
    const body = new ReadableStream({
      cancel() {
        cleanupStarted = true;
        return delay(300, undefined, { ref: false });
      },
    });
    signal.addEventListener(
      'abort',
      () => {
        body.cancel().catch(() => {});
      },
      { once: true },
    );
    return new Response(body, { status: 429 });
  });
  let stdout = '';
  const code = await main(['--url', 'http://127.0.0.1:3000/healthz', '--rps', '10', '--seconds', '1'], {
    stdout: {
      write: (value) => {
        stdout += value;
      },
    },
  });
  const report = JSON.parse(stdout);
  assert.equal(code, 1);
  assert.equal(requests, 6);
  assert.equal(cleanupStarted, true);
  assert.equal(rejectedSignal?.aborted, true);
  assert.equal(report.stopped, 'http-429');
  assert.equal(report.http_429, 1);
  assert.deepEqual(report.load.by_status, { 429: 1 });
});

test('health load: a challenge independently fails and stops the timed run', async (t) => {
  const s = await stand(t, (n) => (n === 6 ? { status: 403, headers: { 'cf-mitigated': 'challenge' } } : {}));
  const result = await run('--url', s.url, '--rps', '4', '--seconds', '1');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.http_429, 0);
  assert.equal(report.stopped, 'challenge');
  assert.deepEqual(report.load.by_status, { 403: 1 });
  assert.equal(s.requests.length, 6);
});

test('health load: a 429 in warm-up stops before any timed launches', async (t) => {
  const s = await stand(t, () => ({ status: 429 }));
  const result = await run('--url', s.url, '--rps', '10', '--seconds', '1');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.http_429, 1);
  assert.equal(report.stopped, 'warmup');
  assert.equal(report.load.requests, 0);
  assert.equal(s.requests.length, 1);
});

test('health load: redirects stay unfollowed and oversized health responses fail safely', async (t) => {
  const redirects = { status: 302, headers: { location: '/redirection-target' } };
  const oversized = { status: 200, body: 'OVERSIZED_SENTINEL'.repeat(4096) };
  for (const [response, error] of [
    [redirects, 'http-status'],
    [oversized, 'invalid-health-body'],
  ]) {
    const s = await stand(t, (n) => (n === 6 ? response : {}));
    const result = await run('--url', s.url, '--rps', '4', '--seconds', '1');
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /OVERSIZED_SENTINEL|redirection-target/);
    const report = JSON.parse(result.stdout);
    assert.equal(report.http_429, 0);
    assert.equal(report.stopped, error);
    assert.deepEqual(report.load.by_status, { [response.status]: 1 });
    assert.deepEqual(report.load.errors, { [error]: 1 });
    assert.equal(report.load.healthy, 0);
    assert.ok(s.requests.every((request) => request.path === '/healthz'));
  }
});
