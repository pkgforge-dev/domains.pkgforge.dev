// The shell of the four compaction workflows (DOM-023, docs/architecture.md
// section 5.3): each step below is read out of its .github/workflows/ file
// and run under bash as GitHub runs it (`bash --noprofile --norc -eo pipefail`),
// with RUNNER_TEMP, GITHUB_OUTPUT and GITHUB_ENV in a temporary directory.
// `node` and `oras` are bash functions, so no script runs and nothing reads
// GHCR: each answers from files the test writes (show.mjs's lines, each
// plan.mjs plan and exit code, tags.mjs's tags) and logs its call. jq is the
// real one. Each guard of a step is planted alone: an exit code of a script,
// a verdict, the MAX_LEGS bound, a unit held for its PSL lists, the live
// ledger's read, the package of each replaced pack, the ledger filter's wait
// on its day's domains pack, and the checks that verify-pack must compare.
// The replacement step reads a plan file that planTier and planFile of
// packages/compact write, so its jq reads the fields a real plan holds.
// The job conditions, which no bash run reaches, are held by name at the end
// (rule 3 of scripts/check-workflows.mjs holds the main-only condition of a
// job that writes GHCR). Where bash or jq is not on the PATH the tests are
// skipped and say so, and a skip is not a pass.
//
//   node scripts/test.mjs scripts/compact --name "workflow shell"
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { planFile, planTier } from '@domains/compact';
import { parse } from 'yaml';
import { pack } from '../../packages/root/test/helpers.ts';
import { ROOT } from '../files.mjs';

const WORKFLOWS = join(ROOT, '.github', 'workflows');
const TIERS = ['compact-weekly.yml', 'compact-monthly.yml', 'compact-yearly.yml'];
const ALL = ['compact-daily.yml', ...TIERS];
const MAIN = "github.ref == 'refs/heads/main'";

const hasTools = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
const opts = { skip: hasTools ? false : 'bash or jq is not on the PATH, so the steps were not run' };

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const workflow = (file) => parse(readFileSync(join(WORKFLOWS, file), 'utf8'));

// The doubles. A native jq on Windows writes CRLF unless given -b, and the
// steps compare its output as text; -b changes nothing elsewhere.
const PRELUDE = `
export RUNNER_TEMP="$PWD/runner" GITHUB_OUTPUT="$PWD/output.txt" GITHUB_ENV="$PWD/env.txt" STUB="$PWD/stub" GITHUB_RUN_ID=40000000001
mkdir -p "$RUNNER_TEMP" "$STUB"
: > "$GITHUB_OUTPUT"; : > "$GITHUB_ENV"; : > "$STUB/calls.log"
${process.platform === 'win32' ? 'jq() { command jq -b "$@"; }' : ''}
stub_rc() { if [ -f "$1" ]; then return "$(cat "$1")"; fi; return 0; }
node() {
  printf 'node %s\\n' "$*" >> "$STUB/calls.log"
  local script="$1"; shift
  case "$script" in
    scripts/root/show.mjs) cat "$STUB/show.txt"; stub_rc "$STUB/show.rc" ;;
    scripts/compact/plan.mjs)
      local dataset='' span='' out=''
      while [ "$#" -gt 0 ]; do
        case "$1" in --dataset) dataset="$2"; shift 2 ;; --span) span="$2"; shift 2 ;; --out) out="$2"; shift 2 ;; *) shift ;; esac
      done
      local f="$STUB/plan/$dataset.\${span:0:10}"
      if [ ! -f "$f.json" ]; then
        printf '{"verdict":"wait","dataset":"%s","psl":[],"inputs":[],"excluded":[]}\\n' "$dataset" > "$out"
        echo "verdict wait $dataset $span"
        return 3
      fi
      cp "$f.json" "$out"
      echo "verdict $(jq -r .verdict "$f.json") $dataset $span"
      stub_rc "$f.rc" ;;
    scripts/ghcr/tags.mjs) if [ -f "$STUB/tags.txt" ]; then cat "$STUB/tags.txt"; fi; stub_rc "$STUB/tags.rc" ;;
    scripts/compact/assemble.mjs) cat "$STUB/assemble.txt"; stub_rc "$STUB/assemble.rc" ;;
    scripts/verify-pack.mjs) stub_rc "$STUB/verify.rc" ;;
    scripts/ghcr/push.mjs) stub_rc "$STUB/push.rc" ;;
    *) echo "stub node: no double for $script" >&2; return 99 ;;
  esac
}
oras() {
  printf 'oras %s\\n' "$*" >> "$STUB/calls.log"
  if [ "$1" = pull ] && [ -f "$STUB/psl.dat" ]; then mkdir -p "$4"; cp "$STUB/psl.dat" "$4/public_suffix_list.dat"; fi
}
`;

