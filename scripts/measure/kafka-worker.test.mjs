// scripts/measure/kafka-worker.mjs: DOM-005's reading of the probe's /kafka route.
// A local HTTP server stands in for the probe and runs the real route module
// (probes/worker/src/kafka.ts) against the fake broker of DOM-004's tests on
// 127.0.0.1 over Node sockets; a tail in memory gives each invocation a CPU time
// that is synthetic (a fixed cost plus a cost a message, chosen here), since no
// test can read Cloudflare's. The verdict is checked over that run and over
// faults planted one at a time; the tail's parser and the spawn of the default
// tail run on a stand-in process that prints events as wrangler does. No test
// reaches the network.
//
//   node scripts/test.mjs scripts/measure --name "kafka worker"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProbeError } from '../../probes/worker/src/gaps.ts';
import { LIMITS, makeKafkaRoute, PATH } from '../../probes/worker/src/kafka.ts';
import { ROOT } from '../files.mjs';
import { FakeBroker, zonestreamLike } from './fixtures/kafka/broker.mjs';
import { CONSUMED } from './kafka-runner.mjs';
import {
  CannotRun,
  CPU_PER_1000_MAX_MS,
  callRow,
  eventRow,
  JsonStream,
  joinTail,
  measure,
  readyLabel,
  parseFlags,
  readResult,
  SCHEMA,
  spawnTail,
  summarize,
  tailOf,
  verdict,
  wranglerTailCommand,
  wranglerVersion,
} from './kafka-worker.mjs';

const SCRIPT = fileURLToPath(new URL('./kafka-worker.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kafka-worker-'));
const broker = new FakeBroker(zonestreamLike(Date.now()));
let brokerPort = 0;
before(async () => {
  brokerPort = await broker.start();
});
after(async () => {
  await broker.stop();
  rmSync(dir, { recursive: true, force: true });
});

// A cloudflare:sockets Socket over a Node socket.
const nodeConnect = ({ hostname, port }) => {
  const sock = net.connect({ host: hostname, port });
  const { readable, writable } = Duplex.toWeb(sock);
  const opened = new Promise((ok, fail) => {
    sock.once('connect', () => ok({}));
    sock.once('error', fail);
  });
  return { readable, writable, opened, close: async () => sock.destroy() };
};

// The synthetic CPU of an invocation: 0.1 ms, and 0.004 ms a message.
const syntheticCpu = (messages) => 0.1 + messages * 0.004;

// The real tail showed a full UUID in a query value as REDACTED (MEASURED
// 2026-10-29T00:17Z); the stand-in does the same, so a label of that shape
// cannot be joined here either.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function redacted(url) {
  const out = new URL(url.href);
  for (const [k, v] of url.searchParams) if (UUID.test(v)) out.searchParams.set(k, 'REDACTED');
  return out.href;
}

// A stand-in for the probe: GET / lists the routes, GET /kafka runs the real
// route. Each answered request is pushed to `tail` as wrangler prints an event.
async function probe({ routes = ['/', '/kafka'], version = null, tail = null, cpu = syntheticCpu } = {}) {
  const route = makeKafkaRoute({ hostname: '127.0.0.1', port: brokerPort, connect: nodeConnect, log: () => {} });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let status = 200;
    let body;
    if (url.pathname === '/') body = { worker: 'domains-probe', routes: routes.map((path) => ({ method: 'GET', path, entry: 'DOM-061', summary: `${path} route` })) };
    else if (url.pathname === '/kafka') {
      try {
        const answer = await route.handle(new Request(url), {}, url, Date.now);
        status = answer.status;
        body = await answer.json();
        if (version !== null) body.v = version;
      } catch (err) {
        status = err instanceof ProbeError ? err.status : 500;
        body = { error: err.message };
      }
    } else {
      status = 404;
      body = { error: 'no route' };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    tail?.add({
      outcome: 'ok',
      scriptName: 'domains-probe',
      exceptions: [],
      logs: [],
      eventTimestamp: Date.now(),
      event: { request: { url: redacted(url), method: 'GET', headers: {} }, response: { status } },
      cpuTime: cpu(body?.messages ?? 0),
      wallTime: 40,
    });
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return { base: new URL(`http://127.0.0.1:${server.address().port}/`), close: () => new Promise((done) => server.close(done)) };
}

// max_bytes of 2 KiB: the fake log is small, and a full call (one that ends
// before the head) needs an answer that max_bytes cuts short.
const flagsFor = (base, extra = {}) => ({
  mode: 'measure',
  base,
  minutes: 0.02,
  maxBytes: 2048,
  certBackMin: 15,
  nrdBackMin: 1440,
  sweep: true,
  tail: 'memory',
  out: join(dir, `result-${Math.random().toString(36).slice(2)}.json`),
  verdict: false,
  ...extra,
});
const quiet = { log: () => {}, pollMs: 20, readyCapMs: 2000, flushCapMs: 500 };

// Runs the script as a process, its exit code read from the process itself.
const runScript = (args) =>
  new Promise((done, fail) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });

