// scripts/measure/kafka-cli.mjs: the common flags and their defaults, the data
// directory under the repository root, refusal of a bad flag as a UsageError,
// and an atomic write that leaves no temporary file behind.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from '../files.mjs';
import { commonArgs, DEFAULT_DATA, intArg, positiveArg, resolveData, timeArg, UsageError, writeJson } from './kafka-cli.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('the common flags default to the Zonestream broker on 9092 and the gitignored data directory', () => {
  const c = commonArgs([]);
  assert.equal(c.host, 'kafka.zonestream.openintel.nl');
  assert.equal(c.port, 9092);
  assert.equal(c.data, join(ROOT, DEFAULT_DATA));
  assert.equal(DEFAULT_DATA, '.tmp/measure/DOM-004');
  const d = commonArgs(['--host', '127.0.0.1', '--port', '19092', '--data', 'some/dir', 'pos']);
  assert.deepEqual([d.host, d.port, d.data, d.args._], ['127.0.0.1', 19092, resolve('some/dir'), ['pos']]);
  assert.equal(resolveData(undefined), join(ROOT, DEFAULT_DATA));
});

test('a bad flag is a UsageError', () => {
  assert.throws(() => commonArgs(['--port', 'x']), UsageError);
  assert.throws(() => commonArgs(['--port', '0']), UsageError);
  assert.throws(() => commonArgs(['--host']), UsageError);
  assert.throws(() => commonArgs(['--data']), UsageError);
  assert.throws(() => intArg('1.5', '--n'), UsageError);
  assert.throws(() => intArg('', '--n'), UsageError);
  assert.equal(intArg('7', '--n'), 7);
  assert.throws(() => positiveArg('0', '--m'), UsageError);
  assert.equal(positiveArg('2.5', '--m'), 2.5);
  assert.throws(() => timeArg('yesterday', '--t'), UsageError);
  assert.equal(timeArg('2026-10-27T12:00:00Z', '--t'), Date.parse('2026-10-27T12:00:00Z'));
});

test('writeJson writes whole through a temporary file it removes', () => {
  const d = mkdtempSync(join(tmpdir(), 'kafka-cli-'));
  dirs.push(d);
  const file = join(d, 'deep', 'result.json');
  writeJson(file, { a: 1 });
  writeJson(file, { a: 2 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 });
  assert.deepEqual(readdirSync(join(d, 'deep')), ['result.json']);
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false);
});
