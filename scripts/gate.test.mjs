// scripts/gate.mjs: the steps equal the list TODO/RULES.md §1 names, each step is
// a file that exists, and the runner reads each step's exit code from its own
// process: a failing step fails the run without stopping the later steps, and
// only a run whose every step passed records a pass. The behaviour cases run a
// copy of the gate in a scratch git repository whose steps are stubs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from './files.mjs';
import { STEPS } from './gate.mjs';
import { passesOf } from './lib/gated.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('the gate runs the steps TODO/RULES.md §1 lists, in the same order', () => {
  const rules = readFileSync(join(ROOT, 'TODO', 'RULES.md'), 'utf8');
  const row = rules.split('\n').find((l) => l.startsWith('| the mechanical gate |'));
  assert.ok(row, 'RULES.md §1 has a `| the mechanical gate |` row');
  const listed = [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((c) => /^(node|npm) /.test(c));
  assert.deepEqual(
    listed,
    STEPS.map((s) => s.name),
  );
});

test('every node step names a script that exists', () => {
  for (const s of STEPS.filter((x) => x.cmd === process.execPath)) assert.ok(existsSync(join(ROOT, s.args[0])), s.name);
});

function stubTree(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'domains-gate-'));
  dirs.push(dir);
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  for (const rel of ['scripts/gate.mjs', 'scripts/lib/gated.mjs']) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  const ok = "import { appendFileSync } from 'node:fs';\nappendFileSync('.tmp-ran.txt', process.argv[1] + '\\n');\n";
  for (const rel of ['scripts/todo/check.mjs', 'scripts/todo/count.mjs', 'scripts/check-workflows.mjs', 'scripts/text-check.mjs', 'scripts/scan-secrets.mjs', 'scripts/check-hooks.mjs'])
    put(rel, overrides[rel] ?? ok);
  const pass = 'node -e "process.exit(0)"';
  put('package.json', JSON.stringify({ name: 'stub', private: true, scripts: { test: pass, lint: pass, typecheck: pass, ...overrides.scripts } }));
  put('.gitignore', '.tmp/\n.tmp-ran.txt\nnode_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

function runGate(dir) {
  const r = spawnSync(process.execPath, ['scripts/gate.mjs'], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('a run whose every step passes exits 0 and records a pass of the tree', () => {
  const dir = stubTree();
  const r = runGate(dir);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /gate: all steps passed/);
  assert.match(r.stdout, /gate: pass recorded for tree [0-9a-f]{12}/);
  assert.equal(passesOf(dir).length, 1);
});

test('a failing step exits 1, names the step and its exit code, runs the later steps, and records no pass', () => {
  const dir = stubTree({ 'scripts/text-check.mjs': 'process.exit(3);\n' });
  const r = runGate(dir);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /FAIL node scripts\/text-check\.mjs \(exit 3\)/);
  assert.match(readFileSync(join(dir, '.tmp-ran.txt'), 'utf8'), /scan-secrets\.mjs/, 'the step after the failure still ran');
  assert.doesNotMatch(r.stdout, /gate: all steps passed/);
  assert.deepEqual(passesOf(dir), []);
});

test('a workflow that breaks the policy fails the run, the suites still run, and no pass is recorded', () => {
  const dir = stubTree({ 'scripts/check-workflows.mjs': "process.stderr.write('.github/workflows/x.yml:3: rule 1: top-level permissions\\n');\nprocess.exit(1);\n" });
  const r = runGate(dir);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /FAIL node scripts\/check-workflows\.mjs \(exit 1\)/);
  assert.match(readFileSync(join(dir, '.tmp-ran.txt'), 'utf8'), /text-check\.mjs/, 'the steps after it still ran');
  assert.deepEqual(passesOf(dir), []);
});

test('a failing npm step fails the run too', () => {
  const dir = stubTree({ scripts: { lint: 'node -e "process.exit(4)"' } });
  const r = runGate(dir);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /FAIL npm run lint/);
  assert.deepEqual(passesOf(dir), []);
});

test('a failing type check fails the run and records no pass', () => {
  const dir = stubTree({ scripts: { typecheck: 'node -e "process.exit(1)"' } });
  const r = runGate(dir);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /FAIL npm run typecheck \(exit 1\)/);
  assert.deepEqual(passesOf(dir), []);
});

test('a run that changes a file records no pass', () => {
  const dir = stubTree({ 'scripts/scan-secrets.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('changed-during-the-run.txt', 'x');\n" });
  const r = runGate(dir);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /no pass recorded: the files changed during the run/);
  assert.deepEqual(passesOf(dir), []);
});

// A step ended by a signal has no exit status (null), and must fail the run
// (AGENTS.md absolute 5): nothing may read null as 0.
test('a step ended by a signal fails the run and records no pass', { skip: process.platform === 'win32' ? 'POSIX signals' : false }, () => {
  const dir = stubTree({ 'scripts/text-check.mjs': "process.kill(process.pid, 'SIGKILL');\n" });
  const r = runGate(dir);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /FAIL node scripts\/text-check\.mjs \(exit null\)/);
  assert.deepEqual(passesOf(dir), []);
});

// npm is spawned without a shell off Windows, so a PATH without it is a step
// that could not start: exit 2, not a pass and not an ordinary failure.
test('a step that cannot start exits 2 and records no pass', { skip: process.platform === 'win32' ? 'npm runs through cmd.exe on Windows' : false }, () => {
  const dir = stubTree();
  const empty = mkdtempSync(join(tmpdir(), 'domains-gate-path-'));
  dirs.push(empty);
  const r = spawnSync(process.execPath, ['scripts/gate.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: empty } });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /COULD NOT START npm test: /);
  assert.deepEqual(passesOf(dir), []);
});