let passing = null;
async function passingRun() {
  if (passing !== null) return passing;
  const tail = tailOf('memory', true);
  const p = await probe({ tail });
  try {
    const flags = flagsFor(p.base);
    const result = await measure(flags, { ...quiet, startTail: () => tail });
    passing = { result, flags };
    return passing;
  } finally {
    await p.close();
  }
}

test('kafka worker: a run against the stand-in probe reads every topic, joins every call to its tail event, writes the result and passes', async () => {
  const { result, flags } = await passingRun();
  assert.equal(result.schema, SCHEMA);
  assert.equal(result.tail.ready, true);
  assert.equal(result.tail.matched, result.calls.length, 'every call has its tail event');
  assert.deepEqual(
    result.calls.filter((c) => c.phase === 'socket').map((c) => [c.sockets_asked, c.status, c.sockets.opened]),
    [
      [2, 200, 2],
      [6, 200, 6],
    ],
  );
  for (const topic of CONSUMED) {
    const t = result.topics[topic];
    assert.ok(t.calls >= 1, topic);
    assert.ok(t.messages > 0, topic);
    assert.equal(t.failed_batches, 0, topic);
    assert.equal(t.cpu.calls_with_cpu, t.calls, topic);
    // The judged figure: the synthetic CPU of the full calls over their messages.
    const full = result.calls.filter((c) => c.phase === 'loop' && c.topic === topic && c.messages > 0 && c.lag > 0);
    assert.ok(full.length >= 1, `${topic}: a full call`);
    assert.equal(t.cpu.full_calls_with_cpu, full.length, topic);
    const cpu = full.reduce((a, c) => a + syntheticCpu(c.messages), 0);
    const messages = full.reduce((a, c) => a + c.messages, 0);
    assert.equal(t.cpu.per_1000_ms, Math.round((cpu / messages) * 1000 * 1000) / 1000, topic);
    assert.ok(t.cpu.per_1000_ms < CPU_PER_1000_MAX_MS, topic);
    assert.equal(t.cpu.empty_call_cpu_ms.p50, 0.1, `${topic}: a call at the head costs the fixed 0.1 ms`);
  }
  assert.ok(result.topics.certstream_domains.by_codec.snappy > 0);
  assert.ok(result.topics.newly_registered_domain.by_codec.none > 0);
  // The sweep reached the route's cap: the fake topic holds far less than 1 MiB.
  assert.equal(result.sweep.steps.length, 7);
  assert.equal(result.sweep.largest_ok_max_bytes, LIMITS.max_bytes);
  assert.equal(result.sweep.first_failure, null);
  assert.deepEqual(result.errors, []);
  const written = JSON.parse(readFileSync(flags.out, 'utf8'));
  assert.deepEqual(written, JSON.parse(JSON.stringify(result)));
  assert.deepEqual(readResult(flags.out), written, 'the file reads back as a DOM-005 result');
  const text = readFileSync(flags.out, 'utf8');
  assert.ok(!text.includes('127.0.0.1'), 'the result records no URL and no address');
  const v = verdict(written);
  assert.deepEqual(v.failures, []);
  assert.equal(v.pass, true);
  assert.match(v.lines.join('\n'), /certstream_domains: \d+ messages in \d+ call\(s\)/);
  assert.match(v.lines.join('\n'), /max_bytes: the largest that answered 200 is 64 MiB/);
});

