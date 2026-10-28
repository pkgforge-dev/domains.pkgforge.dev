// scripts/measure/kafka-window.mjs against the fake broker: the window between
// two times is read by offsets, and the three files design A wrote land under
// --data with design A's counts; a message that is not JSON is counted; the
// name hash is design A's, bit for bit.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { certValue, FakeBroker, makePartition, runCli } from './fixtures/kafka/broker.mjs';
import { h53, hashNames, normaliseName } from './kafka-window.mjs';

const brokers = [];
const dirs = [];
after(async () => {
  for (const b of brokers) await b.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-27T12:00:00Z');

test('kafka-window writes the names, their hashes and design A stat for the window', async () => {
  // A message every 10 s from 11:55 to 12:10; message 40 is not JSON.
  const records = Array.from({ length: 90 }, (_, i) => {
    const ts = T0 - 300e3 + i * 10e3;
    return { timestamp: ts, value: i === 40 ? 'not json' : certValue(i, ts) };
  });
  const b = new FakeBroker({ certstream_domains: [makePartition({ baseOffset: 5000, records, perBatch: 10 })] });
  await b.start();
  brokers.push(b);
  const data = mkdtempSync(join(tmpdir(), 'kafka-window-'));
  dirs.push(data);
  const run = await runCli('scripts/measure/kafka-window.mjs', ['2026-10-27T12:00:00Z', '2026-10-27T12:05:00Z', 'w1', '--host', '127.0.0.1', '--port', String(b.port), '--data', data]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(readdirSync(data).sort(), ['w1.names.f64', 'w1.names.txt', 'w1.stat.json']);
  const stat = JSON.parse(readFileSync(join(data, 'w1.stat.json'), 'utf8'));
  // Offsets 5030 to 5059 hold 12:00:00 to 12:04:50; whole batches of ten.
  assert.equal(stat.messages, 30);
  assert.equal(stat.json_errors, 1);
  assert.deepEqual(stat.window, ['2026-10-27T12:00:00Z', '2026-10-27T12:05:00Z']);
  assert.equal(stat.first_seen, '2026-10-27T12:00:00.000Z');
  assert.equal(stat.ended_by, 'window');
  const names = readFileSync(join(data, 'w1.names.txt'), 'utf8').split('\n');
  assert.equal(names.length, stat.distinct_names);
  assert.ok(names.includes('h30.example.com'));
  assert.ok(names.includes('w30.example.org'), 'the wildcard label is dropped');
  const raw = readFileSync(join(data, 'w1.names.f64'));
  const f64 = new Float64Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  assert.equal(f64.length, names.length);
  assert.ok(
    f64.every((x, i) => i === 0 || f64[i - 1] <= x),
    'sorted',
  );
});

test('kafka-window refuses a reversed window, a bad name and a missing argument', async () => {
  assert.equal((await runCli('scripts/measure/kafka-window.mjs', ['2026-10-27T12:05:00Z', '2026-10-27T12:00:00Z', 'x'])).code, 2);
  assert.equal((await runCli('scripts/measure/kafka-window.mjs', ['2026-10-27T12:00:00Z', '2026-10-27T12:05:00Z', '../x'])).code, 2);
  assert.equal((await runCli('scripts/measure/kafka-window.mjs', ['2026-10-27T12:00:00Z'])).code, 2);
});

// docs/research/2026-10-27-design-a/scripts/kafka-window.mjs's h53, as it ran.
// biome-ignore format: kept on one line as design A wrote it
function designAh53(s) { let a = 0x811c9dc5, b = 0x01000193 ^ 0x9747b28c; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15; } return (a >>> 0) + (b & 0x1fffff) * 4294967296; }

test('the name hash and normalisation are design A', () => {
  for (const s of ['', 'a', 'example.com', 'h12345.example.org', 'xn--bcher-kva.example', 'é.example']) assert.equal(h53(s), designAh53(s), s);
  assert.equal(normaliseName('*.Example.COM'), 'example.com');
  assert.equal(normaliseName('a.example'), 'a.example');
  assert.deepEqual(
    [...hashNames(new Set(['b', 'a']))],
    [h53('a'), h53('b')].sort((x, y) => x - y),
  );
});
