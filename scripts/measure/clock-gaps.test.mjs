// scripts/measure/clock-gaps.mjs: the gaps, the slots and the verdict on run
// lists whose gaps are known by construction, the closing gap that fails a
// clock that stopped, the exit codes of the command line, the paging and its
// guards against a fake gh, and a run list recorded from mirror-archlinux.
//
// Every test runs offline. The one test of the production `gh` runs only
// `gh --version`, and skips where gh is not installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRunsFile, fetchRuns, makeGh, measure, parseFlags, quantile, RULE, runsPathFor, tickOf, UsageError } from './clock-gaps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'clock-gaps.mjs');
const RECORDED = join(HERE, 'fixtures', 'clock-gaps', 'mirror-upstream-watch.runs.json');

const dirs = [];
after(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'domains-clock-gaps-'));
  dirs.push(d);
  return d;
};

const T0 = Date.parse('2026-11-01T00:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

// One run created at `createdMs`, whose one job a runner takes `lagS` seconds
// later and holds for `durS` seconds; with `runner: false` no runner takes it.
function run(id, createdMs, { lagS = 3, durS = 10, runner = true, event = 'workflow_dispatch', branch = 'main' } = {}) {
  const started = runner ? createdMs + lagS * 1000 : createdMs;
  return {
    id,
    created_at: iso(createdMs),
    run_started_at: iso(createdMs),
    status: 'completed',
    conclusion: runner ? 'success' : 'cancelled',
    event,
    head_branch: branch,
    run_attempt: 1,
    jobs: [
      {
        name: 'tick',
        started_at: iso(started),
        completed_at: iso(runner ? started + durS * 1000 : started),
        runner_name: runner ? 'GitHub Actions 1' : null,
        conclusion: runner ? 'success' : 'cancelled',
      },
    ],
  };
}

const runList = ({ workflow = 'measure-clock-chain.yml', event = 'workflow_dispatch', fetchedMs, runs }) => ({
  version: 1,
  repo: 'pkgforge-dev/domains.pkgforge.dev',
  workflow,
  event,
  branch: 'main',
  fetched_at: iso(fetchedMs),
  gh: 'gh version 0.0.0 (test)',
  total_count: runs.length,
  runs,
});

const CHAIN = { workflow: 'measure-clock-chain.yml', event: 'workflow_dispatch', intervalMin: 5, hours: 48 };
const SCHEDULE_1H = { workflow: 'measure-clock-schedule.yml', event: 'schedule', intervalMin: 5, hours: 1 };

// A chain ticking every 5 minutes for 48 h and 30 min, with the runs created
// at minutes 105 to 135 missing (one 40 minute gap), and the run of minute 500
// waiting 60 s for its runner instead of 3 s.
function holedChain() {
  const runs = [];
  let id = 1;
  for (let m = 0; m <= 2910; m += 5) {
    if (m >= 105 && m <= 135) continue;
    runs.push(run(id++, T0 + m * MIN, { lagS: m === 500 ? 60 : 3 }));
  }
  return runList({ fetchedMs: T0 + 50 * 60 * MIN, runs });
}

// A cron at 5 minutes over 1 hour, sparse: created at +20 s, +5:40, +6:10,
// +27:00, +58:00 and +70:00 (after the window), each started 2 s later, and one
// at +40:00 that no runner took.
function sparseCron() {
  const s = (sec) => T0 + sec * 1000;
  const runs = [
    run(1, s(20), { lagS: 2, event: 'schedule' }),
    run(2, s(340), { lagS: 2, event: 'schedule' }),
    run(3, s(370), { lagS: 2, event: 'schedule' }),
    run(4, s(1620), { lagS: 2, event: 'schedule' }),
    run(5, s(2400), { runner: false, event: 'schedule' }),
    run(6, s(3480), { lagS: 2, event: 'schedule' }),
    run(7, s(4200), { lagS: 2, event: 'schedule' }),
  ];
  return runList({ workflow: 'measure-clock-schedule.yml', event: 'schedule', fetchedMs: T0 + 2 * 60 * MIN, runs });
}

function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

test('clock gaps: a 5 minute chain with one 40 minute hole passes, and the hole is its one break', () => {
  const { complete, result } = measure(holedChain(), CHAIN);
  assert.equal(complete, true);
  assert.equal(result.clock, 'actions-chain');
  assert.equal(result.from, '2026-11-01T00:00:03Z');
  assert.equal(result.to, '2026-11-03T00:00:03Z');
  // 576 runs created in [0, 2880) minutes, less the 7 of minutes 105 to 135.
  assert.equal(result.runs, 569);
  assert.equal(result.expected, 576);
  // 568 gaps inside the window and the closing gap to the first run after it.
  assert.equal(result.gaps, 569);
  assert.deepEqual(result.gaps_min, { median: 5, p90: 5, max: 40 });
  assert.deepEqual(result.start_lag_s, { median: 3, p90: 3, max: 60 });
  assert.equal(result.breaks_over_30min, 1);
  assert.equal(result.slots, null);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.rule, { p90_max_min: 15, max_max_min: 60 });
  assert.equal(result.cost.runner_s_total, 569 * 10);
});

