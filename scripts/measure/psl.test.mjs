// The Public Suffix List matcher of scripts/measure/psl.mjs, against a small
// list holding each rule kind (fixtures/thc/psl-mini.dat), against design A's
// set-based algorithm as an oracle, and the cache that reuses a registrable
// domain for the keys under it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPsl, PslError, parsePsl, regKey, regKeyCached, split } from './psl.mjs';
import { reverseName } from './revlabel.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/thc/psl-mini.dat', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./psl.mjs', import.meta.url));
const psl = loadPsl(FIXTURE);
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Design A's algorithm (docs/research/2026-10-27-design-a/scripts/psl.mjs), kept
// here as the oracle: sets of rule strings and a scan from the longest suffix.
function oracle(text, icannOnly) {
  const rules = new Set();
  const wild = new Set();
  const exc = new Set();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('// ===BEGIN ICANN')) section = 'icann';
    if (line.startsWith('// ===BEGIN PRIVATE')) section = 'private';
    if (!line || line.startsWith('//')) continue;
    if (icannOnly && section !== 'icann') continue;
    if (line.startsWith('!')) exc.add(line.slice(1));
    else if (line.startsWith('*.')) wild.add(line.slice(2));
    else rules.add(line);
  }
  return (name) => {
    const labels = name.split('.');
    const n = labels.length;
    let best = 1;
    let k = null;
    for (let i = 0; i < n; i++) {
      const s = labels.slice(i).join('.');
      if (exc.has(s)) {
        k = n - i - 1;
        break;
      }
      if (rules.has(s) && n - i > best) best = n - i;
      if (i + 1 < n && wild.has(labels.slice(i + 1).join('.')) && n - i > best) best = n - i;
    }
    if (k === null) k = best;
    return labels.length > k ? labels.slice(-(k + 1)).join('.') : null;
  };
}

