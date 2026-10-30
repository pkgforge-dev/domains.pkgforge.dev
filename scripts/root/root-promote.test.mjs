// .github/workflows/root-promote.yml, read as YAML: the contract DOM-020 gives
// it (TODO/storage.md). It is called (workflow_call) and dispatched, holds the
// concurrency group root-writer with queue: max and no cancel (ruling 18), and
// its one job `promote` holds contents: read and packages: write (issues:
// write joins with DOM-034, the step that uses it); only the move step holds
// the token; the anonymous read follows the move; and the issue step is a
// no-op that fails the job until DOM-034.
// scripts/check-workflows.mjs holds the 15 rules of every workflow (rule 13's
// clause for this file among them); this test holds what is particular to this
// one, and runs the move step's own bash with a stand-in `node` that records
// its arguments, so the inputs' path to the scripts is tested, not read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { checkText, JOB_GRANTS } from '../check-workflows.mjs';
import { BASH, stepScript } from '../lib/workflow-step.mjs';

const FILE = fileURLToPath(new URL('../../.github/workflows/root-promote.yml', import.meta.url));
const TEXT = readFileSync(FILE, 'utf8');
const wf = parse(TEXT);
const job = wf.jobs.promote;
const steps = job.steps;
const step = (name) => steps.find((s) => s.name === name);
const INPUTS = ['add', 'replace', 'psl', 'rollback_to'];

test('root-promote: called and dispatched with the same four string inputs and the boolean partial, default false, in the group root-writer with queue: max and no cancel', () => {
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    assert.deepEqual(Object.keys(wf.on[trigger].inputs), [...INPUTS, 'partial'], trigger);
    for (const i of INPUTS) assert.deepEqual([wf.on[trigger].inputs[i].type, wf.on[trigger].inputs[i].required, wf.on[trigger].inputs[i].default], ['string', false, ''], `${trigger}.${i}`);
    const p = wf.on[trigger].inputs.partial;
    assert.deepEqual([p.type, p.required, p.default], ['boolean', false, false], `${trigger}.partial`);
  }
  assert.deepEqual(wf.on.workflow_call.inputs, wf.on.workflow_dispatch.inputs, 'the two triggers take the same inputs');
  assert.deepEqual(Object.keys(wf.on).sort(), ['workflow_call', 'workflow_dispatch']);
  assert.equal(wf.on.workflow_call.secrets, undefined);
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(wf.concurrency, { group: 'root-writer', queue: 'max', 'cancel-in-progress': false });
  assert.deepEqual(Object.keys(wf.jobs), ['promote']);
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(job['timeout-minutes'], 15);
  assert.deepEqual(checkText(TEXT, '.github/workflows/root-promote.yml'), []);
});

test('root-promote: the job promote holds contents: read and packages: write, a grant JOB_GRANTS gives it, and no issues: write before a step uses it', () => {
  assert.deepEqual(job.permissions, { contents: 'read', packages: 'write' });
  assert.ok(JOB_GRANTS.packages.includes('promote'));
});

