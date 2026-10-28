// The days of scripts/measure/thc-list.mjs, over the Hugging Face listing as it
// was read on 2026-10-28T10:26:15Z (fixtures/thc/listing-2026-10-28.json): the
// 54-day span of DOM-009 and its two gaps, one day, and the refusals.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cs2Url, gapsOf, hfUrl, isDay, ListingError, parseListing, planDays, readListing } from './thc-list.mjs';

const LISTING = fileURLToPath(new URL('./fixtures/thc/listing-2026-10-28.json', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./thc-list.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'thc-list-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('thc list: the recorded listing holds 55 days, and 54 through 2026-10-26 with two gaps', () => {
  const { days, other } = readListing(LISTING);
  assert.equal(days.length, 55);
  assert.deepEqual(other, []);
  const plan = planDays(days, { day: '2026-10-26', matrix: true });
  assert.equal(plan.length, 54);
  assert.equal(plan[0].day, '2026-09-01');
  assert.equal(
    plan.reduce((a, d) => a + d.size, 0),
    35765972194,
  );
  assert.deepEqual(gapsOf(plan), ['2026-10-04', '2026-10-09']);
  assert.deepEqual(
    plan.find((d) => d.day === '2026-09-27'),
    { day: '2026-09-27', path: '2026/9/2026-09-27.txt.gz', size: 914045559 },
  );
});

test('thc list: one day alone, and a day the listing does not hold', () => {
  const { days } = readListing(LISTING);
  assert.deepEqual(planDays(days, { day: '2026-10-26' }), [{ day: '2026-10-26', path: '2026/10/2026-10-26.txt.gz', size: 319917410 }]);
  assert.throws(() => planDays(days, { day: '2026-10-04' }), ListingError);
  assert.throws(() => planDays(days, { day: '2026-10-04', matrix: true }), ListingError);
  assert.throws(() => planDays(days, { day: '2026-13-01' }), ListingError);
});

test('thc list: refuses a directory that is not the month of the date, a repeat and a bad size', () => {
  const file = (path, size = 10) => ({ type: 'file', path, size });
  assert.throws(() => parseListing([file('2026/10/2026-09-30.txt.gz')]), ListingError);
  assert.throws(() => parseListing([file('2026/09/2026-09-30.txt.gz')]), ListingError);
  assert.throws(() => parseListing([file('2026/9/2026-09-30.txt.gz'), file('2026/9/2026-09-30.txt.gz')]), ListingError);
  assert.throws(() => parseListing([file('2026/9/2026-09-30.txt.gz', 0)]), ListingError);
  assert.throws(() => parseListing([file('2026/2/2026-02-30.txt.gz')]), ListingError);
  assert.throws(() => parseListing({}), ListingError);
  assert.deepEqual(parseListing([file('README.md'), { type: 'directory', path: '2026' }]), { days: [], other: ['README.md'] });
});

test('thc list: the URLs of a day', () => {
  assert.equal(hfUrl('2026/10/2026-10-26.txt.gz'), 'https://huggingface.co/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/resolve/2026/10/2026-10-26.txt.gz?download=true');
  assert.equal(cs2Url('2026-10-26'), 'https://cs2.ip.thc.org/2026-10-26.txt.gz');
  assert.equal(isDay('2026-10-26'), true);
  assert.equal(isDay('2026-10-32'), false);
  assert.equal(isDay('26-10-2026'), false);
});

test('thc list: the command line writes a matrix that holds only include', () => {
  const out = join(dir, 'github-output');
  writeFileSync(out, '');
  const printed = execFileSync(process.execPath, [SCRIPT, '--listing', LISTING, '--day', '2026-10-26', '--matrix', 'true', '--github-output', out], { encoding: 'utf8' }).split('\n');
  const line = readFileSync(out, 'utf8');
  assert.match(line, /^matrix=\{"include":\[/);
  const matrix = JSON.parse(line.slice('matrix='.length));
  assert.deepEqual(Object.keys(matrix), ['include']);
  assert.equal(matrix.include.length, 54);
  assert.deepEqual(JSON.parse(printed[1]).gaps, ['2026-10-04', '2026-10-09']);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--listing', LISTING, '--day', '2026-10-04']).status, 1);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--listing', LISTING, '--day', '2026-10-26', '--matrix', 'yes']).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--listing', join(dir, 'absent.json'), '--day', '2026-10-26']).status, 1);
});
