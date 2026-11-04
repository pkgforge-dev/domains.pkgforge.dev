// scripts/measure/edge-load.test.mjs — DOM-062's load script against a local
// HTTP server that stands in for the Worker and for Cloudflare's edge in its
// place, and a local stand-in DoH server. The answers are synthetic: the
// Worker's carry its `access-control-expose-headers`, as apps/api/src/answer.ts
// sets it, and the edge's lack it. Their statuses, colos, codes and versions
// are invented. Each criterion's refusal is planted in the server's answers.
//
//   node scripts/test.mjs scripts/measure --name "edge load"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { classify, edgeCode, judge, main, parseFlags, pinnedLookup, SCHEMA, summarize, UsageError, WORKER_HEADER } from './edge-load.mjs';
import { parseFlags as rangeFlags, UsageError as RangeUsageError } from './range-load.mjs';

const SCRIPT = fileURLToPath(new URL('./edge-load.mjs', import.meta.url));
const VERSION = '0123456789ab';
const dir = mkdtempSync(join(tmpdir(), 'edge-load-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// A /healthz answer of the Worker.
const worker = (status = 200, extra = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', [WORKER_HEADER]: 'x-domains-root, retry-after', 'x-domains-cache': 'hit', 'cf-ray': '0123456789abcdef-TST', ...extra },
  body: JSON.stringify({ ok: status === 200, version: VERSION, root_age_s: 60 }),
});
// An answer of the edge in the Worker's place: no Worker header, and a page
// that names the caller's address beside its error code.
const edge = (status, code, extra = {}) => ({
  status,
  headers: { 'content-type': 'text/html', 'cf-ray': '0123456789abcdef-TST', ...extra },
  body: `<html><title>Error ${code}</title><p>error code: ${code}</p><p>Your IP: 192.0.2.77</p></html>`,
});

// The stand-in. respond(n) gives { status, headers, body, delay, hang } for the n-th request.
async function stand(respond = () => worker()) {
  const state = { requests: [], inflight: 0, maxInflight: 0 };
  const server = createServer(async (req, res) => {
    const n = state.requests.length;
    state.requests.push({ path: req.url, host: req.headers.host, ua: req.headers['user-agent'] });
    state.inflight += 1;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    const r = await respond(n);
    if (r.delay) await delay(r.delay);
    state.inflight -= 1;
    if (r.hang) return;
    res.writeHead(r.status, r.headers);
    res.end(r.body ?? '');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/healthz`,
    state,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(ok);
      }),
  };
}

// A stand-in DoH server of the JSON form: `answers` maps "name type" to records.
async function dohServer(answers, status = 200) {
  const asked = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const key = `${u.searchParams.get('name')} ${u.searchParams.get('type')}`;
    asked.push({ key, accept: req.headers.accept });
    const type = u.searchParams.get('type') === 'A' ? 1 : 28;
    res.writeHead(status, { 'content-type': 'application/dns-json' });
    res.end(JSON.stringify({ Status: 0, Answer: (answers[key] ?? []).map((data) => ({ name: u.searchParams.get('name'), type, TTL: 300, data })) }));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}/dns-query`,
    asked,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(ok);
      }),
  };
}

async function run(args) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { stdout: { write: (s) => (stdout += s) }, stderr: { write: (s) => (stderr += s) } });
  return { code, stdout, stderr };
}

let n = 0;
const outPath = () => join(dir, `result-${n++}.json`);