test('root-promote: only the move step holds the token; the links and oras come first, the anonymous read and the issue no-op after', () => {
  const holders = steps.filter((s) => JSON.stringify(s.env ?? {}).includes('github.token'));
  assert.deepEqual(
    holders.map((s) => s.name),
    ['Move root:latest'],
  );
  const move = step('Move root:latest');
  assert.equal(move.id, 'move');
  assert.deepEqual(move.env, {
    REGISTRY_TOKEN: '${{ github.token }}',
    ADD: '${{ inputs.add }}',
    REPLACE: '${{ inputs.replace }}',
    PSL: '${{ inputs.psl }}',
    ROLLBACK_TO: '${{ inputs.rollback_to }}',
    PARTIAL: '${{ inputs.partial }}',
  });
  assert.doesNotMatch(move.run, /REGISTRY_TOKEN/);
  const names = steps.map((s) => s.name ?? s.uses);
  const at = (n) => names.indexOf(n);
  assert.ok(at('Link the workspace packages') < at('Move root:latest'));
  assert.ok(at('Install oras') < at('Move root:latest'));
  assert.ok(at('Move root:latest') < at('Read root:latest anonymously'));
  assert.ok(at('Read root:latest anonymously') < at('Raise an issue (a no-op until DOM-034)'));
  // The links install no package from the registry, and run no install script.
  assert.match(step('Link the workspace packages').run, /^ {0}set -euo pipefail\nnpm ci --omit=dev --ignore-scripts --no-audit --no-fund\n/);
  const read = step('Read root:latest anonymously');
  assert.equal(read.id, 'public');
  assert.equal(read.env, undefined);
  assert.equal(read.run, 'rc=0\nnode scripts/root/show.mjs --ref latest || rc=$?\necho "rc=$rc" >> "$GITHUB_OUTPUT"\nexit "$rc"\n');
  const raise = step('Raise an issue (a no-op until DOM-034)');
  assert.equal(raise.if, '${{ failure() }}');
  assert.match(raise.run, /exit 1\s*$/);
  // DOM-034 adds scripts/track-issue; no step runs it yet.
  for (const s of steps) assert.doesNotMatch(s.run ?? '', /^\s*(?:[A-Z_]+=\S*\s+)*scripts\/track-issue\b/m, s.name ?? s.uses);
});

test('root-promote: every script the workflow runs is in the tree', () => {
  const scripts = [...new Set([...TEXT.matchAll(/scripts\/[a-z/-]+(?:\.mjs)?/g)].map((m) => m[0]))].filter((s) => !s.endsWith('/') && s !== 'scripts/track-issue');
  assert.deepEqual(scripts.sort(), [
    'scripts/check-workflows.mjs',
    'scripts/ghcr/push.mjs',
    'scripts/install-oras',
    'scripts/root/lib.mjs',
    'scripts/root/promote.mjs',
    'scripts/root/rollback.mjs',
    'scripts/root/show.mjs',
    'scripts/verify-pack.mjs',
  ]);
  for (const s of scripts) assert.ok(existsSync(fileURLToPath(new URL(`../../${s}`, import.meta.url))), s);
});

// The move step's bash, run with a stand-in `node` first on PATH that records
// each argument on its own line and exits FAKE_EXIT.
function runMove(t, env) {
  const dir = mkdtempSync(join(tmpdir(), 'root-promote-step-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const cwd = join(dir, 'cwd');
  mkdirSync(bin);
  mkdirSync(cwd);
  // A file a glob of the inputs would find.
  writeFileSync(join(cwd, 'planted.txt'), '');
  writeFileSync(join(bin, 'node'), '#!/usr/bin/env bash\nfor a in "$@"; do printf \'%s\\n\' "$a"; done >> "$FAKE_LOG"\nprintf -- "--\\n" >> "$FAKE_LOG"\nexit "${FAKE_EXIT:-0}"\n');
  chmodSync(join(bin, 'node'), 0o755);
  const log = join(dir, 'log');
  const output = join(dir, 'output');
  writeFileSync(log, '');
  writeFileSync(output, '');
  const posix = (p) => p.replaceAll('\\', '/');
  const prelude = 'if command -v cygpath >/dev/null 2>&1; then PATH="$(cygpath -u "$FAKE_BIN"):$PATH"; else PATH="$FAKE_BIN:$PATH"; fi\n';
  const script = stepScript(FILE, 'move', /node scripts\/root\/promote\.mjs "\$\{args\[@\]\}"/);
  const r = spawnSync(BASH, ['-c', `${prelude}${script}`], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FAKE_BIN: bin, FAKE_LOG: posix(log), GITHUB_OUTPUT: posix(output), ADD: '', REPLACE: '', PSL: '', ROLLBACK_TO: '', PARTIAL: 'false', ...env },
  });
  const calls = readFileSync(log, 'utf8')
    .split('--\n')
    .filter((c) => c !== '')
    .map((c) => c.split('\n').filter((l) => l !== ''));
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, calls, output: readFileSync(output, 'utf8') };
}

