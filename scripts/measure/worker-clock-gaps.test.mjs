// scripts/measure/worker-clock-gaps.test.mjs — DOM-002's reading of the probe's
// ticks, run as a process on recorded /gaps answers whose gaps are known: from a
// file, and over HTTP from a local server standing in for the probe.
//
//   node scripts/test.mjs scripts/measure --name "worker clock gaps"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BREAK_MIN as PROBE_BREAK_MIN,
  DEFINITIONS as PROBE_DEFINITIONS,
  RULE as PROBE_RULE,
  quantile as probeQuantile,
  gapsResult,
  makeTick,
  requireCron,
  tickToJson,
} from '../../probes/worker/src/gaps.ts';
import { BREAK_MIN, DEFINITIONS, quantile, RULE } from './clock-gaps.mjs';
import { gapsUrl, recompute, ticksPathFor } from './worker-clock-gaps.mjs';

const SCRIPT = fileURLToPath(new URL('./worker-clock-gaps.mjs', import.meta.url));
const M1 = requireCron('* * * * *');
const M5 = requireCron('*/5 * * * *');
const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const dir = mkdtempSync(join(tmpdir(), 'worker-clock-gaps-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// The ticks of both crons from T0 until `untilMin` minutes, each started 40 ms
// late, without the minute slots `drop` names.
function ticks(untilMin, drop = () => false) {
  const out = [];
  for (let slot = 0; slot < untilMin; slot += 1) {
    const at = T0 + slot * MIN;
    if (!drop(slot)) out.push(makeTick(M1, at, at + 40, null, null));
    if (slot % 5 === 0) out.push(makeTick(M5, at, at + 40, 110 + (slot % 7), null));
  }
  return out;
}

// A /gaps?ticks=1 answer as the probe writes it: the result, then what it adds
// beside it, with the ticks it read: the window's, and each cron's first past it.
function answer(hours, nowMs, drop) {
  const toMs = T0 + hours * HOUR;
  const all = ticks(Math.min(hours * 60 + 10, (nowMs - T0) / MIN), drop);
  const read = all.filter((t) => t.scheduledMs < toMs);
  for (const cron of [M1.cron, M5.cron]) {
    const past = all.find((t) => t.cron === cron && t.scheduledMs >= toMs);
    if (past) read.push(past);
  }
  return { ...gapsResult({ ticks: read, hours, fromMs: T0, nowMs }), read_from: 'R2 binding PROBE', list_calls: 9, ticks: read.map(tickToJson) };
}

let n = 0;
function file(value) {
  const path = join(dir, `answer-${n++}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function run(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

const verdicts = (stderr) => stderr.split('\n').filter((line) => line.startsWith('verdict='));

test('worker clock gaps: 48 hours with a 45 minute hole write the file and print one verdict=PASS line', async () => {
  const out = join(dir, 'pass.json');
  const r = await run(['--input', file(answer(48, T0 + 49 * HOUR, (s) => s >= 100 && s < 144)), '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const lines = verdicts(r.stderr);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^verdict=PASS clock=worker cron="\* \* \* \* \*" runs=2836\/2880 p90_gap_min=1 max_gap_min=45 breaks_over_30min=1 missed=44 /);
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(JSON.parse(r.stdout), written);
  assert.equal(written.clock, 'worker');
  assert.equal(written.runs, 2836);
  assert.equal(written.expected, 2880);
  assert.deepEqual(written.gaps_min, { median: 1, p90: 1, max: 45 });
  assert.deepEqual(written.slots, { expected: 2880, hit: 2836, missed: 44 });
  assert.equal(written.breaks_over_30min, 1);
  assert.deepEqual(written.put_ms, { median: 113, p90: 116, max: 116 });
  assert.equal(written.class_a_ops, (2836 + 576) * 2 + 576);
  assert.equal(written.beside[0].expected, 576);
  assert.equal(written.ticks, undefined);
  assert.equal(written.read_from, undefined);
  // The answer is kept beside the result only when it came from the probe.
  assert.equal(existsSync(ticksPathFor(out)), false);
});

test('worker clock gaps: a 61 minute hole is a FAIL verdict, written, exit 0', async () => {
  const out = join(dir, 'fail.json');
  const r = await run(['--input', file(answer(48, T0 + 49 * HOUR, (s) => s >= 100 && s < 160)), '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(verdicts(r.stderr)[0], /^verdict=FAIL /);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).gaps_min.max, 61);
});

test('worker clock gaps: a window that has not ended exits 1 and writes nothing', async () => {
  const out = join(dir, 'partial.json');
  const r = await run(['--input', file(answer(48, T0 + 10 * HOUR)), '--out', out]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(verdicts(r.stderr)[0], /^verdict=INCOMPLETE .* hours_seen=10\/48$/);
  assert.match(r.stderr, /has not ended; nothing written/);
  assert.equal(existsSync(out), false);
});

test('worker clock gaps: an answer whose numbers differ from its own ticks is refused', async () => {
  const saved = answer(48, T0 + 49 * HOUR);
  saved.gaps_min = { ...saved.gaps_min, max: 2 };
  const out = join(dir, 'tampered.json');
  const r = await run(['--input', file(saved), '--out', out]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /differ from the recomputation in gaps_min/);
  assert.equal(existsSync(out), false);
});

test('worker clock gaps: an answer for other hours, without ticks, or with a bad tick is refused', async () => {
  const saved = answer(48, T0 + 49 * HOUR);
  const other = await run(['--input', file(saved), '--hours', '24']);
  assert.equal(other.code, 2);
  assert.match(other.stderr, /covers 48 hours, not 24/);
  const { ticks: _dropped, ...bare } = saved;
  const noTicks = await run(['--input', file(bare)]);
  assert.equal(noTicks.code, 2);
  assert.match(noTicks.stderr, /no ticks array/);
  const broken = await run(['--input', file({ ...saved, ticks: [{ ...saved.ticks[0], lag_ms: 41 }, ...saved.ticks.slice(1)] })]);
  assert.equal(broken.code, 2);
  assert.match(broken.stderr, /bad tick: tick #0: lag_ms 41/);
});

test('worker clock gaps: bad usage exits 2', async () => {
  const saved = file(answer(1, T0 + 2 * HOUR));
  for (const args of [
    [],
    ['--input', saved, '--url', 'http://127.0.0.1:9/gaps'],
    ['--input', saved, '--hours', '0'],
    ['--input', saved, '--hours', 'x'],
    ['--url', 'probe.example/gaps'],
    ['--input', saved, '--out'],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /usage:/);
  }
});

test('worker clock gaps: the /gaps URL asks for the hours and every tick', () => {
  assert.equal(gapsUrl('https://probe.example/gaps', 48), 'https://probe.example/gaps?hours=48&ticks=1');
  assert.equal(ticksPathFor('docs/research/measure/DOM-002/worker.json'), 'docs/research/measure/DOM-002/worker.ticks.json');
});

test('worker clock gaps: over HTTP it reads the probe, writes the result and the answer beside it; a 500 exits 2', async () => {
  const saved = answer(1, T0 + 2 * HOUR);
  const asked = [];
  const server = createServer((request, response) => {
    asked.push(request.url);
    if (request.url.startsWith('/broken')) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"planted"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(saved));
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const out = join(dir, 'http.json');
    const r = await run(['--url', `${base}/gaps`, '--hours', '1', '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(verdicts(r.stderr)[0], /^verdict=PASS /);
    assert.equal(asked[0], '/gaps?hours=1&ticks=1');
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).runs, 60);
    // The saved answer reads back offline to the same result.
    const kept = ticksPathFor(out);
    assert.deepEqual(JSON.parse(readFileSync(kept, 'utf8')), saved);
    const again = await run(['--input', kept]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), JSON.parse(readFileSync(out, 'utf8')));
    const broken = await run(['--url', `${base}/broken/gaps`, '--hours', '1', '--out', join(dir, 'broken.json')]);
    assert.equal(broken.code, 2);
    assert.match(broken.stderr, /answered 500/);
    const wrongHours = await run(['--url', `${base}/gaps`, '--out', join(dir, 'wrong.json')]);
    assert.equal(wrongHours.code, 2);
    assert.equal(asked.at(-1), '/gaps?hours=48&ticks=1');
  } finally {
    await new Promise((closed) => server.close(closed));
  }
});

// DOM-003 compares this result with DOM-001's, so the probe's copy of the
// arithmetic (probes/worker/src/gaps.ts) and clock-gaps.mjs must agree on the
// rule, the break threshold and the quantile, in code and in the definition
// each result carries.
test('worker clock gaps: the probe and clock-gaps.mjs share the rule, the break threshold and the quantile', () => {
  assert.deepEqual({ ...PROBE_RULE }, { ...RULE });
  assert.equal(PROBE_BREAK_MIN, BREAK_MIN);
  assert.equal(PROBE_DEFINITIONS.quantiles, DEFINITIONS.quantiles);
  const lists = [[], [7], [3, 1, 2], [4, 1, 3, 2], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [0.5, 61, 1, 1, 14.99, 15, 15.01, 2, 3]];
  for (let size = 1; size <= 40; size += 1) lists.push(Array.from({ length: size }, (_, i) => ((i * 37) % 23) + i / 10));
  for (const xs of lists) for (const q of [0.5, 0.9]) assert.equal(probeQuantile(xs, q), quantile(xs, q), `q=${q} of ${JSON.stringify(xs)}`);
});

// The recomputation detects a deployed probe that runs other code: every member
// of the result is compared, so a tamper of any one of them is refused. It
// cannot find an arithmetic defect that both sides share (both run gaps.ts);
// gaps.test.ts pins the arithmetic itself.
test('worker clock gaps: a tamper of any one member of the result is refused', () => {
  const saved = answer(2, T0 + 3 * HOUR, (s) => s === 17);
  const keys = Object.keys(gapsResult({ ticks: [], hours: 2, fromMs: null, nowMs: T0 }));
  assert.ok(keys.length >= 25);
  assert.deepEqual(recompute(structuredClone(saved), 2).runs, 119);
  for (const key of keys) {
    const tampered = structuredClone(saved);
    tampered[key] = { tampered: key };
    assert.throws(() => recompute(tampered, 2), Error, key);
    if (!['version', 'clock', 'hours', 'from', 'now'].includes(key)) assert.throws(() => recompute(tampered, 2), new RegExp(`differ from the recomputation in ${key}(,|:)`), key);
  }
});
