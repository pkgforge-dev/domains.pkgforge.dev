// The chain of .github/workflows/measure-tiles.yml (DOM-011): the run block of
// its `successor` step, cut from the workflow and run under bash with a fake
// `gh` and a fake `sleep` first on PATH (scripts/lib/workflow-step.mjs), and
// the shape of its three jobs read with the yaml parser. The step tests are
// skipped where no bash or no jq is found.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { BASH, JQ, runStep, stepScript } from '../lib/workflow-step.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOW = join(ROOT, '.github', 'workflows', 'measure-tiles.yml');
const script = () => stepScript(WORKFLOW, 'successor', /gh workflow run measure-tiles\.yml --ref main --repo "\$GITHUB_REPOSITORY" -f until="\$UNTIL"/);
const runChain = (t, { until, ref, attempt, state, runs, dispatch }) =>
  runStep(t, script(), { fake: { state, runs, dispatch }, env: { UNTIL: until, ...(ref ? { GITHUB_REF: ref } : {}), ...(attempt ? { GITHUB_RUN_ATTEMPT: attempt } : {}) } });

const later = () => new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SKIP = !BASH ? 'no bash on this machine' : !JQ ? 'no jq on this machine' : false;
const STATE_CALL = 'api repos/pkgforge-dev/domains.pkgforge.dev/actions/workflows/measure-tiles.yml --jq .state';
const LIST_CALL = /^run list --repo pkgforge-dev\/domains\.pkgforge\.dev --workflow measure-tiles\.yml --branch main --limit 50 --json databaseId,status --jq /;
const runs = (...xs) => JSON.stringify(xs.map(([databaseId, status]) => ({ databaseId, status })));

test('tiles chain: a run before until starts its successor with the same until', { skip: SKIP }, (t) => {
  const until = later();
  const r = runChain(t, { until, runs: runs([42, 'in_progress'], [41, 'completed']) });
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 3);
  assert.equal(r.calls[0], STATE_CALL);
  assert.match(r.calls[1], LIST_CALL);
  assert.equal(r.calls[2], `workflow run measure-tiles.yml --ref main --repo pkgforge-dev/domains.pkgforge.dev -f until=${until}`);
  assert.match(r.summary, /successor=started tries=1/);
});

test('tiles chain: at or after until, or with an until that is not an instant, no successor starts', { skip: SKIP }, (t) => {
  const past = runChain(t, { until: '2026-10-01T00:00:00Z' });
  assert.equal(past.status, 0);
  assert.deepEqual(past.calls, []);
  assert.match(past.summary, /successor=none/);
  const bad = runChain(t, { until: '2026-10-29 16:00' });
  assert.equal(bad.status, 1);
  assert.deepEqual(bad.calls, []);
  assert.match(bad.stdout, /::error::until is not an instant/);
});

test('tiles chain: a re-run, a run off main, a disabled workflow or another waiting run starts no successor', { skip: SKIP }, (t) => {
  const rerun = runChain(t, { until: later(), attempt: '2' });
  assert.deepEqual(rerun.calls, []);
  assert.match(rerun.stdout, /attempt 2 is a re-run/);
  const off = runChain(t, { until: later(), ref: 'refs/heads/topic' });
  assert.deepEqual(off.calls, []);
  const disabled = runChain(t, { until: later(), state: 'disabled_manually' });
  assert.deepEqual(disabled.calls, [STATE_CALL]);
  const waiting = runChain(t, { until: later(), runs: runs([42, 'in_progress'], [43, 'queued']) });
  assert.equal(waiting.calls.filter((c) => c.startsWith('workflow run')).length, 0);
  assert.match(waiting.stdout, /1 other run\(s\) of main are waiting/);
  // The same listing without the waiting run dispatches: that run alone stopped it.
  const alone = runChain(t, { until: later(), runs: runs([42, 'in_progress']) });
  assert.match(alone.calls.at(-1), /^workflow run measure-tiles\.yml /);
  // A lagging listing of this run (42) as queued, and another run in progress,
  // are not waiting runs: the successor still starts.
  const lagging = runChain(t, { until: later(), runs: runs([42, 'queued'], [44, 'in_progress']) });
  assert.match(lagging.calls.at(-1), /^workflow run measure-tiles\.yml /);
  assert.match(lagging.summary, /successor=started/);
});