test('edge load: the flags are checked, and range-load.mjs still refuses the old Prove line, so this script exists', async () => {
  const base = ['--url', 'https://w.example.test/healthz'];
  for (const [args, why] of [
    [['--rps', '1'], /--url is required/],
    [['--url', 'ftp://w.example.test/healthz', '--rps', '1'], /--url must be an http or https URL/],
    [base, /--rps is required/],
    [[...base, '--rps', '0'], /--rps must be a whole number from 1 to 500/],
    [[...base, '--rps', '1', '--prefill', '101'], /--prefill must be a whole number from 0 to 100/],
    [[...base, '--rps', '1', '--doh', 'not a url'], /--doh is not a URL/],
    [[...base, '--rps', '1', '--rps', '2'], /--rps is given twice/],
    [[...base, '--rps', '1', '--family', '5'], /--family must be 4 or 6/],
    [[...base, '--rps', '1', '--mode', 'warm'], /unknown flag --mode/],
    [[...base, '--rps', '1', '--place', 'Operator'], /--place is a short lowercase label/],
  ]) {
    assert.throws(
      () => parseFlags(args),
      (e) => e instanceof UsageError && why.test(e.message),
      args.join(' '),
    );
  }
  const f = parseFlags([...base, '--rps', '100']);
  assert.deepEqual([f.seconds, f.expect, f.prefill, f.doh, f.family, f.timeoutMs, f.place], [60, 200, 5, null, null, 30000, 'local']);
  assert.equal(parseFlags([...base, '--rps', '1', '--family', '4']).family, 4);
  // The Prove line DOM-062 carried until this script, refused before any request.
  assert.throws(
    () => rangeFlags(['--url', 'https://domains.pkgforge.dev/healthz', '--rps', '100', '--seconds', '60', '--mode', 'warm', '--expect', '200']),
    (e) => e instanceof RangeUsageError && /ending in \/range/.test(e.message),
  );
  const cli = await new Promise((done) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [SCRIPT, '--rps', '1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => done({ code, err }));
  });
  assert.equal(cli.code, 2);
  assert.match(cli.err, /--url is required[\s\S]*usage:/);
});

