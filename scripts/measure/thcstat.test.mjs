// The raw-line statistics of scripts/measure/thcstat.mjs, and its command line
// over a gzip file and over one that is cut short.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createRawStats } from './thcstat.mjs';

const SCRIPT = fileURLToPath(new URL('./thcstat.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'thc-stat-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('thc thcstat: counts wildcards, upper case, other bytes, carriage returns and inversions', () => {
  const s = createRawStats();
  for (const line of ['b.com', '*.a.com', 'A.com', 'c.com\r', 'x y.com', 'd.com']) s.add(line);
  assert.deepEqual(s.result(), {
    lines: 6,
    bytes: 41,
    wildcard_lines: 1,
    upper_case_lines: 1,
    non_printable_lines: 2,
    carriage_return_lines: 1,
    adjacent_inversions: 2,
    max_line_length: 7,
  });
});

test('thc thcstat: the command line reads a gzip file and refuses one cut short', () => {
  const gz = join(dir, 'day.txt.gz');
  const body = gzipSync(Buffer.from('b.com\na.com\n'));
  writeFileSync(gz, body);
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, gz], { encoding: 'utf8' }));
  assert.equal(out.lines, 2);
  assert.equal(out.adjacent_inversions, 1);
  const cut = join(dir, 'cut.txt.gz');
  writeFileSync(cut, body.subarray(0, 12));
  assert.equal(spawnSync(process.execPath, [SCRIPT, cut]).status, 2);
});
