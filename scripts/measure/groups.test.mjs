// The names-a-domain histogram of scripts/measure/groups.mjs over sorted
// hashes, its largest domains by name, and its command line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { groupHistogram } from './groups.mjs';

const PSL = fileURLToPath(new URL('./fixtures/thc/psl-mini.dat', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./groups.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'thc-groups-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('thc groups: each run of a hash is one domain and its length the names it holds', () => {
  const sorted = new Float64Array([1, 2, 2, ...new Array(10).fill(3), ...new Array(150).fill(4)]);
  const h = groupHistogram(sorted, new Map([[4, 'big.example']]), 2);
  assert.equal(h.registrable, 4);
  assert.equal(h.names, 163);
  assert.deepEqual(
    h.buckets.map((b) => [b.label, b.registrable, b.names]),
    [
      ['=1', 1, 1],
      ['2-9', 1, 2],
      ['10-99', 1, 10],
      ['100-999', 1, 150],
      ['1k-9.9k', 0, 0],
      ['10k-99k', 0, 0],
      ['>=100k', 0, 0],
    ],
  );
  assert.deepEqual(h.top, [
    { reg: 'big.example', names: 150 },
    { reg: null, names: 10 },
  ]);
  assert.equal(h.top_pct_names, 98.2);
});

test('thc groups: an empty input has no domain', () => {
  const h = groupHistogram(new Float64Array(0));
  assert.equal(h.registrable, 0);
  assert.deepEqual(h.top, []);
});

test('thc groups: the command line reads a sorted record file', () => {
  const f = join(dir, 'keys.sorted');
  writeFileSync(f, ['com.example\t0', 'com.example.a\t0', 'com.example.b\t1', 'net.other\t0'].join('\n') + '\n');
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--psl', PSL, '--input', f], { encoding: 'utf8' }));
  assert.equal(out.registrable, 2);
  assert.equal(out.names, 4);
  assert.equal(out.buckets[0].registrable, 1);
  assert.equal(out.buckets[1].names, 3);
});
