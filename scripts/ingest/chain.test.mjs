// scripts/ingest/chain.mjs: the chain of ingest-live.yml (D14 of DOM-024). The
// off cases, the dispatch held by a waiting run, the dispatch tried three
// times, a listing that fails, the boundary arithmetic, a clock file that does
// not validate, and a planted failing step: the chain job's steps, start, a
// step that fails, due and sleep, run in order with the conditions of
// ingest-live.yml, where the dispatch is recorded before the failure. The
// verb due (DOM-023's Decision of 2026-11-01): the last instant of each cron
// of DUE, the table held to the workflow files, and each answer of a row. A
// fake gh logs each call and answers from the test; no test reaches GitHub.
// Every test name holds "chain" (the Prove of DOM-024: node scripts/test.mjs
// scripts/ingest --name chain).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { ROOT } from '../files.mjs';
import {
  DEFAULT_CLOCK,
  DEFAULT_INTERVAL_MIN,
  DISPATCH_PAUSE_S,
  DUE,
  DUE_GRACE_S,
  DUE_LIST_LIMIT,
  DUE_SINCE,
  EXIT,
  GH_TIMEOUT_MS,
  ghRunner,
  INTERVAL_MIN_RANGE,
  lastInstant,
  main,
  nextBoundary,
  readClock,
} from './chain.mjs';

const SCRIPT = fileURLToPath(new URL('./chain.mjs', import.meta.url));
const ENV = { GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '400', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'pkgforge-dev/domains.pkgforge.dev', GH_TOKEN: 'synthetic' };
const ENOENT = () => {
  const e = new Error('ENOENT: no such file or directory');
  e.code = 'ENOENT';
  throw e;
};

// A fake gh: `runs` answers `run list` (a list of runs, or `fail`), `dispatch`
// answers each `workflow run` in turn (0 or a failing code). Every call, and
// every sleep, goes into `log` in order.
function fake({ runs = [], dispatch = [0] } = {}) {
  const log = [];
  let n = 0;
  const gh = (args) => {
    log.push(`gh ${args.join(' ')}`);
    if (args[0] === 'run' && args[1] === 'list')
      return runs === 'fail' ? { code: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' } : { code: 0, stdout: typeof runs === 'string' ? runs : JSON.stringify(runs), stderr: '' };
    if (args[0] === 'workflow' && args[1] === 'run') {
      const code = dispatch[Math.min(n++, dispatch.length - 1)];
      return { code, stdout: '', stderr: code === 0 ? '' : 'HTTP 500: Internal Server Error' };
    }
    return { code: 2, stdout: '', stderr: `fake gh does not know ${args.join(' ')}` };
  };
  const sleep = async (ms) => {
    log.push(`sleep ${ms}`);
  };
  return { gh, sleep, log };
}

async function chain(argv, { clock = { clock: 'actions-chain' }, env = ENV, runs, dispatch, now } = {}) {
  const f = fake({ runs, dispatch });
  const out = [];
  const err = [];
  const readFile = clock === null ? ENOENT : () => (typeof clock === 'string' ? clock : JSON.stringify(clock));
  const code = await main(argv, { gh: f.gh, sleep: f.sleep, env, readFile, now: () => Date.parse(now ?? '2026-10-30T08:23:17Z'), out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, log: f.log, text: `${out.join('\n')}\n${err.join('\n')}` };
}

test('chain: with no config/clock.json, start, due and sleep are off, call no gh and sleep not at all', async () => {
  for (const verb of ['start', 'due', 'sleep']) {
    const r = await chain([verb], { clock: null });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, ['chain off: config/clock.json does not exist; only the cron and dispatches start runs']);
    assert.deepEqual(r.log, []);
  }
});

test('chain: another clock is off for every verb', async () => {
  for (const clock of ['actions-schedule', 'worker', 'none']) {
    for (const verb of ['start', 'due', 'sleep']) {
      const r = await chain([verb], { clock: { clock, decided: '2026-10-30T00:00:00Z' } });
      assert.equal(r.code, EXIT.ok, r.text);
      assert.deepEqual(r.out, [`chain off: the clock is ${clock}`]);
      assert.deepEqual(r.log, []);
    }
  }
});

test('chain: a run of another ref starts no successor, and a re-run neither', async () => {
  const branch = await chain(['start'], { env: { ...ENV, GITHUB_REF: 'refs/heads/feature' } });
  assert.equal(branch.code, EXIT.ok);
  assert.deepEqual(branch.out, ['chain off: a run on refs/heads/feature starts no successor']);
  const again = await chain(['start'], { env: { ...ENV, GITHUB_RUN_ATTEMPT: '2' } });
  assert.equal(again.code, EXIT.ok);
  assert.deepEqual(again.out, ['chain off: attempt 2 is a re-run; attempt 1 started the successor']);
  assert.deepEqual([...branch.log, ...again.log], []);
});

test('chain: a waiting run holds the dispatch; this run, running runs and finished ones do not', async () => {
  const runs = [
    { databaseId: 400, status: 'queued' },
    { databaseId: 399, status: 'in_progress' },
    { databaseId: 398, status: 'completed' },
  ];
  const free = await chain(['start'], { runs });
  assert.equal(free.code, EXIT.ok, free.text);
  assert.deepEqual(free.out, ['chain started: the successor is dispatched (try 1)']);
  assert.deepEqual(free.log, [
    'gh run list --repo pkgforge-dev/domains.pkgforge.dev --workflow ingest-live.yml --branch main --limit 50 --json databaseId,status',
    'gh workflow run ingest-live.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev',
  ]);
  for (const status of ['queued', 'pending', 'waiting', 'requested']) {
    const held = await chain(['start'], { runs: [...runs, { databaseId: 401, status }] });
    assert.equal(held.code, EXIT.ok, held.text);
    assert.deepEqual(held.out, ['chain held: 1 run(s) wait; the chain goes on through them']);
    assert.equal(
      held.log.some((l) => l.startsWith('gh workflow run')),
      false,
    );
  }
});

test('chain: three failed dispatches, 15 s apart, are broken: exit 1', async () => {
  const r = await chain(['start'], { dispatch: [1, 1, 1] });
  assert.equal(r.code, EXIT.broken, r.text);
  assert.deepEqual(r.out, ['chain broken: the successor was not dispatched in 3 tries; the cron backstop restarts the chain']);
  assert.deepEqual(
    r.log.filter((l) => !l.startsWith('gh run list')),
    [
      'gh workflow run ingest-live.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev',
      `sleep ${DISPATCH_PAUSE_S * 1000}`,
      'gh workflow run ingest-live.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev',
      `sleep ${DISPATCH_PAUSE_S * 1000}`,
      'gh workflow run ingest-live.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev',
    ],
  );
  const second = await chain(['start'], { dispatch: [1, 0] });
  assert.equal(second.code, EXIT.ok);
  assert.deepEqual(second.out, ['chain started: the successor is dispatched (try 2)']);
});

test('chain: a listing that fails or does not parse warns and still dispatches', async () => {
  for (const runs of ['fail', 'not json', JSON.stringify({ runs: [] }), JSON.stringify([{ id: 1 }])]) {
    const r = await chain(['start'], { runs });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.out[0], /^chain warn: the runs did not list \(.+\); the successor is dispatched anyway$/);
    assert.equal(r.out[1], 'chain started: the successor is dispatched (try 1)');
  }
});