test('edge load: the prefill runs one at a time before the clock, the load counts every Worker answer, and a clean run PASSes', async () => {
  const s = await stand();
  try {
    const out = outPath();
    const r = await run(['--url', s.url, '--rps', '20', '--seconds', '1', '--prefill', '3', '--place', 'operator', '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(s.state.requests.length, 23);
    assert.ok(s.state.requests.every((q) => q.path === '/healthz' && q.ua === USER_AGENT));
    assert.match(r.stdout, /^prefill {6}3 of 3 expected {2}worker-200:3$/m);
    assert.match(r.stdout, /^requests {5}20 {2}200 20 {2}429 0 {2}403 0 {2}503 0 {2}challenge 0 {2}5xx 0 {2}other 0$/m);
    assert.match(r.stdout, /^PASS no-429 {2}0 of 20$/m);
    assert.match(r.stdout, /^PASS no-gate {2}403 0 · 503 0 · challenge 0 of 20$/m);
    assert.match(r.stdout, /\nPASS\n$/);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(result.schema, SCHEMA);
    assert.equal(result.entry, 'DOM-062');
    assert.deepEqual(result.target, { host: `127.0.0.1:${s.port}`, path: '/healthz' });
    assert.deepEqual(result.resolver, { kind: 'literal', doh: null, family: null, addresses: [{ address: '127.0.0.1', family: 4 }] });
    assert.deepEqual([result.run.place, result.run.rps, result.run.seconds, result.run.expect, result.run.prefill, result.run.user_agent], ['operator', 20, 1, 200, 3, USER_AGENT]);
    assert.deepEqual(result.prefill, { requests: 3, expected: 3, by_status: { 'worker-200': 3 } });
    const sum = result.summary;
    assert.deepEqual(sum.by_status, { 'worker-200': 20 });
    assert.deepEqual([sum.writers, sum.colos, sum.cache, sum.versions, sum.remotes], [{ worker: 20 }, { TST: 20 }, { hit: 20 }, { [VERSION]: 20 }, { '127.0.0.1': 20 }]);
    assert.equal(result.transport.protocol, 'http/1.1');
    assert.ok(result.transport.connections >= 1 && result.transport.connections <= 23, `${result.transport.connections} connections`);
    assert.match(r.stdout, /^transport {4}http\/1\.1, \d+ connection\(s\) opened$/m);
    assert.equal(result.verdict, 'PASS');
  } finally {
    await s.close();
  }
});

test('edge load: one 429 of the edge fails no-429, and the record keeps its error code, never its page', async () => {
  const s = await stand((i) => (i === 7 ? edge(429, 1015) : worker()));
  try {
    const out = outPath();
    const r = await run(['--url', s.url, '--rps', '20', '--seconds', '1', '--prefill', '0', '--out', out]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^FAIL no-429 {2}1 of 20$/m);
    assert.match(r.stdout, /^by_status +worker-200:19 edge-429-1015:1$/m);
    assert.match(r.stdout, /\nFAIL\n$/);
    const text = readFileSync(out, 'utf8');
    assert.equal(text.includes('192.0.2.77'), false, 'the edge page names the caller, and the record never keeps it');
    // The stand-in plants by arrival, which can differ from the client's order, so the sample's index is not asserted.
    assert.deepEqual(
      JSON.parse(text).summary.samples.map((x) => [x.key, x.code]),
      [['edge-429-1015', 1015]],
    );
  } finally {
    await s.close();
  }
});

test('edge load: a challenge, a 403 and a 503 each fail no-gate, whoever wrote the 503', async () => {
  for (const [planted, detail] of [
    [edge(403, 1020, { 'cf-mitigated': 'challenge' }), '403 0 · 503 0 · challenge 1 of 20'],
    [edge(403, 1020), '403 1 · 503 0 · challenge 0 of 20'],
    [worker(503), '403 0 · 503 1 · challenge 0 of 20'],
    [edge(503, 1102), '403 0 · 503 1 · challenge 0 of 20'],
  ]) {
    const s = await stand((i) => (i === 4 ? planted : worker()));
    try {
      const r = await run(['--url', s.url, '--rps', '20', '--seconds', '1', '--prefill', '0']);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, new RegExp(`^FAIL no-gate {2}${detail}$`, 'm'));
      assert.match(r.stdout, /^PASS no-429/m);
    } finally {
      await s.close();
    }
  }
});

test('edge load: an edge answer of --expect, a redirect and a client timeout count as other, and a 502 as 5xx', async () => {
  const s = await stand((i) => {
    if (i === 2) return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>a page of the edge</html>' };
    if (i === 3) return { status: 301, headers: { location: 'http://127.0.0.1:1/elsewhere' }, body: '' };
    if (i === 4) return { hang: true };
    if (i === 5) return edge(502, 1101);
    return worker();
  });
  try {
    const out = outPath();
    const r = await run(['--url', s.url, '--rps', '10', '--seconds', '1', '--prefill', '0', '--timeout-ms', '1000', '--out', out]);
    assert.equal(r.code, 1);
    const sum = JSON.parse(readFileSync(out, 'utf8')).summary;
    assert.deepEqual(sum.counts, { requests: 10, expected: 6, 429: 0, 403: 0, 503: 0, challenge: 0, '5xx': 1, other: 3 });
    assert.deepEqual(sum.by_status, { 'worker-200': 6, 'edge-200': 1, 'edge-301': 1, 'client-timeout': 1, 'edge-502-1101': 1 });
    assert.equal(s.state.requests.filter((q) => q.path !== '/healthz').length, 0, 'the redirect is not followed');
    assert.ok(sum.latency_ms.max >= 1000, 'the client timeout counts in the latency');
    assert.match(r.stdout, /^FAIL 5xx-at-most-1pct {2}1 of 10$/m);
    assert.match(r.stdout, /^FAIL other-at-most-1pct {2}3 of 10$/m);
  } finally {
    await s.close();
  }
});

test('edge load: a prefill that does not answer --expect from the Worker fails prefill-expected, and the run still goes on', async () => {
  const s = await stand((i) => (i === 0 ? edge(502, 1101) : worker()));
  try {
    const r = await run(['--url', s.url, '--rps', '10', '--seconds', '1', '--prefill', '2']);
    assert.equal(r.code, 1);
    assert.equal(s.state.requests.length, 12);
    assert.match(r.stdout, /^FAIL prefill-expected {2}1 of 2$/m);
    assert.match(r.stdout, /^requests {5}10 {2}200 10 /m);
  } finally {
    await s.close();
  }
});

test('edge load: --doh resolves the host through the DoH server and connects there; a DoH answer with no address exits 2 before any request', async () => {
  const s = await stand();
  const d = await dohServer({ 'edge-load.test A': ['127.0.0.1'] });
  try {
    const url = `http://edge-load.test:${s.port}/healthz`;
    const out = outPath();
    const r = await run(['--url', url, '--rps', '10', '--seconds', '1', '--prefill', '1', '--doh', d.url, '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(
      d.asked.map((q) => [q.key, q.accept]),
      [
        ['edge-load.test A', 'application/dns-json'],
        ['edge-load.test AAAA', 'application/dns-json'],
      ],
    );
    assert.equal(s.state.requests.length, 11);
    assert.ok(
      s.state.requests.every((q) => q.host === `edge-load.test:${s.port}`),
      'the Host header keeps the name',
    );
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(result.resolver, { kind: 'doh', doh: d.url, family: null, addresses: [{ address: '127.0.0.1', family: 4 }] });
    assert.match(r.stdout, /^resolver {5}doh http:\/\/127\.0\.0\.1:\d+\/dns-query: 127\.0\.0\.1$/m);
  } finally {
    await d.close();
  }
  const empty = await dohServer({});
  const failing = await dohServer({}, 500);
  try {
    for (const doh of [empty.url, failing.url]) {
      const out = outPath();
      const r = await run(['--url', `http://edge-load.test:${s.port}/healthz`, '--rps', '10', '--seconds', '1', '--doh', doh, '--out', out]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /could not run: the DoH server (gave no A or AAAA address for edge-load\.test|answered 500)/);
      assert.equal(existsSync(out), false);
    }
    assert.equal(s.state.requests.length, 11, 'no request reached the target');
  } finally {
    await empty.close();
    await failing.close();
    await s.close();
  }
});

test('edge load: --family keeps the addresses of one family, so every request leaves from one source address; a family the resolver lacks exits 2', async () => {
  const s = await stand();
  const d = await dohServer({ 'edge-load.test A': ['127.0.0.1'], 'edge-load.test AAAA': ['::1'] });
  try {
    const url = `http://edge-load.test:${s.port}/healthz`;
    const out = outPath();
    const r = await run(['--url', url, '--rps', '10', '--seconds', '1', '--prefill', '0', '--doh', d.url, '--family', '4', '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(result.resolver, { kind: 'doh', doh: d.url, family: 4, addresses: [{ address: '127.0.0.1', family: 4 }] });
    assert.deepEqual(result.summary.remotes, { '127.0.0.1': 10 });
    assert.equal(result.run.family, 4);
    assert.match(r.stdout, /^edge-load place=local rps=10 seconds=1 expect=200 prefill=0 family=4 /m);
    const only4 = await dohServer({ 'edge-load.test A': ['127.0.0.1'] });
    try {
      const six = await run(['--url', url, '--rps', '10', '--seconds', '1', '--doh', only4.url, '--family', '6']);
      assert.equal(six.code, 2);
      assert.match(six.stderr, /could not run: the doh resolver gave no IPv6 address for edge-load.test/);
    } finally {
      await only4.close();
    }
    assert.equal(s.state.requests.length, 10, 'the refused run sent nothing');
  } finally {
    await d.close();
    await s.close();
  }
});

// A cleartext HTTP/2 stand-in of the Worker. It counts the sessions the client
// opened, and closes a session gracefully after `closeAfter` streams when set.
async function standH2(closeAfter = 0) {
  const state = { sessions: 0, streams: 0, ua: new Set() };
  const open = new Set();
  const perSession = new WeakMap();
  const server = http2.createServer();
  server.on('session', (session) => {
    state.sessions += 1;
    open.add(session);
    session.on('close', () => open.delete(session));
  });
  server.on('stream', (stream, headers) => {
    state.streams += 1;
    state.ua.add(headers['user-agent']);
    const w = worker();
    stream.respond({ ':status': w.status, ...w.headers });
    stream.end(w.body);
    const n = (perSession.get(stream.session) ?? 0) + 1;
    perSession.set(stream.session, n);
    if (closeAfter > 0 && n === closeAfter) stream.session.close();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}/healthz`,
    state,
    close: () =>
      new Promise((ok) => {
        for (const session of open) session.destroy();
        server.close(ok);
      }),
  };
}

test('edge load: --h2 sends every request over one HTTP/2 connection, and counts a new one when the server closes it', async () => {
  const one = await standH2();
  try {
    const out = outPath();
    const r = await run(['--url', one.url, '--rps', '20', '--seconds', '1', '--prefill', '2', '--h2', '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual([one.state.sessions, one.state.streams, [...one.state.ua]], [1, 22, [USER_AGENT]]);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(result.transport, { protocol: 'h2', connections: 1 });
    assert.equal(result.run.h2, true);
    assert.deepEqual(result.summary.by_status, { 'worker-200': 20 });
    assert.match(r.stdout, /^transport {4}h2, 1 connection\(s\) opened$/m);
  } finally {
    await one.close();
  }
  // One request at a time, so no stream is in flight when the server closes its session.
  const closing = await standH2(3);
  try {
    const out = outPath();
    const r = await run(['--url', closing.url, '--rps', '1', '--seconds', '1', '--prefill', '7', '--h2', '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(closing.state.streams, 8);
    assert.equal(result.transport.connections, closing.state.sessions, 'the record counts every connection the server saw');
    assert.ok(result.transport.connections >= 3, `${result.transport.connections} connections for 8 requests at 3 a connection`);
  } finally {
    await closing.close();
  }
  assert.throws(
    () => parseFlags(['--url', 'https://w.example.test/healthz', '--rps', '1', '--h2', 'yes']),
    (e) => e instanceof UsageError && /--h2 takes no value|unexpected argument/.test(e.message),
  );
});

test('edge load: classify puts a challenge first, then 429, 403 and 503, and reads the writer from the Worker header', () => {
  const a = (status, headers = {}, text = '') => ({ status, headers, text, bytes: 0, remote: null, ms: 1, client: null });
  const w = { [WORKER_HEADER]: 'x' };
  assert.deepEqual(classify(a(200, w), 200), { writer: 'worker', cls: 'expected', key: 'worker-200', code: null });
  assert.deepEqual(classify(a(200), 200), { writer: 'edge', cls: 'other', key: 'edge-200', code: null });
  assert.deepEqual(classify(a(429, w), 200), { writer: 'worker', cls: '429', key: 'worker-429', code: null });
  assert.deepEqual(classify(a(429, { 'cf-mitigated': 'challenge' }, 'error code: 1015'), 200), { writer: 'edge', cls: 'challenge', key: 'edge-429-1015-mitigated-challenge', code: 1015 });
  assert.deepEqual(classify(a(503, {}, '<title>Error 1102</title>'), 200), { writer: 'edge', cls: '503', key: 'edge-503-1102', code: 1102 });
  assert.deepEqual(classify(a(500, w, 'error code: 1015'), 200), { writer: 'worker', cls: '5xx', key: 'worker-500', code: null }, 'a Worker body is never read for an edge code');
  assert.deepEqual(classify({ status: null, headers: {}, text: '', bytes: 0, remote: null, ms: 1, client: 'client-error ECONNRESET' }, 200), {
    writer: null,
    cls: 'other',
    key: 'client-error ECONNRESET',
    code: null,
  });
  assert.equal(edgeCode('nothing here'), null);
  assert.equal(edgeCode('error code: 1020'), 1020);
});

test('edge load: judge holds 1% as a pass and more as a fail, and no-gate sums 403, 503 and challenge', () => {
  const rec = (cls, key = 'worker-200') => ({ i: 0, lag: 0, ms: 5, writer: 'worker', cls, key, code: null, colo: 'TST', remote: '127.0.0.1', cache: 'hit', version: VERSION });
  const names = (crit) => Object.fromEntries(crit.map((c) => [c.name, c.pass]));
  const pre = { requests: 1, expected: 1 };
  const ok = [...Array.from({ length: 98 }, () => rec('expected')), rec('5xx', 'worker-500'), rec('other', 'client-timeout')];
  assert.deepEqual(names(judge(summarize(ok), pre)), { requests: true, 'no-429': true, 'no-gate': true, '5xx-at-most-1pct': true, 'other-at-most-1pct': true, 'prefill-expected': true });
  assert.equal(names(judge(summarize([...ok, rec('5xx', 'worker-502')]), pre))['5xx-at-most-1pct'], false);
  assert.equal(names(judge(summarize([...ok, rec('other', 'edge-200')]), pre))['other-at-most-1pct'], false);
  for (const cls of ['403', '503', 'challenge']) assert.equal(names(judge(summarize([...ok, rec(cls)]), pre))['no-gate'], false, cls);
  assert.equal(names(judge(summarize([]), pre)).requests, false);
  assert.equal(names(judge(summarize(ok), { requests: 2, expected: 1 }))['prefill-expected'], false);
});

test('edge load: pinnedLookup answers the host with its pinned addresses, by family, and leaves other names to the system', async () => {
  const look = pinnedLookup('w.example.test', [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 },
  ]);
  const call = (name, opts) => new Promise((ok) => look(name, opts, (err, a, f) => ok({ err, a, f })));
  assert.deepEqual(await call('w.example.test', { all: true }), {
    err: null,
    a: [
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ],
    f: undefined,
  });
  assert.deepEqual(await call('W.Example.Test', { family: 6 }), { err: null, a: '::1', f: 6 });
  const none = pinnedLookup('w.example.test', [{ address: '127.0.0.1', family: 4 }]);
  const missing = await new Promise((ok) => none('w.example.test', { family: 6 }, (err) => ok(err)));
  assert.equal(missing?.code, 'ENOTFOUND');
  const local = await call('localhost', { all: true });
  assert.equal(local.err, null);
  assert.ok(Array.isArray(local.a) && local.a.length > 0);
});
