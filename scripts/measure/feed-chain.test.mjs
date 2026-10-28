// The chain step of .github/workflows/measure-feeds.yml (DOM-012): the run
// block of its `successor` job, cut from the workflow and run under bash with a
// fake `gh` and a fake `sleep` first on PATH (scripts/lib/workflow-step.mjs).
// Skipped where no bash or no jq is found.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BASH, JQ, runStep, stepScript } from '../lib/workflow-step.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOW = join(ROOT, '.github', 'workflows', 'measure-feeds.yml');
const script = () => stepScript(WORKFLOW, 'successor', /gh workflow run measure-feeds\.yml --ref main --repo "\$GITHUB_REPOSITORY" -f until="\$UNTIL"/);
const runChain = (t, { until, ref, attempt, state, runs, dispatch }) =>
  runStep(t, script(), { fake: { state, runs, dispatch }, env: { UNTIL: until, ...(ref ? { GITHUB_REF: ref } : {}), ...(attempt ? { GITHUB_RUN_ATTEMPT: attempt } : {}) } });

const later = () => new Date(Date.now() + 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SKIP = !BASH ? 'no bash on this machine' : !JQ ? 'no jq on this machine' : false;
const STATE_CALL = 'api repos/pkgforge-dev/domains.pkgforge.dev/actions/workflows/measure-feeds.yml --jq .state';
const LIST_CALL = /^run list --repo pkgforge-dev\/domains\.pkgforge\.dev --workflow measure-feeds\.yml --branch main --limit 50 --json databaseId,status --jq /;
const runs = (...xs) => JSON.stringify(xs.map(([databaseId, status]) => ({ databaseId, status })));

test('feed chain: a run before until starts its successor with the same until', { skip: SKIP }, (t) => {
  const until = later();
  const r = runChain(t, { until, runs: runs([42, 'in_progress'], [41, 'completed']) });
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 3);
  assert.equal(r.calls[0], STATE_CALL);
  assert.match(r.calls[1], LIST_CALL);
  assert.equal(r.calls[2], `workflow run measure-feeds.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev -f until=${until}`);
  assert.match(r.summary, /^run=42 attempt=1 started=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z until=/m);
  assert.match(r.summary, /successor=started tries=1/);
});

test('feed chain: a run at or after until starts nothing and passes', { skip: SKIP }, (t) => {
  const r = runChain(t, { until: '2026-10-01T00:00:00Z' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.summary, /successor=none/);
});

test('feed chain: an until that is not an instant starts nothing and fails the step', { skip: SKIP }, (t) => {
  const r = runChain(t, { until: 'tomorrow' });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, []);
  assert.match(r.stdout, /::error::until is not an instant/);
});

test('feed chain: a run off main, or of a disabled workflow, starts nothing', { skip: SKIP }, (t) => {
  const off = runChain(t, { until: later(), ref: 'refs/heads/topic' });
  assert.equal(off.status, 0);
  assert.deepEqual(off.calls, []);
  const disabled = runChain(t, { until: later(), state: 'disabled_manually' });
  assert.equal(disabled.status, 0);
  assert.deepEqual(disabled.calls, [STATE_CALL], 'only the state was read');
  assert.match(disabled.stdout, /the workflow is disabled_manually/);
});

test('feed chain: a re-run starts no successor, since attempt 1 started one', { skip: SKIP }, (t) => {
  const r = runChain(t, { until: later(), attempt: '2' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.stdout, /attempt 2 is a re-run/);
  assert.match(r.summary, /successor=none/);
});

test('feed chain: another waiting run of main means a chain goes on already; a running or ended one does not', { skip: SKIP }, (t) => {
  for (const status of ['pending', 'queued', 'waiting', 'requested']) {
    const r = runChain(t, { until: later(), runs: runs([42, 'in_progress'], [43, status]) });
    assert.equal(r.status, 0, status);
    assert.equal(r.calls.filter((c) => c.startsWith('workflow run')).length, 0, `a ${status} run: no dispatch`);
    assert.match(r.stdout, /1 other run\(s\) of main are waiting/, status);
  }
  // The predecessor, still listed in_progress for a moment after it ended,
  // never ends the chain; nor does this run when it is listed as waiting.
  const lag = runChain(t, { until: later(), runs: runs([41, 'in_progress'], [42, 'pending'], [40, 'completed']) });
  assert.equal(lag.status, 0);
  assert.match(lag.calls.at(-1), /^workflow run measure-feeds\.yml /);
});

test('feed chain: an unreadable state or listing still dispatches; three failed dispatches fail the step', { skip: SKIP }, (t) => {
  const unread = runChain(t, { until: later(), state: 'fail' });
  assert.equal(unread.status, 0);
  assert.match(unread.calls.at(-1), /^workflow run measure-feeds\.yml /);
  const unlisted = runChain(t, { until: later(), runs: 'fail' });
  assert.equal(unlisted.status, 0);
  assert.match(unlisted.stdout, /could not list the workflow's runs/);
  assert.match(unlisted.calls.at(-1), /^workflow run measure-feeds\.yml /);
  const broken = runChain(t, { until: later(), dispatch: 'fail' });
  assert.equal(broken.status, 1);
  assert.deepEqual(
    broken.calls.filter((c) => c.startsWith('workflow run') || c.startsWith('sleep')).map((c) => c.split(' ')[0]),
    ['workflow', 'sleep', 'workflow', 'sleep', 'workflow'],
  );
  assert.match(broken.stdout, /could not start the successor in 3 tries/);
});

test('feed chain: the polls run in their own job, with a read-only token, and each attempt uploads its own artifact', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const jobs = text.slice(text.indexOf('\njobs:\n'));
  const poll = jobs.slice(jobs.indexOf('\n  poll:\n'));
  const successor = jobs.slice(0, jobs.indexOf('\n  poll:\n'));
  assert.match(successor, /permissions:\n {6}actions: write\n {6}contents: read\n/);
  assert.doesNotMatch(successor, /continue-on-error/);
  assert.match(poll, /permissions:\n {6}contents: read\n {4}steps:/);
  assert.doesNotMatch(poll, /actions: write/);
  assert.doesNotMatch(jobs, /\n {4}needs:/, 'the two jobs start together');
  assert.match(poll, /name: feeds-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\n/);
});
