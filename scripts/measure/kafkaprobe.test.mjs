// scripts/measure/kafkaprobe.mjs against the fake broker: one line per
// partition with earliest, latest, retained and the counts of the last hour,
// day and week; an unreachable broker exits 1.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closedPort, FakeBroker, makePartition, runCli } from './fixtures/kafka/broker.mjs';

const brokers = [];
after(async () => {
  for (const b of brokers) await b.stop();
});

test('kafkaprobe prints the offsets and counts of every partition', async () => {
  const now = Date.now();
  // One message every 30 minutes for the last 48 hours, a minute clear of each
  // boundary the probe computes from its own later clock.
  const records = Array.from({ length: 96 }, (_, i) => ({ timestamp: now - (96 - i) * 30 * 60e3 + 60e3, value: `{"i":${i}}` }));
  const b = new FakeBroker({ t: [makePartition({ baseOffset: 1000, records, perBatch: 4, codec: 'none' })] });
  await b.start();
  brokers.push(b);
  const run = await runCli('scripts/measure/kafkaprobe.mjs', ['--host', '127.0.0.1', '--port', String(b.port)]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^tcp connected 127\.0\.0\.1/m);
  assert.match(run.stdout, /^topics t\(ec=0,parts=1\)$/m);
  const line = run.stdout.split('\n').find((l) => l.startsWith('t p0'));
  assert.ok(line, run.stdout);
  assert.match(line, /earliest 1000 latest 1096 retained 96 \| last 1h 2 \| last 24h 48 \| last 7d 96/);
});

test('kafkaprobe exits 1 when the broker cannot be reached', async () => {
  const run = await runCli('scripts/measure/kafkaprobe.mjs', ['--host', '127.0.0.1', '--port', String(await closedPort())]);
  assert.equal(run.code, 1);
});