test('chain: sleep waits to the first multiple of interval_min since the epoch strictly after now', async () => {
  assert.equal(nextBoundary(Date.parse('2026-10-30T08:23:17Z'), 10), Date.parse('2026-10-30T08:30:00Z'));
  assert.equal(nextBoundary(Date.parse('2026-10-30T08:30:00Z'), 10), Date.parse('2026-10-30T08:40:00Z'));
  assert.equal(nextBoundary(Date.parse('2026-10-30T08:29:59.500Z'), 10), Date.parse('2026-10-30T08:30:00Z'));
  // 7 minutes: multiples of 420 s since 1970, not of the hour.
  const seven = nextBoundary(Date.parse('2026-10-30T08:23:17Z'), 7);
  assert.equal(seven % 420_000, 0);
  assert.ok(seven > Date.parse('2026-10-30T08:23:17Z') && seven - Date.parse('2026-10-30T08:23:17Z') <= 420_000);
  // 30 minutes, ruling 27's interval: the boundaries are the hour and the half hour.
  assert.equal(nextBoundary(Date.parse('2026-10-30T08:23:17Z'), 30), Date.parse('2026-10-30T08:30:00Z'));
  assert.equal(nextBoundary(Date.parse('2026-10-30T08:30:00Z'), 30), Date.parse('2026-10-30T09:00:00Z'));
  assert.equal(nextBoundary(Date.parse('2026-10-30T23:59:59.500Z'), 30), Date.parse('2026-10-31T00:00:00Z'));
  // With no interval_min the sleep takes the default, 30.
  const r = await chain(['sleep'], { now: '2026-10-30T08:43:17Z' });
  assert.equal(r.code, EXIT.ok, r.text);
  assert.deepEqual(r.out, ['sleep 1003 s to 2026-10-30T09:00:00Z']);
  assert.deepEqual(r.log, ['sleep 1003000']);
  // A now on a boundary sleeps a whole interval, the longest sleep: 1,800 s at 30.
  const top = await chain(['sleep', '--now', '2026-10-30T08:30:00Z'], { clock: { clock: 'actions-chain', interval_min: 30 } });
  assert.deepEqual([top.out, top.log], [['sleep 1800 s to 2026-10-30T09:00:00Z'], ['sleep 1800000']]);
  const at = await chain(['sleep', '--now', '2026-10-30T08:30:00Z'], { clock: { clock: 'actions-chain', interval_min: 12 } });
  assert.deepEqual(at.out, ['sleep 360 s to 2026-10-30T08:36:00Z']);
  const ten = await chain(['sleep'], { clock: { clock: 'actions-chain', interval_min: 10 } });
  assert.deepEqual(ten.out, ['sleep 403 s to 2026-10-30T08:30:00Z']);
});

test("chain: the default interval is ruling 27's 30 minutes, config/clock.json sets it, and the range tops out at it", () => {
  assert.equal(DEFAULT_INTERVAL_MIN, 30);
  assert.deepEqual({ ...INTERVAL_MIN_RANGE }, { min: 1, max: 30 });
  assert.ok(Object.isFrozen(INTERVAL_MIN_RANGE));
  assert.deepEqual(readClock(DEFAULT_CLOCK), { clock: 'actions-chain', interval: DEFAULT_INTERVAL_MIN });
  assert.equal(JSON.parse(readFileSync(DEFAULT_CLOCK, 'utf8')).interval_min, DEFAULT_INTERVAL_MIN, 'the file names the interval, not only the default');
  // Each end of the range reads, and the default divides an hour, so the boundaries fall on the hour.
  for (const interval_min of [INTERVAL_MIN_RANGE.min, INTERVAL_MIN_RANGE.max]) assert.equal(readClock('x', () => JSON.stringify({ clock: 'actions-chain', interval_min })).interval, interval_min);
  assert.equal(60 % DEFAULT_INTERVAL_MIN, 0);
});

test('chain: an interval out of 1 to 30, a clock not of the four, a file not JSON and no repository are exit 2', async () => {
  for (const interval_min of [0, 31, 60, 2.5, '30', null]) {
    const r = await chain(['sleep'], { clock: { clock: 'actions-chain', interval_min } });
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, /interval_min is .+, not a whole number of 1 to 30/);
    assert.deepEqual(r.log, [], 'no sleep');
  }
  const clock = await chain(['start'], { clock: { clock: 'cron' } });
  assert.equal(clock.code, EXIT.usage);
  assert.match(clock.text, /clock is "cron", not one of actions-schedule, actions-chain, worker, none/);
  const text = await chain(['start'], { clock: '{"clock":' });
  assert.equal(text.code, EXIT.usage);
  assert.match(text.text, /is not JSON/);
  // JSON that is no object: null, a list and a string.
  for (const json of ['null', '["actions-chain"]', '"actions-chain"']) {
    const r = await chain(['start'], { clock: json });
    assert.equal(r.code, EXIT.usage, json);
    assert.match(r.text, /clock\.json is not a JSON object$/m, json);
    assert.deepEqual(r.log, [], 'gh never ran');
  }
  const repo = await chain(['start'], { env: { ...ENV, GITHUB_REPOSITORY: '' } });
  assert.equal(repo.code, EXIT.usage);
  assert.match(repo.text, /GITHUB_REPOSITORY is not set/);
  assert.deepEqual(repo.log, []);
  for (const argv of [[], ['stop'], ['start', '--now', '2026-10-30T08:00:00Z'], ['sleep', '--now', '2026-10-30T08:00Z'], ['start', '--workflow', '../x.yml']]) {
    assert.equal((await chain(argv)).code, EXIT.usage, argv.join(' '));
  }
  // The chain dispatches ingest-live.yml and no other workflow; a flag of one value is given once.
  for (const [argv, re] of [
    [['start', '--workflow=-x.yml'], /--workflow "-x\.yml" is not ingest-live\.yml/],
    [['start', '--workflow', 'root-promote.yml'], /--workflow "root-promote\.yml" is not ingest-live\.yml/],
    [['start', '--workflow', '..yml'], /is not ingest-live\.yml/],
    [['sleep', '--now', '2026-10-30T08:00:00Z', '--now', '2026-10-30T09:00:00Z'], /--now is given twice/],
    // A word after the verb is no flag, and a flag with no value is refused, never taken as the default.
    [['start', 'extra'], /^chain: "extra" is not a flag$/m],
    [['start', '--clock'], /^chain: --clock needs a value$/m],
    [['sleep', '--clock'], /^chain: --clock needs a value$/m],
  ]) {
    const r = await chain(argv);
    assert.equal(r.code, EXIT.usage, argv.join(' '));
    assert.match(r.text, re);
    assert.deepEqual(r.log, [], 'gh never ran');
  }
  assert.equal((await chain(['start', '--workflow', 'ingest-live.yml'])).code, EXIT.ok);
});

