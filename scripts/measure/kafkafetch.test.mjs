// scripts/measure/kafkafetch.mjs against the fake broker: one Fetch printed
// batch by batch, snappy decoded, from an offset or from latest-N; a corrupt
// batch exits 1 rather than printing garbage.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { FakeBroker, makePartition, runCli } from './fixtures/kafka/broker.mjs';
import { parseOffsetArg } from './kafkafetch.mjs';

const brokers = [];
after(async () => {
  for (const b of brokers) await b.stop();
});
const recs = (n) => Array.from({ length: n }, (_, i) => ({ timestamp: 1_793_000_000_000 + i, value: `{"domain":"d${i}.example"}` }));

async function start(topics) {
  const b = new FakeBroker(topics);
  await b.start();
  brokers.push(b);
  return ['--host', '127.0.0.1', '--port', String(b.port)];
}

test('kafkafetch prints each batch with its codec and the first records', async () => {
  const flags = await start({ t: [makePartition({ baseOffset: 100, records: recs(60), perBatch: 20 })] });
  const run = await runCli('scripts/measure/kafkafetch.mjs', ['t', 'latest-25', '100000', ...flags]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^Fetch\(1\) versions \{"min":0,"max":16\}/m);
  assert.match(run.stdout, /hwm 160/);
  assert.match(run.stdout, /^ rec 135 key null val \{"domain":"d35\.example"\}$/m, 'the first record shown is the one asked for');
  assert.equal((run.stdout.match(/^ batch magic 2 compression snappy records 20/gm) ?? []).length, 2);
  assert.match(run.stdout, /^decoded records 40 /m);
  const at = await runCli('scripts/measure/kafkafetch.mjs', ['t', '100', ...flags]);
  assert.equal(at.code, 0, at.stderr);
  assert.match(at.stdout, /^ rec 100 /m);
});

test('kafkafetch exits 1 on a corrupt batch and 2 on bad arguments', async () => {
  const flags = await start({ t: [makePartition({ records: recs(10), perBatch: 10, corrupt: [0] })] });
  const run = await runCli('scripts/measure/kafkafetch.mjs', ['t', '0', ...flags]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /crc: CRC-32C/);
  assert.equal((await runCli('scripts/measure/kafkafetch.mjs', ['t'])).code, 2);
  assert.equal((await runCli('scripts/measure/kafkafetch.mjs', ['t', 'latest'])).code, 2);
  assert.deepEqual(parseOffsetArg('latest-5000'), { latestMinus: 5000 });
  assert.deepEqual(parseOffsetArg('42'), { offset: 42 });
});