const EXPR = /\$\{\{[\s\S]*?\}\}/;

// The env of a step as GitHub builds it: the workflow's, the job's, then the
// step's. An expression takes the value the test gives it, and a variable an
// earlier step wrote to GITHUB_ENV comes from `given` too.
function envOf(wf, job, step, given) {
  const env = {};
  for (const [k, v] of Object.entries({ ...wf.env, ...job.env, ...step.env })) {
    if (Object.hasOwn(given, k)) env[k] = String(given[k]);
    else if (typeof v === 'string' && EXPR.test(v)) throw new Error(`${k} is the expression ${v}, and the test gives it no value`);
    else env[k] = String(v);
  }
  for (const [k, v] of Object.entries(given)) env[k] = String(v);
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

// At most this many bash processes at once: a test starts its cases side by
// side, since a bash process on Windows starts slowly.
const BASH_AT_ONCE = Math.max(2, Math.min(8, availableParallelism()));
let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= BASH_AT_ONCE) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function bash(dir, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'step.sh'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// Runs the step `name` of job `jobId` of `file`. `stub` and `files` map paths,
// under stub/ and under the working directory, to their contents.
async function runStep(file, jobId, name, { env = {}, stub = {}, files = {} } = {}) {
  const wf = workflow(file);
  const job = wf.jobs[jobId];
  assert.ok(job, `${file} has no job ${jobId}`);
  const step = job.steps.find((s) => s.name === name);
  assert.ok(step, `${file} job ${jobId} has no step "${name}"`);
  const dir = mkdtempSync(join(tmpdir(), 'domains-wf-'));
  dirs.push(dir);
  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  for (const [rel, text] of Object.entries(stub)) put(join(dir, 'stub', rel), text);
  for (const [rel, text] of Object.entries(files)) put(join(dir, rel), text);
  put(join(dir, 'step.sh'), `${PRELUDE}\n${step.run}`);
  const r = await slot(() => bash(dir, { ...process.env, ...envOf(wf, job, step, env) }));
  const calls = readFileSync(join(dir, 'stub', 'calls.log'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const plans = join(dir, 'runner', 'plan', 'plans');
  return {
    status: r.status,
    text: `${r.stdout}\n${r.stderr}`,
    output: kv(join(dir, 'output.txt')),
    env: kv(join(dir, 'env.txt')),
    calls,
    plans: existsSync(plans) ? readdirSync(plans).sort() : [],
    dir,
  };
}

const hex = (c) => c.repeat(64);
const PIN = hex('b');
const showTxt = ({ digest = `sha256:${hex('a')}`, psl = PIN } = {}) =>
  [`root root:latest ${digest}`, 'format domains.root.v1', 'root_seq 3', ...(psl === null ? [] : [`psl ${psl}`, `psl_live ${psl}`]), 'datasets none: no live pack', ''].join('\n');
const NS = 'pkgforge-dev/domains.pkgforge.dev';
const entry = (repo, tag) => ({ repo: `${NS}/${repo}`, tag });
// The fields of a plan file that the steps read (packages/compact, planFile).
const planJson = (dataset, tag, start, { verdict = 'ready', ranges = 1, psl = [PIN], inputs = [], excluded = [], sources = ['ct-live', 'thc-ct'] } = {}) =>
  `${JSON.stringify({ verdict, dataset, tag, span: { start, end: start }, key: verdict === 'ready' ? { ranges } : null, psl, inputs, excluded, sources })}\n`;
const unitsOf = (r) => JSON.parse(r.output.units).include;

// The plan step of `file` for the one unit `span` (the dispatched form), with
// `plans` keyed by dataset: { json, rc }. A dataset with no entry waits.
function plan(file, span, plans = {}, show = {}) {
  const stub = { 'show.txt': showTxt(show), ...(show.rc === undefined ? {} : { 'show.rc': String(show.rc) }) };
  for (const [dataset, p] of Object.entries(plans)) {
    stub[`plan/${dataset}.${span}.json`] = p.json;
    if (p.rc !== undefined) stub[`plan/${dataset}.${span}.rc`] = String(p.rc);
  }
  return runStep(file, 'plan', 'Plan the units', { env: { SPAN: span }, stub });
}

const MONDAY = '2026-10-05';
const W = `${MONDAY}T00:00:00Z`;
const DAY = '2026-10-26';
const D = `${DAY}T00:00:00Z`;
const SPANS = { 'compact-weekly.yml': MONDAY, 'compact-monthly.yml': '2026-10-01', 'compact-yearly.yml': '2026-01-01', 'compact-daily.yml': DAY };
const TAGS = { 'compact-weekly.yml': 'w-2026w41', 'compact-monthly.yml': 'm-202610', 'compact-yearly.yml': 'y-2026', 'compact-daily.yml': 'd-20261026' };

// Each case of a test runs side by side; the assertions read the results in order.
const each = (list, fn) => Promise.all(list.map(fn));

test('workflow shell: in every tier a unit that waits (exit 3) is left, and the run stays green with nothing to compact', opts, async () => {
  const runs = await each(ALL, (file) => plan(file, SPANS[file]));
  for (const [i, r] of runs.entries()) {
    assert.equal(r.status, 0, `${ALL[i]}\n${r.text}`);
    assert.match(r.text, /nothing to compact: no unit is ready/);
    assert.equal(r.output.ready, 'false', ALL[i]);
    assert.equal(r.output.psl, PIN, `${ALL[i]}: the pinned PSL goes to the assemble job`);
  }
});

test('workflow shell: each other exit of plan.mjs stops the run before any matrix, a ready unit beside it too', opts, async () => {
  // Every exit in the daily and the weekly; the monthly and the yearly run the weekly's text.
  const cases = ALL.flatMap((file) => (file === 'compact-daily.yml' || file === 'compact-weekly.yml' ? [1, 2, 4, 70] : [1, 70]).map((rc) => [file, rc]));
  const runs = await each(cases, ([file, rc]) => {
    const s = `${SPANS[file]}T00:00:00Z`;
    return plan(file, SPANS[file], { names: { json: planJson('names', `names-${TAGS[file]}`, s) }, domains: { json: planJson('domains', 'x', s), rc } });
  });
  for (const [i, r] of runs.entries()) {
    const [file, rc] = cases[i];
    assert.equal(r.status, 1, `${file} rc ${rc}\n${r.text}`);
    assert.match(r.text, new RegExp(`plan\\.mjs exited ${rc} for domains`));
    assert.match(r.text, /1 unit\(s\) could not be planned; nothing is compacted in this run/);
    assert.equal(r.output.ready, undefined, `${file} rc ${rc}: no matrix`);
  }
});

test("workflow shell: show.mjs's own exit stops the run, and a root read with no digest or no pinned PSL is a fault", opts, async () => {
  // Every exit in the daily and the weekly; the monthly and the yearly run the weekly's text.
  const shows = (file) => [...(file === 'compact-daily.yml' || file === 'compact-weekly.yml' ? [{ rc: 1 }, { rc: 2 }, { rc: 70 }] : []), { rc: 4 }, { digest: 'none' }, { psl: null }];
  const cases = ALL.flatMap((file) => shows(file).map((show) => [file, show]));
  const runs = await each(cases, ([file, show]) => plan(file, SPANS[file], {}, show));
  for (const [i, r] of runs.entries()) {
    const [file, show] = cases[i];
    if (show.rc !== undefined) assert.equal(r.status, show.rc, `${file} show rc ${show.rc}`);
    else {
      assert.equal(r.status, 1, `${file}\n${r.text}`);
      assert.match(r.text, show.psl === null ? /root:latest read with no pinned PSL hash/ : /root:latest read with no digest/);
    }
    assert.ok(!r.calls.some((c) => c.includes('plan.mjs')), `${file}: nothing is planned on that root`);
  }
});

test('workflow shell: in a tier above the day only ready makes legs; present, skip and wait make none, and a tag that is not lowercase stops the run', opts, async () => {
  const runs = await each(TIERS, (file) => {
    const s = `${SPANS[file]}T00:00:00Z`;
    return Promise.all([
      plan(file, SPANS[file], {
        names: { json: planJson('names', `names-${TAGS[file]}`, s, { ranges: 2 }) },
        domains: { json: planJson('domains', `domains-${TAGS[file]}`, s, { verdict: 'present' }) },
        feed: { json: planJson('feed', `feed-${TAGS[file]}`, s, { verdict: 'skip' }) },
      }),
      plan(file, SPANS[file], { names: { json: planJson('names', 'Names-W', s) } }),
    ]);
  });
  for (const [i, [r, upper]] of runs.entries()) {
    const file = TIERS[i];
    assert.equal(r.status, 0, `${file}\n${r.text}`);
    assert.deepEqual(unitsOf(r), [{ unit: `names-${TAGS[file]}` }], file);
    assert.deepEqual(r.plans, [`names-${TAGS[file]}.json`], file);
    assert.equal(JSON.parse(r.output.legs).include.length, 2, file);
    assert.equal(r.output.counted, 'true', file);
    assert.equal(upper.status, 1, file);
    assert.match(upper.text, /names a tag that is not lowercase/);
  }
});

test('workflow shell: at most MAX_LEGS legs in a run, 256 kept and 257 deferred, in every tier', opts, async () => {
  // A unit of 200 ranges, then one of 55, 56 or 57. The plans are taken in name order.
  const run = (file, second) => {
    if (file !== 'compact-daily.yml') {
      const s = `${SPANS[file]}T00:00:00Z`;
      return plan(file, SPANS[file], {
        domains: { json: planJson('domains', `domains-${TAGS[file]}`, s, { ranges: 200 }) },
        names: { json: planJson('names', `names-${TAGS[file]}`, s, { ranges: second }) },
      });
    }
    // In the daily, names alone is merged: the two units are two days, the last LOOKBACK days.
    const stub = { 'show.txt': showTxt() };
    for (const [n, ranges] of [
      [2, 200],
      [1, second],
    ]) {
      const day = new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
      stub[`plan/names.${day}.json`] = planJson('names', `names-d-${day.replaceAll('-', '')}`, `${day}T00:00:00Z`, { ranges });
    }
    return runStep(file, 'plan', 'Plan the units', { env: { SPAN: '', LOOKBACK: '2' }, stub });
  };
  const cases = ALL.flatMap((file) => [55, 56, 57].map((second) => [file, second]));
  const runs = await each(cases, ([file, second]) => run(file, second));
  for (const [i, r] of runs.entries()) {
    const [file, second] = cases[i];
    const what = `${file} 200 + ${second}`;
    assert.equal(r.status, 0, `${what}\n${r.text}`);
    assert.equal(unitsOf(r).length, second === 57 ? 1 : 2, what);
    assert.equal(JSON.parse(r.output.legs).include.length, second === 57 ? 200 : 200 + second, what);
    assert.equal(/deferred .*: its 57 range\(s\) would pass 256 legs/.test(r.text), second === 57, what);
  }
});

test('workflow shell: a tier above the day holds a domains or feed unit built under two PSL lists, and keeps names and new-name for the pinned list', opts, async () => {
  const two = [hex('1'), hex('2')];
  const runs = await each(TIERS, (file) => {
    const s = `${SPANS[file]}T00:00:00Z`;
    return Promise.all([
      plan(file, SPANS[file], Object.fromEntries(['names', 'domains', 'feed', 'new-name'].map((ds) => [ds, { json: planJson(ds, `${ds}-${TAGS[file]}`, s, { psl: two }) }]))),
      plan(file, SPANS[file], { domains: { json: planJson('domains', `domains-${TAGS[file]}`, s) } }),
    ]);
  });
  for (const [i, [r, one]] of runs.entries()) {
    const file = TIERS[i];
    assert.equal(r.status, 0, `${file}\n${r.text}`);
    assert.deepEqual(unitsOf(r), [{ unit: `names-${TAGS[file]}` }, { unit: `new-name-${TAGS[file]}` }], file);
    for (const ds of ['domains', 'feed']) {
      assert.match(r.text, new RegExp(`held ${ds}-${TAGS[file]}: its inputs were built under 2 PSL lists`));
      assert.match(r.text, new RegExp(`::warning::${ds}-${TAGS[file]} is held`));
    }
    assert.match(r.text, /2 unit\(s\) held: built under more than one PSL list/);
    assert.deepEqual(unitsOf(one), [{ unit: `domains-${TAGS[file]}` }], `${file}: one list is no hold`);
  }
});

test('workflow shell: PSL_KEYED of the tier workflows is PSL_KEYED of scripts/compact/assemble.mjs', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'compact', 'assemble.mjs'), 'utf8');
  const m = src.match(/^const PSL_KEYED = \[([^\]]*)\];$/m);
  assert.ok(m, 'assemble.mjs holds const PSL_KEYED');
  const keyed = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  for (const file of TIERS) assert.deepEqual(workflow(file).env.PSL_KEYED.split(' '), keyed, file);
});