test('kafka worker: --verdict FILE prints PASS and exits 0, FAIL and exits 1, and refuses a file that is not a DOM-005 result or whose summary differs from its calls', async () => {
  const { result } = await passingRun();
  const file = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const pass = await runScript(['--verdict', file('pass.json', result)]);
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stdout, /^PASS DOM-005 Kafka from a Worker connect\(\)/);
  const failing = structuredClone(result);
  for (const c of failing.calls) c.cpu_ms = c.messages === null ? null : 1 + c.messages;
  Object.assign(failing, summarize(failing.calls));
  const fail = await runScript(['--verdict', file('fail.json', failing)]);
  assert.equal(fail.code, 1, fail.stderr);
  assert.match(fail.stdout, /^FAIL /);
  assert.match(fail.stdout, /FAIL certstream_domains: [\d.]+ ms of CPU per 1,000 messages, above 50/);
  const tampered = structuredClone(result);
  tampered.topics.certstream_domains.messages += 1;
  const bad = await runScript(['--verdict', file('tampered.json', tampered)]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /differ from its calls/);
  const other = await runScript(['--verdict', join(ROOT, 'scripts', 'measure', 'fixtures', 'kafka', 'recorded.json')]);
  assert.equal(other.code, 2);
  assert.match(other.stderr, /is not a DOM-005 result/);
  const missing = await runScript(['--verdict', join(dir, 'no-such.json')]);
  assert.equal(missing.code, 2);
  const usage = await runScript([]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /give --url/);
});

test('kafka worker: each planted fault fails the verdict on its own check, and only on it', async () => {
  const { result } = await passingRun();
  const plant = (fn) => {
    const r = structuredClone(result);
    fn(r);
    return verdict(r).failures;
  };
  const loopRow = (r, topic) => r.calls.find((c) => c.phase === 'loop' && c.topic === topic && c.messages > 0);
  const cases = [
    [
      'a loop call that answered 502',
      (r) =>
        r.calls.push({
          ...structuredClone(loopRow(r, 'newly_registered_fqdn')),
          label: 'x-502',
          status: 502,
          error: 'connect kafka.zonestream.openintel.nl:9092: refused',
          cpu_ms: null,
          outcome: null,
        }),
      /^1 of \d+ loop call\(s\) did not answer 200; the first: 502 connect/,
    ],
    [
      'a batch that failed its CRC',
      (r) => {
        const c = loopRow(r, 'certstream_domains');
        c.failed_batches = 1;
        c.failures = { crc: 1 };
      },
      /^1 batch\(es\) failed to decode: \{"crc":1\}$/,
    ],
    [
      'no snappy batch',
      (r) => {
        for (const c of r.calls) if (c.by_codec?.snappy) c.by_codec = { none: c.by_codec.snappy };
      },
      /^no snappy batch was decoded$/,
    ],
    [
      'no codec-none batch',
      (r) => {
        for (const c of r.calls) if (c.by_codec?.none) c.by_codec = { snappy: c.by_codec.none };
      },
      /^no codec-none batch was decoded$/,
    ],
    [
      'a tail with no cpuTime',
      (r) => {
        for (const c of r.calls) c.cpu_ms = null;
        r.tail.with_cpu = 0;
      },
      /^no CPU figure: the tail \(memory, ready true\) gave \d+ event\(s\), \d+ of \/kafka, and none carried cpuTime$/,
    ],
    [
      'CPU above the rule on one topic',
      (r) => {
        for (const c of r.calls) if (c.topic === 'newly_registered_domain' && c.phase === 'loop') c.cpu_ms = c.messages * 0.051 + 1;
      },
      new RegExp(`^newly_registered_domain: [\\d.]+ ms of CPU per 1,000 messages, above ${CPU_PER_1000_MAX_MS}$`),
    ],
    [
      'an invocation that exceeded its CPU',
      (r) => {
        loopRow(r, 'confirmed_newly_registered_domain').outcome = 'exceededCpu';
      },
      /^confirmed_newly_registered_domain: invocation outcomes \{"exceededCpu":1\}$/,
    ],
    [
      'a socket that did not open',
      (r) => {
        for (const c of r.calls)
          if (c.phase === 'socket') {
            c.status = 502;
            c.sockets.opened = 0;
            c.error = 'connect: refused';
          }
      },
      /^the socket did not open: 502 connect: refused$/,
    ],
    [
      'a topic that read nothing',
      (r) => {
        for (const c of r.calls) if (c.topic === 'newly_registered_fqdn' && c.phase === 'loop') c.messages = 0;
      },
      /^newly_registered_fqdn: no message was read$/,
    ],
    ['an error of a step', (r) => r.errors.push('the tail ended before it was ready (exit 1)'), /^error: the tail ended before it was ready \(exit 1\)$/],
    [
      'no CPU figure for the full calls of one topic',
      (r) => {
        for (const c of r.calls) if (c.topic === 'certstream_domains' && c.phase === 'loop' && c.lag > 0) c.cpu_ms = null;
      },
      /^certstream_domains: no full call \(one that ended before the head\) has a CPU figure$/,
    ],
  ];
  assert.deepEqual(verdict(result).failures, [], 'the unplanted run passes');
  for (const [name, fn, pattern] of cases) {
    const failures = plant(fn);
    assert.equal(failures.length, 1, `${name}: ${JSON.stringify(failures)}`);
    assert.match(failures[0], pattern, name);
  }
});

