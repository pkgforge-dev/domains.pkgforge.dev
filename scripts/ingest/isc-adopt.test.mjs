import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoOf } from '@domains/ghcr';
import { emptyState, parseProposal, parseState } from '@domains/state';
import { parse } from 'yaml';
import { BASH, JQ, runStep, stepScript } from '../lib/workflow-step.mjs';
import { adopt, main, parseStage, provePrefix } from './isc-adopt.mjs';

const NOW = '2026-01-20T00:00:00Z';
const STATE = `sha256:${'1'.repeat(64)}`;
const ROOT = `sha256:${'2'.repeat(64)}`;
const PSL = '3'.repeat(64);
const RUN = '4567';
const FIRST = '2026-01-01';
const SECOND = '2026-01-02';
const THIRD = '2026-01-03';
const at = (day) => `${day}T00:00:00Z`;
const after = (next) => ({ next, alias: null, watch: [], review: null, blockedHour: null });

function segment(day, n) {
  const rawSha256 = String(n).repeat(64);
  return {
    type: 'segment',
    day,
    ref: `obs:isc-new.${day.replaceAll('-', '')}.${rawSha256.slice(0, 12)}-d`,
    digest: `sha256:${rawSha256}`,
    rawSha256,
    rawBytes: n * 100,
    count: n,
    verdict: 'ok',
    url: `https://isc.sans.edu/feeds/domaindata.${day}.json.gz`,
  };
}

const first = segment(FIRST, 4);
const second = segment(SECOND, 5);
const lines = (rows = [first, second], { start = FIRST, end = THIRD, header = {}, complete = { type: 'complete', segments: rows.length } } = {}) =>
  [
    {
      type: 'stage',
      format: 'domains.isc-stage.v1',
      rootDigest: ROOT,
      stateDigest: STATE,
      domainsSince: null,
      psl: PSL,
      window: { start: at(start), end: at(end) },
      run: RUN,
      attempt: 1,
      at: NOW,
      ...header,
    },
    ...rows,
    complete,
  ]
    .map(JSON.stringify)
    .join('\n') + '\n';
const staged = (text = lines(), run = RUN, attempt = 1) => parseStage(text, { run, attempt });

function pack(s, end) {
  return {
    repo: repoOf('obs'),
    tag: s.ref.slice(4),
    tier: 'seg',
    manifest: s.digest,
    count: s.count,
    psl: PSL,
    sources: ['isc-new'],
    span: { start: at(s.day), end: at(end) },
  };
}

const packs = [pack(first, SECOND), pack(second, THIRD)];
const root = (domains = packs, other = {}) => ({ root_seq: 1, datasets: { domains }, through: { 'isc-new': at(THIRD) }, withdrawn: [], ...other });

test('adoption accepts the complete, typed, ordered stage window and binds the run attempt', () => {
  assert.deepEqual(
    staged().map((p) => [p.day, p.ref, p.digest, p.psl]),
    [first, second].map((p) => [p.day, p.ref, p.digest, PSL]),
  );
  assert.throws(() => staged(lines(), RUN, 2), /run attempt/);
  assert.throws(() => staged(lines([first], { complete: { type: 'segment' } })), /completion/);
  assert.throws(() => staged(lines([first, second], { complete: { type: 'complete', segments: 1 } })), /completion/);
  assert.throws(() => staged(lines([second, first])), /2026-01-01/);
  assert.throws(() => staged(lines([first])), /2026-01-02/);
  assert.throws(() => staged(lines([{ ...first, rawSha256: second.rawSha256 }, second])), /raw identity/);
  assert.throws(() => staged(lines([{ ...first, url: 'https://isc.sans.edu/feeds/domaindata.json.gz' }, second])), /dated URL/);
  assert.throws(() => staged(lines([{ ...first, verdict: 'quarantine' }, second])), /quarantine/);
  assert.throws(() => staged(lines([first, second], { header: { stateDigest: 'latest' } })), /anchors/);
});