test('root-promote: the move step passes each input word to promote.mjs as its own flag, never globbed, and its exit code through', {
  skip: BASH === null ? 'no bash on this machine' : false,
}, (t) => {
  const r = runMove(t, { ADD: 'names:names-d-20261026  obs:thc-ct.20261026.0232f4df0831 *', REPLACE: 'names:a,names:b=names:c', PSL: 'psl-1f96bae40adf' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [
    ['scripts/root/promote.mjs', '--add', 'names:names-d-20261026', '--add', 'obs:thc-ct.20261026.0232f4df0831', '--add', '*', '--replace', 'names:a,names:b=names:c', '--psl', 'psl-1f96bae40adf'],
  ]);
  assert.equal(r.output, 'rc=0\n');
  // No input at all: promote.mjs with no flag (the live root's PSL, nothing added).
  assert.deepEqual(runMove(t, {}).calls, [['scripts/root/promote.mjs']]);
  // A caller's input of several lines, a blank first line and tabs among them: every word arrives.
  const lines = runMove(t, { ADD: '\n  names:a names:b\nnames:c\t\n', REPLACE: 'names:x=names:y\n\nnames:z=names:w' });
  assert.equal(lines.status, 0, lines.stderr);
  assert.deepEqual(lines.calls, [['scripts/root/promote.mjs', '--add', 'names:a', '--add', 'names:b', '--add', 'names:c', '--replace', 'names:x=names:y', '--replace', 'names:z=names:w']]);
  // The script's own exit code is the step's, and the output rc.
  const three = runMove(t, { ADD: 'names:x', FAKE_EXIT: '3' });
  assert.equal(three.status, 3);
  assert.equal(three.output, 'rc=3\n');
  assert.match(three.stdout, /::error::the move of root:latest exited 3/);
});

test('root-promote: partial true passes --partial last, false passes nothing, and any other value runs nothing and fails', { skip: BASH === null ? 'no bash on this machine' : false }, (t) => {
  const on = runMove(t, { ADD: 'obs:a obs:b', PARTIAL: 'true' });
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(on.calls, [['scripts/root/promote.mjs', '--add', 'obs:a', '--add', 'obs:b', '--partial']]);
  assert.deepEqual(runMove(t, { ADD: 'obs:a', PARTIAL: 'false' }).calls, [['scripts/root/promote.mjs', '--add', 'obs:a']]);
  for (const value of ['', 'True', '1', 'yes']) {
    const bad = runMove(t, { ADD: 'obs:a', PARTIAL: value });
    assert.equal(bad.status, 2, JSON.stringify(value));
    assert.deepEqual(bad.calls, [], JSON.stringify(value));
    assert.equal(bad.output, 'rc=2\n');
    assert.match(bad.stdout, /::error::partial is not true or false/);
  }
});

test('root-promote: rollback_to runs rollback.mjs, alone; with another input it runs nothing and fails', { skip: BASH === null ? 'no bash on this machine' : false }, (t) => {
  const r = runMove(t, { ROLLBACK_TO: 'r-20261029t091000z' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [['scripts/root/rollback.mjs', '--to', 'r-20261029t091000z']]);
  for (const extra of [{ ADD: 'names:x' }, { REPLACE: 'names:a=names:b' }, { PSL: 'psl-1f96bae40adf' }, { PARTIAL: 'true' }]) {
    const bad = runMove(t, { ROLLBACK_TO: 'r-20261029t091000z', ...extra });
    assert.equal(bad.status, 2, JSON.stringify(extra));
    assert.deepEqual(bad.calls, []);
    assert.equal(bad.output, 'rc=2\n');
    assert.match(bad.stdout, /::error::rollback_to takes no add, replace, psl or partial/);
  }
});