test('clock gaps: a sparse cron fails, with its gaps, its breaks and its slots', () => {
  const { complete, result } = measure(sparseCron(), SCHEDULE_1H);
  assert.equal(complete, true);
  assert.equal(result.clock, 'actions-schedule');
  assert.equal(result.runs, 5);
  assert.equal(result.expected, 12);
  // Gaps in seconds: 320, 30, 1250, 1860, and the closing 720 to the run after
  // the window. Sorted in minutes: 0.5, 5.33, 12, 20.83, 31.
  assert.deepEqual(result.gaps_min, { median: 12, p90: 31, max: 31 });
  assert.equal(result.breaks_over_30min, 1);
  assert.deepEqual(result.start_lag_s, { median: 2, p90: 2, max: 2 });
  // Slots 0, 1 (twice), 5, 8 (the run no runner took) and 11 hold a run; the
  // run of +70:00 is slot 14, outside the 12.
  assert.deepEqual(result.slots, { expected: 12, hit: 5, missed: 7 });
  assert.equal(result.runs_not_started, 1);
  assert.equal(result.verdict, 'FAIL');
});

test('clock gaps: a clock that stops inside the window fails on its closing gap', () => {
  const runs = [];
  for (let m = 0; m < 24 * 60; m += 5) runs.push(run(runs.length + 1, T0 + m * MIN));
  const { complete, result } = measure(runList({ fetchedMs: T0 + 50 * 60 * MIN, runs }), CHAIN);
  assert.equal(complete, true);
  assert.equal(result.runs, 288);
  // The last tick is at minute 1435; the window ends at minute 2880.
  assert.equal(result.gaps_min.max, 1445);
  assert.equal(result.gaps_min.p90, 5);
  assert.equal(result.breaks_over_30min, 1);
  assert.equal(result.verdict, 'FAIL');
});

test('clock gaps: the verdict is PASS at the bounds of the rule, and FAIL one second past them', () => {
  // ticks: [minute, extra seconds] of each run's creation, over a window of 2 hours.
  const verdictOf = (ticks, intervalMin) => {
    const runs = ticks.map(([m, s = 0], i) => run(i + 1, T0 + m * MIN + s * 1000));
    return measure(runList({ fetchedMs: T0 + 3 * 60 * MIN, runs }), { ...CHAIN, intervalMin, hours: 2 }).result;
  };
  const every = (step, skip = () => false) => {
    const out = [];
    for (let m = 0; m <= 120; m += step) if (!skip(m)) out.push([m]);
    return out;
  };
  // Eight gaps of 15 min: the p90 is the max, 15.
  const even = every(15);
  assert.deepEqual(verdictOf(even, 15).gaps_min, { median: 15, p90: RULE.p90_max_min, max: 15 });
  assert.equal(verdictOf(even, 15).verdict, 'PASS');
  even[4] = [60, 1];
  assert.equal(verdictOf(even, 15).verdict, 'FAIL', 'a p90 gap of 15 min 1 s is over the rule');
  // Twelve gaps of 5 min and one of 60 (minutes 35 to 85 missing): the p90 is 5.
  const holed = every(5, (m) => m >= 35 && m <= 85);
  assert.deepEqual(verdictOf(holed, 5).gaps_min, { median: 5, p90: 5, max: RULE.max_max_min });
  assert.equal(verdictOf(holed, 5).verdict, 'PASS');
  holed[7] = [90, 1];
  assert.equal(verdictOf(holed, 5).verdict, 'FAIL', 'a max gap of 60 min 1 s is over the rule');
});

