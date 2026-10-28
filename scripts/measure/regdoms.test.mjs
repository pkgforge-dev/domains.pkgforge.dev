// The registrable domains of scripts/measure/regdoms.mjs over keys in sorted
// order: distinct domains and sites, names that are a suffix, the samples, and a
// sibling key that sorts inside a domain.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { h53, sampleLimit } from './f64cmp.mjs';
import { loadPsl } from './psl.mjs';
import { allDigitsTld, createSplitter } from './regdoms.mjs';

const PSL = fileURLToPath(new URL('./fixtures/thc/psl-mini.dat', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./regdoms.mjs', import.meta.url));
const psl = loadPsl(PSL);
const dir = mkdtempSync(join(tmpdir(), 'thc-regdoms-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const KEYS = [
  'com.amazonaws',
  'com.amazonaws.s3.b.a',
  'com.amazonaws.s3.b.c',
  'com.example',
  'com.example-x',
  'com.example-x.www',
  'com.example.api',
  'com.example.www',
  'io.github',
  'io.github.x',
  'io.github.y',
  'uk.co',
  'uk.co.b',
  'uk.co.b.a',
];

function run(sampleBits = 0) {
  const s = createSplitter(psl, { capacity: 4, sampleBits });
  for (const k of KEYS) s.add(k, k === 'com.example' ? 3 : 1);
  return s.finish();
}

test('thc regdoms: counts distinct registrable domains and sites over sorted keys', () => {
  const r = run();
  assert.equal(r.names, 14);
  assert.deepEqual(r.flags, { plain: 13, wildcard: 0, both: 1 });
  // ICANN: amazonaws.com, example.com, example-x.com, github.io, b.co.uk
  assert.equal(r.distinct_registrable_icann, 5);
  // full list: amazonaws.com, b.s3.amazonaws.com, example.com, example-x.com, x.github.io, y.github.io, b.co.uk
  assert.equal(r.distinct_sites_full_psl, 7);
  assert.equal(r.names_that_are_a_suffix, 1);
  assert.equal(r.tlds, 3);
  assert.equal(r.suffix_counts_selected.com, 8);
  assert.equal(r.suffix_counts_selected['co.uk'], 2);
});

test('thc regdoms: counts the address literals, whose top-level label is all digits', () => {
  assert.equal(allDigitsTld('1.2.0.192'), true);
  assert.equal(allDigitsTld('com.example'), false);
  assert.equal(allDigitsTld('1com.example'), false);
  assert.equal(allDigitsTld(''), false);
  const s = createSplitter(psl);
  for (const k of ['1.2.0.192', '1.2.0.193', 'com.example']) s.add(k, 1);
  const r = s.finish();
  assert.equal(r.names_with_an_all_digit_tld, 2);
  assert.equal(r.tlds, 2);
  assert.equal(r.tlds_all_digits, 1);
});

test('thc regdoms: a sibling that sorts inside a domain does not split it', () => {
  const r = run();
  const example = h53('com.example');
  const runs = [...r.sortedRegs].filter((h) => h === example).length;
  assert.equal(runs, 3);
});

test('thc regdoms: the samples hold the hashes under the limit, and every hash with no sample', () => {
  const all = run(0);
  assert.equal(all.nameSample.length, 14);
  assert.equal(all.regSample.length, 5);
  const limit = sampleLimit(2);
  const some = run(2);
  assert.deepEqual(
    [...some.nameSample],
    [...all.nameSample].filter((h) => h < limit),
  );
  assert.deepEqual(
    [...some.regSample],
    [...all.regSample].filter((h) => h < limit),
  );
});

test('thc regdoms: the command line counts a sorted record file', () => {
  const f = join(dir, 'keys.sorted');
  writeFileSync(f, KEYS.map((k) => `${k}\t0`).join('\n') + '\n');
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--psl', PSL, '--input', f], { encoding: 'utf8' }));
  assert.equal(out.names, 14);
  assert.equal(out.distinct_registrable_icann, 5);
  assert.equal(out.distinct_sites_full_psl, 7);
  assert.match(out.psl_sha256, /^[0-9a-f]{64}$/);
});
