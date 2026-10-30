// The shape and the shell of .github/workflows/ingest-live.yml (DOM-024,
// docs/architecture.md sections 5.3 and 5.4). The shape (the triggers, the
// groups, each job's grants, timeouts, needs and if, the step ids and their
// env) is read with the yaml parser. Each step that runs a script is cut from
// the file (stepScript of scripts/lib/workflow-step.mjs) and run under bash
// with that module's fake gh and fake sleep first on PATH (runStep), and with
// a bash function `node` put before the step. The function logs each call to
// the same log as the fake gh, with its arguments quoted, and answers by the
// flags, the lines, the files and the exit codes that scripts/ingest/ and
// scripts/state/ keep (plan.mjs, run.mjs, chain.mjs, advance.mjs, hours.mjs
// and move.mjs): a test writes the file or the exit code each call answers
// with. No script of those directories runs here, and nothing reads GHCR. jq
// is the real one. The steps run with -e and pipefail, as GitHub runs them
// (`bash --noprofile --norc -eo pipefail`). Where bash or jq is missing, the
// step tests are skipped and say so, and a skip is not a pass.
//
//   node scripts/test.mjs scripts/workflows --name ingest-live
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { ACTION_PINS, checkText } from '../check-workflows.mjs';
import { ROOT } from '../files.mjs';
import { BASH, JQ, runStep, stepScript } from '../lib/workflow-step.mjs';

const FILE = join(ROOT, '.github', 'workflows', 'ingest-live.yml');
const TEXT = readFileSync(FILE, 'utf8');
const WF = parse(TEXT);
const MAIN = "github.ref == 'refs/heads/main'";
const TOKEN = '${{ github.token }}';
const SKIP = !BASH ? 'no bash on this machine, so the steps were not run' : !JQ ? 'no jq on this machine, so the steps were not run' : false;
const REPO = 'pkgforge-dev/domains.pkgforge.dev';
const posix = (p) => p.replaceAll('\\', '/');
const hex = (c) => c.repeat(64);

// The node double. Each call is logged as `node ARG...`, each argument quoted
// by printf %q, so the boundaries between arguments are kept. The STUB
// directory holds what each script answers: plan.json (copied to plan.mjs's
// --out), advance.txt (advance.mjs's lines), and NAME.rc, an exit code
// (plan, run.<adapter>, advance, hours, move, chain.start, chain.sleep).
// chain.mjs start dispatches with gh, as scripts/ingest/chain.mjs does when the
// clock is actions-chain; chain.start.rc stands in for its other exits.
const PRELUDE = `
stub_rc() { if [ -f "$STUB/$1.rc" ]; then return "$(cat "$STUB/$1.rc")"; fi; return 0; }
node() {
  { printf 'node'; printf ' %q' "$@"; printf '\\n'; } >> "$FAKE_LOG"
  local script="$1"
  shift
  case "$script" in
    scripts/ingest/plan.mjs)
      local out=''
      while [ "$#" -gt 0 ]; do
        if [ "$1" = --out ]; then out="$2"; fi
        shift
      done
      if [ -f "$STUB/plan.json" ]; then cp "$STUB/plan.json" "$out"; fi
      stub_rc plan ;;
    scripts/ingest/run.mjs)
      local id=''
      while [ "$#" -gt 0 ]; do
        if [ "$1" = --adapter ]; then id="$2"; fi
        shift
      done
      echo "cursor $id none (state:latest none)"
      stub_rc "run.$id" ;;
    scripts/state/advance.mjs)
      if [ -f "$STUB/advance.txt" ]; then cat "$STUB/advance.txt"; fi
      stub_rc advance ;;
    scripts/state/hours.mjs) stub_rc hours ;;
    scripts/state/move.mjs) stub_rc move ;;
    scripts/ingest/chain.mjs)
      if [ "$1" = start ]; then
        if [ -f "$STUB/chain.start.rc" ]; then
          stub_rc chain.start
          return
        fi
        if gh workflow run ingest-live.yml --ref main --repo "$GITHUB_REPOSITORY"; then
          echo "chain started: the successor is dispatched (try 1)"
          return 0
        fi
        echo "chain broken: the successor was not dispatched in 3 tries; the cron backstop restarts the chain"
        return 1
      fi
      echo "sleep 300 s to 2026-10-30T09:00:00Z"
      sleep 300
      stub_rc chain.sleep ;;
    *) echo "stub node: no double for $script" >&2; return 99 ;;
  esac
}
set -eo pipefail
`;

// The steps by id, with the job each is in.
const STEPS = new Map();
for (const [job, j] of Object.entries(WF.jobs)) for (const s of j.steps ?? []) if (s.id) STEPS.set(s.id, { job, step: s });

// The env of the step `id` as GitHub builds it: the workflow's, the job's,
// then the step's. An expression takes the value the test gives; a test that
// gives a variable the step does not declare is refused, so no test passes on
// a value the workflow never sets (GITHUB_* and the fakes' own aside).
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

