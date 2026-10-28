// scripts/measure/kafka-sample.mjs against the fake broker: samples.json under
// --data holds, per topic and partition, the newest messages' count, their
// mean value size in bytes and four samples; a topic the broker does not serve
// exits 1.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FakeBroker, makePartition, runCli } from './fixtures/kafka/broker.mjs';
import { describe } from './kafka-sample.mjs';

const brokers = [];
const dirs = [];
after(async () => {
  for (const b of brokers) await b.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const recs = (n, v) => Array.from({ length: n }, (_, i) => ({ timestamp: 1_793_000_000_000 + i, value: v(i) }));

test('kafka-sample writes the size and samples of the newest messages to DIR/samples.json', async () => {
  const b = new FakeBroker({
    x: [makePartition({ baseOffset: 10_000, records: recs(500, () => 'é'.repeat(10)), perBatch: 50 })],
    y: [makePartition({ records: recs(20, (i) => `{"i":${i}}`), perBatch: 5, codec: 'gzip' })],
  });
  await b.start();
  brokers.push(b);
  const data = mkdtempSync(join(tmpdir(), 'kafka-sample-'));
  dirs.push(data);
  const run = await runCli('scripts/measure/kafka-sample.mjs', ['--host', '127.0.0.1', '--port', String(b.port), '--data', data, '--topics', 'x,y']);
  assert.equal(run.code, 0, run.stderr);
  const out = JSON.parse(readFileSync(join(data, 'samples.json'), 'utf8'));
  assert.equal(out.x[0].latest, 10_500);
  assert.equal(out.x[0].n, 300, 'the 300 messages before the newest');
  assert.equal(out.x[0].bytes_per_msg, 20, 'ten two-byte characters are 20 bytes');
  assert.equal(out.x[0].sample.length, 4);
  assert.equal(out.x[0].sample[0].off, 10_200);
  assert.equal(out.y[0].n, 20);
  const missing = await runCli('scripts/measure/kafka-sample.mjs', ['--host', '127.0.0.1', '--port', String(b.port), '--data', data, '--topics', 'nope']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /does not serve nope/);
});

test('describe gives a null mean for no messages', () => {
  assert.deepEqual(describe([]), { n: 0, bytes_per_msg: null, sample: [] });
});
