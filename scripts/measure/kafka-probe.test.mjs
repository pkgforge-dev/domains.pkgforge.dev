// scripts/measure/kafka-probe.mjs against the fake broker: the API ranges, the
// brokers, the topics, and the earliest and latest offset of each partition;
// an unreachable broker exits 1.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closedPort, FakeBroker, makePartition, runCli } from './fixtures/kafka/broker.mjs';

const brokers = [];
after(async () => {
  for (const b of brokers) await b.stop();
});
const series = (n) => Array.from({ length: n }, (_, i) => ({ timestamp: 1_793_000_000_000 + i * 1000, value: `{"i":${i}}` }));

test('kafka-probe prints the API ranges and the offsets of every partition', async () => {
  const b = new FakeBroker({ a: [makePartition({ baseOffset: 5, records: series(12) })], b: [0, 1].map((p) => makePartition({ baseOffset: p * 50, records: series(3) })) });
  await b.start();
  brokers.push(b);
  const run = await runCli('scripts/measure/kafka-probe.mjs', ['--host', '127.0.0.1', '--port', String(b.port)]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Metadata \[0,12\] ListOffsets \[0,8\] Fetch \[0,16\]/);
  assert.match(run.stdout, /^a earliest \[\{"pid":0,"pe":0,"ts":"-1","off":"5"\}\]$/m);
  assert.match(run.stdout, /^a latest \[\{"pid":0,"pe":0,"ts":"-1","off":"17"\}\]$/m);
  assert.match(run.stdout, /^b latest \[\{"pid":0,"pe":0,"ts":"-1","off":"3"\},\{"pid":1,"pe":0,"ts":"-1","off":"53"\}\]$/m);
});

test('kafka-probe exits 1 when the broker cannot be reached', async () => {
  const run = await runCli('scripts/measure/kafka-probe.mjs', ['--host', '127.0.0.1', '--port', String(await closedPort())]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /ECONNREFUSED/);
});