test('tiles chain: a run at the instant until starts no successor', { skip: SKIP }, (t) => {
  // until is this second; the step reads the clock after it, so now >= until.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const r = runChain(t, { until: now });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.summary, /successor=none/);
});

test('tiles chain: three failed dispatches fail the step', { skip: SKIP }, (t) => {
  const broken = runChain(t, { until: later(), dispatch: 'fail' });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /could not start the successor in 3 tries/);
  assert.equal(broken.calls.filter((c) => c.startsWith('workflow run')).length, 3, 'three dispatch tries, no more');
  assert.deepEqual(
    broken.calls.filter((c) => c.startsWith('sleep')),
    ['sleep 15', 'sleep 15'],
  );
  const second = runChain(t, { until: later(), dispatch: 'fail-1' });
  assert.equal(second.status, 0);
  assert.match(second.summary, /successor=started tries=2/);
});

test('tiles chain: the dispatching token reaches no step that reads an outside host; the two readers hold contents: read', () => {
  const w = parse(readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.concurrency, { group: 'measure-tiles', queue: 'max', 'cancel-in-progress': false });
  assert.deepEqual(w.defaults, { run: { shell: 'bash' } });
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(w.jobs), ['measure-chain', 'rounds', 'overlap']);
  const chain = w.jobs['measure-chain'];
  assert.deepEqual(chain.permissions, { actions: 'write', contents: 'read' });
  assert.deepEqual(
    chain.steps.map((s) => s.id),
    ['successor'],
    'the job that can dispatch runs one step, which reads no outside host',
  );
  // A run of another branch runs no job: it holds the group for no time, and
  // uploads nothing the verdict could read.
  for (const name of ['measure-chain', 'rounds', 'overlap']) assert.equal(w.jobs[name].if, "github.ref == 'refs/heads/main'", name);
  for (const name of ['rounds', 'overlap']) {
    const job = w.jobs[name];
    assert.deepEqual(job.permissions, { contents: 'read' }, name);
    assert.equal(job.needs, undefined, `${name} starts with the chain job`);
    assert.equal(job['continue-on-error'], undefined);
    const upload = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
    assert.equal(upload.with.overwrite, true, name);
    assert.equal(upload.if, 'always()', name);
    assert.match(upload.with.name, new RegExp(`^tiles-${name}-\\$\\{\\{ github\\.run_id \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}$`));
  }
});

test('tiles chain: every job is bounded, every action pinned with its version, and no expression sits in a run string', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const w = parse(text);
  for (const [name, job] of Object.entries(w.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-24.04', name);
    assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] <= 350, name);
    for (const s of job.steps) {
      if (s.run) assert.doesNotMatch(s.run, /\$\{\{/, `${name}: ${s.name ?? s.id}`);
      if (String(s.uses ?? '').startsWith('actions/checkout@')) assert.equal(s.with['persist-credentials'], false);
    }
  }
  const uses = [...text.matchAll(/uses: (\S+)(.*)$/gm)];
  assert.ok(uses.length >= 6);
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
    assert.match(rest, /^ # v\d+\.\d+\.\d+$/, ref);
  }
  assert.doesNotMatch(text, /secrets\.|pull_request_target|workflow_run|if: !/);
  // The rounds stop at until, and the overlap picks its window with it.
  assert.match(w.jobs.rounds.steps.find((s) => /round/.test(s.name ?? '')).run, /--until "\$UNTIL"/);
  assert.equal(w.jobs.rounds.steps.find((s) => /round/.test(s.name ?? '')).env.UNTIL, '${{ inputs.until }}');
  assert.match(w.jobs.overlap.steps.find((s) => /overlap/.test(s.name ?? '')).run, /tiles-window\.mjs --overlap --until "\$UNTIL"/);
});
