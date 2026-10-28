// The hash files of scripts/measure/f64cmp.mjs: the hash and its sample, the
// sorted duplicate-free arrays, their files, the comparison, and the command
// line's exit codes.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSortedUnique, compareF64, createF64, F64Error, h53, readF64, sampleLimit, sortUnique, writeF64 } from './f64cmp.mjs';

const SCRIPT = fileURLToPath(new URL('./f64cmp.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'thc-f64-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('thc f64: h53 is a fixed integer below 2^53 for a key', () => {
  // Pinned: a hash file of one run is compared with another, so the hash never changes quietly.
  assert.equal(h53('com.example'), 6013560846452904);
  assert.equal(h53(''), 3010749177691147);
  for (const k of ['a', 'np.com.example.api', 'x'.repeat(253)]) {
    const h = h53(k);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 53, k);
    assert.equal(h53(k), h);
  }
});

test('thc f64: a sample of 1 in 16 keeps about a sixteenth of the keys', () => {
  const limit = sampleLimit(4);
  let kept = 0;
  const n = 200000;
  for (let i = 0; i < n; i++) if (h53(`com.example${i}.www`) < limit) kept += 1;
  assert.ok(Math.abs(kept / n - 1 / 16) < 0.003, `kept ${kept} of ${n}`);
  assert.equal(sampleLimit(0), 2 ** 53);
  assert.throws(() => sampleLimit(21), F64Error);
  assert.throws(() => sampleLimit(1.5), F64Error);
});

test('thc f64: the growable array, sortUnique and the file round trip', () => {
  const a = createF64(2);
  for (const x of [5, 3, 5, 1, 3, 9, 1]) a.push(x);
  assert.equal(a.size, 7);
  const u = sortUnique(a.array());
  assert.deepEqual([...u], [1, 3, 5, 9]);
  const f = join(dir, 'a.f64');
  writeF64(f, u);
  assert.deepEqual([...readF64(f)], [1, 3, 5, 9]);
  const bad = join(dir, 'bad.f64');
  writeFileSync(bad, Buffer.alloc(12));
  assert.throws(() => readF64(bad), F64Error);
});

test('thc f64: checkSortedUnique refuses a repeat, a fall, a fraction and a value at the limit', () => {
  checkSortedUnique(new Float64Array([0, 1, 7]), 8);
  for (const bad of [
    [1, 1],
    [2, 1],
    [0.5, 1],
    [0, 8],
    [-1, 0],
  ]) {
    assert.throws(() => checkSortedUnique(new Float64Array(bad), 8), F64Error, JSON.stringify(bad));
  }
});

test('thc f64: compareF64 counts the intersection', () => {
  assert.deepEqual(compareF64(new Float64Array([1, 2, 3, 4]), new Float64Array([2, 4, 6])), { A: 4, B: 3, both: 2, pctOfA: 50, pctOfB: 66.67 });
  assert.deepEqual(compareF64(new Float64Array([]), new Float64Array([1])), { A: 0, B: 1, both: 0, pctOfA: 0, pctOfB: 0 });
});

test('thc f64: the command line compares two files and refuses an unsorted one', () => {
  const a = join(dir, 'x.f64');
  const b = join(dir, 'y.f64');
  writeF64(a, new Float64Array([1, 2, 3]));
  writeF64(b, new Float64Array([3, 4]));
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, a, b], { encoding: 'utf8' }));
  assert.deepEqual(out, { a: 'x.f64', b: 'y.f64', A: 3, B: 2, both: 1, pctOfA: 33.33, pctOfB: 50 });
  const u = join(dir, 'u.f64');
  writeF64(u, new Float64Array([3, 1]));
  assert.equal(spawnSync(process.execPath, [SCRIPT, a, u]).status, 1);
  assert.equal(spawnSync(process.execPath, [SCRIPT, a]).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, a, join(dir, 'absent.f64')]).status, 2);
});