test('workflow shell: the daily makes a day leg for a ready domains unit, keeps its feed when ready or waiting, and keeps no feed beside a domains unit that waits', opts, async () => {
  const f = 'compact-daily.yml';
  const [both, present, waits] = await Promise.all([
    plan(f, DAY, { domains: { json: planJson('domains', 'domains-d-20261026', D) }, feed: { json: planJson('feed', 'feed-d-20261026', D, { verdict: 'wait' }), rc: 3 } }),
    plan(f, DAY, { domains: { json: planJson('domains', 'domains-d-20261026', D, { verdict: 'present' }) }, feed: { json: planJson('feed', 'feed-d-20261026', D) } }),
    plan(f, DAY, { feed: { json: planJson('feed', 'feed-d-20261026', D) } }),
  ]);
  assert.equal(both.status, 0, both.text);
  assert.deepEqual(unitsOf(both), [
    { unit: 'domains-d-20261026', kind: 'day', day: DAY },
    { unit: 'feed-d-20261026', kind: 'day', day: DAY },
  ]);
  assert.deepEqual(JSON.parse(both.output.days).include, [{ day: DAY }]);
  assert.equal(both.output.dayed, 'true');
  assert.equal(both.output.merged, 'false');
  assert.deepEqual(unitsOf(present), [{ unit: 'feed-d-20261026', kind: 'day', day: DAY }], 'a live domains day builds its feed');
  assert.equal(waits.output.ready, 'false', 'no feed beside a domains day that waits');
  assert.equal(waits.output.dayed, 'false');
});

