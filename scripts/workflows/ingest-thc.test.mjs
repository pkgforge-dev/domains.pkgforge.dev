// The shape and the shell of .github/workflows/ingest-thc.yml (DOM-029,
// design sections 12.1 and 13.5; docs/architecture.md section 5.3). The shape
// (the triggers, the group, each job's grants, timeouts, needs and if, the
// steps, their ids, env and timeouts) is read with the yaml parser. Each step
// that runs a script is cut from the file (stepScript of
// scripts/lib/workflow-step.mjs) and run under bash with that module's fakes
// first on PATH (runStep), and with a bash function `node` before the step:
// it logs each call with its arguments quoted and answers from the files a
// test writes, as thc-plan.mjs and run.mjs would (the plan's files, run.mjs's
// lines and exit code). No script runs here, and nothing reads GHCR or a host;
// scripts/workflows/ingest-thc-scripts.test.mjs runs the real scripts. jq is
// the real one. The steps run with -e and pipefail, as GitHub runs them.
// Where bash or jq is missing, the step tests are skipped and say so, and a
// skip is not a pass.
//
//   node scripts/test.mjs scripts/workflows --name "ingest-thc:"
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { ACTION_PINS, checkText } from '../check-workflows.mjs';
import { ROOT } from '../files.mjs';
import { DUE } from '../ingest/chain.mjs';
import { MAX_DAYS } from '../ingest/thc-plan.mjs';
import { BASH, JQ, runStep, stepScript } from '../lib/workflow-step.mjs';

const FILE = join(ROOT, '.github', 'workflows', 'ingest-thc.yml');
const LIVE = join(ROOT, '.github', 'workflows', 'ingest-live.yml');
const TEXT = readFileSync(FILE, 'utf8');
const WF = parse(TEXT);
const MAIN = "github.ref == 'refs/heads/main'";
const TOKEN = '${{ github.token }}';
const SKIP = !BASH ? 'no bash on this machine, so the steps were not run' : !JQ ? 'no jq on this machine, so the steps were not run' : false;
const posix = (p) => p.replaceAll('\\', '/');
const PSL12 = '0232f4df0831';

// The node double. thc-plan.mjs copies STUB/thc/ (a plan's files) into its
// --out; run.mjs prints STUB/run.txt and, with run.die, the step's shell is
// killed after those lines, as its timeout ends it. NAME.rc is an exit code
// (plan, run). The double prints NODE_OPTIONS to the log as it sees it.
const PRELUDE = `
stub_rc() { if [ -f "$STUB/$1.rc" ]; then return "$(cat "$STUB/$1.rc")"; fi; return 0; }
node() {
  { printf 'node'; printf ' %q' "$@"; printf '\\n'; } >> "$FAKE_LOG"
  local script="$1"
  shift
  case "$script" in
    scripts/ingest/thc-plan.mjs)
      local out=''
      while [ "$#" -gt 0 ]; do
        if [ "$1" = --out ]; then out="$2"; fi
        shift
      done
      if [ -d "$STUB/thc" ]; then mkdir -p "$out"; cp -R "$STUB/thc/." "$out/"; fi
      stub_rc plan ;;
    scripts/ingest/run.mjs)
      echo "node_options \${NODE_OPTIONS:-none}" >> "$FAKE_LOG"
      if [ -f "$STUB/run.txt" ]; then cat "$STUB/run.txt"; fi
      if [ -f "$STUB/run.die" ]; then kill -KILL $$; fi
      stub_rc run ;;
    *) echo "stub node: no double for $script" >&2; return 99 ;;
  esac
}
set -eo pipefail
`;

const STEPS = new Map();
for (const [job, j] of Object.entries(WF.jobs)) for (const s of j.steps ?? []) if (s.id) STEPS.set(s.id, { job, step: s });

