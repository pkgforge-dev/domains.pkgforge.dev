// scripts/measure/kafka-runner.mjs: the verdict passes a result that meets the
// pass rule and fails each way the rule can be missed; the measuring run,
// against a fake broker shaped like Zonestream's, writes a result the verdict
// passes, records a corrupt batch as a failure, and records an unreachable
// broker; the window of step 6 and the per-day arithmetic are checked alone.
// The command line runs as a child process and its exit code is read from it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { closedPort, FakeBroker, runCli, zonestreamLike } from './fixtures/kafka/broker.mjs';
import { CONSUMED, measure, options, perDay, SCHEMA, verdict, windowStart } from './kafka-runner.mjs';

const SCRIPT = 'scripts/measure/kafka-runner.mjs';
const dirs = [];
const brokers = [];
after(async () => {
  for (const b of brokers) await b.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'kafka-runner-'));
  dirs.push(d);
  return d;
};

function passing() {
  return {
    schema: SCHEMA,
    started_at: '2026-10-28T10:00:00.000Z',
    runner: { os: 'Linux', arch: 'X64' },
    reach_9092: { port: 9092, ok: true, ms: 20 },
    reach_9091: { port: 9091, ok: false, error: 'timeout' },
    decode: { batches: 900, by_codec: { snappy: 800, none: 100 }, failures: {}, failed_by_codec: {} },
    snappy_failures: 0,
    window_5min: { window: ['2026-10-27T12:00:00.000Z', '2026-10-27T12:05:00.000Z'], messages: 290000, ended_by: 'window' },
    window_5min_seconds: 9.5,
    consume: Object.fromEntries(CONSUMED.map((t) => [t, { messages: 1000, messages_24h: 500000, wire_bytes_per_day: 6e9, raw_bytes_per_day: 2e10 }])),
    errors: [],
  };
}

test('the verdict passes a result that meets the pass rule', () => {
  const v = verdict(passing());
  assert.deepEqual(v.reasons, []);
  assert.equal(v.pass, true);
  assert.ok(v.lines.some((l) => /certstream_domains: 6\.000 GB a day on the wire/.test(l)));
});

test('the verdict fails each way the pass rule can be missed', () => {
  const cases = [
    ['9092 closed', (r) => (r.reach_9092 = { port: 9092, ok: false, error: 'timeout' }), /port 9092 is not reachable \(timeout\)/],
    ['9091 not recorded', (r) => delete r.reach_9091, /reach of port 9091 is not recorded/],
    ['a snappy failure', (r) => ((r.snappy_failures = 2), (r.decode.failures = { crc: 2 })), /2 snappy batch\(es\) failed/],
    ['snappy failures not recorded', (r) => delete r.snappy_failures, /snappy_failures is not recorded/],
    ['no snappy batch', (r) => (r.decode.by_codec = { none: 100 }), /no snappy batch was decoded/],
    ['another codec failed', (r) => (r.decode.failures = { gzip: 1 }), /1 batch\(es\) failed to decode/],
    ['a slow window', (r) => (r.window_5min_seconds = 60), /took 60 s, not under 60 s/],
    ['no window', (r) => (r.window_5min_seconds = null), /5-minute window was not read/],
    ['a cut window', (r) => (r.window_5min.ended_by = 'wall'), /did not read to its end \(ended_by wall\)/],
    ['an empty window', (r) => (r.window_5min.messages = 0), /held no message/],
    ['a missing per-day', (r) => (r.consume.newly_registered_fqdn.wire_bytes_per_day = null), /wire_bytes_per_day is not recorded for newly_registered_fqdn/],
    ['a missing topic', (r) => delete r.consume.confirmed_newly_registered_domain, /not recorded for confirmed_newly_registered_domain/],
    ['a step error', (r) => r.errors.push({ step: 'offsets', error: 'Error: boom' }), /1 step error\(s\): offsets: Error: boom/],
  ];
  for (const [name, plant, reason] of cases) {
    const r = passing();
    plant(r);
    const v = verdict(r);
    assert.equal(v.pass, false, name);
    assert.ok(
      v.reasons.some((x) => reason.test(x)),
      `${name}: ${v.reasons.join(' | ')}`,
    );
  }
  assert.match(verdict({ schema: 'other' }).error, /not a DOM-004 kafka-runner result/);
  assert.match(verdict(null).error, /not a DOM-004/);
});