test('workflow shell: the daily holds a day whose domains inputs were built under two PSL lists, with its feed, and keeps names for the pinned list', opts, async () => {
  const two = [hex('1'), hex('2')];
  const r = await plan('compact-daily.yml', DAY, {
    names: { json: planJson('names', 'names-d-20261026', D, { psl: two }) },
    domains: { json: planJson('domains', 'domains-d-20261026', D, { psl: two }) },
    feed: { json: planJson('feed', 'feed-d-20261026', D) },
  });
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(unitsOf(r), [{ unit: 'names-d-20261026', kind: 'merge', day: '' }]);
  assert.match(r.text, /held domains-d-20261026 and the feed of its day: its inputs were built under 2 PSL lists/);
  assert.match(r.text, /1 day\(s\) held: built under more than one PSL list/);
  assert.equal(r.output.dayed, 'false');
});

// The step that reads the live ledger, for DAY, with tags.mjs's lines and exit.
const ledger = (tags, rc, firstLedger = false) =>
  runStep('compact-daily.yml', 'day', 'Read the live ledger', { env: { DAY, FIRST_LEDGER: String(firstLedger) }, stub: { 'tags.txt': tags, 'tags.rc': String(rc) } });

test('workflow shell: a state that does not read with no credential fails the day leg unless the dispatch says no run has pushed it', opts, async () => {
  const [absent, first, two, defect] = await Promise.all([ledger('PRIVATE PACKAGE\n', 4), ledger('PRIVATE PACKAGE\n', 4, true), ledger('', 2), ledger('', 70)]);
  assert.equal(absent.status, 4, absent.text);
  assert.match(absent.text, /absent or private, which answer alike/);
  assert.equal(absent.env.LEDGER, undefined, 'no ledger is chosen');
  assert.equal(first.status, 0, first.text);
  assert.equal(first.env.LEDGER, '--first-ledger');
  assert.equal(two.status, 2);
  assert.equal(defect.status, 70);
});

