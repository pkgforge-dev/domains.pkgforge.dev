// scripts/lib/gated.mjs: the tree a gate pass is recorded against, and the record.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { filesTree, passesFile, passesOf, passOf, recordPass } from './gated.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'domains-gated-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.tmp/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  return dir;
}

test('the tree names the working files, a new file changes it, and an ignored file does not', () => {
  const dir = repo();
  const t1 = filesTree(dir);
  assert.match(t1, /^[0-9a-f]{40,64}$/);
  assert.equal(filesTree(dir), t1, 'the same files name the same tree');
  writeFileSync(join(dir, 'b.txt'), 'two\n');
  const t2 = filesTree(dir);
  assert.notEqual(t2, t1);
  mkdirSync(join(dir, '.tmp'));
  writeFileSync(join(dir, '.tmp', 'scratch.txt'), 'ignored\n');
  assert.equal(filesTree(dir), t2, 'a gitignored file is outside the tree');
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  assert.notEqual(filesTree(dir), t2, 'an edit changes the tree');
});

test('naming the tree leaves the real index untouched', () => {
  const dir = repo();
  filesTree(dir);
  assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }), '', 'nothing was staged');
});

test('a pass is appended to .tmp/gate-passes.jsonl, and passOf returns the newest of a tree', () => {
  const dir = repo();
  const file = recordPass(dir, { tree: 'aaa', head: null, node: 'v26.7.0', at: '2026-10-27T00:00:00.000Z' });
  assert.equal(file, passesFile(dir));
  recordPass(dir, { tree: 'bbb', head: 'h1', node: 'v26.7.0', at: '2026-10-27T00:01:00.000Z' });
  recordPass(dir, { tree: 'aaa', head: 'h2', node: 'v26.7.0', at: '2026-10-27T00:02:00.000Z' });
  assert.equal(passesOf(dir).length, 3);
  assert.equal(passOf(dir, 'aaa').head, 'h2');
  assert.equal(passOf(dir, 'ccc'), null);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3);
});

test('a torn or foreign line is no pass, and an absent record holds none', () => {
  const dir = repo();
  assert.deepEqual(passesOf(dir), []);
  recordPass(dir, { tree: 'aaa', head: null });
  appendFileSync(passesFile(dir), '{"tree":"torn\n{"no":"tree"}\n\n');
  assert.deepEqual(
    passesOf(dir).map((p) => p.tree),
    ['aaa'],
  );
});