test('clock gaps: a run no runner took is no tick', () => {
  assert.equal(tickOf(run(1, T0, { runner: false })), null);
  const t = tickOf({ ...run(2, T0, { lagS: 4 }), jobs: [...run(2, T0, { lagS: 9 }).jobs, ...run(2, T0, { lagS: 4 }).jobs, ...run(2, T0, { runner: false }).jobs] });
  assert.equal(t.t, T0 + 4000);
  assert.equal(t.runnerS, 20);
});

test('clock gaps: a run of another event or branch, or a list of another workflow, is refused', () => {
  const doc = holedChain();
  doc.runs[3] = run(4, T0 + 15 * MIN, { branch: 'topic' });
  assert.throws(() => measure(doc, CHAIN), /run 4 is of event workflow_dispatch on topic/);
  assert.throws(() => measure(holedChain(), { ...CHAIN, workflow: 'other.yml' }), /not other\.yml/);
  assert.throws(() => checkRunsFile({ ...holedChain(), version: 2 }), /version is 2/);
  assert.throws(() => checkRunsFile({ ...holedChain(), fetched_at: 'yesterday' }), /fetched_at/);
});

test('clock gaps: a quantile is the value at index floor(n * q), as in design B and the probe of DOM-002', () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([4, 1, 3, 2], 0.5), 3, 'the upper middle value of an even count');
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 0.9), 11);
  assert.equal(quantile([5, 1, 4, 2, 3], 0.9), 5);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(quantile([], 0.9), null);
});

test('clock gaps: the flags are checked', () => {
  const ok = ['--workflow', 'measure-clock-chain.yml', '--event', 'workflow_dispatch', '--interval-min', '5', '--hours', '48'];
  assert.deepEqual(parseFlags(ok), {
    workflow: 'measure-clock-chain.yml',
    event: 'workflow_dispatch',
    repo: 'pkgforge-dev/domains.pkgforge.dev',
    intervalMin: 5,
    hours: 48,
    out: undefined,
    runs: undefined,
  });
  const swap = (k, v) => ok.map((x, i) => (ok[i - 1] === k ? v : x));
  for (const bad of [
    [],
    swap('--event', 'push'),
    swap('--hours', '0'),
    swap('--interval-min', '2.5'),
    swap('--workflow', '../x.yml'),
    [...swap('--interval-min', '7'), '--hours', '1'],
    [...ok, '--out'],
  ]) {
    assert.throws(() => parseFlags(bad), UsageError, JSON.stringify(bad));
  }
  assert.equal(runsPathFor('a/schedule.json'), 'a/schedule.runs.json');
  assert.equal(runsPathFor('a/schedule'), 'a/schedule.runs.json');
});

