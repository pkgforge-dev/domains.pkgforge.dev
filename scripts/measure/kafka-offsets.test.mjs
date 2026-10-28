// scripts/measure/kafka-offsets.mjs against the fake broker: offsets.json under
// --data holds every topic's counts and two messages at each end of each
// partition, snappy decoded; nothing is written outside --data.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FakeBroker, makePartition, runCli } from './fixtures/kafka/broker.mjs';

const brokers = [];
const dirs = [];
after(async () => {
  for (const b of brokers) await b.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('kafka-offsets writes the counts and the end samples of every topic to DIR/offsets.json', async () => {
  const now = Date.now();
  const records = Array.from({ length: 40 }, (_, i) => ({ timestamp: now - (40 - i) * 60e3, value: JSON.stringify({ i, domain: `d${i}.example` }) }));
  const b = new FakeBroker({ cs: [makePartition({ baseOffset: 900, records, perBatch: 8 })], empty: [{ batches: [], earliest: 7, hwm: 7 }] });
  await b.start();
  brokers.push(b);
  const data = mkdtempSync(join(tmpdir(), 'kafka-offsets-'));
  dirs.push(data);
  const run = await runCli('scripts/measure/kafka-offsets.mjs', ['--host', '127.0.0.1', '--port', String(b.port), '--data', data]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(readdirSync(data), ['offsets.json']);
  const out = JSON.parse(readFileSync(join(data, 'offsets.json'), 'utf8'));
  assert.ok(Date.parse(out.at) >= now);
  const cs = out.res.cs;
  assert.deepEqual([cs.retained, cs.last_24h, cs.partitions], [40, 40, 1]);
  const p = cs.by_partition[0];
  assert.deepEqual(
    p.sample.map((s) => s.off),
    [900, 901, 938, 939],
  );
  assert.equal(JSON.parse(p.sample[0].v).domain, 'd0.example');
  assert.equal(p.earliest_msg_ts, new Date(records[0].timestamp).toISOString());
  assert.equal(p.latest_msg_ts, new Date(records[39].timestamp).toISOString());
  assert.deepEqual(out.res.empty.by_partition[0].sample, []);
});