test('workflow shell: a public state with no filter is the first ledger, one of the day or later builds none, and an older one is pulled with the delta', opts, async () => {
  const [none, same, later, live] = await Promise.all([
    ledger('', 0),
    ledger('ledger-filter-20261026\n', 0),
    ledger('ledger-filter-20261025\nledger-filter-20261027\n', 0),
    ledger('ledger-filter-20261024\nledger-filter-20261025\n', 0),
  ]);
  assert.equal(none.env.LEDGER, '--first-ledger');
  assert.equal(same.env.LEDGER, '--no-ledger');
  assert.equal(later.env.LEDGER, '--no-ledger');
  assert.equal(live.status, 0, live.text);
  assert.equal(live.env.LEDGER, 'live');
  assert.ok(
    live.calls.some((c) => /^oras pull ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/state:ledger-filter-20261025 /.test(c)),
    live.calls.join('\n'),
  );
  assert.ok(
    live.calls.some((c) => /^oras pull ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/state:ledger-delta /.test(c)),
    live.calls.join('\n'),
  );
});

// The replacement step of `file` for the plan file `text`.
const replace = (file, text) =>
  runStep(file, 'assemble', 'Write the replacement', {
    env: { UNIT: 'feed-w-2026w41', PKG: 'feed', TAG: 'feed-w-2026w41' },
    files: { 'runner/plans/feed-w-2026w41.json': text },
  });