// The env of the step `id` as GitHub builds it; an expression takes the value
// the test gives, and a variable the step does not declare is refused.
function envOf(id, given) {
  const { job, step } = STEPS.get(id);
  const declared = { ...WF.env, ...WF.jobs[job].env, ...step.env };
  const env = {};
  for (const [k, v] of Object.entries(declared)) {
    if (Object.hasOwn(given, k)) env[k] = String(given[k]);
    else if (/\$\{\{/.test(String(v))) throw new Error(`step ${id}: ${k} is the expression ${v}, and the test gives it no value`);
    else env[k] = String(v);
  }
  for (const [k, v] of Object.entries(given)) {
    if (!Object.hasOwn(declared, k) && !/^GITHUB_/.test(k)) throw new Error(`step ${id} declares no ${k}`);
    env[k] = String(v);
  }
  return env;
}

const kv = (path) =>
  existsSync(path)
    ? Object.fromEntries(
        readFileSync(path, 'utf8')
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/\r$/, '')]),
      )
    : {};

function step(t, id, must, { env = {}, stub = {} } = {}) {
  const w = mkdtempSync(join(tmpdir(), 'ingest-thc-'));
  t.after(() => rmSync(w, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(stub)) {
    mkdirSync(dirname(join(w, 'stub', rel)), { recursive: true });
    writeFileSync(join(w, 'stub', rel), text);
  }
  mkdirSync(join(w, 'stub'), { recursive: true });
  mkdirSync(join(w, 'runner'));
  writeFileSync(join(w, 'output.txt'), '');
  const base = { STUB: posix(join(w, 'stub')), RUNNER_TEMP: posix(join(w, 'runner')), GITHUB_OUTPUT: posix(join(w, 'output.txt')) };
  const r = runStep(t, `${PRELUDE}${stepScript(FILE, id, must)}`, { env: { ...base, ...envOf(id, env) } });
  return { ...r, text: `${r.stdout}\n${r.stderr}`, output: kv(join(w, 'output.txt')), nodes: r.calls.filter((c) => c.startsWith('node ')), runner: join(w, 'runner'), w };
}

// ---- the shape -------------------------------------------------------------

test("ingest-thc: the triggers are the backstop cron of the chain's row and a dispatch with from and to, which reach the plan step through env alone", () => {
  assert.equal(WF.name, 'Ingest THC');
  assert.deepEqual(Object.keys(WF.on), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(WF.on.schedule, [{ cron: '5 * * * *' }]);
  // D2 of DOM-029: the chain is the clock, the cron its backstop, one row of DUE.
  assert.deepEqual(
    DUE.filter((r) => r.file === 'ingest-thc.yml').map((r) => r.cron),
    ['5 * * * *'],
  );
  const inputs = WF.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['from', 'to']);
  for (const [name, input] of Object.entries(inputs)) {
    assert.equal(input.type, 'string', name);
    assert.equal(input.required, false, name);
    assert.equal(input.default, '', name);
  }
  assert.deepEqual(STEPS.get('plan').step.env, { FROM: '${{ inputs.from }}', TO: '${{ inputs.to }}' });
  const readers = [...STEPS].filter(([, { step }]) => JSON.stringify(step).includes('inputs.')).map(([id]) => id);
  assert.deepEqual(readers, ['plan']);
  for (const [job, j] of Object.entries(WF.jobs)) for (const s of j.steps ?? []) if (s.run) assert.doesNotMatch(s.run, /\$\{\{/, `${job}: ${s.name ?? s.uses}`);
});

test('ingest-thc: permissions {} at the top, the group ingest-thc-ct with queue max and no cancel, bash, LC_ALL=C, and the four jobs', () => {
  assert.deepEqual(WF.permissions, {});
  assert.deepEqual(WF.concurrency, { group: 'ingest-thc-ct', queue: 'max', 'cancel-in-progress': false });
  assert.deepEqual(WF.defaults, { run: { shell: 'bash' } });
  assert.deepEqual(WF.env, { LC_ALL: 'C' });
  assert.deepEqual(Object.keys(WF.jobs), ['plan', 'ingest', 'push', 'promote']);
  assert.deepEqual(checkText(TEXT, '.github/workflows/ingest-thc.yml'), []);
});

test("ingest-thc: each job's grants, timeout, needs, if and matrix (D12, D29)", () => {
  const { plan, ingest, push, promote } = WF.jobs;
  assert.equal(plan.if, MAIN);
  assert.equal(plan.needs, undefined);
  assert.equal(plan['timeout-minutes'], 20);
  assert.deepEqual(plan.permissions, { contents: 'read' });
  assert.deepEqual(plan.outputs, {
    mode: '${{ steps.plan.outputs.mode }}',
    any: '${{ steps.plan.outputs.any }}',
    matrix: '${{ steps.plan.outputs.matrix }}',
    proposals: '${{ steps.plan.outputs.proposals }}',
  });

  assert.equal(ingest.needs, 'plan');
  assert.equal(ingest.if, "${{ github.ref == 'refs/heads/main' && needs.plan.outputs.any == 'true' }}");
  // D29: the run step's 150 minutes, and 15 for the setup and the push.
  assert.equal(ingest['timeout-minutes'], 165);
  assert.deepEqual(ingest.permissions, { contents: 'read', packages: 'write' });
  assert.deepEqual(ingest.strategy, { 'fail-fast': false, 'max-parallel': 6, matrix: '${{ fromJSON(needs.plan.outputs.matrix) }}' });
  assert.equal(ingest.concurrency, undefined, 'the legs move no tag');

  assert.deepEqual(push.needs, ['plan', 'ingest']);
  assert.equal(push.if, "${{ !cancelled() && github.ref == 'refs/heads/main' && needs.plan.result == 'success' && (needs.plan.outputs.any == 'true' || needs.plan.outputs.proposals == 'true') }}");
  assert.equal(push['timeout-minutes'], 30);
  assert.deepEqual(push.concurrency, { group: 'root-writer', queue: 'max', 'cancel-in-progress': false });
  assert.deepEqual(push.permissions, { contents: 'read', packages: 'write' });
  assert.deepEqual(push.outputs, { add: '${{ steps.move.outputs.add }}', gap: '${{ steps.move.outputs.gap }}' });

  assert.equal(promote.needs, 'push');
  assert.equal(promote.if, "${{ !cancelled() && needs.push.result == 'success' && (needs.push.outputs.add != '' || needs.push.outputs.gap != '') }}");
  assert.deepEqual(promote.permissions, { contents: 'read', packages: 'write' });
  assert.equal(promote.uses, './.github/workflows/root-promote.yml');
  assert.deepEqual(promote.with, { add: '${{ needs.push.outputs.add }}', gap: '${{ needs.push.outputs.gap }}', partial: true });
  assert.equal(promote.concurrency, undefined, 'root-promote.yml holds root-writer itself (ruling 18)');
  for (const [id, job] of Object.entries(WF.jobs)) assert.equal(job.permissions?.issues, undefined, id);
});

test('ingest-thc: the steps keep their names, ids, order and timeouts; the leg sets NODE_OPTIONS (D24); the artifacts are named and kept 3 days', () => {
  const named = (job) => WF.jobs[job].steps.map((s) => s.name ?? s.uses.split('@')[0]);
  assert.deepEqual(named('plan'), ['actions/checkout', 'actions/setup-node', 'Link the workspace packages', 'Plan the days', 'actions/upload-artifact', 'actions/upload-artifact']);
  assert.deepEqual(named('ingest'), ['actions/checkout', 'actions/setup-node', 'Link the workspace packages', 'Install oras', 'actions/download-artifact', 'Run thc-ct', 'actions/upload-artifact']);
  assert.deepEqual(named('push'), ['actions/checkout', 'actions/setup-node', 'Link the workspace packages', 'Install oras', 'actions/download-artifact', 'Advance the cursors', 'Move state:latest']);
  const ids = Object.fromEntries([...STEPS].map(([id, { job, step }]) => [id, [job, step.name, step['timeout-minutes']]]));
  assert.deepEqual(ids, {
    plan: ['plan', 'Plan the days', 15],
    run: ['ingest', 'Run thc-ct', 150],
    advance: ['push', 'Advance the cursors', 5],
    move: ['push', 'Move state:latest', 5],
  });
  assert.deepEqual(STEPS.get('run').step.env, {
    REGISTRY_TOKEN: TOKEN,
    MODE: '${{ needs.plan.outputs.mode }}',
    DAY: '${{ matrix.day }}',
    PSL: '${{ matrix.psl }}',
    NODE_OPTIONS: '--max-old-space-size=8192',
  });
  const [planUp, adoptUp] = WF.jobs.plan.steps.filter((s) => String(s.uses).startsWith('actions/upload-artifact@'));
  assert.equal(planUp.if, "${{ steps.plan.outputs.mode == 'backfill' }}");
  assert.deepEqual(planUp.with, {
    name: 'thc-plan',
    path: '${{ runner.temp }}/thc/plan.json\n${{ runner.temp }}/thc/matrix.json\n${{ runner.temp }}/thc/state.json\n${{ runner.temp }}/thc/psl-*.dat\n',
    overwrite: true,
    'retention-days': 3,
    'if-no-files-found': 'error',
  });
  assert.equal(adoptUp.if, "${{ steps.plan.outputs.proposals == 'true' }}");
  assert.deepEqual(adoptUp.with, { name: 'proposals-thc-plan', path: '${{ runner.temp }}/thc/proposals/', overwrite: true, 'retention-days': 3, 'if-no-files-found': 'error' });
  const legDown = WF.jobs.ingest.steps.find((s) => String(s.uses).startsWith('actions/download-artifact@'));
  assert.equal(legDown.if, "${{ needs.plan.outputs.mode == 'backfill' }}");
  assert.deepEqual(legDown.with, { name: 'thc-plan', path: '${{ runner.temp }}/thc' });
  const legUp = WF.jobs.ingest.steps.find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
  assert.equal(legUp.if, '${{ !cancelled() }}');
  assert.deepEqual(legUp.with, { name: 'proposals-thc-${{ matrix.day }}', path: '${{ runner.temp }}/out/proposals/', overwrite: true, 'retention-days': 3, 'if-no-files-found': 'ignore' });
  const pushDown = WF.jobs.push.steps.find((s) => String(s.uses).startsWith('actions/download-artifact@'));
  // The legs' proposals-thc-<day> and the plan's proposals-thc-plan, and nothing else (thc-plan is no proposal).
  assert.deepEqual(pushDown.with, { pattern: 'proposals-thc-*', 'merge-multiple': true, path: '${{ runner.temp }}/proposals' });
  for (const job of ['plan', 'ingest', 'push'])
    assert.match(WF.jobs[job].steps.find((s) => s.name === 'Link the workspace packages').run, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/, job);
});

test("ingest-thc: the push job's steps 'Advance the cursors' and 'Move state:latest' are ingest-live.yml's, the same text, env, if and timeout", () => {
  const live = parse(readFileSync(LIVE, 'utf8'));
  for (const id of ['advance', 'move']) {
    const a = live.jobs.push.steps.find((s) => s.id === id);
    const b = WF.jobs.push.steps.find((s) => s.id === id);
    for (const k of ['name', 'run', 'env', 'if', 'timeout-minutes']) assert.deepEqual(b[k], a[k], `${id}.${k}`);
  }
});

test('ingest-thc: every action is a pin of ACTION_PINS, checkout keeps no credential, and the token is in the env of the steps that push or move with it, and no other', () => {
  for (const [job, j] of Object.entries(WF.jobs))
    for (const s of j.steps ?? []) {
      if (!s.uses) continue;
      const [name, sha] = s.uses.split('@');
      assert.equal(ACTION_PINS[name]?.sha, sha, `${job}: ${s.uses}`);
      if (name === 'actions/checkout') assert.equal(s.with['persist-credentials'], false, job);
    }
  const tokened = [];
  for (const [job, j] of Object.entries(WF.jobs)) for (const s of j.steps ?? []) for (const [k, v] of Object.entries(s.env ?? {})) if (v === TOKEN) tokened.push(`${job}/${s.id}/${k}`);
  assert.deepEqual(tokened, ['ingest/run/REGISTRY_TOKEN', 'push/advance/REGISTRY_TOKEN', 'push/move/REGISTRY_TOKEN']);
  assert.equal(TEXT.split('github.token').length - 1, tokened.length, 'no other reference to the token');
});

test('ingest-thc: every step that runs a script reads its exit from the script, never through a pipe', () => {
  let scripts = 0;
  for (const [job, j] of Object.entries(WF.jobs))
    for (const s of j.steps ?? []) {
      if (!s.run) continue;
      for (const line of s.run.split('\n').filter((l) => /^\s*node scripts\//.test(l))) {
        scripts += 1;
        assert.match(line, /^\s*node scripts\/[a-z/-]+\.mjs [^|]*\|\| rc=\$\?$/, `${job}: ${line}`);
      }
    }
  assert.equal(scripts, 4, 'thc-plan, run, advance and move');
});

// ---- the plan step ---------------------------------------------------------

const PLAN_MUST = /node scripts\/ingest\/thc-plan\.mjs --from "\$FROM" --to "\$TO" --out "\$out" --run "\$GITHUB_RUN_ID" \|\| rc=\$\?/;
const planFiles = (days, { proposals = [] } = {}) => {
  const files = {
    'thc/plan.json': `${JSON.stringify({ format: 'domains.thc-plan.v1', from: days[0]?.day ?? '2026-10-01', to: days.at(-1)?.day ?? '2026-10-01', now: '2026-11-02T05:00:00Z', days })}\n`,
    'thc/matrix.json': `${JSON.stringify({ include: days.filter((d) => d.action === 'run').map((d) => ({ day: d.day, psl: d.psl.slice(0, 12) })) })}\n`,
  };
  for (const p of proposals) files[`thc/proposals/${p}`] = '{}\n';
  return files;
};
const runDay = (day) => ({ day, action: 'run', bytes: 1, host: 'hf', verdict: 'ok', path: null, psl: PSL12.padEnd(64, '0'), tags: [] });
const plan = (t, { from = '', to = '', files = {}, rc } = {}) =>
  step(t, 'plan', PLAN_MUST, { env: { FROM: from, TO: to, GITHUB_RUN_ID: '41000000001' }, stub: { ...files, ...(rc === undefined ? {} : { 'plan.rc': String(rc) }) } });

test("ingest-thc: 'Plan the days' with no input plans the live run, one leg live under root, and reads nothing", { skip: SKIP }, (t) => {
  const r = plan(t);
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(r.output, { mode: 'live', any: 'true', matrix: '{"include":[{"day":"live","psl":"root"}]}', proposals: 'false' });
  assert.deepEqual(r.nodes, []);
  assert.match(r.text, /the live run: one leg/);
});

test("ingest-thc: 'Plan the days' with from and to runs thc-plan.mjs and writes the matrix, any and proposals from its files", { skip: SKIP }, (t) => {
  const days = [runDay('2026-09-01'), { ...runDay('2026-09-02'), action: 'present', psl: null }, runDay('2026-09-03')];
  const r = plan(t, { from: '2026-09-01', to: '2026-09-03', files: planFiles(days, { proposals: ['proposal.thc-ct.20260902.json'] }) });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.nodes.length, 1);
  assert.match(r.nodes[0], /^node scripts\/ingest\/thc-plan\.mjs --from 2026-09-01 --to 2026-09-03 --out \S+\/runner\/thc --run 41000000001$/);
  assert.equal(r.output.mode, 'backfill');
  assert.equal(r.output.any, 'true');
  assert.equal(r.output.proposals, 'true');
  assert.deepEqual(JSON.parse(r.output.matrix), {
    include: [
      { day: '2026-09-01', psl: PSL12 },
      { day: '2026-09-03', psl: PSL12 },
    ],
  });
  assert.match(r.text, /the backfill of 2026-09-01 to 2026-09-03: 2 leg\(s\), and 1 proposal\(s\) the plan wrote/);
  // No leg and no proposal (every day present): nothing runs after the plan.
  const none = plan(t, { from: '2026-09-02', to: '2026-09-02', files: planFiles([{ ...runDay('2026-09-02'), action: 'present', psl: null }]) });
  assert.equal(none.status, 0, none.text);
  assert.deepEqual([none.output.any, none.output.proposals, none.output.matrix], ['false', 'false', '{"include":[]}']);
  // Proposals and no leg: push still runs.
  const adopt = plan(t, { from: '2026-09-02', to: '2026-09-02', files: planFiles([{ ...runDay('2026-09-02'), action: 'adopt', psl: null }], { proposals: ['proposal.thc-ct.20260902.json'] }) });
  assert.deepEqual([adopt.output.any, adopt.output.proposals], ['false', 'true']);
});

test("ingest-thc: 'Plan the days' refuses one input alone or a day off its form (exit 2) before any script, keeps thc-plan.mjs's exit, and refuses a matrix that is not the plan's run days", {
  skip: SKIP,
}, (t) => {
  for (const [from, to] of [
    ['2026-09-01', ''],
    ['', '2026-09-01'],
    ['2026-9-01', '2026-09-02'],
    ['2026-09-01', '2026-09-02\nany=true'],
  ]) {
    const r = plan(t, { from, to });
    assert.equal(r.status, 2, `${from} ${to}\n${r.text}`);
    assert.match(r.text, /from and to come together, each a day YYYY-MM-DD/);
    assert.deepEqual(r.nodes, []);
    assert.deepEqual(r.output, {});
  }
  for (const rc of [1, 2, 4, 70]) {
    const r = plan(t, { from: '2026-09-01', to: '2026-09-01', rc });
    assert.equal(r.status, rc, r.text);
    assert.match(r.text, new RegExp(`::error::scripts/ingest/thc-plan\\.mjs exited ${rc} `));
    assert.deepEqual(r.output, {});
  }
  const days = [runDay('2026-09-01'), runDay('2026-09-02')];
  const files = planFiles(days);
  // matrix.json names one leg plan.json does not run.
  const fewer = { ...files, 'thc/matrix.json': `${JSON.stringify({ include: [{ day: '2026-09-01', psl: PSL12 }] })}\n` };
  const lies = plan(t, { from: '2026-09-01', to: '2026-09-02', files: fewer });
  assert.equal(lies.status, 1, lies.text);
  assert.match(lies.text, /whose run days are the legs of matrix\.json/);
  assert.deepEqual(lies.output, {});
  for (const leg of [
    { day: '2026-09-01', psl: 'root' },
    { day: 'live', psl: PSL12 },
    { day: '2026-09-01\nany=false', psl: PSL12 },
    { day: '2026-09-01', psl: PSL12.toUpperCase() },
  ]) {
    const bad = plan(t, { from: '2026-09-01', to: '2026-09-01', files: { ...files, 'thc/matrix.json': `${JSON.stringify({ include: [leg] })}\n` } });
    assert.equal(bad.status, 1, `${JSON.stringify(leg)}\n${bad.text}`);
    assert.match(bad.text, /is not a list of legs \{ day, psl \}/);
    assert.deepEqual(bad.output, {});
  }
  const other = plan(t, { from: '2026-09-01', to: '2026-09-02', files: { ...files, 'thc/plan.json': files['thc/plan.json'].replace('thc-plan.v1', 'thc-plan.v2') } });
  assert.equal(other.status, 1, other.text);
});

// ---- the leg ---------------------------------------------------------------

const RUN_MUST = /node scripts\/ingest\/run\.mjs "\$\{args\[@\]\}" >&3 \|\| rc=\$\?/;
const leg = (t, { mode = 'backfill', day = '2026-10-26', psl = PSL12, lines = [], rc, die = false } = {}) =>
  step(t, 'run', RUN_MUST, {
    env: { REGISTRY_TOKEN: 'placeholder', MODE: mode, DAY: day, PSL: psl },
    stub: { ...(lines.length > 0 ? { 'run.txt': `${lines.join('\n')}\n` } : {}), ...(rc === undefined ? {} : { 'run.rc': String(rc) }), ...(die ? { 'run.die': '' } : {}) },
  });
const SEG = (verdict, d = '') => `segment obs:thc-ct.20261026.8a960c4f290f${d} thc-ct names 2026-10-26T00:00:00Z 2026-10-27T00:00:00Z records 3 verdict ${verdict}`;
const STATS = (fields) => `stats thc-ct ${JSON.stringify({ bytes: 324537041, files: 1, refused_share: 0.00018, ...fields })}`;
const warnings = (r) => r.stdout.split('\n').filter((l) => l.startsWith('::warning::'));

test("ingest-thc: 'Run thc-ct' runs run.mjs live under root, or a backfill leg over its one day under the plan's list and state, with NODE_OPTIONS", { skip: SKIP }, (t) => {
  const live = leg(t, { mode: 'live', day: 'live', psl: 'root' });
  assert.equal(live.status, 0, live.text);
  assert.equal(live.nodes.length, 1);
  assert.match(live.nodes[0], /^node scripts\/ingest\/run\.mjs --adapter thc-ct --out \S+\/runner\/out --psl root$/);
  assert.ok(live.calls.includes('node_options --max-old-space-size=8192'), live.calls.join('\n'));
  const day = leg(t);
  assert.equal(day.status, 0, day.text);
  assert.match(
    day.nodes[0],
    new RegExp(
      `^node scripts/ingest/run\\.mjs --adapter thc-ct --out \\S+/runner/out --psl \\S+/runner/thc/psl-${PSL12}\\.dat --state \\S+/runner/thc/state\\.json --from 2026-10-26T00:00:00Z --to 2026-10-27T00:00:00Z$`,
    ),
  );
  // The last day of a month ends on the first of the next.
  const end = leg(t, { day: '2026-10-31' });
  assert.match(end.nodes[0], / --from 2026-10-31T00:00:00Z --to 2026-11-01T00:00:00Z$/);
});

test("ingest-thc: 'Run thc-ct' refuses a day or a list off its form, and a mode that is not the leg's, before run.mjs", { skip: SKIP }, (t) => {
  for (const [o, re] of [
    [{ day: '2026-10-2' }, /the leg's day is not live or YYYY-MM-DD/],
    [{ day: '../x' }, /the leg's day is not live or YYYY-MM-DD/],
    [{ psl: 'abc' }, /the leg's list is not root or 12 hex digits/],
    [{ psl: '../../etc/x' }, /the leg's list is not root or 12 hex digits/],
    [{ mode: 'live', day: '2026-10-26', psl: 'root' }, /are not a live leg/],
    [{ mode: 'live', day: 'live', psl: PSL12 }, /are not a live leg/],
    [{ mode: 'backfill', day: 'live', psl: 'root' }, /are not a live leg/],
    [{ mode: 'backfill', day: '2026-10-26', psl: 'root' }, /are not a live leg/],
    [{ mode: '' }, /are not a live leg/],
  ]) {
    const r = leg(t, o);
    assert.equal(r.status, 1, `${JSON.stringify(o)}\n${r.text}`);
    assert.match(r.text, re);
    assert.deepEqual(r.nodes, [], JSON.stringify(o));
  }
});

test("ingest-thc: 'Run thc-ct' prints run.mjs's lines and warns on a quarantined segment, a fault, a file of 900,000,000 B or more and a refused share of 0.01 or more", { skip: SKIP }, (t) => {
  const r = leg(t, {
    lines: [SEG('quarantine'), SEG('quarantine', '-d'), 'fault thc-ct gzip 2026-10-26 cs2: the gzip does not decode', STATS({ bytes: 900_000_000, refused_share: 0.01 })],
    rc: 1,
  });
  assert.equal(r.status, 1, r.text);
  const w = warnings(r);
  assert.equal(w.length, 5, r.text);
  assert.match(w[0], /^::warning::segment obs:thc-ct\.20261026\.8a960c4f290f thc-ct .* verdict quarantine: served and never new \(ruling 23\)/);
  assert.match(w[2], /^::warning::fault thc-ct gzip 2026-10-26 cs2: /);
  assert.equal(w[3], '::warning::thc-ct read 900000000 B, 900000000 B or more: a day file layer holds 2 GiB at most (D27 of DOM-029)');
  assert.equal(w[4], '::warning::thc-ct refused a share of 0.01 of the non-empty lines, 0.01 or more; above 0.5 the file is the fault format (D4 of DOM-029)');
  assert.match(r.text, /::error::scripts\/ingest\/run\.mjs exited 1 for thc-ct /);
  // The run's own lines come first, unchanged.
  assert.deepEqual(r.stdout.split('\n').slice(0, 4), [
    SEG('quarantine'),
    SEG('quarantine', '-d'),
    'fault thc-ct gzip 2026-10-26 cs2: the gzip does not decode',
    STATS({ bytes: 900_000_000, refused_share: 0.01 }),
  ]);
  // Just under each bound, an ok segment, a stats key that ends in bytes and a share written with an exponent: no warning.
  const quiet = leg(t, {
    lines: [SEG('ok'), SEG('ok', '-d'), STATS({ bytes: 899_999_999, refused_share: 0.0099, raw_bytes: 950_000_000 }), STATS({ refused_share: 1.8e-7 }), 'segment x verdict quarantined'],
  });
  assert.equal(quiet.status, 0, quiet.text);
  assert.deepEqual(warnings(quiet), []);
});

test("ingest-thc: 'Run thc-ct' keeps run.mjs's every exit, and a step its timeout ends has printed the lines run.mjs wrote", { skip: SKIP }, (t) => {
  for (const rc of [1, 2, 4, 70]) {
    const r = leg(t, { lines: [SEG('ok')], rc });
    assert.equal(r.status, rc, r.text);
    assert.match(r.text, new RegExp(`::error::scripts/ingest/run\\.mjs exited ${rc} for thc-ct `));
  }
  const killed = leg(t, { lines: [SEG('ok'), SEG('ok', '-d')], die: true });
  assert.notEqual(killed.status, 0, killed.text);
  assert.deepEqual(killed.stdout.split('\n').filter(Boolean), [SEG('ok'), SEG('ok', '-d')]);
});

test("ingest-thc: the plan's window bound is compact-daily.yml's MAX_RANGE_DAYS, so a backfilled window compacts in one range dispatch (D18)", () => {
  const daily = parse(readFileSync(join(ROOT, '.github', 'workflows', 'compact-daily.yml'), 'utf8'));
  assert.equal(Number(daily.env.MAX_RANGE_DAYS), MAX_DAYS);
});

// ---- the artifacts the push job merges --------------------------------------

test("ingest-thc: the push job's pattern proposals-thc-* takes every leg's artifact and the plan's proposals, and not the plan's inputs", () => {
  const names = ['proposals-thc-2026-10-26', 'proposals-thc-live', 'proposals-thc-plan', 'thc-plan'];
  const pattern = WF.jobs.push.steps.find((s) => String(s.uses).startsWith('actions/download-artifact@')).with.pattern;
  const re = new RegExp(`^${pattern.replaceAll('*', '.*')}$`);
  assert.deepEqual(
    names.filter((n) => re.test(n)),
    ['proposals-thc-2026-10-26', 'proposals-thc-live', 'proposals-thc-plan'],
  );
  // A leg is named by its day or live, so no leg's artifact is the plan's.
  assert.ok(!/^(live|[0-9]{4}-[0-9]{2}-[0-9]{2})$/.test('plan'));
});