test('adoption requires every day from the DPK1 epoch and refuses overlapping stage identities that disagree', () => {
  assert.throws(() => provePrefix([staged(lines([second], { start: SECOND }))], root(), SECOND), /2026-01-01 has no staged evidence/);
  const third = segment(THIRD, 6);
  assert.throws(() => provePrefix([staged(lines([first], { end: SECOND })), staged(lines([third], { start: THIRD, end: '2026-01-04' }))], root(), THIRD), /2026-01-02 has no staged evidence/);
  const conflicting = staged(lines([{ ...second, digest: first.digest }], { start: SECOND }));
  assert.throws(() => provePrefix([staged(), conflicting], root(), SECOND), /conflicting stage evidence.*2026-01-02/);
  assert.equal(provePrefix([staged(), staged()], root(), SECOND).length, 2);
});

test('adoption refuses a missing or conflicting live digest despite a source through date, gaps, and a covering day pack', () => {
  for (const days of [
    [packs[0]],
    [packs[0], { ...packs[1], manifest: first.digest }],
    [packs[0], { ...packs[1], tier: 'd' }],
    [packs[0], { ...packs[1], quarantine: true }],
    [packs[0], { ...packs[1], psl: 'f'.repeat(64) }],
    [...packs, { ...packs[1], manifest: first.digest }],
  ]) {
    assert.throws(() => provePrefix([staged()], root(days, { gaps: { 'isc-new': [SECOND] } }), SECOND), /2026-01-02.*exact live/);
  }
  assert.throws(() => provePrefix([staged()], root(packs, { withdrawn: [{ manifest: second.digest }] }), SECOND), /2026-01-02.*withdrawn/);
  assert.deepEqual(
    provePrefix([staged()], root(), SECOND).map((p) => p.day),
    [FIRST, SECOND],
  );
});

const options = (state = emptyState('2026-01-19T00:00:00Z'), extra = {}) => ({
  root: root(),
  live: { digest: STATE, state },
  expectState: STATE,
  expectCursor: null,
  stages: [staged()],
  target: SECOND,
  now: NOW,
  run: RUN,
  attempt: 1,
  ...extra,
});

test('adoption accepts one ordinary proposal only after the prefix is proved and keeps unrelated state', () => {
  const base = emptyState('2026-01-19T00:00:00Z');
  const state = { ...base, cursors: { 'oi-nrd': { offset: 123 } }, moved: { 'oi-nrd': { at: base.updated, run: RUN } }, gaps: { 'thc-ct': [SECOND] } };
  const r = adopt(options(state));
  assert.deepEqual(r.proposal.before, null);
  assert.deepEqual(r.proposal.after, after(THIRD));
  assert.equal(r.proposal.segments.length, 2);
  assert.deepEqual(
    r.state.history['isc-new'],
    [first, second].map((p) => ({ day: p.day, count: p.rawBytes, quarantined: false })),
  );
  assert.deepEqual(r.state.cursors['oi-nrd'], state.cursors['oi-nrd']);
  assert.deepEqual(r.state.gaps, state.gaps);
  assert.deepEqual(r.state.owed, []);
  assert.equal(r.state.moved['isc-new'].run, RUN);
});

test('adoption refuses stale state or exact cursor mismatches and never rewinds; a fresh retry is already covered', () => {
  assert.throws(() => adopt(options(undefined, { expectState: ROOT })), /state digest changed/);
  assert.throws(() => adopt(options(undefined, { expectCursor: after(FIRST) })), /ISC cursor changed/);
  assert.throws(() => adopt(options(undefined, { now: at('2026-01-06') })), /D\+5/);
  const r = adopt(options());
  const current = { digest: ROOT, state: r.state };
  assert.throws(() => adopt(options(r.state, { live: current })), /state digest changed/);
  assert.throws(() => adopt(options(r.state, { live: current, expectState: ROOT, expectCursor: after(THIRD), target: FIRST })), /backward/);
  const retry = adopt(options(r.state, { live: current, expectState: ROOT, expectCursor: after(THIRD) }));
  assert.equal(retry.proposal, null);
  assert.equal(retry.state, r.state);
});