test('the window of step 6 is 12:00Z of the latest day it ended 5 minutes before now', () => {
  const at = (s) => Date.parse(s);
  assert.equal(new Date(windowStart(at('2026-10-28T14:00:00Z'), null).t0).toISOString(), '2026-10-28T12:00:00.000Z');
  assert.equal(new Date(windowStart(at('2026-10-28T12:10:00Z'), null).t0).toISOString(), '2026-10-28T12:00:00.000Z');
  assert.equal(new Date(windowStart(at('2026-10-28T12:09:59Z'), null).t0).toISOString(), '2026-10-27T12:00:00.000Z');
  assert.equal(new Date(windowStart(at('2026-10-28T10:35:00Z'), null).t0).toISOString(), '2026-10-27T12:00:00.000Z');
  const fb = windowStart(at('2026-10-28T10:35:30Z'), at('2026-10-27T13:00:00Z'));
  assert.deepEqual([new Date(fb.t0).toISOString(), fb.fallback], ['2026-10-28T10:15:00.000Z', true]);
});

test('per-day bytes scale the sample to the day, and are null without a sample', () => {
  assert.equal(perDay(1000, 10, 864), 86400);
  assert.equal(perDay(1000, 0, 864), null);
  assert.equal(perDay(1000, 10, null), null);
});

async function zonestream(options) {
  const b = new FakeBroker(zonestreamLike(Date.now(), options));
  await b.start();
  brokers.push(b);
  return b;
}

test('a run against a Zonestream-shaped broker writes a result the verdict passes', async () => {
  const b = await zonestream();
  const data = scratch();
  const run = await runCli(SCRIPT, ['--host', '127.0.0.1', '--port', String(b.port), '--alt-port', String(await closedPort()), '--data', data], {
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    JOB_STARTED_AT: '2026-10-28T10:00:00Z',
  });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const file = join(data, 'result.json');
  const r = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(r.schema, SCHEMA);
  assert.deepEqual(r.runner.os, 'Linux');
  assert.equal(r.runner.job_started_at, '2026-10-28T10:00:00Z');
  assert.equal(r.reach_9092.ok, true);
  assert.equal(r.reach_9091.error, 'ECONNREFUSED');
  assert.deepEqual(Object.keys(r.topics).sort(), [
    'certstream',
    'certstream_domains',
    'confirmed_newly_registered_domain',
    'newly_issued_certificates_measurements',
    'newly_registered_domain',
    'newly_registered_fqdn',
    'newly_registered_fqdn_measurements',
  ]);
  assert.equal(r.topics.newly_registered_fqdn_measurements.partitions, 4);
  const cs = r.consume.certstream_domains;
  assert.ok(cs.messages >= 20 && cs.messages <= 40, `10 minutes of a message every 30 s, in whole batches of 20: ${cs.messages}`);
  assert.equal(cs.ended_by, 'window');
  assert.equal(cs.wire_bytes_per_day, Math.round((cs.wire_bytes / cs.messages) * cs.messages_24h));
  for (const t of CONSUMED) assert.ok(r.consume[t].wire_bytes_per_day > 0, t);
  assert.equal(r.window_5min.messages > 0, true);
  assert.equal(r.window_5min.json_errors, 0);
  assert.ok(r.decode.by_codec.snappy > 0);
  assert.equal(r.snappy_failures, 0);
  assert.equal(/address/i.test(JSON.stringify(r)), false, 'no address is recorded');
  const v = await runCli(SCRIPT, ['--verdict', file]);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /^PASS DOM-004/);
});

