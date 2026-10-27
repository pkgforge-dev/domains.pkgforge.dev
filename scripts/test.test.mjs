// scripts/test.mjs: the runner is seen to fail on zero tests, on a filter that
// matches none, on a failing test and on a missing directory, and to skip
// node_modules, dot-directories and docs/research. Each case runs a copy of the
// runner in a scratch directory and reads its exit code from its own process.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from './files.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PASS = "import { test } from 'node:test';\ntest('passes here', () => {});\ntest('also passes', () => {});\n";
const FAIL = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails here', () => assert.equal(1, 2));\n";

function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'domains-runner-'));
  dirs.push(dir);
  for (const rel of ['scripts/test.mjs', 'scripts/files.mjs', 'scripts/lib/args.mjs', 'scripts/lib/test-counter.mjs']) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return (...args) => {
    try {
      const stdout = execFileSync(process.execPath, ['scripts/test.mjs', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status, stdout: String(err.stdout), stderr: String(err.stderr) };
    }
  };
}

test('passing tests exit 0 and are counted', () => {
  const run = scratch({ 'a/one.test.mjs': PASS });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /test: 2 test\(s\) passed under \. \(1 file\(s\)\)/);
});

test('a failing test exits 1', () => {
  const run = scratch({ 'a/one.test.mjs': PASS, 'b/two.test.mjs': FAIL });
  assert.equal(run().status, 1);
});

test('zero tests is a failure, never a pass', () => {
  const run = scratch({ 'a/readme.md': 'no tests here\n' });
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no test ran under \./);
});

test('a directory without a test file fails, and a directory that does not exist exits 2', () => {
  const run = scratch({ 'a/one.test.mjs': PASS, 'empty/x.txt': 'x\n' });
  const empty = run('empty');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no test ran under empty/);
  const absent = run('missing');
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /no directory missing/);
  assert.equal(run('a').status, 0);
});

test('--name selects by test name and fails when nothing matches', () => {
  const run = scratch({ 'a/one.test.mjs': PASS });
  const some = run('a', '--name', 'also');
  assert.equal(some.status, 0, some.stderr);
  assert.match(some.stdout, /1 test\(s\) passed matching also/);
  const none = run('a', '--name', 'no such test');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /--name no such test matched no test under a/);
});

test('node_modules, dot-directories and docs/research are not walked', () => {
  const run = scratch({
    'a/one.test.mjs': PASS,
    'node_modules/dep/x.test.mjs': FAIL,
    '.hidden/y.test.mjs': FAIL,
    'docs/research/2026/z.test.mjs': FAIL,
  });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(1 file\(s\)\)/);
});