// The plan file packages/compact writes (planTier, then planFile, as
// scripts/compact/plan.mjs does) for the feed week 2026w41 whose day
// 2026-10-06 is one quarantined segment of obs: the week replaces it and does
// not read it (ruling 23). The entries are synthetic (packages/root/test/helpers.ts).
// plan.mjs is not run: validateRoot refuses the field `quarantine` until
// DOM-029 adds it, so no root.json can carry the mark yet.
const SEG = { ...pack('feed', 'seg', '2026-10-06T00:00:00Z', { end: '2026-10-07T00:00:00Z', sources: ['oi-nrd'] }).pack, quarantine: true };
function quarantinedWeek() {
  const day = (d) => pack('feed', 'd', `2026-10-${String(d).padStart(2, '0')}T00:00:00Z`).pack;
  const live = { datasets: { feed: [day(5), SEG, day(7), day(8), day(9), day(10), day(11)] } };
  const tier = planTier(live, 'feed', 'w', W);
  assert.equal(tier.verdict, 'ready', tier.reason);
  return `${JSON.stringify(planFile({ plan: tier, root: `sha256:${hex('e')}`, key: { cuts: [], ranges: 1, bytes: [0], total: 0 }, time: null }))}\n`;
}

test('workflow shell: a replacement names each pack in its own package, a quarantined segment of obs among them, and refuses a pack with no repo', opts, async () => {
  const real = quarantinedWeek();
  assert.deepEqual(
    JSON.parse(real).excluded.map((e) => [e.repo, e.tag]),
    [[`${NS}/obs`, SEG.tag]],
  );
  const noRepo = { manifest: `sha256:${hex('c')}`, tag: 'oi-nrd.20261026.0123456789ab', reason: 'quarantined' };
  const runs = await each(ALL, (file) =>
    Promise.all([
      replace(file, real),
      replace(file, planJson('feed', 'feed-w-2026w41', W, { inputs: [entry('feed', 'feed-d-20261005')], excluded: [noRepo] })),
      replace(file, planJson('feed', 'feed-w-2026w41', W)),
    ]),
  );
  const days = [5, 7, 8, 9, 10, 11].map((d) => `feed:feed-d-202610${String(d).padStart(2, '0')}`).join(',');
  for (const [i, [r, bare, add]] of runs.entries()) {
    const file = ALL[i];
    assert.equal(r.status, 0, `${file}\n${r.text}`);
    assert.ok(r.text.split('\n').includes(`replace ${days},obs:${SEG.tag}=feed:feed-w-2026w41`), `${file}\n${r.text}`);
    assert.equal(bare.status, 1, `${file}\n${bare.text}`);
    assert.match(bare.text, /names a pack with no repo/);
    assert.ok(!existsSync(join(bare.dir, 'runner', 'replace', 'feed-w-2026w41.txt')), `${file}: no replacement is written`);
    assert.match(add.text, /^add feed:feed-w-2026w41$/m);
  }
});