// The job chain as GitHub runs it, with the steps that run a script and a
// planted failing step after the start: in order, a step with no `if` while no
// step before it failed, and the sleep when the start succeeded (its `if` in
// ingest-live.yml, held by the test below). The steps read the committed
// config/clock.json. Each step's outcome, and the log of the fake gh and sleep.
async function chainJobModel({ dispatch, planted = false } = {}) {
  const f = fake({ dispatch });
  const out = [];
  const deps = { gh: f.gh, sleep: f.sleep, env: ENV, readFile: (p) => readFileSync(p, 'utf8'), now: () => Date.parse('2026-11-01T02:00:00Z'), out: (l) => out.push(l), err: () => undefined };
  const outcome = {};
  const plant = async () => {
    f.log.push('planted step fails');
    return 1;
  };
  const steps = [
    { id: 'start', run: () => main(['start'], deps) },
    ...(planted ? [{ id: 'planted', run: plant }] : []),
    { id: 'due', run: () => main(['due'], deps) },
    { id: 'sleep', when: () => outcome.start === 'success', run: () => main(['sleep'], deps) },
  ];
  for (const s of steps) {
    const runs = s.when ? s.when() : !Object.values(outcome).includes('failure');
    outcome[s.id] = !runs ? 'skipped' : (await s.run()) === 0 ? 'success' : 'failure';
  }
  return { outcome, out, log: f.log };
}

test('chain: a step of the chain job that fails after the start does not stop the dispatch or the sleep, and the job ends failed', async () => {
  const job = parse(readFileSync(join(ROOT, '.github', 'workflows', 'ingest-live.yml'), 'utf8')).jobs.chain.steps;
  assert.deepEqual(
    job.filter((s) => s.run).map((s) => [s.id, s.if]),
    [
      ['start', undefined],
      ['due', undefined],
      ['sleep', "${{ !cancelled() && steps.start.outcome == 'success' }}"],
    ],
    'the conditions chainJobModel runs the steps by',
  );
  const r = await chainJobModel({ planted: true });
  assert.deepEqual(r.outcome, { start: 'success', planted: 'failure', due: 'skipped', sleep: 'success' }, 'the job ends failed at the planted step');
  const dispatched = r.log.indexOf('gh workflow run ingest-live.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev');
  assert.ok(dispatched >= 0, r.log.join('\n'));
  assert.ok(dispatched < r.log.indexOf('planted step fails'), r.log.join('\n'));
  // On the boundary of 02:00, the committed interval of 30 minutes sleeps to 02:30.
  assert.deepEqual(r.out, ['chain started: the successor is dispatched (try 1)', 'sleep 1800 s to 2026-11-01T02:30:00Z']);
  assert.equal(r.log.at(-1), 'sleep 1800000', 'the sleep after the failure ran');
  // With no plant, the due step runs between the start and the sleep.
  const clean = await chainJobModel();
  assert.deepEqual(clean.outcome, { start: 'success', due: 'success', sleep: 'success' });
  assert.deepEqual(clean.out.slice(0, 2), ['chain started: the successor is dispatched (try 1)', 'due compact-daily.yml: dispatched for 2026-11-01T01:35:00Z']);
  assert.equal(clean.out.at(-1), 'sleep 1800 s to 2026-11-01T02:30:00Z');
  // A start that fails skips the due step and the sleep: with no successor, the sleep holds no grid.
  const broken = await chainJobModel({ dispatch: [1, 1, 1] });
  assert.deepEqual(broken.outcome, { start: 'failure', due: 'skipped', sleep: 'skipped' });
  assert.equal(
    broken.log.some((l) => l.includes('compact-daily.yml') || l === `sleep ${1_800_000}`),
    false,
    broken.log.join('\n'),
  );
});

