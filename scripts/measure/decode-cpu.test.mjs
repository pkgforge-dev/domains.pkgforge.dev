// scripts/measure/decode-cpu.test.mjs — DOM-008's reading of the probe's CPU
// time, offline. Every input is synthetic: scripts/measure/fixtures/decode/
// tail.synthetic.txt was written by hand in the shape `wrangler tail --format
// json` prints (JSON.stringify(event, null, 4), wrangler 4.150.0's jsonPrintLogs)
// with the trace fields of @cloudflare/workers-types 5.20261013.1 (cpuTime,
// wallTime, outcome, event.request.url, event.response.status); its numbers are
// invented and no tail printed it. The runs below are generated here, and the
// live path runs against a local HTTP server standing in for the probe, with a
// tail fed in process. Each refusal plants the one fault its guard catches.
//
//   node scripts/test.mjs scripts/measure --name "decode cpu"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../files.mjs';
import {
  blocksOf,
  CouldNotRun,
  createJsonSplitter,
  eventRecord,
  lines,
  main,
  PLAN,
  parseFlags,
  RESULT_FORMAT,
  RUN_FORMAT,
  requestUrl,
  runPathFor,
  spawnTail,
  summarise,
  UsageError,
  wranglerTailCommand,
} from './decode-cpu.mjs';
import { MANIFEST_FORMAT } from './make-sample-pack.mjs';