function paths(t) {
  const dir = mkdtempSync(join(tmpdir(), 'isc-adopt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evidence = join(dir, 'evidence');
  const path = join(evidence, `${RUN}-1`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'stage.jsonl'), lines());
  return { evidence, out: join(dir, 'out') };
}

async function run(t, { rootChanged = false, stateChanged = false, current = null } = {}) {
  const { evidence, out } = paths(t);
  const candidates = options();
  const live = current === null ? candidates.live : { digest: STATE, state: adopt(candidates).state };
  const argv = ['--target', SECOND, '--expect-state', STATE, '--expect-cursor', JSON.stringify(current), '--evidence', evidence, '--out', out];
  const messages = [];
  let rootReads = 0;
  let stateReads = 0;
  const status = await main(argv, {
    env: { GITHUB_RUN_ID: RUN, GITHUB_RUN_ATTEMPT: '2' },
    now: () => Date.parse(NOW),
    out: (line) => messages.push(line),
    err: (line) => messages.push(line),
    readRoot: async (ref) => {
      assert.equal(ref, 'latest');
      rootReads += 1;
      return { digest: rootChanged && rootReads > 1 ? STATE : ROOT, root: root() };
    },
    readState: async (ref) => {
      assert.equal(ref, 'latest');
      stateReads += 1;
      return stateChanged && stateReads > 1 ? { ...live, digest: ROOT } : live;
    },
  });
  return { status, messages, out, rootReads, stateReads };
}

test('adoption CLI writes the canonical proposal and move candidate after rechecking both digests', async (t) => {
  const r = await run(t);
  assert.equal(r.status, 0, r.messages.join('\n'));
  assert.deepEqual([r.rootReads, r.stateReads], [2, 2]);
  assert.match(r.messages[0], /accepted 1 ISC proposal for 2 exact live days through 2026-01-02; next 2026-01-03/);
  const proposal = parseProposal(readFileSync(join(r.out, 'proposal.isc-new.json')));
  const state = parseState(readFileSync(join(r.out, 'next.json')));
  assert.equal(proposal.run, RUN);
  assert.equal(proposal.attempt, 2);
  assert.deepEqual(state.cursors['isc-new'], proposal.after);
});

test('adoption CLI writes no files on a moved root, moved state, or already covered cursor', async (t) => {
  for (const options of [{ rootChanged: true }, { stateChanged: true }, { current: after(THIRD) }]) {
    const r = await run(t, options);
    assert.equal(r.status, options.current === undefined ? 1 : 3, r.messages.join('\n'));
    assert.equal(existsSync(r.out), false);
    assert.match(r.messages[0], /changed while proving|already covered/);
  }
});

const WORKFLOW_FILE = fileURLToPath(new URL('../../.github/workflows/ingest-isc-adopt.yml', import.meta.url));
const WF = parse(readFileSync(WORKFLOW_FILE, 'utf8'));
const SKIP = !BASH || !JQ ? 'bash and jq are required to drive the workflow steps' : false;

test('adoption workflow is dispatch-only with least privileges and one main writer', () => {
  assert.deepEqual(Object.keys(WF.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(WF.jobs), ['push']);
  const { push } = WF.jobs;
  assert.equal(push.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(push.concurrency, { group: 'root-writer', queue: 'max', 'cancel-in-progress': false });
  assert.deepEqual(WF.permissions, {});
  assert.deepEqual(push.permissions, { actions: 'read', contents: 'read', packages: 'write' });
  assert.equal(push.steps.find((s) => s.id === 'move').if, "steps.prove.outputs.move == 'true'");
});

const SUCCESS = {
  id: 4567,
  run_attempt: 1,
  path: '.github/workflows/ingest-isc-stage.yml',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_repository: { full_name: 'pkgforge-dev/domains.pkgforge.dev' },
};

const API = [
  'gh() {',
  '  printf "gh %s\\n" "$*" >> "$FAKE_LOG"',
  '  if [[ "$1" == api ]]; then printf "%s\\n" "$METADATA"; return; fi',
  '  if [[ "$1 $2" != "run download" ]]; then return 90; fi',
  '  while [[ "$1" != --dir ]]; do shift; done',
  '  mkdir "$2"',
  '  if [[ "$MISSING" == no ]]; then touch "$2/stage.jsonl"; fi',
  '}',
].join('\n');

function download(t, { stages = '4567-1', metadata = SUCCESS, missing = 'no' } = {}) {
  return runStep(t, `${API}\n${stepScript(WORKFLOW_FILE, 'evidence', /gh run download/)}`, { env: { STAGES: stages, METADATA: JSON.stringify(metadata), MISSING: missing } });
}

test('adoption workflow downloads only the exact artifact of an authenticated successful stage attempt', { skip: SKIP }, (t) => {
  const valid = download(t);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(
    valid.calls.map((call) => call.replace(/--dir .*/, '--dir [stage]')),
    ['gh api repos/pkgforge-dev/domains.pkgforge.dev/actions/runs/4567/attempts/1', 'gh run download 4567 --repo pkgforge-dev/domains.pkgforge.dev --name isc-stage-4567-1 --dir [stage]'],
  );
  for (const metadata of [
    { ...SUCCESS, conclusion: 'failure' },
    { ...SUCCESS, path: '.github/workflows/ingest-isc-archive.yml' },
    { ...SUCCESS, head_branch: 'other' },
    { ...SUCCESS, event: 'push' },
    { ...SUCCESS, run_attempt: 2 },
  ]) {
    const refused = download(t, { metadata });
    assert.equal(refused.status, 1, refused.stderr);
    assert.equal(refused.calls.length, 1);
    assert.match(refused.stdout, /is not a successful indexed ISC stage attempt/);
  }
  const missing = download(t, { missing: 'yes' });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /has no stage.jsonl/);
});

test('adoption workflow refuses duplicate or malformed run attempts before calling GitHub', { skip: SKIP }, (t) => {
  for (const stages of ['4567-1 4567-1', '4567-1\n4568-1', '0-1', '4567-01', '../4567-1', '4567-1;echo']) {
    const r = download(t, { stages });
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(r.calls, []);
  }
});

const CLI = [
  'GITHUB_OUTPUT="$FAKE_LOG"',
  'node() {',
  '  printf "node %s\\n" "$*" >> "$FAKE_LOG"',
  '  if [[ "$CODE" == 0 && "$CANDIDATE" == yes ]]; then mkdir "$RUNNER_TEMP/isc-adopt"; touch "$RUNNER_TEMP/isc-adopt/next.json"; fi',
  '  return "$CODE"',
  '}',
].join('\n');

test('adoption workflow requires a state candidate on proof success and keeps the CAS move exit', { skip: SKIP }, (t) => {
  const run = (id, code, candidate) =>
    runStep(t, `${CLI}\n${stepScript(WORKFLOW_FILE, id)}`, {
      env: { CODE: String(code), CANDIDATE: candidate, EXPECT_STATE: STATE, EXPECT_CURSOR: 'null', TARGET: SECOND },
    });
  const proved = run('prove', 0, 'yes');
  assert.equal(proved.status, 0, proved.stderr);
  assert.deepEqual(proved.calls.slice(1), ['move=true']);
  const missing = run('prove', 0, 'no');
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /proof produced no state candidate/);
  const already = run('prove', 3, 'no');
  assert.equal(already.status, 0, already.stderr);
  assert.deepEqual(already.calls.slice(1), ['move=false']);
  const refused = run('prove', 4, 'no');
  assert.equal(refused.status, 4, refused.stderr);
  assert.equal(refused.calls.length, 1);
  const move = run('move', 1, 'no');
  assert.equal(move.status, 1, move.stderr);
  assert.equal(move.calls.length, 1);
  assert.ok(move.calls[0].startsWith('node scripts/state/move.mjs state --file '));
  assert.ok(move.calls[0].endsWith(` --expect ${STATE}`));
});