test('workflow shell: assemble takes the pinned PSL for a names unit built under two lists, and only then', opts, async () => {
  const run = (file, psl, pin = PIN) => {
    const unit = `names-${TAGS[file]}`;
    return runStep(file, 'assemble', 'Assemble the pack', {
      env: { UNIT: unit, REBUILD: 'false', PIN_PSL: pin },
      stub: { 'assemble.txt': `present names:${unit} (${unit}): nothing is written\n` },
      files: { [`runner/plans/${unit}.json`]: planJson('names', unit, `${SPANS[file]}T00:00:00Z`, { psl }) },
    });
  };
  const two = [hex('1'), hex('2')];
  const runs = await each(ALL, (file) => Promise.all([run(file, two), run(file, [PIN]), run(file, two, '')]));
  const assembleCall = (r) => r.calls.find((c) => c.startsWith('node scripts/compact/assemble.mjs')) ?? '';
  for (const [i, [several, one, noPin]] of runs.entries()) {
    const file = ALL[i];
    assert.equal(several.status, 0, `${file}\n${several.text}`);
    assert.ok(assembleCall(several).includes(`--psl ${PIN}`), several.calls.join('\n'));
    assert.equal(several.env.OUTCOME, 'present');
    assert.equal(one.status, 0, `${file}\n${one.text}`);
    assert.ok(!assembleCall(one).includes('--psl'), one.calls.join('\n'));
    assert.equal(noPin.status, 1, file);
    assert.match(noPin.text, /gave no pinned PSL hash/);
  }
});

const PSL_TEXT = 'com\nnet\n';
const PSL_HASH = createHash('sha256').update(PSL_TEXT).digest('hex');
// The verify step of `file` for a pack of `dataset` with `count` records.
function verify(file, dataset, count, { psl = PSL_HASH, rc = 0 } = {}) {
  const unit = `${dataset}-${TAGS[file]}`;
  const titles = ['part.000', 'idx', ...(dataset === 'feed' ? ['time.part.000', 'time.idx', 'summary.json'] : [])];
  const manifest = {
    artifactType: 'application/vnd.pkgforge.domains.pack.v1',
    annotations: { 'dev.pkgforge.domains.psl': psl, 'dev.pkgforge.domains.count': String(count) },
    layers: titles.map((t) => ({ mediaType: 'application/octet-stream', annotations: { 'org.opencontainers.image.title': t } })),
  };
  return runStep(file, 'assemble', 'Verify the pack', {
    env: { UNIT: unit },
    stub: { 'psl.dat': PSL_TEXT, 'verify.rc': String(rc) },
    files: { 'runner/manifest.json': JSON.stringify(manifest), [`runner/plans/${unit}.json`]: planJson(dataset, unit, `${SPANS[file]}T00:00:00Z`) },
  });
}
const verifyCall = (r) => r.calls.find((c) => c.startsWith('node scripts/verify-pack.mjs'));

test('workflow shell: verify names every check to compare, time for a feed pack that holds records, under the PSL the pack names', opts, async () => {
  const base = 'dataset,length,count,sha256,psl,sources,precision';
  const runs = await each(ALL, (file) =>
    Promise.all([verify(file, 'feed', 5), verify(file, 'feed', 0), verify(file, 'names', 5), verify(file, 'names', 5, { psl: hex('d') }), verify(file, 'names', 5, { rc: 1 })]),
  );
  for (const [i, [feed, empty, names, other, failed]] of runs.entries()) {
    const file = ALL[i];
    assert.equal(feed.status, 0, `${file}\n${feed.text}`);
    assert.match(verifyCall(feed), new RegExp(`--require ${base},time `));
    assert.match(verifyCall(feed), /\/pack\/part\.000 .*\/pack\/idx .*\/pack\/time\.part\.000 .*\/pack\/time\.idx$/);
    assert.ok(!verifyCall(feed).includes('summary.json'), 'only the key and time copies are verified');
    assert.match(verifyCall(empty), new RegExp(`--require ${base} `));
    assert.match(verifyCall(names), new RegExp(`--require ${base} `));
    assert.equal(other.status, 1, file);
    assert.match(other.text, /does not hash to/);
    assert.equal(verifyCall(other), undefined, `${file}: nothing is verified under another list`);
    assert.equal(failed.status, 1, `${file}: a check that fails stops the leg`);
  }
});