test('kafka worker: the CPU rule passes 50 ms per 1,000 messages and fails anything above it', async () => {
  const { result } = await passingRun();
  assert.equal(CPU_PER_1000_MAX_MS, 50);
  const at = (perMessageMs) => {
    const r = structuredClone(result);
    for (const c of r.calls) if (c.topic === 'newly_registered_domain' && c.phase === 'loop') c.cpu_ms = c.messages * perMessageMs;
    return verdict(r).failures.filter((f) => f.startsWith('newly_registered_domain:'));
  };
  assert.deepEqual(at(0.05), [], 'exactly 50 passes');
  assert.equal(at(0.050001).length, 1, '50.001 fails');
  assert.equal(at(0.075).length, 1, '75 fails');
});

test('kafka worker: joinTail gives each call its own event only, and a call with no event keeps no CPU figure', () => {
  const calls = ['a', 'b', 'c'].map((label) => ({ label, cpu_ms: null, tail_wall_ms: null, outcome: null }));
  const rows = [
    { path: PATH, call: 'a', cpu_ms: 5, wall_ms: 40, outcome: 'ok' },
    { path: PATH, call: 'c', cpu_ms: 7, wall_ms: 60, outcome: 'ok' },
    { path: '/', call: 'b', cpu_ms: 99, wall_ms: 1, outcome: 'ok' },
    { path: PATH, call: 'a', cpu_ms: 11, wall_ms: 1, outcome: 'ok' },
  ];
  const stats = { duplicates: 0 };
  joinTail(calls, rows, stats);
  assert.deepEqual(
    calls.map((c) => [c.label, c.cpu_ms, c.tail_wall_ms, c.outcome]),
    [
      ['a', 5, 40, 'ok'],
      ['b', null, null, null],
      ['c', 7, 60, 'ok'],
    ],
  );
  assert.equal(stats.matched, 2);
  assert.equal(stats.duplicates, 1);
});

test('kafka worker: the probe without /kafka, or one that answers another version, cannot be measured', async () => {
  const bare = await probe({ routes: ['/', '/gaps'] });
  try {
    await assert.rejects(
      measure(flagsFor(bare.base), { ...quiet, startTail: () => tailOf('memory', true) }),
      (err) => err instanceof CannotRun && /does not list \/kafka: probes\/worker took the route out when DOM-005 closed .* only --verdict FILE runs/.test(err.message),
    );
  } finally {
    await bare.close();
  }
  const tail = tailOf('memory', true);
  const newer = await probe({ version: 2, tail });
  try {
    const flags = flagsFor(newer.base);
    await assert.rejects(measure(flags, { ...quiet, startTail: () => tail }), (err) => err instanceof CannotRun && /answers \/kafka version 2; this script reads version 1/.test(err.message));
    assert.ok(existsSync(flags.out), 'what was measured before the refusal is written');
  } finally {
    await newer.close();
  }
});

test('kafka worker: as a process, --url with --no-tail measures, writes the result and exits 1 with FAIL on the missing CPU figure', async () => {
  const p = await probe();
  try {
    const out = join(dir, 'cli.json');
    const r = await runScript(['--url', p.base.href, '--minutes', '0.02', '--max-bytes', '2048', '--no-tail', '--no-sweep', '--out', out, '--verdict']);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /^FAIL DOM-005 /);
    assert.match(r.stdout, /FAIL no CPU figure: the tail \(none, ready null\) gave 0 event\(s\)/);
    assert.doesNotMatch(r.stdout, /FAIL .*(did not answer 200|failed to decode|no message was read)/, 'the decode itself passed');
    const written = readResult(out);
    assert.equal(written.tail.source, 'none');
    assert.ok(written.calls.length >= 6);
    const usage = await runScript(['--url', p.base.href, '--minutes', 'x']);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /--minutes needs a number above zero/);
  } finally {
    await p.close();
  }
  const gone = await runScript(['--url', 'http://127.0.0.1:9/', '--no-tail', '--out', join(dir, 'gone.json')]);
  assert.equal(gone.code, 2);
  assert.match(gone.stderr, /the probe's route list could not be read/);
});