test('a corrupt certstream batch makes the run record a snappy failure and the verdict fail', async () => {
  const now = Date.now();
  // A message every 30 s in batches of 20: the last batch starts at now - 10 min,
  // inside step 3's range of now - 15 min to now - 5 min.
  const b = await zonestream({ corruptCertstream: [42_000_000_000 + 26 * 120 - 20] });
  const data = scratch();
  const run = await runCli(SCRIPT, ['--host', '127.0.0.1', '--port', String(b.port), '--alt-port', String(await closedPort()), '--data', data]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const r = JSON.parse(readFileSync(join(data, 'result.json'), 'utf8'));
  // 1, or 2 when the window of step 6 also holds the batch (a run at 12:10Z to 12:15Z).
  assert.ok(r.snappy_failures >= 1, JSON.stringify(r.decode));
  assert.deepEqual(Object.keys(r.decode.failures), ['crc']);
  const v = await runCli(SCRIPT, ['--verdict', join(data, 'result.json')]);
  assert.equal(v.code, 1);
  assert.match(v.stdout, /^FAIL DOM-004/);
  assert.match(v.stdout, /\d snappy batch\(es\) failed to decode/);
  assert.ok(Date.now() - now < 120e3);
});

test('a consumed topic the broker does not serve fails its own step and the verdict, and the others are measured', async () => {
  const topics = zonestreamLike(Date.now());
  delete topics.confirmed_newly_registered_domain;
  const b = new FakeBroker(topics);
  await b.start();
  brokers.push(b);
  const data = scratch();
  const run = await runCli(SCRIPT, ['--host', '127.0.0.1', '--port', String(b.port), '--alt-port', String(await closedPort()), '--data', data]);
  assert.equal(run.code, 1, run.stdout + run.stderr);
  const r = JSON.parse(readFileSync(join(data, 'result.json'), 'utf8'));
  assert.deepEqual(
    r.errors.map((e) => e.step),
    ['consume confirmed_newly_registered_domain'],
  );
  assert.ok(r.consume.newly_registered_domain.wire_bytes_per_day > 0);
  assert.ok(r.window_5min.messages > 0);
  const v = await runCli(SCRIPT, ['--verdict', join(data, 'result.json')]);
  assert.equal(v.code, 1);
  assert.match(v.stdout, /wire_bytes_per_day is not recorded for confirmed_newly_registered_domain/);
});

test('an unreachable broker is recorded, exits 1, and the verdict fails', async () => {
  const data = scratch();
  const run = await runCli(SCRIPT, ['--host', '127.0.0.1', '--port', String(await closedPort()), '--alt-port', String(await closedPort()), '--data', data]);
  assert.equal(run.code, 1, run.stdout + run.stderr);
  const r = JSON.parse(readFileSync(join(data, 'result.json'), 'utf8'));
  assert.equal(r.reach_9092.ok, false);
  assert.match(r.errors[0].error, /port 9092 is not reachable/);
  const v = await runCli(SCRIPT, ['--verdict', join(data, 'result.json')]);
  assert.equal(v.code, 1);
  assert.match(v.stdout, /port 9092 is not reachable \(ECONNREFUSED\)/);
});

test('the verdict exits 2 on a file it cannot read or that is not a DOM-004 result, and bad flags exit 2', async () => {
  const data = scratch();
  assert.equal((await runCli(SCRIPT, ['--verdict', join(data, 'missing.json')])).code, 2);
  writeFileSync(join(data, 'other.json'), '{"schema":"other"}');
  assert.equal((await runCli(SCRIPT, ['--verdict', join(data, 'other.json')])).code, 2);
  writeFileSync(join(data, 'broken.json'), '{');
  assert.equal((await runCli(SCRIPT, ['--verdict', join(data, 'broken.json')])).code, 2);
  assert.equal((await runCli(SCRIPT, ['--verdict'])).code, 2);
  assert.equal((await runCli(SCRIPT, ['--minutes', 'ten'])).code, 2);
  assert.equal((await runCli(SCRIPT, ['--minutes', '20', '--back', '15'])).code, 2);
  writeFileSync(join(data, 'pass.json'), JSON.stringify(passing()));
  assert.equal((await runCli(SCRIPT, ['--verdict', join(data, 'pass.json')])).code, 0);
});

test('the result is saved after every step, so a run cut short keeps what it measured', async () => {
  const b = await zonestream();
  const o = options(['--host', '127.0.0.1', '--port', String(b.port), '--alt-port', String(await closedPort()), '--data', scratch()]);
  const saved = [];
  const r = await measure(o, { save: (x) => saved.push(structuredClone(x)), log: () => {} });
  assert.deepEqual(r.errors, []);
  // reach, offsets, certstream_domains, the three NRD topics, the window, and the end.
  assert.equal(saved.length, 8);
  assert.equal(saved[0].reach_9092.ok, true);
  assert.equal(saved[0].topics, null);
  assert.ok(saved[1].topics.certstream_domains, 'the offsets are saved before any read');
  assert.deepEqual(saved[1].consume, {});
  assert.deepEqual(Object.keys(saved[2].consume), ['certstream_domains']);
  assert.equal(saved[6].window_5min.messages > 0, true);
  assert.equal(saved[6].finished_at, null);
  assert.notEqual(saved[7].finished_at, null);
});

test('a result that cannot be written exits 2', async () => {
  const data = scratch();
  const blocker = join(data, 'a-file');
  writeFileSync(blocker, 'not a directory');
  const run = await runCli(SCRIPT, ['--host', '127.0.0.1', '--port', String(await closedPort()), '--alt-port', String(await closedPort()), '--out', join(blocker, 'result.json')]);
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /kafka-runner: cannot write /);
});
