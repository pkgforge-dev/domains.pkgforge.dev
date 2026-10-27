// scripts/check-hooks.mjs: a hook in the index without the executable bit fails
// the step, one with the bit passes, and a hook not yet in the index passes with a
// note. The parser is checked on `git ls-files -s` lines, and the command line is
// run in a scratch git repository, its exit code read from its own process.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from './files.mjs';
import { findings, parseStaged } from './check-hooks.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const hasGit = spawnSync('git', ['--version']).status === 0;
const opts = { skip: hasGit ? false : 'git is not on the PATH, so the command line was not run' };

test('parseStaged reads stage 0 entries and findings names every entry that is not 100755', () => {
  const out = [
    '100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\t.githooks/commit-msg',
    '100755 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\t.githooks/other',
    '100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 2\t.githooks/conflicted',
    '',
  ].join('\n');
  const entries = parseStaged(out);
  assert.deepEqual(entries, [
    { mode: '100644', path: '.githooks/commit-msg' },
    { mode: '100755', path: '.githooks/other' },
  ]);
  const failed = findings(entries);
  assert.equal(failed.length, 1);
  assert.match(failed[0], /\.githooks\/commit-msg is in the index as mode 100644; run: git update-index --chmod=\+x/);
  assert.deepEqual(findings([{ mode: '100755', path: '.githooks/commit-msg' }]), []);
});

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'domains-hooks-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(ROOT, 'scripts', 'check-hooks.mjs'), join(dir, 'scripts', 'check-hooks.mjs'));
  mkdirSync(join(dir, '.githooks'));
  writeFileSync(join(dir, '.githooks', 'commit-msg'), '#!/bin/sh\nexit 0\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const run = (dir) => {
  const r = spawnSync(process.execPath, ['scripts/check-hooks.mjs'], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

test('before the first git add the step passes with a note, and a staged hook without the bit fails until the bit is set', opts, () => {
  const dir = scratchRepo();
  const before = run(dir);
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /in the index yet/);

  execFileSync('git', ['update-index', '--add', '--chmod=-x', '.githooks/commit-msg'], { cwd: dir });
  const plain = run(dir);
  assert.equal(plain.status, 1, `${plain.stdout}${plain.stderr}`);
  assert.match(plain.stderr, /FAIL \.githooks\/commit-msg is in the index as mode 100644/);

  execFileSync('git', ['update-index', '--chmod=+x', '.githooks/commit-msg'], { cwd: dir });
  const fixed = run(dir);
  assert.equal(fixed.status, 0, `${fixed.stdout}${fixed.stderr}`);
  assert.match(fixed.stdout, /1 file\(s\) under \.githooks\/ carry the executable bit/);
});