test('clock gaps: the command line writes the result, prints one verdict line, and exits 0', () => {
  const dir = tmp();
  const runs = writeJson(dir, 'chain.runs.json', holedChain());
  const out = join(dir, 'out', 'chain.json');
  const r = cli(['--workflow', 'measure-clock-chain.yml', '--event', 'workflow_dispatch', '--interval-min', '5', '--hours', '48', '--runs', runs, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(JSON.parse(r.stdout), written);
  assert.equal(written.verdict, 'PASS');
  const verdicts = r.stderr.split('\n').filter((l) => l.startsWith('verdict='));
  assert.deepEqual(verdicts, ['verdict=PASS clock=actions-chain runs=569/576 p90_gap_min=5 max_gap_min=40 breaks_over_30min=1']);
  assert.equal(existsSync(runsPathFor(out)), false, 'a run list read from a file is not copied');
});

test('clock gaps: a FAIL verdict is a finding, and still exits 0', () => {
  const dir = tmp();
  const runs = writeJson(dir, 'cron.runs.json', sparseCron());
  const r = cli(['--workflow', 'measure-clock-schedule.yml', '--event', 'schedule', '--interval-min', '5', '--hours', '1', '--runs', runs]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^verdict=FAIL clock=actions-schedule runs=5\/12 p90_gap_min=31 max_gap_min=31 breaks_over_30min=1$/m);
});

test('clock gaps: a window that has not ended is INCOMPLETE, exits 1 and writes nothing', () => {
  const dir = tmp();
  const doc = holedChain();
  doc.fetched_at = iso(T0 + 10 * 60 * MIN);
  doc.runs = doc.runs.filter((r) => Date.parse(r.created_at) < T0 + 10 * 60 * MIN);
  const runs = writeJson(dir, 'early.runs.json', doc);
  const out = join(dir, 'early.json');
  const r = cli(['--workflow', 'measure-clock-chain.yml', '--event', 'workflow_dispatch', '--interval-min', '5', '--hours', '48', '--runs', runs, '--out', out]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(existsSync(out), false);
  assert.equal(JSON.parse(r.stdout).complete, false);
  assert.match(r.stderr, /^verdict=INCOMPLETE clock=actions-chain .* hours_seen=10\/48$/m);
  const none = writeJson(dir, 'none.runs.json', { ...doc, runs: [] });
  const empty = cli(['--workflow', 'measure-clock-chain.yml', '--event', 'workflow_dispatch', '--interval-min', '5', '--hours', '48', '--runs', none]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /^verdict=INCOMPLETE clock=actions-chain runs=0 /m);
});

test('clock gaps: bad flags and a malformed run list exit 2', () => {
  const dir = tmp();
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['--workflow', 'x.yml', '--event', 'push', '--interval-min', '5', '--hours', '48']).status, 2);
  const runs = writeJson(dir, 'bad.runs.json', { ...holedChain(), version: 9 });
  const r = cli(['--workflow', 'measure-clock-chain.yml', '--event', 'workflow_dispatch', '--interval-min', '5', '--hours', '48', '--runs', runs]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not run: not a run list of version 1/);
});

// A stand-in for gh: `--version`, the run listing and the jobs of a run, for
// the scenario named by its first argument. Any other call exits 1, as gh does
// on an error.
const FAKE_GH = `
const [scenario, ...args] = process.argv.slice(2);
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const T0 = Date.parse('2026-11-01T00:00:00Z');
const runOf = (id) => ({ id, created_at: iso(T0 + id * 300000), run_started_at: iso(T0 + id * 300000), status: 'completed', conclusion: 'success', event: 'schedule', head_branch: 'main', run_attempt: 1, extra: 'dropped' });
if (args[0] === '--version') { console.log('gh version 9.9.9 (fake)\\nhttps://example.invalid'); process.exit(0); }
if (args[0] !== 'api') { console.error('unknown command'); process.exit(1); }
const path = args[1];
let m = path.match(/^repos\\/o\\/n\\/actions\\/workflows\\/w\\.yml\\/runs\\?event=schedule&branch=main&exclude_pull_requests=true&per_page=100&page=(\\d+)$/);
if (m) {
  if (scenario === 'down') { console.error('HTTP 502: Bad Gateway'); process.exit(1); }
  const page = Number(m[1]);
  if (scenario === 'nolist') { console.log(JSON.stringify({ total_count: 150 })); process.exit(0); }
  const total = scenario === 'capped' ? 1000 : scenario === 'lossy' ? 160 : 150;
  // Newest first, as GitHub lists them. Page 2 repeats a run of page 1, as a
  // run created while the pages are read shifts them.
  const ids = page === 1 ? Array.from({ length: 100 }, (_, i) => 150 - i) : page === 2 ? Array.from({ length: 51 }, (_, i) => 51 - i) : [];
  console.log(JSON.stringify({ total_count: total, workflow_runs: ids.map(runOf) }));
  process.exit(0);
}
m = path.match(/^repos\\/o\\/n\\/actions\\/runs\\/(\\d+)\\/attempts\\/1\\/jobs\\?per_page=100$/);
if (m) {
  const id = Number(m[1]);
  const start = T0 + id * 300000 + 2000;
  if (scenario === 'nojobs') { console.log(JSON.stringify({ total_count: 1 })); process.exit(0); }
  console.log(JSON.stringify({ total_count: scenario === 'manyjobs' ? 101 : 1, jobs: [{ name: 'tick', started_at: iso(start), completed_at: iso(start + 9000), runner_name: 'GitHub Actions ' + id, conclusion: 'success', steps: [] }] }));
  process.exit(0);
}
console.error('unexpected path ' + path);
process.exit(1);
`;

function fakeGh(scenario) {
  const dir = tmp();
  const script = join(dir, 'fake-gh.mjs');
  writeFileSync(script, FAKE_GH);
  return makeGh([process.execPath, script, scenario]);
}

test('clock gaps: the run list is read page by page, once per run, with the first attempt jobs of each', async () => {
  const doc = await fetchRuns({ gh: fakeGh('ok'), repo: 'o/n', workflow: 'w.yml', event: 'schedule', now: () => new Date(T0 + 99 * 3_600_000) });
  assert.equal(doc.version, 1);
  assert.equal(doc.gh, 'gh version 9.9.9 (fake)');
  assert.equal(doc.fetched_at, '2026-11-05T03:00:00.000Z');
  assert.equal(doc.total_count, 150);
  assert.deepEqual(
    doc.runs.map((r) => r.id),
    Array.from({ length: 150 }, (_, i) => i + 1),
  );
  assert.equal(doc.runs[0].extra, undefined, 'only the named fields are kept');
  assert.deepEqual(doc.runs[0].jobs, [{ name: 'tick', started_at: '2026-11-01T00:05:02Z', completed_at: '2026-11-01T00:05:11Z', runner_name: 'GitHub Actions 1', conclusion: 'success' }]);
  assert.doesNotThrow(() => checkRunsFile(doc));
});

test('clock gaps: a listing at the 1,000 run cap, a listing with runs missing, and a gh failure are refused', async () => {
  await assert.rejects(fetchRuns({ gh: fakeGh('capped'), repo: 'o/n', workflow: 'w.yml', event: 'schedule' }), /GitHub lists at most 1000/);
  await assert.rejects(fetchRuns({ gh: fakeGh('lossy'), repo: 'o/n', workflow: 'w.yml', event: 'schedule' }), /read 150 runs of w\.yml, GitHub counted 160/);
  await assert.rejects(fetchRuns({ gh: fakeGh('down'), repo: 'o/n', workflow: 'w.yml', event: 'schedule' }), /HTTP 502: Bad Gateway/);
});

test('clock gaps: the production gh runner answers gh --version', { skip: spawnSync('gh', ['--version']).error ? 'gh is not installed' : false }, async () => {
  assert.match(await makeGh()(['--version']), /^gh version \d+\.\d+\.\d+/);
});

test('clock gaps: the run list recorded from mirror-archlinux upstream-watch.yml reads, and its */15 cron fails', () => {
  // Recorded 2026-10-28T10:33:41Z with this script (--repo pkgforge-dev/mirror-archlinux
  // --workflow upstream-watch.yml --event schedule). The numbers below are that
  // reading, kept as a regression. A second method agrees: jq over the runs'
  // created_at, not the jobs, gives 16 gaps, median 168.8, p90 291.33, max 314.33.
  // The entry's premise measured the same cron with a median gap of 227 to 233
  // min over its whole history.
  const doc = checkRunsFile(JSON.parse(readFileSync(RECORDED, 'utf8')));
  const { complete, result } = measure(doc, { workflow: 'upstream-watch.yml', event: 'schedule', intervalMin: 15, hours: 48 });
  assert.equal(complete, true);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.runs, 16);
  assert.equal(result.expected, 192);
  assert.deepEqual(result.gaps_min, { median: 168.78, p90: 291.33, max: 314.33 });
  assert.deepEqual(result.slots, { expected: 192, hit: 16, missed: 176 });
  assert.ok(result.start_lag_s.max <= 60, 'a runner takes a scheduled job within a minute');
});

