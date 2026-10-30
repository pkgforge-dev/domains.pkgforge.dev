// scripts/ingest/chain.mjs: the chain of ingest-live.yml (D14 of DOM-024). The
// off cases, the dispatch held by a waiting run, the dispatch tried three
// times, a listing that fails, the boundary arithmetic, a clock file that does
// not validate, and a planted failing step: the chain job's steps, start and a
// step that fails, run in order as GitHub runs a job, where the dispatch is
// recorded before the failure. A fake gh logs each call and answers from the
// test; no test reaches GitHub. Every test name holds "chain" (the Prove of
// DOM-024: node scripts/test.mjs scripts/ingest --name chain).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DISPATCH_PAUSE_S, EXIT, ghRunner, main, nextBoundary, readClock } from './chain.mjs';

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

test('chain: with no config/clock.json, start and sleep are off, call no gh and sleep not at all', async () => {
  for (const verb of ['start', 'sleep']) {
    const r = await chain([verb], { clock: null });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, ['chain off: config/clock.json does not exist; only the cron and dispatches start runs']);
    assert.deepEqual(r.log, []);
  }
});

test('chain: another clock is off for both verbs', async () => {
  for (const clock of ['actions-schedule', 'worker', 'none']) {
    for (const verb of ['start', 'sleep']) {
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
  const r = await chain(['sleep']);
  assert.equal(r.code, EXIT.ok, r.text);
  assert.deepEqual(r.out, ['sleep 403 s to 2026-10-30T08:30:00Z']);
  assert.deepEqual(r.log, ['sleep 403000']);
  const at = await chain(['sleep', '--now', '2026-10-30T08:30:00Z'], { clock: { clock: 'actions-chain', interval_min: 12 } });
  assert.deepEqual(at.out, ['sleep 360 s to 2026-10-30T08:36:00Z']);
});

test('chain: an interval out of 1 to 12, a clock not of the four, a file not JSON and no repository are exit 2', async () => {
  for (const interval_min of [0, 13, 2.5, '10', null]) {
    const r = await chain(['sleep'], { clock: { clock: 'actions-chain', interval_min } });
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, /interval_min is .+, not a whole number of 1 to 12/);
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

test('chain: a step of the chain job that fails after the start does not stop the dispatch, and the job ends failed', async () => {
  // A job as GitHub runs one: its steps in order, the first failing step ending it.
  const f = fake();
  const out = [];
  const deps = { gh: f.gh, sleep: f.sleep, env: ENV, readFile: () => '{"clock":"actions-chain"}', out: (l) => out.push(l), err: () => undefined };
  const steps = [
    { id: 'start', run: () => main(['start'], deps) },
    {
      id: 'planted',
      run: async () => {
        f.log.push('planted step fails');
        return 1;
      },
    },
    { id: 'sleep', run: () => main(['sleep'], deps) },
  ];
  let failed = null;
  for (const s of steps) {
    const code = await s.run();
    if (code !== 0) {
      failed = s.id;
      break;
    }
  }
  assert.equal(failed, 'planted', 'the job ends failed at the planted step');
  const dispatched = f.log.indexOf('gh workflow run ingest-live.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev');
  assert.ok(dispatched >= 0, f.log.join('\n'));
  assert.ok(dispatched < f.log.indexOf('planted step fails'), f.log.join('\n'));
  assert.deepEqual(out, ['chain started: the successor is dispatched (try 1)']);
  assert.equal(
    f.log.some((l) => l.startsWith('sleep')),
    false,
    'no step after the failure ran',
  );
});

test('chain: the production defaults read the clock file, the environment and the clock, and sleep for real', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-chain-'));
  try {
    const off = spawnSync(process.execPath, [SCRIPT, 'start', '--clock', join(dir, 'absent.json')], { encoding: 'utf8', env: { ...process.env, ...ENV } });
    assert.equal(off.status, EXIT.ok, off.stderr);
    assert.equal(off.stdout, 'chain off: config/clock.json does not exist; only the cron and dispatches start runs\n');
    // A boundary one second away: the real sleep ends, and the process exits 0.
    const clock = join(dir, 'clock.json');
    writeFileSync(clock, '{"clock":"actions-chain","interval_min":1}');
    const now = new Date();
    const at = `${new Date(now.getTime() - (now.getTime() % 60_000) + 59_000).toISOString().slice(0, 19)}Z`;
    const slept = spawnSync(process.execPath, [SCRIPT, 'sleep', '--clock', clock, '--now', at], { encoding: 'utf8' });
    assert.equal(slept.status, EXIT.ok, slept.stderr);
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