// A directory of its own for one run: stub/ for the double, runner/ as
// RUNNER_TEMP with `files` in it, and output.txt as GITHUB_OUTPUT.
function world(t, { stub = {}, files = {} }) {
  const w = mkdtempSync(join(tmpdir(), 'ingest-live-'));
  t.after(() => rmSync(w, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  mkdirSync(join(w, 'stub'));
  mkdirSync(join(w, 'runner'));
  for (const [rel, text] of Object.entries(stub)) put(join(w, 'stub', rel), text);
  for (const [rel, text] of Object.entries(files)) put(join(w, 'runner', rel), text);
  writeFileSync(join(w, 'output.txt'), '');
  return { w, base: { STUB: posix(join(w, 'stub')), RUNNER_TEMP: posix(join(w, 'runner')), GITHUB_OUTPUT: posix(join(w, 'output.txt')) } };
}

// Runs the step `id`, whose run block must hold `must`.
function step(t, id, must, { env = {}, stub = {}, files = {}, fake = {} } = {}) {
  const { w, base } = world(t, { stub, files });
  const stepEnv = envOf(id, env);
  const r = runStep(t, `${PRELUDE}${stepScript(FILE, id, must)}`, { fake, env: { ...base, ...stepEnv } });
  return { ...r, text: `${r.stdout}\n${r.stderr}`, output: kv(join(w, 'output.txt')), nodes: r.calls.filter((c) => c.startsWith('node ')), runner: join(w, 'runner') };
}

// ---- the shape -------------------------------------------------------------

test('ingest-live: the triggers are the backstop cron and a dispatch with sources, from and to, which reach steps through env alone', () => {
  assert.equal(WF.name, 'Ingest live');
  assert.deepEqual(Object.keys(WF.on), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(WF.on.schedule, [{ cron: '7,22,37,52 * * * *' }]);
  const inputs = WF.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['sources', 'from', 'to']);
  for (const [name, input] of Object.entries(inputs)) {
    assert.equal(input.type, 'string', name);
    assert.equal(input.required, false, name);
    assert.equal(input.default, '', name);
  }
  // Each input reaches the plan step through env, and no other step reads one.
  assert.deepEqual(STEPS.get('plan').step.env, { SOURCES: '${{ inputs.sources }}', FROM: '${{ inputs.from }}', TO: '${{ inputs.to }}' });
  const readers = [...STEPS].filter(([, { step }]) => JSON.stringify(step).includes('inputs.')).map(([id]) => id);
  assert.deepEqual(readers, ['plan']);
  for (const [job, j] of Object.entries(WF.jobs)) for (const s of j.steps ?? []) if (s.run) assert.doesNotMatch(s.run, /\$\{\{/, `${job}: ${s.name ?? s.uses}`);
});

test('ingest-live: permissions {} at the top, one group ingest-live with queue max and no cancel, bash, and the five jobs', () => {
  assert.deepEqual(WF.permissions, {});
  assert.deepEqual(WF.concurrency, { group: 'ingest-live', queue: 'max', 'cancel-in-progress': false });
  assert.deepEqual(WF.defaults, { run: { shell: 'bash' } });
  assert.deepEqual(WF.env, { LC_ALL: 'C' });
  assert.deepEqual(Object.keys(WF.jobs), ['plan', 'ingest', 'push', 'promote', 'chain']);
  // The policy of DOM-014 holds the file whole.
  assert.deepEqual(checkText(TEXT, '.github/workflows/ingest-live.yml'), []);
});

test("ingest-live: each job's grants, timeout, needs and if", () => {
  const { plan, ingest, push, promote, chain } = WF.jobs;
  assert.equal(plan.if, MAIN);
  assert.equal(plan.needs, undefined);
  assert.equal(plan['timeout-minutes'], 10);
  assert.deepEqual(plan.permissions, { contents: 'read' });
  assert.deepEqual(plan.outputs, {
    any: '${{ steps.plan.outputs.any }}',
    matrix: '${{ steps.plan.outputs.matrix }}',
    from: '${{ steps.plan.outputs.from }}',
    to: '${{ steps.plan.outputs.to }}',
  });

  assert.equal(ingest.needs, 'plan');
  assert.equal(ingest.if, "${{ github.ref == 'refs/heads/main' && needs.plan.outputs.any == 'true' }}");
  assert.equal(ingest['timeout-minutes'], 30);
  assert.deepEqual(ingest.permissions, { contents: 'read', packages: 'write' });
  assert.deepEqual(ingest.strategy, { 'fail-fast': false, 'max-parallel': 3, matrix: '${{ fromJSON(needs.plan.outputs.matrix) }}' });
  assert.equal(ingest.concurrency, undefined, 'the legs move no tag');

  assert.deepEqual(push.needs, ['plan', 'ingest']);
  assert.equal(push.if, "${{ !cancelled() && github.ref == 'refs/heads/main' && needs.plan.result == 'success' && needs.plan.outputs.any == 'true' }}");
  assert.equal(push['timeout-minutes'], 30);
  assert.deepEqual(push.concurrency, { group: 'root-writer', queue: 'max', 'cancel-in-progress': false });
  assert.deepEqual(push.permissions, { contents: 'read', packages: 'write' });
  assert.deepEqual(push.outputs, { add: '${{ steps.move.outputs.add }}' });

  assert.equal(promote.needs, 'push');
  assert.equal(promote.if, "${{ !cancelled() && needs.push.result == 'success' && needs.push.outputs.add != '' }}");
  assert.deepEqual(promote.permissions, { contents: 'read', packages: 'write' });
  assert.equal(promote.uses, './.github/workflows/root-promote.yml');
  // partial: an owed pack across a hole waits, owed, and the others are promoted (scripts/root/promote.mjs --partial).
  assert.deepEqual(promote.with, { add: '${{ needs.push.outputs.add }}', partial: true });
  const called = parse(readFileSync(join(ROOT, '.github', 'workflows', 'root-promote.yml'), 'utf8')).on.workflow_call.inputs;
  assert.deepEqual([called.add.type, called.partial.type], ['string', 'boolean'], 'each value is of the type the called input takes');
  assert.equal(promote.concurrency, undefined, 'root-promote.yml holds root-writer itself (ruling 18)');
  assert.equal(promote.steps, undefined);

  assert.equal(chain.needs, undefined, 'the chain starts with the run');
  assert.equal(chain.if, MAIN);
  assert.equal(chain['timeout-minutes'], 15);
  assert.deepEqual(chain.permissions, { actions: 'write', contents: 'read' });

  // issues: write waits for scripts/track-issue (DOM-034).
  for (const [id, job] of Object.entries(WF.jobs)) assert.equal(job.permissions?.issues, undefined, id);
  // The one call of root-promote.yml: the promotion of the hour packs and the segments is one call.
  assert.deepEqual(
    Object.entries(WF.jobs)
      .filter(([, j]) => j.uses)
      .map(([id]) => id),
    ['promote'],
  );
});

test('ingest-live: the steps keep their names, ids, order and timeouts, and push moves state last', () => {
  const named = (job) => WF.jobs[job].steps.map((s) => s.name ?? s.uses.split('@')[0]);
  assert.deepEqual(named('plan'), ['actions/checkout', 'actions/setup-node', 'Link the workspace packages', 'Plan the lanes']);
  assert.deepEqual(named('ingest'), ['actions/checkout', 'actions/setup-node', 'Link the workspace packages', 'Install oras', "Run the lane's adapters", 'actions/upload-artifact']);
  assert.deepEqual(named('push'), [
    'actions/checkout',
    'actions/setup-node',
    'Link the workspace packages',
    'Install oras',
    'actions/download-artifact',
    'Advance the cursors',
    'Build the closed hours',
    'Move state:latest',
  ]);
  assert.deepEqual(named('chain'), ['actions/checkout', 'actions/setup-node', 'Start the successor', 'Sleep to the next boundary']);
  const ids = Object.fromEntries([...STEPS].map(([id, { job, step }]) => [id, [job, step.name, step['timeout-minutes']]]));
  assert.deepEqual(ids, {
    plan: ['plan', 'Plan the lanes', 5],
    run: ['ingest', "Run the lane's adapters", 25],
    advance: ['push', 'Advance the cursors', 5],
    hours: ['push', 'Build the closed hours', 15],
    move: ['push', 'Move state:latest', 5],
    start: ['chain', 'Start the successor', 2],
    sleep: ['chain', 'Sleep to the next boundary', 13],
  });
  // The move runs after a failed hours step too, never after a failed advance.
  assert.equal(STEPS.get('move').step.if, "${{ !cancelled() && steps.advance.outcome == 'success' }}");
  assert.equal(STEPS.get('hours').step.if, undefined);
  // The leg's upload and the push job's download.
  const upload = WF.jobs.ingest.steps.find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, '${{ !cancelled() }}');
  assert.deepEqual(upload.with, { name: 'proposals-${{ matrix.lane }}', path: '${{ runner.temp }}/out/proposals/', overwrite: true, 'retention-days': 3, 'if-no-files-found': 'ignore' });
  const download = WF.jobs.push.steps.find((s) => String(s.uses).startsWith('actions/download-artifact@'));
  assert.deepEqual(download.with, { pattern: 'proposals-*', 'merge-multiple': true, path: '${{ runner.temp }}/proposals' });
  // The workspace links: the chain job runs no npm ci; the others import what their scripts import.
  const link = (job) => WF.jobs[job].steps.find((s) => s.name === 'Link the workspace packages')?.run ?? '';
  assert.equal(link('chain'), '');
  assert.doesNotMatch(JSON.stringify(WF.jobs.chain), /npm ci/);
  const imports = (job) => [...link(job).matchAll(/import\('(@domains\/[a-z]+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports('plan'), ['@domains/adapter']);
  assert.deepEqual(imports('ingest'), ['@domains/adapter', '@domains/compact', '@domains/ghcr', '@domains/names', '@domains/pack', '@domains/root', '@domains/state']);
  assert.deepEqual(imports('push'), [
    '@domains/adapter',
    '@domains/compact',
    '@domains/feed',
    '@domains/ghcr',
    '@domains/ledger',
    '@domains/names',
    '@domains/pack',
    '@domains/root',
    '@domains/state',
  ]);
  for (const job of ['plan', 'ingest', 'push']) assert.match(link(job), /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/, job);
});

test('ingest-live: every action is a pin of ACTION_PINS, checkout keeps no credential, and the token is in the env of the steps that push, move, dispatch or read the live state with it, and no other', () => {
  const uses = [];
  for (const [job, j] of Object.entries(WF.jobs))
    for (const s of j.steps ?? []) {
      if (!s.uses) continue;
      uses.push(s.uses);
      const [name, sha] = s.uses.split('@');
      assert.equal(ACTION_PINS[name]?.sha, sha, `${job}: ${s.uses}`);
      if (name === 'actions/checkout') assert.equal(s.with['persist-credentials'], false, job);
    }
  assert.equal(uses.filter((u) => u.startsWith('actions/checkout@')).length, 4, 'every job with steps checks out');
  const tokened = [];
  for (const [job, j] of Object.entries(WF.jobs)) for (const s of j.steps ?? []) for (const [k, v] of Object.entries(s.env ?? {})) if (v === TOKEN) tokened.push(`${job}/${s.id}/${k}`);
  assert.deepEqual(tokened, ['ingest/run/REGISTRY_TOKEN', 'push/advance/REGISTRY_TOKEN', 'push/hours/REGISTRY_TOKEN', 'push/move/REGISTRY_TOKEN', 'chain/start/GH_TOKEN']);
  assert.equal(TEXT.split('github.token').length - 1, tokened.length, 'no other reference to the token');
});

test('ingest-live: every step that runs a script reads its exit from the script, never through a pipe', () => {
  let scripts = 0;
  for (const [job, j] of Object.entries(WF.jobs))
    for (const s of j.steps ?? []) {
      if (!s.run) continue;
      for (const line of s.run.split('\n').filter((l) => /^\s*node scripts\//.test(l))) {
        scripts += 1;
        assert.match(line, /^\s*node scripts\/[a-z/]+\.mjs [^|]*\|\| rc=\$\?$/, `${job}: ${line}`);
      }
    }
  assert.equal(scripts, 7, 'plan, run, advance, hours, move, start and sleep');
});

// ---- the plan step ---------------------------------------------------------

const PLAN_MUST = /node scripts\/ingest\/plan\.mjs "\$\{args\[@\]\}" \|\| rc=\$\?/;
const planFile = (lanes, { any = Object.values(lanes).some((l) => l.length > 0), from = null, to = null } = {}) => `${JSON.stringify({ format: 'domains.ingest-plan.v1', lanes, any, from, to })}\n`;
const plan = (t, { sources = '', from = '', to = '', file, rc } = {}) =>
  step(t, 'plan', PLAN_MUST, {
    env: { SOURCES: sources, FROM: from, TO: to },
    stub: { ...(file === undefined ? {} : { 'plan.json': file }), ...(rc === undefined ? {} : { 'plan.rc': String(rc) }) },
  });

test("ingest-live: 'Plan the lanes' writes any, matrix, from and to from the plan file, one leg a lane that holds an adapter", { skip: SKIP }, (t) => {
  const r = plan(t, { file: planFile({ kafka: ['oi-cs'], tiles: [], feeds: ['cenk-nrd', 'isc-new'] }) });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.output.any, 'true');
  assert.deepEqual(JSON.parse(r.output.matrix), {
    include: [
      { lane: 'kafka', adapters: ['oi-cs'] },
      { lane: 'feeds', adapters: ['cenk-nrd', 'isc-new'] },
    ],
  });
  assert.equal(r.output.from, '');
  assert.equal(r.output.to, '');
  assert.equal(r.nodes.length, 1);
  assert.match(r.nodes[0], /^node scripts\/ingest\/plan\.mjs --out \S+\/runner\/plan\.json$/, 'no --only, --from or --to when no input is given');
});

test("ingest-live: 'Plan the lanes' passes --only, --from and --to only when each is given, each as one argument", { skip: SKIP }, (t) => {
  const window = plan(t, {
    sources: 'oi-cs isc-new',
    from: '2026-10-30T00:00:00Z',
    to: '2026-10-30T01:00:00Z',
    file: planFile({ kafka: ['oi-cs'], tiles: [], feeds: ['isc-new'] }, { from: '2026-10-30T00:00:00Z', to: '2026-10-30T01:00:00Z' }),
  });
  assert.equal(window.status, 0, window.text);
  assert.match(window.nodes[0], / --only oi-cs\\ isc-new --from 2026-10-30T00:00:00Z --to 2026-10-30T01:00:00Z$/);
  assert.equal(window.output.from, '2026-10-30T00:00:00Z');
  assert.equal(window.output.to, '2026-10-30T01:00:00Z');
  const only = plan(t, { sources: 'oi-cs', file: planFile({ kafka: ['oi-cs'], tiles: [], feeds: [] }) });
  assert.match(only.nodes[0], / --only oi-cs$/);
  // One end of a window is passed as given: plan.mjs refuses it (exit 2), and the step keeps that exit.
  const half = plan(t, { sources: 'oi-cs', from: '2026-10-30T00:00:00Z', rc: 2 });
  assert.match(half.nodes[0], / --only oi-cs --from 2026-10-30T00:00:00Z$/);
  assert.equal(half.status, 2);
});

test("ingest-live: 'Plan the lanes' with no adapter in any lane writes any=false and an empty matrix, and stays green", { skip: SKIP }, (t) => {
  const r = plan(t, { file: planFile({ kafka: [], tiles: [], feeds: [] }) });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.output.any, 'false');
  assert.deepEqual(JSON.parse(r.output.matrix), { include: [] });
  assert.match(r.text, /no lane holds an adapter: nothing is ingested, and state is not moved/);
});

test("ingest-live: 'Plan the lanes' keeps plan.mjs's exit, and refuses a plan whose any and lanes disagree or whose window is not two instants", { skip: SKIP }, (t) => {
  for (const rc of [2, 70]) {
    const r = plan(t, { rc });
    assert.equal(r.status, rc, r.text);
    assert.match(r.text, new RegExp(`::error::scripts/ingest/plan\\.mjs exited ${rc} `));
    assert.deepEqual(r.output, {}, 'no output');
  }
  const lies = plan(t, { file: planFile({ kafka: [], tiles: [], feeds: [] }, { any: true }) });
  assert.equal(lies.status, 1, lies.text);
  assert.match(lies.text, /the plan says any=true and names 0 lane\(s\) with adapters/);
  const hides = plan(t, { file: planFile({ kafka: ['oi-cs'], tiles: [], feeds: [] }, { any: false }) });
  assert.equal(hides.status, 1, hides.text);
  const other = plan(t, { file: `${JSON.stringify({ format: 'domains.ingest-plan.v2', lanes: {}, any: false })}\n` });
  assert.equal(other.status, 1, other.text);
  assert.match(other.text, /is not a plan file of the format domains\.ingest-plan\.v1/);
  const injected = plan(t, { file: planFile({ kafka: ['oi-cs'], tiles: [], feeds: [] }, { from: '2026-10-30T00:00:00Z\nany=false', to: '2026-10-30T01:00:00Z' }) });
  assert.equal(injected.status, 1, injected.text);
  assert.deepEqual(injected.output, {}, 'no line reaches GITHUB_OUTPUT');
});

// ---- the leg ---------------------------------------------------------------

const RUN_MUST = /node scripts\/ingest\/run\.mjs --adapter "\$id" --lane "\$LANE" --out "\$RUNNER_TEMP\/out" --psl root "\$\{window\[@\]\}" \|\| rc=\$\?/;
// ADAPTERS as GitHub's toJSON writes it: indented over several lines.
const runLane = (t, adapters, { lane = 'kafka', from = '', to = '', rcs = {} } = {}) =>
  step(t, 'run', RUN_MUST, {
    env: { REGISTRY_TOKEN: 'placeholder', LANE: lane, ADAPTERS: typeof adapters === 'string' ? adapters : JSON.stringify(adapters, null, 2), FROM: from, TO: to },
    stub: Object.fromEntries(Object.entries(rcs).map(([id, rc]) => [`run.${id}.rc`, String(rc)])),
  });

test("ingest-live: 'Run the lane's adapters' runs each adapter of the lane in order with the lane, --out and --psl root", { skip: SKIP }, (t) => {
  const r = runLane(t, ['oi-cs', 'oi-nrd']);
  assert.equal(r.status, 0, r.text);
  assert.equal(r.nodes.length, 2);
  for (const [i, id] of ['oi-cs', 'oi-nrd'].entries()) assert.match(r.nodes[i], new RegExp(`^node scripts/ingest/run\\.mjs --adapter ${id} --lane kafka --out \\S+/runner/out --psl root$`));
  assert.match(r.text, /2 adapter\(s\) of the lane kafka ran/);
  const w = runLane(t, ['oi-cs'], { from: '2026-10-30T00:00:00Z', to: '2026-10-30T01:00:00Z' });
  assert.equal(w.status, 0, w.text);
  assert.match(w.nodes[0], / --psl root --from 2026-10-30T00:00:00Z --to 2026-10-30T01:00:00Z$/);
});

test("ingest-live: 'Run the lane's adapters' goes on past a failing adapter, names it and exits 1", { skip: SKIP }, (t) => {
  const r = runLane(t, ['a-one', 'b-two', 'c-three', 'd-four'], { lane: 'feeds', rcs: { 'b-two': 1, 'c-three': 4 } });
  assert.equal(r.status, 1, r.text);
  assert.deepEqual(
    r.nodes.map((c) => c.split(' ')[3]),
    ['a-one', 'b-two', 'c-three', 'd-four'],
    'every adapter of the lane ran',
  );
  assert.match(r.text, /::error::scripts\/ingest\/run\.mjs exited 1 for the adapter b-two /);
  assert.match(r.text, /::error::scripts\/ingest\/run\.mjs exited 4 for the adapter c-three /);
  assert.match(r.text, /2 of 4 adapter\(s\) of the lane feeds failed: b-two c-three/);
  for (const rc of [2, 70]) {
    const one = runLane(t, ['a-one'], { rcs: { 'a-one': rc } });
    assert.equal(one.status, 1, `a leg is red on exit ${rc}`);
  }
});

test("ingest-live: 'Run the lane's adapters' refuses an adapter list off the id grammar, a lane that is not one of the three, and half a window, before any adapter runs", { skip: SKIP }, (t) => {
  for (const adapters of [['oi-cs', 'Bad_Id'], ['../x'], ['-x'], ['a--b'], [`a${'b'.repeat(63)}`], [], '"oi-cs"', '[1]', 'not json']) {
    const r = runLane(t, adapters);
    assert.equal(r.status, 1, `${JSON.stringify(adapters)}\n${r.text}`);
    assert.match(r.text, /are not a list of ids/);
    assert.deepEqual(r.nodes, [], JSON.stringify(adapters));
  }
  // 63 characters is the longest id (MAX_ID of packages/adapter).
  assert.equal(runLane(t, [`a${'b'.repeat(62)}`]).status, 0);
  const lane = runLane(t, ['oi-cs'], { lane: 'zones' });
  assert.equal(lane.status, 1);
  assert.match(lane.text, /the lane is not kafka, tiles or feeds/);
  assert.deepEqual(lane.nodes, []);
  const half = runLane(t, ['oi-cs'], { from: '2026-10-30T00:00:00Z' });
  assert.equal(half.status, 1);
  assert.match(half.text, /one end of the backfill window/);
  assert.deepEqual(half.nodes, []);
});

// ---- the job push ----------------------------------------------------------

const ADVANCE_MUST = /node scripts\/state\/advance\.mjs --proposals "\$RUNNER_TEMP\/proposals" --out "\$RUNNER_TEMP\/state" > "\$RUNNER_TEMP\/advance\.txt" \|\| rc=\$\?/;
const advance = (t, lines, rc = 0) => step(t, 'advance', ADVANCE_MUST, { env: { REGISTRY_TOKEN: 'placeholder' }, stub: { 'advance.txt': lines, ...(rc === 0 ? {} : { 'advance.rc': String(rc) }) } });

test("ingest-live: 'Advance the cursors' prints advance.mjs's lines and turns each dropped line into a warning", { skip: SKIP }, (t) => {
  const r = advance(
    t,
    [
      'live state:latest none',
      'settled obs:a.20261030t080000z.20261030t081000z held the live root names it',
      'accepted oi-cs segments 2 raw 1 history 0 cursor moved',
      'dropped isc-new stale-before the proposal read {"last_day":"2026-10-28"} and the live cursor is {"last_day":"2026-10-29"}',
      'dropped - invalid proposal.x.json does not parse',
      'next changed owed 2',
      '',
    ].join('\n'),
  );
  assert.equal(r.status, 0, r.text);
  assert.match(r.nodes[0], /^node scripts\/state\/advance\.mjs --proposals \S+\/runner\/proposals --out \S+\/runner\/state$/);
  const warnings = r.text.split('\n').filter((l) => l.startsWith('::warning::'));
  assert.equal(warnings.length, 2, r.text);
  assert.match(warnings[0], /^::warning::dropped isc-new stale-before .*; the adapter is read again from its live cursor next run$/);
  assert.match(warnings[1], /^::warning::dropped - invalid /);
  assert.match(r.text, /^accepted oi-cs segments 2 raw 1 history 0 cursor moved$/m);
  for (const rc of [1, 2, 4, 70]) {
    const f = advance(t, 'dropped oi-cs digest the tag holds another digest\n', rc);
    assert.equal(f.status, rc, f.text);
    assert.match(f.text, new RegExp(`::error::scripts/state/advance\\.mjs exited ${rc} .*state is not moved`));
    assert.match(f.text, /::warning::dropped oi-cs digest/, 'the warnings come first');
  }
});

const HOURS_MUST = /node scripts\/state\/hours\.mjs --next "\$RUNNER_TEMP\/state\/next\.json" --out "\$RUNNER_TEMP\/hours" \|\| rc=\$\?/;
const hours = (t, rc) => step(t, 'hours', HOURS_MUST, { env: { REGISTRY_TOKEN: 'placeholder' }, stub: rc === 0 ? {} : { 'hours.rc': String(rc) } });

test("ingest-live: 'Build the closed hours' is green on 0 and on 3, an hour that waits, and red on every other exit", { skip: SKIP }, (t) => {
  const built = hours(t, 0);
  assert.equal(built.status, 0, built.text);
  assert.match(built.nodes[0], /^node scripts\/state\/hours\.mjs --next \S+\/runner\/state\/next\.json --out \S+\/runner\/hours$/);
  const waits = hours(t, 3);
  assert.equal(waits.status, 0, waits.text);
  assert.match(waits.text, /an hour waits \(scripts\/state\/hours\.mjs exited 3\)/);
  assert.doesNotMatch(waits.text, /::error::/);
  for (const rc of [1, 2, 4, 70]) {
    const r = hours(t, rc);
    assert.equal(r.status, rc, r.text);
    assert.match(r.text, new RegExp(`::error::scripts/state/hours\\.mjs exited ${rc} `));
  }
});

const MOVE_MUST = /node scripts\/state\/move\.mjs state --file "\$next" --expect "\$expect" \|\| rc=\$\?/;
const owedItem = (ref) => ({
  ref,
  digest: `sha256:${hex('c')}`,
  dataset: ref.startsWith('feed:') ? 'feed' : 'domains',
  tier: ref.startsWith('feed:') ? 'h' : 'seg',
  start: '2026-10-30T08:00:00Z',
  end: '2026-10-30T09:00:00Z',
  since: '2026-10-30T09:07:12Z',
});
const nextJson = (refs) => `${JSON.stringify({ format: 'domains.state.v1', updated: '2026-10-30T09:07:12Z', cursors: {}, moved: {}, history: {}, owed: refs.map(owedItem) })}\n`;
const advanceJson = (live) => `${JSON.stringify({ format: 'domains.advance.v1', live, changed: true, accepted: [], dropped: [], settled: [] })}\n`;
const move = (t, { live = `sha256:${hex('a')}`, refs = [], rc = 0, files } = {}) =>
  step(t, 'move', MOVE_MUST, {
    env: { REGISTRY_TOKEN: 'placeholder' },
    stub: rc === 0 ? {} : { 'move.rc': String(rc) },
    files: files ?? { 'state/advance.json': advanceJson(live), 'state/next.json': nextJson(refs) },
  });
const SEG = 'obs:oi-cs.20261030t080000z.20261030t081000z-d';
const HOUR = 'feed:feed-h-2026103008';

test("ingest-live: 'Move state:latest' moves under the digest advance.mjs read, and writes add from the owed refs of next.json", { skip: SKIP }, (t) => {
  const r = move(t, { refs: [SEG, HOUR] });
  assert.equal(r.status, 0, r.text);
  assert.match(r.nodes[0], new RegExp(`^node scripts/state/move\\.mjs state --file \\S+/runner/state/next\\.json --expect sha256:${hex('a')}$`));
  assert.equal(r.output.add, `${SEG} ${HOUR}`);
  assert.match(r.text, /state owes 2 pack\(s\) to the root/);
  const first = move(t, { live: null, refs: [SEG] });
  assert.equal(first.status, 0, first.text);
  assert.match(first.nodes[0], / --expect none$/, 'no live state: the first state');
  const none = move(t, {});
  assert.equal(none.status, 0, none.text);
  assert.equal(none.output.add, '', 'nothing owed: promote is skipped');
  assert.match(none.text, /state owes no pack: nothing to promote/);
});

test("ingest-live: 'Move state:latest' warns on a refusal (1), keeps every exit, and writes no add when it did not move", { skip: SKIP }, (t) => {
  const refused = move(t, { refs: [SEG], rc: 1 });
  assert.equal(refused.status, 1, refused.text);
  assert.match(
    refused.text,
    /::warning::state:latest was not moved: another writer moved it since this run read it, or the move failed \(scripts\/state\/move\.mjs exited 1\); the live state is kept/,
  );
  assert.equal(refused.output.add, undefined);
  for (const rc of [2, 4, 70]) {
    const r = move(t, { refs: [SEG], rc });
    assert.equal(r.status, rc, r.text);
    assert.match(r.text, new RegExp(`::error::scripts/state/move\\.mjs exited ${rc} moving state:latest`));
    assert.doesNotMatch(r.text, /::warning::/, `exit ${rc} is no refusal`);
    assert.equal(r.output.add, undefined);
  }
});

test("ingest-live: 'Move state:latest' refuses missing or foreign files and an owed ref that is not obs:TAG or feed:TAG", { skip: SKIP }, (t) => {
  const missing = move(t, { files: { 'state/next.json': nextJson([]) } });
  assert.equal(missing.status, 1, missing.text);
  assert.match(missing.text, /wrote no advance\.json or no next\.json/);
  assert.deepEqual(missing.nodes, []);
  const format = move(t, { files: { 'state/advance.json': advanceJson(null).replace('advance.v1', 'advance.v9'), 'state/next.json': nextJson([]) } });
  assert.equal(format.status, 1, format.text);
  assert.deepEqual(format.nodes, []);
  const live = move(t, { live: 'latest' });
  assert.equal(live.status, 1, live.text);
  assert.match(live.text, /names a live state that is not none or a sha256 digest/);
  assert.deepEqual(live.nodes, []);
  for (const ref of ['root:latest', 'obs:Upper', 'obs:a b', 'names:names-d-20261026']) {
    const r = move(t, { refs: [SEG, ref] });
    assert.equal(r.status, 1, `${ref}\n${r.text}`);
    assert.match(r.text, /which is not obs:TAG or feed:TAG/);
    assert.equal(r.output.add, undefined, ref);
  }
  const noList = move(t, { files: { 'state/advance.json': advanceJson(null), 'state/next.json': '{"format":"domains.state.v1","owed":{"ref":1}}\n' } });
  assert.equal(noList.status, 1, noList.text);
  assert.equal(noList.output.add, undefined);
});

// ---- the chain -------------------------------------------------------------

const START_MUST = /node scripts\/ingest\/chain\.mjs start \|\| rc=\$\?/;
const SLEEP_MUST = /node scripts\/ingest\/chain\.mjs sleep \|\| rc=\$\?/;

// The job chain as GitHub runs it: each step in its own shell, in order, and
// the job ends at the first step that fails. `planted` is put after `after`.
function chainJob(t, { planted = null, after = 'start', fake = {}, stub = {} } = {}) {
  const { base } = world(t, { stub });
  const steps = WF.jobs.chain.steps.filter((s) => s.run).map((s) => [s.id, stepScript(FILE, s.id, s.id === 'start' ? START_MUST : SLEEP_MUST)]);
  const parts = [];
  for (const [id, script] of steps) {
    parts.push(`(\n${script}\n)`);
    if (planted && id === after) parts.push(`(\n${planted}\n)`);
  }
  const env = { ...base, ...envOf('start', { GH_TOKEN: 'placeholder' }) };
  const r = runStep(t, `${PRELUDE}${parts.join('\n')}\n`, { fake, env });
  return { ...r, text: `${r.stdout}\n${r.stderr}` };
}
const DISPATCH = `workflow run ingest-live.yml --ref main --repo ${REPO}`;
const PLANTED = 'echo "planted failure" >> "$FAKE_LOG"\nexit 1';

test("ingest-live: chain: 'Start the successor' is the first step of its job that runs a script, and it alone holds the token that dispatches", () => {
  const steps = WF.jobs.chain.steps;
  const first = steps.findIndex((s) => typeof s.run === 'string');
  assert.equal(steps[first].id, 'start');
  for (const s of steps.slice(0, first)) assert.match(String(s.uses), /^actions\/(?:checkout|setup-node)@/, 'only the checkout and node come before it');
  assert.deepEqual(steps[first].env, { GH_TOKEN: TOKEN });
  assert.equal(steps.find((s) => s.id === 'sleep').env, undefined);
  assert.deepEqual(
    steps.filter((s) => s.run).map((s) => s.id),
    ['start', 'sleep'],
  );
});

test('ingest-live: chain: with a planted failing step after the start, the dispatch is in the log before the failure and the job ends failed', { skip: SKIP }, (t) => {
  const r = chainJob(t, { planted: PLANTED });
  assert.notEqual(r.status, 0, r.text);
  assert.deepEqual(r.calls, ['node scripts/ingest/chain.mjs start', DISPATCH, 'planted failure']);
  assert.match(r.text, /chain started: the successor is dispatched/);
  // Without the plant the job dispatches, then sleeps to the boundary.
  const clean = chainJob(t);
  assert.equal(clean.status, 0, clean.text);
  assert.deepEqual(clean.calls, ['node scripts/ingest/chain.mjs start', DISPATCH, 'node scripts/ingest/chain.mjs sleep', 'sleep 300']);
});

test('ingest-live: chain: a dispatch that fails fails the job before its sleep, and every exit of chain.mjs is kept', { skip: SKIP }, (t) => {
  const broken = chainJob(t, { fake: { dispatch: 'fail' } });
  assert.equal(broken.status, 1, broken.text);
  assert.deepEqual(broken.calls, ['node scripts/ingest/chain.mjs start', DISPATCH]);
  assert.match(broken.text, /::error::scripts\/ingest\/chain\.mjs start exited 1 \(1 the successor was not dispatched in 3 tries/);
  for (const rc of [2, 70]) {
    const r = chainJob(t, { stub: { 'chain.start.rc': String(rc) } });
    assert.equal(r.status, rc, r.text);
    assert.match(r.text, new RegExp(`::error::scripts/ingest/chain\\.mjs start exited ${rc} `));
    const s = chainJob(t, { stub: { 'chain.sleep.rc': String(rc) } });
    assert.equal(s.status, rc, s.text);
    assert.match(s.text, new RegExp(`::error::scripts/ingest/chain\\.mjs sleep exited ${rc} `));
  }
});