test('kafka worker: a tail that never shows the run is recorded, and the verdict fails on the missing CPU figure', async () => {
  const deaf = tailOf('memory', true);
  const p = await probe();
  try {
    const flags = flagsFor(p.base, { sweep: false });
    const result = await measure(flags, { ...quiet, readyCapMs: 100, startTail: () => deaf });
    assert.equal(result.tail.ready, false);
    assert.match(result.errors[0], /the tail showed no request of this run in 0.1 s/);
    const { failures } = verdict(result);
    assert.ok(failures.some((f) => /^no CPU figure/.test(f)));
    assert.ok(failures.some((f) => /^error: the tail showed no request/.test(f)));
    assert.equal(result.sweep.steps.length, 0);
  } finally {
    await p.close();
  }
});

test('kafka worker: the tail parser splits pretty-printed events at any chunk boundary, skips text between them and counts a broken one', () => {
  const events = [
    { outcome: 'ok', event: { request: { url: 'https://probe.test/kafka?topic=t&offset=0&call=ab-1', method: 'GET' }, response: { status: 200 } }, cpuTime: 7, wallTime: 120 },
    { outcome: 'ok', event: { cron: '* * * * *', scheduledTime: 1 }, cpuTime: 1 },
    { event: { type: 'overload', message: 'Tail is currently in sampling mode' } },
    { outcome: 'exceededCpu', logs: [{ message: ['a } brace and a "quote" in a string \\ { ['] }], event: { request: { url: 'https://probe.test/?tail_ready=r1' } } },
  ];
  const text = `${JSON.stringify(events[0], null, 4)}\n  ▲ [WARNING] text that is not JSON\n${events
    .slice(1)
    .map((e) => JSON.stringify(e, null, 4))
    .join('\n')}\n{"broken": tru}\n`;
  for (const size of [1, 7, text.length]) {
    const got = [];
    let errors = 0;
    const stream = new JsonStream(
      (v) => got.push(v),
      () => (errors += 1),
    );
    for (let i = 0; i < text.length; i += size) stream.push(text.slice(i, i + size));
    assert.deepEqual(got, events, `chunks of ${size}`);
    assert.equal(errors, 1, `chunks of ${size}`);
  }
  assert.deepEqual(eventRow(events[0]), { kind: 'request', path: '/kafka', call: 'ab-1', ready: null, outcome: 'ok', cpu_ms: 7, wall_ms: 120, status: 200 });
  assert.deepEqual(eventRow(events[1]), { kind: 'other' });
  assert.deepEqual(eventRow(events[2]), { kind: 'overload' });
  assert.deepEqual(eventRow(events[3]), { kind: 'request', path: '/', call: null, ready: 'r1', outcome: 'exceededCpu', cpu_ms: null, wall_ms: null, status: null });
});