const SCRIPT = fileURLToPath(new URL('./decode-cpu.mjs', import.meta.url));
const TAIL = fileURLToPath(new URL('./fixtures/decode/tail.synthetic.txt', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'decode-cpu-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const T0 = Date.parse('2026-10-28T12:00:00.000Z');
const NAMES = 262_144;

const crcOf = (per, blocks) => ((per * 31 + blocks * 7919) >>> 0).toString(16).padStart(8, '0');

// A manifest of make-sample-pack.mjs with the CRC chain crcOf gives.
function manifest(change = () => {}) {
  const m = {
    format: MANIFEST_FORMAT,
    names: NAMES,
    packs: [1024, 4096, 16384].map((per) => ({ per, blocks: NAMES / per, records: NAMES, crc_through: Array.from({ length: NAMES / per }, (_, i) => crcOf(per, i + 1)) })),
  };
  change(m);
  return m;
}

const answerOf = (combo) => {
  const blocks = blocksOf(combo);
  const names = Math.min(blocks * combo.per, NAMES);
  return { names, crc32: crcOf(combo.per, blocks), per: combo.per, blocks, raw_bytes: names * 10, packed_bytes: names * 6, rows_count: combo.rows ?? null };
};

// A run as runLive returns it: `requests` requests a combination, each traced
// unless drop says not, with the CPU time cpu(c, n).
function syntheticRun({
  requests = 20,
  cpu = (c, n) => 0.4 + 0.1 * c + n * 0.01,
  wall = (_c, n) => 30 + n,
  drop = () => false,
  status = () => 200,
  outcome = () => 'ok',
  answer = (c) => answerOf(PLAN[c]),
} = {}) {
  const runId = 'feedc0de';
  const reqs = [];
  const events = [];
  for (let n = 0; n < requests; n += 1) {
    for (let c = 0; c < PLAN.length; c += 1) {
      const tag = `${runId}.${c}.${n}`;
      const s = status(c, n);
      reqs.push({ tag, combo: c, status: s, client_wall_ms: 120 + n, answer: s === 200 ? answer(c, n) : null, error: s === 200 ? null : 'planted' });
      if (!drop(c, n)) events.push({ tag, outcome: outcome(c, n), cpu_ms: cpu(c, n), wall_ms: wall(c, n), status: s, at: T0 + n });
    }
  }
  return {
    format: RUN_FORMAT,
    entry: 'DOM-008',
    url: 'https://probe.example.test/decode',
    run_id: runId,
    started: new Date(T0).toISOString(),
    ended: new Date(T0 + 60_000).toISOString(),
    requests_per_combination: requests,
    concurrency: 4,
    plan: PLAN,
    cpu_source: 'tail',
    tail: { command: 'synthetic' },
    requests: reqs,
    events,
  };
}

let n = 0;
function file(value) {
  const path = join(dir, `in-${n++}.json`);
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
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('decode cpu: the splitter reads wrangler 4-space JSON events back to back, cut anywhere, and skips text between them', () => {
  const text = readFileSync(TAIL, 'utf8');
  for (const size of [1, 7, 64, text.length]) {
    const got = [];
    const splitter = createJsonSplitter((v) => got.push(v));
    splitter.push('Connected to domains-probe\n');
    for (let at = 0; at < text.length; at += size) splitter.push(text.slice(at, at + size));
    assert.equal(got.length, 4, `chunks of ${size}`);
    assert.equal(got[3].exceptions[0].message, 'a message with {braces}, [brackets] and an escaped "quote" inside');
    assert.equal(splitter.stats.skipped_chars, 'Connectedtodomains-probe'.length);
    assert.equal(splitter.stats.bad, 0);
  }
  const bad = createJsonSplitter(() => assert.fail('a broken object is not a value'));
  bad.push('{"a": 1,}\n');
  assert.equal(bad.stats.bad, 1);
});

test('decode cpu: a trace event of a tagged /decode request keeps its cpuTime, wallTime, outcome and status; any other is not the run', () => {
  const events = [];
  const splitter = createJsonSplitter((v) => events.push(v));
  splitter.push(readFileSync(TAIL, 'utf8'));
  assert.deepEqual(
    events.map((e) => eventRecord(e, 'run1')),
    [
      null,
      { tag: 'run1.1.0', outcome: 'ok', cpu_ms: 2, wall_ms: 31, status: 200, at: 1793203201000 },
      null,
      { tag: 'run1.9.0', outcome: 'exception', cpu_ms: 9, wall_ms: 58, status: 500, at: 1793203203000 },
    ],
  );
  assert.equal(eventRecord(events[1], 'run2'), null, 'another run');
  const { cpuTime: _cpu, ...noCpu } = events[1];
  assert.equal(eventRecord(noCpu, 'run1').cpu_ms, null, 'a missing cpuTime stays missing: wallTime never stands in for it');
});

test('decode cpu: a run prints p50 and p99 CPU time for each combination and PASS under the rule', async () => {
  const path = file(syntheticRun());
  const r = await run(['--input', path, '--out', join(dir, 'pass.json')]);
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout.trim().split('\n');
  assert.equal(out.length, PLAN.length + 3);
  // blocks=1 per=4096 is PLAN[3]: values 0.7 + n/100, so p50 is index 10 and p99 index 19.
  assert.match(out[3], /^blocks=1 per=4096 +traced=20\/20 cpu_ms p50=0\.8 p99=0\.89 max=0\.89 per_block p50=0\.8 p99=0\.89 per_1000_names p50=0\.195 p99=0\.217 wall_ms p50=40 p99=49 errors=0$/);
  assert.match(out[5], /^blocks=16 per=4096 .* per_block p50=0\.063 p99=0\.068 /);
  assert.match(out.at(-3), /^PASS decode-4096-p99-at-most-3ms: p99 0\.89 ms, at most 3 ms; errors=0/);
  assert.match(out.at(-2), /^PASS rows-1000-p99-at-most-15ms: p99 1\.49 ms, at most 15 ms; errors=0/);
  assert.equal(out.at(-1), 'verdict=PASS cpu_source=tail cpu_whole_ms=false');
  const result = JSON.parse(readFileSync(join(dir, 'pass.json'), 'utf8'));
  assert.equal(result.format, RESULT_FORMAT);
  assert.equal(result.cpu_source, 'tail');
  assert.match(result.wall_field, /never CPU time/);
  assert.deepEqual([result.combinations[3].raw_bytes, result.combinations[3].packed_bytes], [40_960, 24_576]);
  assert.equal(existsSync(runPathFor(join(dir, 'pass.json'))), false, 'an offline reading writes no run file');
});

test('decode cpu: a p99 over 3 ms for one 4,096-name block, or a failed invocation of 1,000 rows, is FAIL and exit 1', async () => {
  const slow = await run(['--input', file(syntheticRun({ cpu: (c, n) => (c === 3 ? 2.5 + n * 0.05 : 0.5) }))]);
  assert.equal(slow.code, 1, slow.stderr);
  assert.match(slow.stdout, /^FAIL decode-4096-p99-at-most-3ms: p99 3\.45 ms/m);
  assert.match(slow.stdout, /^PASS rows-1000-p99-at-most-15ms/m);
  const failed = await run(['--input', file(syntheticRun({ outcome: (c, n) => (c === 9 && n === 4 ? 'exceededCpu' : 'ok') }))]);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^FAIL rows-1000-p99-at-most-15ms: p99 1\.49 ms, at most 15 ms; errors=1/m);
  const refused = await run(['--input', file(syntheticRun({ status: (c, n) => (c === 3 && n === 0 ? 503 : 200) }))]);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /^FAIL decode-4096-p99-at-most-3ms: p99 0\.89 ms, at most 3 ms; errors=1/m);
});

test('decode cpu: trace events with wallTime and no cpuTime are refused, never read as CPU time', async () => {
  const r = await run(['--input', file(syntheticRun({ cpu: () => null }))]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /the tail's trace events carry no cpuTime, so this source gives no CPU time/);
  assert.equal(r.stdout, '');
});

test('decode cpu: a combination with fewer than 90% of its requests traced cannot be judged', async () => {
  const r = await run(['--input', file(syntheticRun({ drop: (c, n) => c === 7 && n < 3 }))]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /blocks=4 per=16384: 17 of 20 requests have a trace event with cpuTime, fewer than 90%/);
  assert.equal((await run(['--input', file(syntheticRun({ drop: (c, n) => c === 7 && n < 2 }))])).code, 0, '18 of 20 is enough');
});

test('decode cpu: an event with no cpuTime is not traced, so 3 of 20 of them leave a combination unjudged', async () => {
  const cpu = (c, k) => (c === 3 && k < 3 ? null : 0.4 + 0.1 * c + k * 0.01);
  const r = await run(['--input', file(syntheticRun({ cpu }))]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /blocks=1 per=4096: 17 of 20 requests have a trace event with cpuTime, fewer than 90%/);
});

test('decode cpu: a plan without a combination a rule judges, or a manifest pack with too few blocks, cannot be judged', async () => {
  const whole = syntheticRun();
  const noRule = { ...whole, plan: whole.plan.map((c, i) => (i === 3 ? { ...c, per: 2048 } : c)) };
  const r = await run(['--input', file(noRule)]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /the run's plan has no blocks=1 per=4096, which decode-4096-p99-at-most-3ms judges/);
  const small = await run(['--input', file(whole), '--manifest', file(manifest((m) => (m.packs[2].blocks = 8)))]);
  assert.equal(small.code, 2);
  assert.match(small.stderr, /the manifest's pack of 16384 holds 8 blocks, fewer than 16/);
});

test('decode cpu: answers that disagree within a combination, or with the manifest, are refused', async () => {
  const split = await run(['--input', file(syntheticRun({ answer: (c, k) => ({ ...answerOf(PLAN[c]), crc32: c === 1 && k === 5 ? '00000000' : answerOf(PLAN[c]).crc32 }) }))]);
  assert.equal(split.code, 2);
  assert.match(split.stderr, /blocks=4 per=1024: the probe's answers disagree/);
  const path = file(syntheticRun());
  assert.equal((await run(['--input', path, '--manifest', file(manifest())])).code, 0);
  const other = await run(['--input', path, '--manifest', file(manifest((m) => (m.packs[2].crc_through[15] = 'ffffffff')))]);
  assert.equal(other.code, 2);
  assert.match(other.stderr, /blocks=16 per=16384: the probe answered 262144 names, crc32 [0-9a-f]{8}; the manifest says 262144, ffffffff/);
  const wrong = await run(['--input', path, '--manifest', file(manifest((m) => (m.format = 'x')))]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /the manifest is "x"/);
});

test('decode cpu: a run of another format or source is refused', () => {
  assert.throws(() => summarise({ ...syntheticRun(), format: 'other' }), CouldNotRun);
  assert.throws(() => summarise({ ...syntheticRun(), cpu_source: 'logs' }), /CPU source is "logs", not tail/);
  assert.throws(() => summarise({ ...syntheticRun(), events: [] }), /no trace event matched/);
  assert.equal(lines(summarise(syntheticRun())).at(-1), 'verdict=PASS cpu_source=tail cpu_whole_ms=false');
  assert.equal(summarise(syntheticRun({ cpu: (_c, k) => k % 3 })).cpu_whole_ms, true);
});

// A local stand-in for the probe whose every /decode answer is also pushed, as
// a trace event, to the tail the run started. `traced` decides which are.
async function standIn({ traced = () => true, cpuTime = (url) => (url.searchParams.has('rows') ? 1.2 : 0.3 * Number(url.searchParams.get('blocks'))) } = {}) {
  let onEvent = null;
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stand-in.test');
    seen.push(url.search);
    const per = Number(url.searchParams.get('per'));
    const combo = url.searchParams.has('rows') ? { mode: 'rows', per, rows: Number(url.searchParams.get('rows')) } : { mode: 'blocks', per, blocks: Number(url.searchParams.get('blocks')) };
    const body = { ...answerOf(combo), tag: url.searchParams.get('tag') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify(body)}\n`);
    const event = { cpuTime: cpuTime(url), wallTime: 25, outcome: 'ok', eventTimestamp: Date.now(), event: { request: { url: `https://probe.example.test${req.url}` }, response: { status: 200 } } };
    if (onEvent !== null && traced(url)) setImmediate(() => onEvent(event));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const tail = { stopped: false };
  const startTail = async (fn) => {
    onEvent = fn;
    return { hasExited: () => false, stderr: () => '', stats: { objects: 0 }, stop: async () => void (tail.stopped = true) };
  };
  return { url: `http://127.0.0.1:${server.address().port}/decode`, seen, tail, startTail, close: () => new Promise((done) => server.close(done)) };
}

const FAST = { readyMs: 2000, readyEachMs: 200, quietMs: 300, drainMaxMs: 2000, pollMs: 10 };

test('decode cpu: a live run against a stand-in for the probe writes the result and the run, and the run reads back to the same result', async () => {
  const probe = await standIn();
  const out = join(dir, 'live', 'result.json');
  const stdout = [];
  const stderr = [];
  try {
    const code = await main(['--url', probe.url, '--requests', '6', '--concurrency', '3', '--out', out], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      startTail: probe.startTail,
      timing: FAST,
    });
    assert.equal(code, 0, stderr.join(''));
  } finally {
    await probe.close();
  }
  assert.equal(probe.tail.stopped, true, 'the tail is stopped');
  assert.match(probe.seen[0], /^\?blocks=1&per=1024&tag=[0-9a-f]{8}\.ready\.0$/);
  assert.equal(probe.seen.length, 1 + 6 * PLAN.length);
  const result = JSON.parse(readFileSync(out, 'utf8'));
  const saved = JSON.parse(readFileSync(runPathFor(out), 'utf8'));
  assert.equal(saved.format, RUN_FORMAT);
  assert.equal(saved.events.length, 1 + 6 * PLAN.length, 'the marker and every request');
  assert.deepEqual(
    result.combinations.map((c) => [c.name, c.traced, c.cpu_ms.p99]),
    PLAN.map((c) => [c.mode === 'blocks' ? `blocks=${c.blocks} per=${c.per}` : `rows=1000 per=4096`, 6, c.mode === 'rows' ? 1.2 : Number((0.3 * c.blocks).toFixed(3))]),
  );
  const again = await run(['--input', runPathFor(out)]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, stdout.join(''));
});

test('decode cpu: a live run whose tail never shows the marker, or traces no cpuTime, exits 2 and keeps what it read', async () => {
  const silent = await standIn({ traced: () => false });
  try {
    const stderr = [];
    const code = await main(['--url', silent.url, '--requests', '1'], { stdout: { write: () => {} }, stderr: { write: (s) => stderr.push(s) }, startTail: silent.startTail, timing: FAST });
    assert.equal(code, 2);
    assert.match(stderr.join(''), /no marker request showed in the tail within 2 s/);
    assert.equal(silent.tail.stopped, true);
  } finally {
    await silent.close();
  }
  const blind = await standIn({ cpuTime: () => undefined });
  const out = join(dir, 'blind', 'result.json');
  try {
    const stderr = [];
    const code = await main(['--url', blind.url, '--requests', '2', '--out', out], { stdout: { write: () => {} }, stderr: { write: (s) => stderr.push(s) }, startTail: blind.startTail, timing: FAST });
    assert.equal(code, 2);
    assert.match(stderr.join(''), /carry no cpuTime/);
  } finally {
    await blind.close();
  }
  assert.equal(existsSync(out), false, 'no result');
  assert.equal(JSON.parse(readFileSync(runPathFor(out), 'utf8')).requests.length, 2 * PLAN.length, 'the run is kept');
});

test('decode cpu: the default tail is the wrangler 4.150.0 of node_modules, run by node from probes/worker', () => {
  const { command, args, cwd } = wranglerTailCommand();
  assert.equal(command, process.execPath);
  assert.equal(args[0], join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
  assert.ok(existsSync(args[0]));
  assert.deepEqual(args.slice(1), ['tail', 'domains-probe', '--format', 'json']);
  assert.equal(cwd, join(ROOT, 'probes', 'worker'));
  const fake = join(dir, 'root');
  mkdirSync(join(fake, 'node_modules', 'wrangler'), { recursive: true });
  writeFileSync(join(fake, 'node_modules', 'wrangler', 'package.json'), JSON.stringify({ version: '4.149.0', bin: { wrangler: './bin/wrangler.js' } }));
  assert.throws(() => wranglerTailCommand(fake), /node_modules holds wrangler 4\.149\.0, not 4\.150\.0/);
});

test('decode cpu: spawnTail reads the events a child prints, and stop() ends the child by its PID', async () => {
  const events = [];
  const child = spawnTail({
    command: process.execPath,
    args: ['-e', "process.stdout.write(require('fs').readFileSync(process.argv[1])); setInterval(() => {}, 1000)", TAIL],
    cwd: dir,
    onEvent: (e) => events.push(e),
  });
  for (let waited = 0; events.length < 4 && waited < 10_000; waited += 20) await sleep(20);
  assert.equal(events.length, 4);
  assert.equal(child.hasExited(), false);
  await child.stop();
  assert.equal(child.hasExited(), true);
});

test('decode cpu: usage faults exit 2', async () => {
  for (const [args, re] of [
    [[], /exactly one of --url and --input/],
    [['--url', 'https://p.test/decode', '--input', 'x.json'], /exactly one of --url and --input/],
    [['--url', 'https://p.test/gaps', '--requests', '1'], /ending in \/decode/],
    [['--url', 'https://p.test/decode?blocks=1', '--requests', '1'], /with no query/],
    [['--url', 'https://p.test/decode'], /--requests N is required/],
    [['--url', 'https://p.test/decode', '--requests', '0'], /--requests must be a whole number from 1 to 2000/],
    [['--url', 'https://p.test/decode', '--requests', '1', '--concurrency', '17'], /--concurrency must be a whole number from 1 to 16/],
    [['--input', 'x.json', '--requests', '5'], /--requests and --concurrency go with --url/],
    [['--input', 'x.json', '--source', 'logs'], /unknown flag --source/],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re);
  }
  assert.throws(() => parseFlags(['--url']), UsageError);
  assert.equal(requestUrl('https://p.test/decode', PLAN[9], 'a.9.0'), 'https://p.test/decode?rows=1000&per=4096&tag=a.9.0');
});
