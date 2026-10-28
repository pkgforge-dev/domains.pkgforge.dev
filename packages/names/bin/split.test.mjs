// packages/names/bin/split.mjs: the exact output of the entry's Prove, a refused
// name, and the runs that cannot start. Offline: the list is the pinned
// fixture of the package's tests, and a planted copy of it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./split.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../test/fixtures/psl-2026-10-27.dat', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('names split: prints suffix, reg and site of each name, the site from the full list', () => {
  const r = run('api.example.com.np', 'x.github.io');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'name api.example.com.np suffix com.np reg example.com.np site example.com.np\nname x.github.io suffix io reg github.io site x.github.io\n');
  assert.equal(r.stderr, '');
});

test('names split: normalises first, and prints - for the site of a name that is a suffix of the full list', () => {
  const r = run('*.API.Example.COM.', 'github.io', 'x.公司.cn');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    'name api.example.com suffix com reg example.com site example.com\nname github.io suffix io reg github.io site -\nname x.xn--55qx5d.cn suffix xn--55qx5d.cn reg x.xn--55qx5d.cn site x.xn--55qx5d.cn\n',
  );
});

test('names split: a refused name prints its reason, the others still print, and the run exits 1', () => {
  const r = run('co.uk', 'np.com', '192.0.2.1', 'a b.com');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'input "co.uk" refused public-suffix\nname np.com suffix com reg np.com site np.com\ninput "192.0.2.1" refused numeric-tld\ninput "a b.com" refused charset\n');
});

test('names split: --psl reads another list, and no name, a missing list or a list cut short exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'names-split-'));
  dirs.push(dir);
  const copy = join(dir, 'psl.dat');
  writeFileSync(copy, readFileSync(FIXTURE));
  const ok = run('--psl', copy, 'x.github.io');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'name x.github.io suffix io reg github.io site x.github.io\n');
  assert.equal(run().status, 2);
  assert.equal(run('--psl', copy).status, 2);
  const missing = run('--psl', join(dir, 'absent.dat'), 'x.github.io');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read the list/);
  const cut = join(dir, 'cut.dat');
  const text = readFileSync(FIXTURE, 'utf8');
  writeFileSync(cut, text.slice(0, text.indexOf('// ===BEGIN PRIVATE DOMAINS===')));
  const short = run('--psl', cut, 'x.github.io');
  assert.equal(short.status, 2);
  assert.match(short.stderr, /missing marker \/\/ ===BEGIN PRIVATE DOMAINS===/);
  assert.equal(short.stdout, '');
});