test('chain: the production defaults read the clock file, the environment and the clock, and sleep for real', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-chain-'));
  try {
    const off = spawnSync(process.execPath, [SCRIPT, 'start', '--clock', join(dir, 'absent.json')], { encoding: 'utf8', env: { ...process.env, ...ENV } });
    assert.equal(off.status, EXIT.ok, off.stderr);
    assert.equal(off.stdout, 'chain off: config/clock.json does not exist; only the cron and dispatches start runs\n');
    // A boundary one second away: the real sleep ends, and the process exits 0.
    // The bound of 30 s fails a sleep that ignores the file's interval at once
    // (status null), where the default of 30 minutes would hang the suite.
    const clock = join(dir, 'clock.json');
    writeFileSync(clock, '{"clock":"actions-chain","interval_min":1}');
    const now = new Date();
    const at = `${new Date(now.getTime() - (now.getTime() % 60_000) + 59_000).toISOString().slice(0, 19)}Z`;
    const slept = spawnSync(process.execPath, [SCRIPT, 'sleep', '--clock', clock, '--now', at], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(slept.status, EXIT.ok, `${slept.stderr} ${slept.signal ?? ''}`);
    assert.match(slept.stdout, /^sleep 1 s to \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z\n$/);
    assert.deepEqual(readClock(clock), { clock: 'actions-chain', interval: 1 });
    // The production gh answers a code and its output, whether or not gh is installed.
    const r = ghRunner(['--version']);
    assert.equal(typeof r.code, 'number');
    assert.equal(typeof r.stdout, 'string');
    assert.equal(typeof r.stderr, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain: the production gh runs gh with a bound of 60 s, and a gh that does not start or runs past it answers 127', () => {
  assert.equal(GH_TIMEOUT_MS, 60_000);
  const calls = [];
  const spawn = (answer) => (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    return answer;
  };
  assert.deepEqual(ghRunner(['run', 'list'], spawn({ status: 0, stdout: '[]', stderr: '' })), { code: 0, stdout: '[]', stderr: '' });
  assert.deepEqual(calls, [['gh', ['run', 'list'], { encoding: 'utf8', timeout: 60_000, windowsHide: true }]]);
  // spawnSync sets error for a gh that does not start and for one it killed at the bound.
  for (const code of ['ENOENT', 'ETIMEDOUT']) {
    const error = Object.assign(new Error(`spawnSync gh ${code}`), { code });
    assert.deepEqual(ghRunner(['run', 'list'], spawn({ error, status: null, stdout: undefined })), { code: 127, stdout: '', stderr: `cannot run gh: spawnSync gh ${code}` });
  }
  // A gh ended by a signal has no status: 128.
  assert.deepEqual(ghRunner(['run', 'list'], spawn({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' })), { code: 128, stdout: '', stderr: '' });
  // The real spawnSync with no gh on PATH: 127 and its reason.
  const dir = mkdtempSync(join(tmpdir(), 'ingest-chain-nogh-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
    const child = `import { ghRunner } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; process.stdout.write(JSON.stringify(ghRunner(['--version'])));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', env: { ...env, PATH: dir } });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.equal(got.code, 127, r.stdout);
    assert.match(got.stderr, /^cannot run gh: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain: a listing that fails is no listing, whatever it printed, and a sleep part of a second long sleeps a whole second', async () => {
  const log = [];
  const out = [];
  const gh = (args) => {
    log.push(args.slice(0, 2).join(' '));
    // A failed listing that printed a waiting run: it holds nothing.
    if (args[1] === 'list') return { code: 1, stdout: JSON.stringify([{ databaseId: 401, status: 'queued' }]), stderr: 'HTTP 502: Bad Gateway' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps = { gh, sleep: async () => undefined, env: ENV, readFile: () => '{"clock":"actions-chain"}', out: (l) => out.push(l), err: () => undefined };
  assert.equal(await main(['start'], deps), EXIT.ok);
  assert.deepEqual(out, ['chain warn: the runs did not list (gh exited 1: HTTP 502: Bad Gateway); the successor is dispatched anyway', 'chain started: the successor is dispatched (try 1)']);
  assert.deepEqual(log, ['run list', 'workflow run']);
  const slept = [];
  const lines = [];
  const at = Date.parse('2026-10-30T08:29:59Z') + 500;
  assert.equal(await main(['sleep'], { ...deps, now: () => at, sleep: async (ms) => slept.push(ms), out: (l) => lines.push(l) }), EXIT.ok);
  assert.deepEqual([lines, slept], [['sleep 1 s to 2026-10-30T08:30:00Z'], [1000]]);
});

// ---- due -------------------------------------------------------------------

const REPO = 'pkgforge-dev/domains.pkgforge.dev';
const at = (s) => Date.parse(s);
// The literal limit, not DUE_LIST_LIMIT, so a changed constant fails here.
const listCall = (file) => `gh run list --repo ${REPO} --workflow ${file} --branch main --limit 20 --json databaseId,createdAt,status,event`;
const runCall = (file) => `gh workflow run ${file} --ref main --repo ${REPO}`;
const run = (databaseId, createdAt, event = 'schedule', status = 'completed') => ({ databaseId, createdAt, event, status });

// `chain.mjs due` at `now` with a fake gh: `lists` answers the listing of
// each workflow file (a list of runs, a string, `fail`, `throw`, or a whole
// answer { code, stdout, stderr }; none is []), and `dispatch` the dispatch of
// each file (an exit code or a whole answer; none is 0). A --limit below 1 is
// refused as gh refuses it. Every call, and every sleep, goes into `log` in order.
async function dueAt(now, { lists = {}, dispatch = {}, env = ENV, clock = { clock: 'actions-chain' }, argv = [] } = {}) {
  const log = [];
  const out = [];
  const err = [];
  const gh = (args) => {
    log.push(`gh ${args.join(' ')}`);
    if (args[0] === 'run' && args[1] === 'list') {
      const limit = Number(args[args.indexOf('--limit') + 1]);
      if (!(limit >= 1)) return { code: 1, stdout: '', stderr: `invalid limit: ${args[args.indexOf('--limit') + 1]}` };
      const l = lists[args[args.indexOf('--workflow') + 1]] ?? [];
      if (l === 'fail') return { code: 1, stdout: JSON.stringify([run(9, '2099-01-01T00:00:00Z')]), stderr: 'HTTP 502: Bad Gateway' };
      if (l === 'throw') throw new Error('a planted defect of gh');
      if (l !== null && typeof l === 'object' && !Array.isArray(l)) return l;
      return { code: 0, stdout: typeof l === 'string' ? l : JSON.stringify(l), stderr: '' };
    }
    if (args[0] === 'workflow' && args[1] === 'run') {
      const d = dispatch[args[2]] ?? 0;
      if (typeof d === 'object') return d;
      return { code: d, stdout: '', stderr: d === 0 ? '' : 'HTTP 500: Internal Server Error' };
    }
    return { code: 2, stdout: '', stderr: `fake gh does not know ${args.join(' ')}` };
  };
  const readFile = clock === null ? ENOENT : () => JSON.stringify(clock);
  const code = await main(['due', ...argv], { gh, sleep: async (ms) => log.push(`sleep ${ms}`), env, readFile, now: () => at(now), out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, log, text: `${out.join('\n')}\n${err.join('\n')}` };
}

const NOT_BEFORE = (file, instant) => `due ${file}: not before ${DUE_SINCE} (its last instant is ${instant})`;

test('chain: lastInstant gives the latest instant at or before now of each cron of DUE, across days, months, years and a leap day', () => {
  const cases = {
    '35 1 * * *': [
      ['2026-11-01T01:35:00Z', '2026-11-01T01:35:00Z'],
      ['2026-11-01T01:34:59Z', '2026-10-31T01:35:00Z'],
      ['2027-01-01T01:34:59Z', '2026-12-31T01:35:00Z'],
      ['2026-03-01T00:00:00Z', '2026-02-28T01:35:00Z'],
      ['2028-03-01T00:00:00Z', '2028-02-29T01:35:00Z'],
    ],
    // 2026-11-02 and 2026-12-28 are Mondays.
    '50 3 * * 1': [
      ['2026-11-02T03:50:00Z', '2026-11-02T03:50:00Z'],
      ['2026-11-02T03:49:59Z', '2026-10-26T03:50:00Z'],
      ['2026-11-01T12:00:00Z', '2026-10-26T03:50:00Z'],
      ['2027-01-03T23:59:59Z', '2026-12-28T03:50:00Z'],
    ],
    '50 4 1 * *': [
      ['2026-11-01T04:50:00Z', '2026-11-01T04:50:00Z'],
      ['2026-11-01T04:49:59Z', '2026-10-01T04:50:00Z'],
      ['2027-01-01T04:49:59Z', '2026-12-01T04:50:00Z'],
      ['2028-02-29T23:59:59Z', '2028-02-01T04:50:00Z'],
      ['2028-03-01T04:49:59Z', '2028-02-01T04:50:00Z'],
    ],
    '50 5 1 1 *': [
      ['2026-01-01T05:50:00Z', '2026-01-01T05:50:00Z'],
      ['2027-01-01T05:49:59Z', '2026-01-01T05:50:00Z'],
      ['2028-12-31T23:59:59Z', '2028-01-01T05:50:00Z'],
      // 366 days back, the most: from 1 January of the year after a leap year.
      ['2029-01-01T05:49:59Z', '2028-01-01T05:50:00Z'],
    ],
    '13 5 * * *': [
      ['2026-11-01T05:13:00Z', '2026-11-01T05:13:00Z'],
      ['2026-11-01T05:12:59Z', '2026-10-31T05:13:00Z'],
      ['2028-02-29T05:13:00Z', '2028-02-29T05:13:00Z'],
      ['2028-03-01T05:12:59Z', '2028-02-29T05:13:00Z'],
    ],
  };
  assert.deepEqual(
    Object.keys(cases),
    DUE.map((r) => r.cron),
    'a case list for each row, in the order of DUE',
  );
  for (const [cron, list] of Object.entries(cases)) for (const [now, want] of list) assert.equal(new Date(lastInstant(cron, at(now))).toISOString().replace('.000', ''), want, `${cron} at ${now}`);
  // A now part of a second after the instant still gives the instant.
  assert.equal(lastInstant('35 1 * * *', at('2026-11-01T01:35:00Z') + 500), at('2026-11-01T01:35:00Z'));
});

test('chain: lastInstant refuses a cron of a form outside the table, and one that names no instant in 367 days', () => {
  for (const [cron, re] of [
    ['*/5 * * * *', /the minute "\*\/5" is not a number of 0 to 59/],
    ['5,35 * * * *', /the minute "5,35" is not a number of 0 to 59/],
    ['35 * * * *', /the hour "\*" is not a number of 0 to 23/],
    ['60 1 * * *', /the minute "60" is not a number of 0 to 59/],
    ['35 24 * * *', /the hour "24" is not a number of 0 to 23/],
    ['35 1 0 * *', /the day of the month "0" is not \* or a number of 1 to 31/],
    ['35 1 32 * *', /the day of the month "32"/],
    ['35 1 * 13 *', /the month "13" is not \* or a number of 1 to 12/],
    ['35 1 * 0 *', /the month "0"/],
    ['35 1 * * 7', /the day of the week "7" is not \* or a number of 0 to 6/],
    ['35 1 * * MON', /the day of the week "MON"/],
    ['35 1 1-7 * *', /the day of the month "1-7"/],
    // A number of three digits, though 035 reads as 35.
    ['035 1 * * *', /the minute "035" is not a number of 0 to 59/],
    ['35 1 * * 001', /the day of the week "001"/],
    ['35 1 * *', /is not 5 fields split by single spaces/],
    ['35 1 * * * 2026', /is not 5 fields/],
    ['35  1 * * *', /is not 5 fields/],
    [' 35 1 * * *', /is not 5 fields/],
    ['35 1 1 * 1', /fixes both the day of the month and the day of the week/],
    ['0 0 30 2 *', /names no instant in the 367 days up to 2026-11-01T00:00:00Z/],
    ['0 0 31 4 *', /names no instant in the 367 days/],
  ]) {
    assert.throws(() => lastInstant(cron, at('2026-11-01T00:00:00Z')), { name: 'UsageError', message: re }, cron);
  }
  // The leap day is found within 367 days of it, and not four years on.
  assert.equal(lastInstant('0 0 29 2 *', at('2029-02-28T23:59:59Z')), at('2028-02-29T00:00:00Z'));
  assert.throws(() => lastInstant('0 0 29 2 *', at('2030-01-01T00:00:00Z')), { name: 'UsageError', message: /names no instant/ });
});

// The workflows whose crons DUE does not hold, each with its reason. A new
// scheduled workflow is a row of DUE or a line here.
const NOT_DUE = {
  'ingest-live.yml': 'the chain itself: its cron is the backstop that restarts the chain',
};
// A measurement's workflow keeps its own clock: it measures that clock, or runs beside one.
const NOT_DUE_PREFIX = /^measure-/;

test('chain: each row of DUE is the one cron of its workflow file, and every other scheduled workflow is a stated exclusion', () => {
  const dir = join(ROOT, '.github', 'workflows');
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const crons = {};
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const wf = parse(text);
    const parsed = (wf.on?.schedule ?? []).map((s) => s.cron);
    // The lines the yaml parser reads, as a line scan sees them, so neither misses a cron.
    const lines = [...text.matchAll(/^\s*-\s*cron:\s*(["'])(.*?)\1\s*$/gm)].map((m) => m[2]);
    assert.deepEqual(lines, parsed, `${f}: every cron line is a cron of on.schedule`);
    if (parsed.length > 0) crons[f] = parsed;
  }
  assert.equal(new Set(DUE.map((r) => r.file)).size, DUE.length, 'a workflow is one row');
  for (const row of DUE) {
    assert.deepEqual(crons[row.file], [row.cron], `${row.file} has exactly the cron of its row`);
    const wf = parse(readFileSync(join(dir, row.file), 'utf8'));
    // A dispatch with no input runs: each input of the workflow has a default and is not required.
    assert.ok(wf.on.workflow_dispatch !== undefined, `${row.file} takes workflow_dispatch`);
    // Each job that needs no job runs on main alone, so a run on another branch builds nothing, and due lists main's runs alone.
    const firsts = Object.entries(wf.jobs).filter(([, j]) => j.needs === undefined);
    assert.ok(firsts.length > 0, row.file);
    for (const [id, j] of firsts) assert.equal(j.if, "github.ref == 'refs/heads/main'", `${row.file}: the job ${id}`);
    for (const [name, input] of Object.entries(wf.on.workflow_dispatch?.inputs ?? {})) {
      assert.notEqual(input.required, true, `${row.file}: the input ${name} is not required`);
      assert.ok(Object.hasOwn(input, 'default'), `${row.file}: the input ${name} has a default`);
    }
  }
  const others = Object.keys(crons).filter((f) => !DUE.some((r) => r.file === f));
  for (const f of others) assert.ok(Object.hasOwn(NOT_DUE, f) || NOT_DUE_PREFIX.test(f), `${f} has a cron and is neither a row of DUE nor a stated exclusion`);
  for (const f of Object.keys(NOT_DUE)) assert.ok(Object.hasOwn(crons, f), `the exclusion ${f} names a scheduled workflow`);
  assert.deepEqual(others.sort(), ['ingest-live.yml', 'measure-clock-chain-keep.yml', 'measure-clock-schedule.yml']);
});

test('chain: due dispatches a row whose instant and grace have passed with no run since the instant, and only that row', async () => {
  const r = await dueAt('2026-11-01T02:00:00Z');
  assert.equal(r.code, EXIT.ok, r.text);
  assert.deepEqual(r.out, [
    'due compact-daily.yml: dispatched for 2026-11-01T01:35:00Z',
    NOT_BEFORE('compact-weekly.yml', '2026-10-26T03:50:00Z'),
    NOT_BEFORE('compact-monthly.yml', '2026-10-01T04:50:00Z'),
    NOT_BEFORE('compact-yearly.yml', '2026-01-01T05:50:00Z'),
    NOT_BEFORE('ref-refresh.yml', '2026-10-31T05:13:00Z'),
  ]);
  assert.deepEqual(r.log, [listCall('compact-daily.yml'), runCall('compact-daily.yml')]);
  // A run older than the instant, by a day or by a second, meets nothing.
  for (const createdAt of ['2026-10-31T07:27:09Z', '2026-11-01T01:34:59Z']) {
    const old = await dueAt('2026-11-01T02:00:00Z', { lists: { 'compact-daily.yml': [run(41180651910, createdAt)] } });
    assert.equal(old.out[0], 'due compact-daily.yml: dispatched for 2026-11-01T01:35:00Z', createdAt);
    assert.deepEqual(old.log, [listCall('compact-daily.yml'), runCall('compact-daily.yml')]);
  }
  // Every row due at once: 2027-01-01 at 06:30 follows each instant of the table.
  const all = await dueAt('2027-01-01T06:30:00Z');
  assert.equal(all.code, EXIT.ok, all.text);
  assert.deepEqual(all.out, [
    'due compact-daily.yml: dispatched for 2027-01-01T01:35:00Z',
    'due compact-weekly.yml: dispatched for 2026-12-28T03:50:00Z',
    'due compact-monthly.yml: dispatched for 2027-01-01T04:50:00Z',
    'due compact-yearly.yml: dispatched for 2027-01-01T05:50:00Z',
    'due ref-refresh.yml: dispatched for 2027-01-01T05:13:00Z',
  ]);
  assert.deepEqual(
    all.log,
    DUE.flatMap((row) => [listCall(row.file), runCall(row.file)]),
  );
});

test('chain: due finds a row met by any run created at or after its instant, whatever its event and status, and dispatches nothing', async () => {
  for (const runs of [
    [run(41300000001, '2026-11-01T01:35:00Z')],
    [run(41300000002, '2026-11-01T01:55:10Z', 'workflow_dispatch', 'in_progress'), run(41180651910, '2026-10-31T07:27:09Z')],
    [run(41300000003, '2026-11-01T01:56:00Z', 'workflow_dispatch', 'queued')],
    [run(41300000004, '2026-11-01T01:57:00.250Z', 'schedule', 'completed')],
  ]) {
    const r = await dueAt('2026-11-01T02:00:00Z', { lists: { 'compact-daily.yml': runs } });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[0], `due compact-daily.yml: met by run ${runs[0].databaseId} (${runs[0].event}, ${runs[0].createdAt})`);
    assert.deepEqual(r.log, [listCall('compact-daily.yml')], 'no dispatch');
  }
  // Two runs since the instant: the first of them met it.
  const two = await dueAt('2026-11-01T08:00:00Z', { lists: { 'compact-daily.yml': [run(41300000006, '2026-11-01T07:27:09Z'), run(41300000005, '2026-11-01T01:55:12Z', 'workflow_dispatch')] } });
  assert.equal(two.out[0], 'due compact-daily.yml: met by run 41300000005 (workflow_dispatch, 2026-11-01T01:55:12Z)');
});

test('chain: due waits within the grace after an instant, and never dispatches for an instant before DUE_SINCE', async () => {
  const early = await dueAt('2026-11-01T01:54:59Z');
  assert.equal(early.code, EXIT.ok, early.text);
  assert.equal(early.out[0], `due compact-daily.yml: next 2026-11-01T01:55:00Z (the instant 2026-11-01T01:35:00Z and ${DUE_GRACE_S} s of grace)`);
  assert.deepEqual(early.log, [], 'a row within its grace lists nothing');
  // At the instant plus the grace, the row is due.
  const onTime = await dueAt('2026-11-01T01:55:00Z');
  assert.equal(onTime.out[0], 'due compact-daily.yml: dispatched for 2026-11-01T01:35:00Z');
  // Before DUE_SINCE's first instant every row is before it, and gh never runs.
  const before = await dueAt('2026-11-01T00:30:00Z');
  assert.equal(before.code, EXIT.ok, before.text);
  assert.deepEqual(before.out, [
    NOT_BEFORE('compact-daily.yml', '2026-10-31T01:35:00Z'),
    NOT_BEFORE('compact-weekly.yml', '2026-10-26T03:50:00Z'),
    NOT_BEFORE('compact-monthly.yml', '2026-10-01T04:50:00Z'),
    NOT_BEFORE('compact-yearly.yml', '2026-01-01T05:50:00Z'),
    NOT_BEFORE('ref-refresh.yml', '2026-10-31T05:13:00Z'),
  ]);
  assert.deepEqual(before.log, []);
});

test('chain: due warns and dispatches nothing for a listing that fails or does not parse, and exits 0', async () => {
  const failed = await dueAt('2026-11-01T02:00:00Z', { lists: { 'compact-daily.yml': 'fail' } });
  assert.equal(failed.code, EXIT.ok, failed.text);
  assert.equal(failed.out[0], 'due compact-daily.yml: warn the runs did not list (gh exited 1: HTTP 502: Bad Gateway); nothing is dispatched, and the next run of the chain lists them again');
  assert.deepEqual(failed.log, [listCall('compact-daily.yml')], 'a failed listing that printed a run meets nothing and dispatches nothing');
  for (const listing of [
    'not json',
    JSON.stringify({ runs: [] }),
    JSON.stringify([{ databaseId: 1 }]),
    JSON.stringify([null]),
    JSON.stringify([{ ...run(1, '2026-11-01T02:00:00Z'), databaseId: '1' }]),
    JSON.stringify([run(1, '2026-11-01')]),
    JSON.stringify([run(1, '2026-11-01T02:00:00+00:00')]),
    JSON.stringify([run(1, '2026-13-01T02:00:00Z')]),
    JSON.stringify([{ ...run(1, '2026-11-01T02:00:00Z'), status: null }]),
    JSON.stringify([{ ...run(1, '2026-11-01T02:00:00Z'), event: 7 }]),
    // One run that does not validate spoils the listing, a valid one beside it too.
    JSON.stringify([run(2, '2026-11-01T01:40:00Z'), { databaseId: 1 }]),
  ]) {
    const r = await dueAt('2026-11-01T02:00:00Z', { lists: { 'compact-daily.yml': listing } });
    assert.equal(r.code, EXIT.ok, listing);
    assert.equal(r.out[0], 'due compact-daily.yml: warn the runs did not list (the listing is not a list of runs); nothing is dispatched, and the next run of the chain lists them again', listing);
    assert.deepEqual(r.log, [listCall('compact-daily.yml')], listing);
  }
  // One row's failed listing leaves the other rows as they are.
  const mixed = await dueAt('2027-01-01T06:30:00Z', { lists: { 'compact-weekly.yml': 'fail' } });
  assert.equal(mixed.code, EXIT.ok, mixed.text);
  assert.match(mixed.out[1], /^due compact-weekly\.yml: warn the runs did not list/);
  assert.deepEqual(
    mixed.log.filter((l) => l.startsWith('gh workflow run')),
    ['compact-daily.yml', 'compact-monthly.yml', 'compact-yearly.yml', 'ref-refresh.yml'].map(runCall),
  );
});

test('chain: due tries a failed dispatch once, warns, goes on to the next row and exits 0', async () => {
  const r = await dueAt('2027-01-01T06:30:00Z', { dispatch: { 'compact-daily.yml': 1 } });
  assert.equal(r.code, EXIT.ok, r.text);
  assert.equal(r.out[0], 'due compact-daily.yml: warn gh workflow run exited 1 (HTTP 500: Internal Server Error); the next run of the chain tries again');
  assert.equal(r.out[1], 'due compact-weekly.yml: dispatched for 2026-12-28T03:50:00Z');
  assert.deepEqual(r.err, ['chain: gh workflow run compact-daily.yml exited 1: HTTP 500: Internal Server Error']);
  assert.equal(r.log.filter((l) => l === runCall('compact-daily.yml')).length, 1, 'one try');
  assert.equal(
    r.log.some((l) => l.startsWith('sleep')),
    false,
    'no pause',
  );
});

test('chain: due is off for no clock file, another clock, another ref and a re-run, and calls no gh', async () => {
  for (const [opts, line] of [
    [{ clock: null }, 'chain off: config/clock.json does not exist; only the cron and dispatches start runs'],
    [{ clock: { clock: 'worker' } }, 'chain off: the clock is worker'],
    [{ env: { ...ENV, GITHUB_REF: 'refs/heads/feature' } }, 'chain off: a run on refs/heads/feature dispatches no scheduled workflow'],
    [{ env: { ...ENV, GITHUB_REF: '' } }, 'chain off: a run on no ref dispatches no scheduled workflow'],
    [{ env: { ...ENV, GITHUB_RUN_ATTEMPT: '2' } }, 'chain off: attempt 2 is a re-run; the next run of the chain dispatches what is due'],
  ]) {
    const r = await dueAt('2027-01-01T06:30:00Z', opts);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, [line]);
    assert.deepEqual(r.log, []);
  }
});

test('chain: due refuses a flag of start, a now off its grammar, a word after the verb and no repository, exit 2, and calls no gh', async () => {
  for (const [argv, env, re] of [
    [['--workflow', 'ingest-live.yml'], ENV, /^chain: due takes no flag --workflow$/m],
    [['--workflow', 'compact-daily.yml'], ENV, /due takes no flag --workflow/],
    [['--now', '2026-11-01T02:00Z'], ENV, /--now "2026-11-01T02:00Z" is not YYYY-MM-DDTHH:MM:SSZ/],
    [['--now', '2026-11-01T02:00:00Z', '--now', '2026-11-01T03:00:00Z'], ENV, /--now is given twice/],
    [['extra'], ENV, /^chain: "extra" is not a flag$/m],
    [['--clock'], ENV, /^chain: --clock needs a value$/m],
    [[], { ...ENV, GITHUB_REPOSITORY: '' }, /GITHUB_REPOSITORY is not set/],
  ]) {
    const r = await dueAt('2027-01-01T06:30:00Z', { argv, env });
    assert.equal(r.code, EXIT.usage, argv.join(' '));
    assert.match(r.text, re, argv.join(' '));
    assert.match(r.text, /\| due \[--clock FILE\] \[--now ISO\] \|/, 'the usage names due');
    assert.deepEqual(r.log, [], 'gh never ran');
  }
  const clock = await dueAt('2027-01-01T06:30:00Z', { clock: { clock: 'actions-chain', interval_min: 0 } });
  assert.equal(clock.code, EXIT.usage);
  assert.deepEqual(clock.log, []);
  // --now names the instant due judges by, in place of the clock of the process.
  const nowFlag = await dueAt('2027-01-01T06:30:00Z', { argv: ['--now', '2026-11-01T01:54:59Z'] });
  assert.equal(nowFlag.out[0], `due compact-daily.yml: next 2026-11-01T01:55:00Z (the instant 2026-11-01T01:35:00Z and ${DUE_GRACE_S} s of grace)`);
  // The production defaults: the clock file off, read by the process itself.
  const dir = mkdtempSync(join(tmpdir(), 'ingest-chain-due-'));
  try {
    const off = spawnSync(process.execPath, [SCRIPT, 'due', '--clock', join(dir, 'absent.json')], { encoding: 'utf8', env: { ...process.env, ...ENV } });
    assert.equal(off.status, EXIT.ok, off.stderr);
    assert.equal(off.stdout, 'chain off: config/clock.json does not exist; only the cron and dispatches start runs\n');
    writeFileSync(join(dir, 'clock.json'), '{"clock":"actions-chain"}');
    const branch = spawnSync(process.execPath, [SCRIPT, 'due', '--clock', join(dir, 'clock.json')], { encoding: 'utf8', env: { ...process.env, ...ENV, GITHUB_REF: 'refs/heads/feature' } });
    assert.equal(branch.status, EXIT.ok, branch.stderr);
    assert.equal(branch.stdout, 'chain off: a run on refs/heads/feature dispatches no scheduled workflow\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chain: DUE and each of its rows are frozen, and its constants are the values the docs and the record state', () => {
  assert.ok(Object.isFrozen(DUE));
  for (const row of DUE) assert.ok(Object.isFrozen(row), row.file);
  assert.throws(() => DUE.push({ file: 'root-promote.yml', cron: '0 0 * * *' }), TypeError);
  assert.throws(() => {
    DUE[0].file = 'root-promote.yml';
  }, TypeError);
  assert.equal(DUE_SINCE, '2026-11-01T00:00:00Z');
  assert.equal(DUE_GRACE_S, 1200);
  assert.equal(DUE_LIST_LIMIT, 20);
});

// A file's text with each run of white space one space, and the `#` that
// starts a comment line of a workflow dropped.
const flatText = (rel) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/^\s*# ?/gm, '')
    .replace(/\s+/g, ' ');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('chain: docs/architecture.md and the comment of ingest-live.yml give the rows of DUE, its grace and DUE_SINCE as chain.mjs holds them', () => {
  const arch = flatText('docs/architecture.md');
  const grace = `${DUE_GRACE_S / 60} minutes`;
  const files = DUE.map((r) => `\`${r.file}\``);
  const listed = `${files.slice(0, -1).join(', ')} and ${files.at(-1)}`;
  // Section 5.2: the rows in the order of DUE, the grace and DUE_SINCE.
  assert.ok(arch.includes(`holds the table \`DUE\` of \`scripts/ingest/chain.mjs\`: ${listed}, each with the one cron of its file`), 'section 5.2 lists the rows of DUE');
  assert.ok(arch.includes(`A row is due ${grace} after its cron's last instant (\`DUE_GRACE_S\`)`), 'section 5.2 gives the grace');
  assert.ok(arch.includes(`An instant before \`DUE_SINCE\`, ${DUE_SINCE}, is never due`), 'section 5.2 gives DUE_SINCE');
  // Section 5.3: each row's cron in the table of schedules, and the grace.
  for (const row of DUE) assert.match(arch, new RegExp(`\\| \`${esc(row.file)}\` \\| \`${esc(row.cron)}\`, the chain when due \\(§5\\.2\\)`), row.file);
  assert.ok(arch.includes(`at its first run ${grace} or more after the cron's instant`), 'section 5.3 gives the grace');
  // Every other "N minutes" of the two paragraphs is the grace.
  const between = (from, to) => {
    const at = arch.indexOf(from);
    assert.ok(at >= 0, from);
    const end = arch.indexOf(to, at);
    assert.ok(end > at, to);
    return arch.slice(at, end);
  };
  const para = between('The chain is also the clock of the scheduled workflows.', 'GitHub Actions is the default.');
  const clock = between('**The clock of the compactions.**', 'A scheduled run plans the last units');
  for (const p of [para, clock]) {
    const minutes = [...p.matchAll(/(\d+) minutes/g)].map((m) => m[0]);
    assert.ok(minutes.length > 0, p);
    for (const m of minutes) assert.equal(m, grace, p);
  }
  const wf = flatText('.github/workflows/ingest-live.yml');
  assert.ok(wf.includes(`whose cron instant passed ${grace} ago or more with no run of it after that instant`), 'the header comment of ingest-live.yml gives the grace');
});

test('chain: lastInstant and due give the same instants whatever the time zone of the process', () => {
  // Nows whose local date differs from the UTC date west of UTC, and two crons
  // outside the table whose instant is another local date east of UTC, where a
  // local getter in place of a UTC one finds another day.
  const cases = [
    ['35 1 * * *', '2026-11-01T02:00:00Z', '2026-11-01T01:35:00Z'],
    ['50 3 * * 1', '2026-11-02T04:00:00Z', '2026-11-02T03:50:00Z'],
    ['50 4 1 * *', '2026-11-01T05:00:00Z', '2026-11-01T04:50:00Z'],
    ['50 5 1 1 *', '2027-01-01T06:30:00Z', '2027-01-01T05:50:00Z'],
    ['13 5 * * *', '2028-02-29T05:40:00Z', '2028-02-29T05:13:00Z'],
    ['30 23 31 12 *', '2027-01-01T00:00:00Z', '2026-12-31T23:30:00Z'],
    // 2026-11-01 is a Sunday.
    ['30 23 * * 0', '2026-11-02T00:00:00Z', '2026-11-01T23:30:00Z'],
  ];
  const child = `
import { lastInstant, main } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
const cases = JSON.parse(process.argv[1]);
const instants = cases.map(([cron, now]) => new Date(lastInstant(cron, Date.parse(now))).toISOString().replace('.000', ''));
const out = [];
const gh = (a) => ({ code: 0, stdout: a[1] === 'list' ? '[]' : '', stderr: '' });
const env = { GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'pkgforge-dev/domains.pkgforge.dev' };
const code = await main(['due', '--now', '2027-01-01T06:30:00Z'], { gh, env, readFile: () => '{"clock":"actions-chain"}', out: (l) => out.push(l), err: (l) => out.push(l) });
process.stdout.write(JSON.stringify({ offset: new Date(Date.parse('2027-01-01T00:00:00Z')).getTimezoneOffset(), instants, code, out }));
`;
  const offsets = {};
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child, JSON.stringify(cases)], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    assert.equal(r.status, 0, `${tz}: ${r.stderr}`);
    const got = JSON.parse(r.stdout);
    offsets[tz] = got.offset;
    assert.deepEqual(
      got.instants,
      cases.map((c) => c[2]),
      tz,
    );
    assert.equal(got.code, EXIT.ok, tz);
    assert.deepEqual(
      got.out,
      [
        'due compact-daily.yml: dispatched for 2027-01-01T01:35:00Z',
        'due compact-weekly.yml: dispatched for 2026-12-28T03:50:00Z',
        'due compact-monthly.yml: dispatched for 2027-01-01T04:50:00Z',
        'due compact-yearly.yml: dispatched for 2027-01-01T05:50:00Z',
        'due ref-refresh.yml: dispatched for 2027-01-01T05:13:00Z',
      ],
      tz,
    );
  }
  // Each zone took effect in its child, so the test is not three runs in one zone.
  assert.deepEqual(offsets, { UTC: 0, 'America/Los_Angeles': 480, 'Pacific/Kiritimati': -840 });
});

test('chain: due exits 70 on a defect, a gh that throws, and names it an internal error', async () => {
  const r = await dueAt('2026-11-01T02:00:00Z', { lists: { 'compact-daily.yml': 'throw' } });
  assert.equal(r.code, EXIT.internal, r.text);
  assert.equal(r.out.length, 0, r.text);
  assert.match(r.err[0], /^chain: internal error: Error: a planted defect of gh/);
});

test('chain: due and sleep refuse a now that the calendar does not hold, exit 2, and call no gh', async () => {
  for (const verb of ['due', 'sleep']) {
    for (const now of ['2026-13-45T25:61:61Z', '2026-02-30T00:00:00Z', '2026-10-30T24:00:00Z', '2026-04-31T00:00:00Z']) {
      const r = await chain([verb, '--now', now]);
      assert.equal(r.code, EXIT.usage, `${verb} ${now}`);
      assert.match(r.text, new RegExp(`--now "${esc(now)}" is not YYYY-MM-DDTHH:MM:SSZ`), `${verb} ${now}`);
      assert.deepEqual(r.log, [], `${verb} ${now}`);
    }
  }
  // A year below 100 is that year, not 1900 and more: every row's instant is before DUE_SINCE.
  const old = await dueAt('2026-11-01T02:00:00Z', { argv: ['--now', '0099-12-31T00:00:00Z'] });
  assert.equal(old.code, EXIT.ok, old.text);
  assert.equal(old.out[0], NOT_BEFORE('compact-daily.yml', '0099-12-30T01:35:00Z'));
  assert.deepEqual(old.log, []);
  assert.equal(lastInstant('50 5 1 1 *', at('0001-06-01T00:00:00Z')), at('0001-01-01T05:50:00Z'));
});

test('chain: a guard that turns the chain off comes before the repository, and a run with no attempt number is attempt 1', async () => {
  const { GITHUB_REPOSITORY: _repo, ...noRepo } = ENV;
  for (const [opts, line] of [
    [{ clock: { clock: 'worker' }, env: noRepo }, 'chain off: the clock is worker'],
    [{ env: { ...noRepo, GITHUB_REF: 'refs/heads/feature' } }, 'chain off: a run on refs/heads/feature dispatches no scheduled workflow'],
    [{ env: { ...noRepo, GITHUB_RUN_ATTEMPT: '2' } }, 'chain off: attempt 2 is a re-run; the next run of the chain dispatches what is due'],
  ]) {
    const r = await dueAt('2027-01-01T06:30:00Z', opts);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, [line]);
    assert.deepEqual(r.log, []);
  }
  const { GITHUB_RUN_ATTEMPT: _attempt, ...noAttempt } = ENV;
  const first = await dueAt('2026-11-01T02:00:00Z', { env: noAttempt });
  assert.equal(first.out[0], 'due compact-daily.yml: dispatched for 2026-11-01T01:35:00Z');
  const started = await chain(['start'], { env: noAttempt });
  assert.deepEqual(started.out, ['chain started: the successor is dispatched (try 1)']);
});

test('chain: due refuses a createdAt with no zone, meets a run a part of a second after the instant, and names the last line of a long stderr', async () => {
  const zoneless = await dueAt('2026-11-01T02:00:00Z', { lists: { 'compact-daily.yml': [run(1, '2026-11-01T01:40:00')] } });
  assert.equal(zoneless.out[0], 'due compact-daily.yml: warn the runs did not list (the listing is not a list of runs); nothing is dispatched, and the next run of the chain lists them again');
  assert.deepEqual(zoneless.log, [listCall('compact-daily.yml')]);
  // In the instant's own second: a time, not a string, compare.
  const frac = await dueAt('2026-11-01T02:00:00Z', { lists: { 'compact-daily.yml': [run(41300000007, '2026-11-01T01:35:00.250Z')] } });
  assert.equal(frac.out[0], 'due compact-daily.yml: met by run 41300000007 (schedule, 2026-11-01T01:35:00.250Z)');
  const listed = await dueAt('2026-11-01T02:00:00Z', { lists: { 'compact-daily.yml': { code: 1, stdout: '', stderr: 'warning: a retry\nHTTP 502: Bad Gateway\n' } } });
  assert.match(listed.out[0], /^due compact-daily\.yml: warn the runs did not list \(gh exited 1: HTTP 502: Bad Gateway\);/);
  const sent = await dueAt('2026-11-01T02:00:00Z', {
    dispatch: { 'compact-daily.yml': { code: 1, stdout: '', stderr: 'could not create workflow dispatch event\nHTTP 422: Unprocessable Entity\n' } },
  });
  assert.equal(sent.out[0], 'due compact-daily.yml: warn gh workflow run exited 1 (HTTP 422: Unprocessable Entity); the next run of the chain tries again');
  assert.deepEqual(sent.err, ['chain: gh workflow run compact-daily.yml exited 1: could not create workflow dispatch event\nHTTP 422: Unprocessable Entity']);
});