test('kafka worker: the default tail runs the pinned wrangler with node from probes/worker, and a spawned tail is parsed and stopped by its PID', async () => {
  const cmd = wranglerTailCommand();
  assert.equal(cmd.command, process.execPath);
  assert.deepEqual(cmd.args, [join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'tail', 'domains-probe', '--format', 'json']);
  assert.equal(cmd.cwd, join(ROOT, 'probes', 'worker'));
  assert.ok(existsSync(cmd.bin), 'wrangler is installed');
  assert.equal(wranglerVersion(), JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies.wrangler, 'the installed wrangler is the pinned one');
  // A stand-in for wrangler: prints two events as wrangler does, a line on stderr, then waits to be ended.
  const fake = join(dir, 'fake-tail.mjs');
  writeFileSync(
    fake,
    [
      "const ev = (call, cpu) => JSON.stringify({ outcome: 'ok', event: { request: { url: `https://probe.test/kafka?call=${call}` } }, cpuTime: cpu }, null, 4);",
      "process.stdout.write(ev('k-1', 3) + '\\n');",
      "process.stdout.write(ev('k-2', 5) + '\\n');",
      "process.stderr.write('a warning\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const errs = [];
  const tail = spawnTail({ command: process.execPath, args: [fake], cwd: dir }, { stderr: { write: (t) => errs.push(t) } });
  assert.equal(typeof tail.pid, 'number');
  for (let i = 0; i < 200 && tail.rows.length < 2; i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(tail.alive(), true);
  await tail.stop();
  assert.equal(tail.alive(), false);
  assert.notEqual(tail.stats.exit, null, 'the process ended');
  assert.deepEqual(
    tail.rows.map((r) => [r.call, r.cpu_ms]),
    [
      ['k-1', 3],
      ['k-2', 5],
    ],
  );
  assert.equal(tail.stats.kafka_events, 2);
  assert.equal(tail.stats.with_cpu, 2);
  assert.equal(tail.stats.stderr_lines, 1);
  assert.match(errs.join(''), /wrangler tail: a warning/);
});

test('kafka worker: a call row keeps the answer fields by name, and an answer that is not a JSON object gives none', () => {
  const base = { label: 'r-1', phase: 'loop', topic: 't', offsetQuery: '5', maxBytes: 1024, socketsAsked: 1, status: 200, clientMs: 12.34, error: null };
  const row = callRow({ ...base, body: { messages: 3, next_offset: 8, lag: 0, extra: 'ignored', bytes: 400 } });
  assert.equal(row.messages, 3);
  assert.equal(row.next_offset, 8);
  assert.equal(row.bytes, 400);
  assert.equal(row.client_ms, 12.3);
  assert.equal(row.extra, undefined);
  assert.equal(row.failures, null, 'a field the answer lacks is null');
  assert.equal(row.error, null);
  for (const body of ['text', [1, 2], 7]) {
    const odd = callRow({ ...base, body });
    assert.equal(odd.messages, null);
    assert.equal(odd.error, 'answered 200 with JSON that is not an object');
  }
  assert.equal(callRow({ ...base, status: 502, body: { error: 'connect: refused', stage: 'connect' } }).error, 'connect: refused');
  assert.equal(callRow({ ...base, status: null, body: null, error: 'the call failed: timeout' }).error, 'the call failed: timeout');
});

test('kafka worker: the flags have the Prove defaults and refuse what they cannot use', () => {
  const f = parseFlags(['--url', 'https://probe.example/', '--minutes', '10', '--verdict']);
  assert.equal(f.mode, 'measure');
  assert.equal(f.base.href, 'https://probe.example/');
  assert.equal(f.minutes, 10);
  assert.equal(f.maxBytes, LIMITS.default_max_bytes);
  assert.equal(f.certBackMin, 15);
  assert.equal(f.nrdBackMin, 1440);
  assert.equal(f.sweep, false, 'the memory sweep is off unless asked');
  assert.equal(parseFlags(['--url', 'https://probe.example/', '--sweep']).sweep, true);
  assert.equal(f.tail, 'wrangler');
  assert.equal(f.out, join(ROOT, 'docs', 'research', 'measure', 'DOM-005', 'result.json'));
  assert.equal(f.verdict, true);
  assert.equal(parseFlags(['--url', 'https://probe.example/sub']).base.href, 'https://probe.example/sub/');
  assert.equal(parseFlags(['--url', 'https://p.example', '--no-tail', '--no-sweep']).tail, 'none');
  assert.equal(parseFlags(['--verdict', 'x.json']).mode, 'verdict');
  for (const args of [
    [],
    ['--url'],
    ['--url', 'probe.example'],
    ['--url', 'ftp://p.example'],
    ['--url', 'https://p.example', '--verdict', 'x.json'],
    ['--url', 'https://p.example', '--minutes', '0'],
    ['--url', 'https://p.example', '--no-tail', '--tail-file', 't.json'],
  ]) {
    assert.throws(
      () => parseFlags(args),
      (err) => err.name === 'UsageError' || err.constructor.name === 'UsageError',
      args.join(' '),
    );
  }
});

test('kafka worker: the ready marker has the shape of a call label, which the tail shows whole, not a UUID, which it redacts', () => {
  assert.equal(readyLabel('0a1b2c3d'), '0a1b2c3d-ready');
  assert.doesNotMatch(readyLabel('0a1b2c3d'), UUID);
  assert.equal(redacted(new URL('https://probe.test/?tail_ready=0a1b2c3d-ready')), 'https://probe.test/?tail_ready=0a1b2c3d-ready');
  assert.match(redacted(new URL('https://probe.test/?tail_ready=1b4e28ba-2fa1-41d2-883f-0016d3cca427')), /tail_ready=REDACTED$/);
});
