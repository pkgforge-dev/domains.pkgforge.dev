// scripts/measure/kafka-record.mjs against the fake broker: each response is
// written whole, size prefix included, and recorded.json names its request,
// size and sha256; the committed fixtures match their own recorded.json.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FakeBroker, runCli, zonestreamLike } from './fixtures/kafka/broker.mjs';
import { parseFetch, Reader, splitBatches } from './kafka-protocol.mjs';

const brokers = [];
const dirs = [];
after(async () => {
  for (const b of brokers) await b.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function checkManifest(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf8'));
  for (const [file, meta] of Object.entries(manifest.files)) {
    const b = readFileSync(join(dir, file));
    assert.equal(b.length, meta.bytes, file);
    assert.equal(sha256(b), meta.sha256, file);
    assert.equal(b.readInt32BE(0), b.length - 4, `${file} is one whole frame`);
  }
  return manifest;
}

test('kafka-record writes whole response frames and a manifest of them', async () => {
  const b = new FakeBroker(zonestreamLike(Date.now()));
  await b.start();
  brokers.push(b);
  const data = mkdtempSync(join(tmpdir(), 'kafka-record-'));
  dirs.push(data);
  const run = await runCli('scripts/measure/kafka-record.mjs', ['--host', '127.0.0.1', '--port', String(b.port), '--data', data]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(readdirSync(data).sort(), [
    'api-versions-v0.bin',
    'fetch-v4-certstream_domains.bin',
    'fetch-v4-newly_registered_domain.bin',
    'list-offsets-v1.bin',
    'metadata-v0.bin',
    'recorded.json',
  ]);
  const manifest = checkManifest(data);
  assert.equal(manifest.files['fetch-v4-certstream_domains.bin'].request.topics[0].topic, 'certstream_domains');
  const f = readFileSync(join(data, 'fetch-v4-certstream_domains.bin'));
  const p = parseFetch(new Reader(f.subarray(8), 'fetch')).topics[0].partitions[0];
  assert.ok(splitBatches(p.records).batches.length >= 1);
});

test('kafka-record writes no fixture from a Fetch the broker refused', async () => {
  const b = new FakeBroker(zonestreamLike(Date.now()), { fetchError: { topic: 'certstream_domains', partition: 0, code: 1 } });
  await b.start();
  brokers.push(b);
  const data = mkdtempSync(join(tmpdir(), 'kafka-record-'));
  dirs.push(data);
  const run = await runCli('scripts/measure/kafka-record.mjs', ['--host', '127.0.0.1', '--port', String(b.port), '--data', data]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /OFFSET_OUT_OF_RANGE/);
  assert.equal(readdirSync(data).includes('fetch-v4-certstream_domains.bin'), false);
  assert.equal(readdirSync(data).includes('recorded.json'), false);
});

test('the committed fixtures match their recorded.json', () => {
  const manifest = checkManifest(join(import.meta.dirname, 'fixtures', 'kafka'));
  assert.equal(manifest.host, 'kafka.zonestream.openintel.nl');
  assert.equal(Object.keys(manifest.files).length, 5);
});
