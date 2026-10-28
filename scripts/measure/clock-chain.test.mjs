// The chain and keepalive steps of DOM-001's clock B
// (.github/workflows/measure-clock-chain.yml and measure-clock-chain-keep.yml):
// each run block cut from its workflow and run under bash with a fake `gh` and
// a fake `sleep` first on PATH (scripts/lib/workflow-step.mjs). Skipped where
// no bash or no jq is found.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BASH, JQ, runStep, stepScript } from '../lib/workflow-step.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CHAIN = join(ROOT, '.github', 'workflows', 'measure-clock-chain.yml');
const KEEP = join(ROOT, '.github', 'workflows', 'measure-clock-chain-keep.yml');
const chainScript = () => stepScript(CHAIN, 'successor', /gh workflow run measure-clock-chain\.yml --ref main --repo "\$GITHUB_REPOSITORY"/);
const keepScript = () => stepScript(KEEP, 'keepalive', /gh workflow run "\$wf" --ref main --repo "\$GITHUB_REPOSITORY"/);

const SKIP = !BASH ? 'no bash on this machine' : !JQ ? 'no jq on this machine' : false;
const later = () => new Date(Date.now() + 2 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const runs = (...xs) => JSON.stringify(xs.map(([databaseId, status]) => ({ databaseId, status })));
const dispatches = (r) => r.calls.filter((c) => c.startsWith('workflow run')).length;
const chain = (t, { end = '', fake = {}, env = {} } = {}) => runStep(t, chainScript(), { fake, env: { CHAIN_END: end, ...env } });
const keep = (t, { end = '', fake = {} } = {}) => runStep(t, keepScript(), { fake, env: { CHAIN_END: end } });

test('clock chain: a run starts its successor, then sleeps to the next 5 minute boundary', { skip: SKIP }, (t) => {
  for (const end of ['', later()]) {
    const r = chain(t, { end, fake: { runs: runs([42, 'in_progress'], [41, 'completed']) } });
    assert.equal(r.status, 0, `CHAIN_END=${end}`);
    assert.equal(dispatches(r), 1);
    assert.match(
      r.calls.find((c) => c.startsWith('run list')),
      /--workflow measure-clock-chain\.yml --branch main --limit 50 --json databaseId,status --jq /,
    );
    // The sleep to the boundary comes last, unless the boundary passed while
    // the step ran.
    const last = r.calls.at(-1);
    if (last.startsWith('sleep')) assert.ok(/^sleep [1-9]\d*$/.test(last) && Number(last.split(' ')[1]) <= 300, last);
    else assert.match(last, /^workflow run /);
    assert.match(r.summary, /successor=started tries=1/);
  }
});

test('clock chain: a passed CHAIN_END starts nothing and passes; a malformed one fails', { skip: SKIP }, (t) => {
  const passed = chain(t, { end: '2026-10-01T00:00:00Z' });
  assert.equal(passed.status, 0);
  assert.deepEqual(passed.calls, []);
  assert.match(passed.stdout, /CHAIN_END 2026-10-01T00:00:00Z has passed/);
  assert.match(passed.summary, /successor=none/);
  for (const end of ['tomorrow', '2026-10-30 11:00:00', '2026-13-45T99:00:00Z']) {
    const bad = chain(t, { end });
    assert.equal(bad.status, 1, end);
    assert.deepEqual(bad.calls, [], end);
  }
});

test('clock chain: a run off main, a re-run, or a run that finds another waiting starts nothing', { skip: SKIP }, (t) => {
  const off = chain(t, { env: { GITHUB_REF: 'refs/heads/topic' } });
  assert.equal(off.status, 0);
  assert.deepEqual(off.calls, []);
  const rerun = chain(t, { env: { GITHUB_RUN_ATTEMPT: '2' } });
  assert.equal(rerun.status, 0);
  assert.deepEqual(rerun.calls, []);
  assert.match(rerun.stdout, /attempt 2 is a re-run/);
  for (const status of ['pending', 'queued', 'waiting', 'requested']) {
    const forked = chain(t, { fake: { runs: runs([42, 'in_progress'], [43, status]) } });
    assert.equal(forked.status, 0, status);
    assert.equal(dispatches(forked), 0, `a ${status} run: no second chain`);
    assert.match(forked.summary, /successor=none/);
  }
  const lag = chain(t, { fake: { runs: runs([41, 'in_progress'], [42, 'pending']) } });
  assert.equal(dispatches(lag), 1, 'a predecessor still listed in_progress, or this run listed as waiting, ends nothing');
  const unlisted = chain(t, { fake: { runs: 'fail' } });
  assert.equal(dispatches(unlisted), 1, 'an unreadable listing still dispatches');
});

test('clock chain: a dispatch is tried 3 times, 15 s apart; the third failure exits 1', { skip: SKIP }, (t) => {
  const second = chain(t, { fake: { dispatch: 'fail-1' } });
  assert.equal(second.status, 0);
  assert.equal(dispatches(second), 2);
  assert.match(second.summary, /successor=started tries=2/);
  const broken = chain(t, { fake: { dispatch: 'fail' } });
  assert.equal(broken.status, 1);
  assert.deepEqual(
    broken.calls.filter((c) => c.startsWith('workflow run') || c.startsWith('sleep')),
    [
      'workflow run measure-clock-chain.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev',
      'sleep 15',
      'workflow run measure-clock-chain.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev',
      'sleep 15',
      'workflow run measure-clock-chain.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev',
    ],
  );
  assert.match(broken.stdout, /could not start the successor in 3 tries/);
});

test('clock chain keepalive: a run of any status but completed is alive, so nothing is started', { skip: SKIP }, (t) => {
  for (const status of ['waiting', 'pending', 'queued', 'requested', 'in_progress']) {
    const r = keep(t, { fake: { runs: runs([7, status], [6, 'completed']) } });
    assert.equal(r.status, 0, status);
    assert.equal(dispatches(r), 0, `a ${status} run is alive`);
    assert.match(r.stdout, /has 1 run\(s\) that have not ended/, status);
  }
});

test('clock chain keepalive: a chain with every run completed is restarted once; one never started is not', { skip: SKIP }, (t) => {
  const broken = keep(t, { fake: { runs: runs([7, 'completed'], [6, 'completed']) } });
  assert.equal(broken.status, 0);
  assert.equal(dispatches(broken), 1);
  assert.equal(broken.calls.at(-1), 'workflow run measure-clock-chain.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev');
  assert.match(broken.summary, /^restarted=measure-clock-chain\.yml at=/m);
  const never = keep(t, { fake: { runs: '[]' } });
  assert.equal(never.status, 0);
  assert.equal(dispatches(never), 0);
  assert.match(never.stdout, /has never run; its first start is made by hand/);
});

test('clock chain keepalive: a passed CHAIN_END or an inactive workflow starts nothing; a malformed CHAIN_END fails', { skip: SKIP }, (t) => {
  const passed = keep(t, { end: '2026-10-01T00:00:00Z', fake: { runs: runs([7, 'completed']) } });
  assert.equal(passed.status, 0);
  assert.deepEqual(passed.calls, []);
  const inactive = keep(t, { fake: { state: 'disabled_manually', runs: runs([7, 'completed']) } });
  assert.equal(inactive.status, 0);
  assert.equal(dispatches(inactive), 0);
  const before = keep(t, { end: later(), fake: { runs: runs([7, 'completed']) } });
  assert.equal(dispatches(before), 1, 'a CHAIN_END still ahead restarts a broken chain');
  const bad = keep(t, { end: 'soon' });
  assert.equal(bad.status, 1);
  assert.deepEqual(bad.calls, []);
});