test('clock gaps: a run of another event, or a list for another event, is refused for the event alone', () => {
  const doc = holedChain();
  doc.runs[3] = run(4, T0 + 15 * MIN, { event: 'schedule' });
  assert.throws(() => measure(doc, CHAIN), /run 4 is of event schedule on main, not workflow_dispatch on main/);
  assert.throws(() => measure(holedChain(), { ...CHAIN, event: 'schedule' }), /is of measure-clock-chain\.yml for event workflow_dispatch, not measure-clock-chain\.yml for schedule/);
});

test('clock gaps: a run list is refused for each malformed part, and a job with no runner may have no times', () => {
  const cases = [
    ...['repo', 'workflow', 'event', 'branch'].map((k) => [(d) => delete d[k], new RegExp(`${k} is not a string`)]),
    [(d) => (d.runs = {}), /runs is not an array/],
    [(d) => (d.runs[0].id = '1'), /a run has no integer id/],
    [(d) => (d.runs[0].created_at = '2026-11-01 00:00'), /run 1 created_at is not an ISO 8601 UTC instant/],
    [(d) => (d.runs[0].event = null), /run 1 has no event or head_branch/],
    [(d) => delete d.runs[0].head_branch, /run 1 has no event or head_branch/],
    [(d) => (d.runs[0].jobs = null), /run 1 jobs is not an array/],
    [(d) => (d.runs[0].jobs[0].started_at = null), /a job of run 1 has a runner and no started_at/],
    [(d) => (d.runs[0].jobs[0].completed_at = 'soon'), /a job of run 1 has a malformed completed_at/],
  ];
  for (const [plant, re] of cases) {
    const doc = holedChain();
    plant(doc);
    assert.throws(
      () => checkRunsFile(doc),
      (e) => /^not a run list of version 1: /.test(e.message) && re.test(e.message),
      String(re),
    );
  }
  const open = holedChain();
  open.runs[0] = run(1, T0, { runner: false });
  open.runs[0].jobs[0].completed_at = null;
  assert.doesNotThrow(() => checkRunsFile(open));
});