test('thc psl: reads both sections, counts the rules and hashes the bytes', () => {
  const bytes = readFileSync(FIXTURE);
  const p = parsePsl(bytes);
  assert.deepEqual(p.rules, { icann: 16, private: 3 });
  assert.equal(p.sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('thc psl: refuses a list without the private section and a rule outside a section', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  assert.throws(() => parsePsl(text.replace('// ===BEGIN PRIVATE DOMAINS===', '')), PslError);
  assert.throws(() => parsePsl(`com\n${text}`), PslError);
  assert.throws(() => parsePsl(text.replace('github.io', 'git*hub.io')), PslError);
});

test('thc psl: splits names by each rule kind, in the ICANN section and in the full list', () => {
  const cases = [
    // name, ICANN { suffix, reg }, full list reg
    ['www.example.com', 'com', 'example.com', 'example.com'],
    ['a.b.co.uk', 'co.uk', 'b.co.uk', 'b.co.uk'],
    ['co.uk', 'co.uk', null, null],
    ['kawasaki.jp', 'jp', 'kawasaki.jp', 'kawasaki.jp'],
    ['foo.kawasaki.jp', 'foo.kawasaki.jp', null, null],
    ['a.foo.kawasaki.jp', 'foo.kawasaki.jp', 'a.foo.kawasaki.jp', 'a.foo.kawasaki.jp'],
    ['city.kawasaki.jp', 'kawasaki.jp', 'city.kawasaki.jp', 'city.kawasaki.jp'],
    ['www.city.kawasaki.jp', 'kawasaki.jp', 'city.kawasaki.jp', 'city.kawasaki.jp'],
    ['api.example.com.np', 'com.np', 'example.com.np', 'example.com.np'],
    ['www.ck', 'ck', 'www.ck', 'www.ck'],
    ['foo.ck', 'foo.ck', null, null],
    ['a.foo.ck', 'foo.ck', 'a.foo.ck', 'a.foo.ck'],
    ['x.github.io', 'io', 'github.io', 'x.github.io'],
    ['github.io', 'io', 'github.io', null],
    ['a.b.s3.amazonaws.com', 'com', 'amazonaws.com', 'b.s3.amazonaws.com'],
    ['x.y.compute.amazonaws.com', 'com', 'amazonaws.com', 'x.y.compute.amazonaws.com'],
    ['example.unknowntld', 'unknowntld', 'example.unknowntld', 'example.unknowntld'],
    ['unknowntld', 'unknowntld', null, null],
  ];
  for (const [name, suffix, reg, site] of cases) {
    assert.deepEqual(split(psl.icann, name), { suffix, reg }, name);
    assert.equal(split(psl.all, name).reg, site, name);
  }
});

test('thc psl: converts an IDN rule to its ASCII form', () => {
  assert.deepEqual(split(psl.icann, 'x.xn--55qx5d.cn'), { suffix: 'xn--55qx5d.cn', reg: 'x.xn--55qx5d.cn' });
  assert.equal(split(psl.icann, 'xn--55qx5d.cn').reg, null);
});

test('thc psl: agrees with design A on every name of up to four labels', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const labels = ['com', 'co', 'uk', 'jp', 'kawasaki', 'city', 'foo', 'ck', 'www', 'io', 'github', 's3', 'amazonaws', 'compute', 'np', 'zz'];
  const names = [];
  const grow = (prefix, depth) => {
    for (const l of labels) {
      const name = prefix === '' ? l : `${l}.${prefix}`;
      names.push(name);
      if (depth < 4) grow(name, depth + 1);
    }
  };
  grow('', 1);
  for (const [trie, icannOnly] of [
    [psl.icann, true],
    [psl.all, false],
  ]) {
    const ref = oracle(text, icannOnly);
    for (const name of names) assert.equal(split(trie, name).reg, ref(name), name);
  }
  assert.ok(names.length > 60000);
});

test('thc psl: the cache gives what the walk gives, over keys in sorted order', () => {
  const labels = ['com', 'amazonaws', 's3', 'compute', 'b', 'jp', 'kawasaki', 'city', 'foo', 'www', 'example', 'example-x'];
  const keys = new Set();
  const grow = (prefix, depth) => {
    for (const l of labels) {
      const key = prefix === '' ? l : `${prefix}.${l}`;
      keys.add(key);
      if (depth < 4) grow(key, depth + 1);
    }
  };
  grow('', 1);
  const sorted = [...keys].sort();
  for (const trie of [psl.icann, psl.all]) {
    const cached = regKeyCached(trie);
    for (const key of sorted) assert.equal(cached(key), regKey(trie, key), key);
  }
});

test('thc psl: the cache is not used under a domain with a rule below it', () => {
  // amazonaws.com has private rules below it: closed in the ICANN section only.
  const all = regKeyCached(psl.all);
  assert.equal(all('com.amazonaws'), 'com.amazonaws');
  assert.equal(all('com.amazonaws.s3.b.a'), 'com.amazonaws.s3.b');
  assert.equal(reverseName(all('com.amazonaws.www')), 'amazonaws.com');
  const icann = regKeyCached(psl.icann);
  assert.equal(icann('com.amazonaws'), 'com.amazonaws');
  assert.equal(icann('com.amazonaws.s3.b.a'), 'com.amazonaws');
  // kawasaki.jp carries a wildcard; city.kawasaki.jp is an exception with nothing below it.
  assert.equal(icann('jp.kawasaki'), 'jp.kawasaki');
  assert.equal(icann('jp.kawasaki.foo.a'), 'jp.kawasaki.foo.a');
  assert.equal(icann('jp.kawasaki.city'), 'jp.kawasaki.city');
  assert.equal(icann('jp.kawasaki.city.www'), 'jp.kawasaki.city');
  assert.equal(icann('jp.kawasaki.foo'), null);
  assert.equal(icann('jp.kawasaki.foo.b'), 'jp.kawasaki.foo.b');
});

test('thc psl: --check prints the hash and the counts, and refuses a list with no private section', () => {
  const out = execFileSync(process.execPath, [SCRIPT, '--check', FIXTURE], { encoding: 'utf8' });
  assert.match(out, /^sha256 [0-9a-f]{64} icann 16 private 3\n$/);
  const dir = mkdtempSync(join(tmpdir(), 'thc-psl-'));
  dirs.push(dir);
  const bad = join(dir, 'bad.dat');
  writeFileSync(bad, readFileSync(FIXTURE, 'utf8').replace('// ===BEGIN PRIVATE DOMAINS===', ''));
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--check', bad]).status, 1);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--check', join(dir, 'absent.dat')]).status, 2);
});

test('thc psl: a list without any one of its four markers, or cut short, is refused by the marker check itself', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'thc-psl-'));
  dirs.push(dir);
  const marks = ['// ===BEGIN ICANN DOMAINS===', '// ===END ICANN DOMAINS===', '// ===BEGIN PRIVATE DOMAINS===', '// ===END PRIVATE DOMAINS==='];
  const cut = (at) => text.slice(0, text.indexOf(at));
  const lists = [
    ...marks.map((mark) => [`without ${mark}`, text.replace(mark, ''), mark]),
    // Truncated after the last ICANN rule, and before the private section.
    ['cut after the ICANN rules', cut('// ===END ICANN DOMAINS==='), '// ===END ICANN DOMAINS==='],
    ['cut before the private section', cut('// ===BEGIN PRIVATE DOMAINS==='), '// ===BEGIN PRIVATE DOMAINS==='],
    ['cut inside the private section', cut('*.compute.amazonaws.com'), '// ===END PRIVATE DOMAINS==='],
  ];
  for (const [name, list, mark] of lists) {
    assert.throws(
      () => parsePsl(list),
      (e) => e instanceof PslError && e.message === `missing marker ${mark}`,
      name,
    );
    const file = join(dir, `${name.replaceAll(/[^a-z]+/g, '-')}.dat`);
    writeFileSync(file, list);
    const r = spawnSync(process.execPath, [SCRIPT, '--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /missing marker/, name);
  }
});