// The daily push step over one day whose domains unit is `planned` this run,
// and whose leg wrote its replacement when `replaced`.
function pushFilters(planned, replaced) {
  const files = {
    [`runner/days/day.${DAY}/ledger/filter.dlbf`]: 'filter',
    [`runner/days/day.${DAY}/ledger/delta.dlbd`]: 'delta',
    [`runner/days/day.${DAY}/day.json`]: JSON.stringify({ day: DAY, ledger: { tag: 'ledger-filter-20261026' } }),
  };
  if (planned) files['runner/plans/domains-d-20261026.json'] = planJson('domains', 'domains-d-20261026', D);
  if (replaced) files['runner/replace/domains-d-20261026.txt'] = 'replace names:x=names:domains-d-20261026\n';
  return runStep('compact-daily.yml', 'push', 'Push the ledger filters', { env: { REGISTRY_TOKEN: 'none' }, files });
}
const pushed = (r) => r.calls.some((c) => c.startsWith('node scripts/ghcr/push.mjs state ledger-filter-20261026 '));

test("workflow shell: a day's ledger filter is pushed once its domains pack verified and pushed, or was live, and not when its leg failed", opts, async () => {
  const [failed, done, live] = await Promise.all([pushFilters(true, false), pushFilters(true, true), pushFilters(false, false)]);
  assert.equal(failed.status, 0, failed.text);
  assert.ok(!pushed(failed), failed.calls.join('\n'));
  assert.match(failed.text, /ledger-filter-20261026 is not pushed: the leg of domains-d-20261026 wrote no replacement/);
  assert.equal(failed.output.moves, '0');
  assert.ok(pushed(done), done.calls.join('\n'));
  assert.equal(done.output.moves, '1');
  assert.ok(pushed(live), 'a domains day live before the run');
});

test('workflow shell: gather promotes nothing when no leg wrote a replacement', opts, async () => {
  const runs = await each(ALL, (file) =>
    Promise.all([
      runStep(file, 'gather', 'Join the replacements'),
      runStep(file, 'gather', 'Join the replacements', { files: { 'runner/replace/a.txt': 'add names:a\n', 'runner/replace/b.txt': 'replace names:x,obs:y=names:b\n' } }),
    ]),
  );
  for (const [i, [none, some]] of runs.entries()) {
    const file = ALL[i];
    assert.equal(none.status, 0, `${file}\n${none.text}`);
    assert.match(none.text, /no leg wrote a replacement or an addition: nothing to promote/);
    assert.equal(none.output.add, undefined, file);
    assert.equal(some.output.add, 'names:a ', file);
    assert.equal(some.output.replace, 'names:x,obs:y=names:b ', file);
  }
});

// The conditions no bash run reaches, held by name: each is one operand a
// review deleted from a copy and saw every check pass.
const conds = (v) => String(v ?? '');
test('workflow shell: the job and step conditions keep the order plan, verify, push, promote, and the filter after assemble', () => {
  for (const file of ALL) {
    const { jobs } = workflow(file);
    assert.equal(jobs.plan.if, MAIN, `${file}: plan runs on main alone, so no job after it runs elsewhere`);
    for (const c of [MAIN, "needs.plan.result == 'success'", "needs.plan.outputs.ready == 'true'"]) assert.ok(conds(jobs.assemble.if).includes(c), `${file} assemble: ${c}`);
    const steps = Object.fromEntries(jobs.assemble.steps.filter((s) => s.name).map((s) => [s.name, s]));
    for (const name of ['Verify the pack', 'Push the pack']) assert.equal(steps[name].if, "env.OUTCOME == 'assembled'", `${file} ${name}`);
    assert.ok(jobs.promote.needs.includes('assemble'), `${file}: promote needs the job that verified`);
    assert.ok(conds(jobs.promote.if).includes("needs.gather.result == 'success'"), `${file} promote`);
    assert.equal(jobs.gather.needs, 'assemble', file);
  }
  const { push } = workflow('compact-daily.yml').jobs;
  assert.deepEqual(push.needs, ['plan', 'day', 'assemble']);
  for (const c of [MAIN, "needs.day.result == 'success'", "needs.assemble.result != 'skipped'"]) assert.ok(conds(push.if).includes(c), `push: ${c}`);
});