test('clock gaps: a run listing or a job listing of another shape, and jobs past one page, are refused', async () => {
  await assert.rejects(fetchRuns({ gh: fakeGh('nolist'), repo: 'o/n', workflow: 'w.yml', event: 'schedule' }), /page 1 of the run list is not a workflow run listing/);
  await assert.rejects(fetchRuns({ gh: fakeGh('nojobs'), repo: 'o/n', workflow: 'w.yml', event: 'schedule' }), /the jobs of run \d+ are not a job listing/);
  await assert.rejects(fetchRuns({ gh: fakeGh('manyjobs'), repo: 'o/n', workflow: 'w.yml', event: 'schedule' }), /run \d+ has 101 jobs, more than one page holds/);
});

test('clock gaps: runs no runner took are counted inside the window only, and no slot before the first is hit', () => {
  const doc = sparseCron();
  // Created 10 minutes before the first tick, and after the window: neither is
  // a run of the window, and the first is in no slot of it.
  doc.runs.push(run(8, T0 - 10 * MIN, { runner: false, event: 'schedule' }), run(9, T0 + 4300 * 1000, { runner: false, event: 'schedule' }));
  const { result } = measure(doc, SCHEDULE_1H);
  assert.equal(result.runs_not_started, 1);
  assert.deepEqual(result.slots, { expected: 12, hit: 5, missed: 7 });
  assert.equal(result.runs, 5);
});

test('clock gaps: the window is complete when fetched at its end, a tick at the end is past it, and a 30 minute gap is no break', () => {
  // Ticks 3 s after minutes 0, 30 and 60 of a 1 hour window from the first.
  const at = (mins, fetchedMs) => measure(runList({ fetchedMs, runs: mins.map(([m, s = 0], i) => run(i + 1, T0 + m * MIN + s * 1000)) }), { ...CHAIN, hours: 1 });
  const to = T0 + 3000 + 60 * MIN;
  const exact = at([[0], [30], [60]], to);
  assert.equal(exact.complete, true, 'fetched exactly at the end');
  assert.equal(exact.result.runs, 2, 'the tick at the end is the first past the window');
  assert.equal(exact.result.gaps, 2);
  assert.deepEqual(exact.result.gaps_min, { median: 30, p90: 30, max: 30 });
  assert.equal(exact.result.breaks_over_30min, 0);
  assert.equal(at([[0], [30], [60]], to - 1000).complete, false, 'a second before the end');
  assert.equal(at([[0], [30, 1], [60]], to).result.breaks_over_30min, 1, 'a gap of 30 min 1 s is a break');
});
