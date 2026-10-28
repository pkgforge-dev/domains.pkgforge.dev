// scripts/measure/kafka-protocol.mjs: requests encode to the exact bytes of
// the protocol; the recorded answers of the real broker parse to the end; a
// batch of every codec the reader supports decodes, and a batch whose CRC-32C,
// compression, magic or record count is wrong throws a KafkaDecodeError of the
// right kind; a response with bytes left over is refused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBatch, varint } from './fixtures/kafka/build.mjs';
import {
  API,
  BATCH_HEADER,
  crc32c,
  decodeBatch,
  encodeRequest,
  fetchBody,
  KafkaDecodeError,
  listOffsetsBody,
  metadataBody,
  ProtocolError,
  parseApiVersions,
  parseFetch,
  parseListOffsets,
  parseMetadata,
  Reader,
  splitBatches,
} from './kafka-protocol.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'kafka');
const recorded = (name) => {
  const b = readFileSync(join(FIXTURES, name));
  assert.equal(b.readInt32BE(0), b.length - 4, `${name} holds one whole frame`);
  return new Reader(b.subarray(8), name);
};
const records = (n, t0 = 1_793_000_000_000) => Array.from({ length: n }, (_, i) => ({ timestamp: t0 + i * 1000, value: JSON.stringify({ i, domain: `d${i}.example` }) }));

test('crc32c matches the Castagnoli check value', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
  assert.equal(crc32c(Buffer.alloc(0)), 0);
});

test('a request carries its size, header v1, client id and body', () => {
  const b = encodeRequest({ apiKey: API.API_VERSIONS, apiVersion: 0, correlationId: 7, clientId: 'ab', body: Buffer.alloc(0) });
  assert.equal(b.toString('hex'), '0000000c' + '0012' + '0000' + '00000007' + '0002' + '6162');
  assert.equal(metadataBody([]).toString('hex'), '00000000');
  const lo = listOffsetsBody([{ topic: 't', partitions: [{ partition: 0, timestamp: -2 }] }]);
  assert.equal(lo.toString('hex'), 'ffffffff' + '00000001' + '000174' + '00000001' + '00000000' + 'fffffffffffffffe');
  const f = fetchBody({ topics: [{ topic: 't', partitions: [{ partition: 1, offset: 42_000_000_000, maxBytes: 1024 }] }], maxWaitMs: 500, minBytes: 1, maxBytes: 2048 });
  assert.equal(f.toString('hex'), 'ffffffff' + '000001f4' + '00000001' + '00000800' + '00' + '00000001' + '000174' + '00000001' + '00000001' + '00000009c7652400' + '00000400');
});

test('the recorded ApiVersions, Metadata and ListOffsets answers of the broker parse to the end', () => {
  const av = parseApiVersions(recorded('api-versions-v0.bin'));
  assert.equal(av.errorCode, 0);
  assert.ok(av.apis.get(API.FETCH).max >= 4, 'the broker serves Fetch v4');
  assert.ok(av.apis.get(API.LIST_OFFSETS).max >= 1);
  const md = parseMetadata(recorded('metadata-v0.bin'));
  assert.equal(md.brokers.length, 1);
  assert.equal(md.brokers[0].port, 9092);
  assert.deepEqual(md.topics.map((t) => t.name).sort(), ['certstream_domains', 'newly_registered_domain']);
  const lo = parseListOffsets(recorded('list-offsets-v1.bin'));
  for (const t of lo) {
    assert.equal(t.partitions[0].errorCode, 0);
    assert.ok(t.partitions[0].offset > 0);
  }
});

test('the recorded Fetch answers split into whole batches and a partial tail, and every batch decodes', () => {
  const cs = parseFetch(recorded('fetch-v4-certstream_domains.bin')).topics[0].partitions[0];
  const nrd = parseFetch(recorded('fetch-v4-newly_registered_domain.bin')).topics[0].partitions[0];
  for (const [name, p] of [
    ['certstream_domains', cs],
    ['newly_registered_domain', nrd],
  ]) {
    const { batches, partial } = splitBatches(p.records);
    assert.ok(batches.length >= 1, name);
    assert.equal(batches.reduce((a, b) => a + b.size, 0) + partial, p.records.length, `${name}: batches and the tail cover the bytes`);
    for (const b of batches) {
      const d = decodeBatch(b.bytes);
      assert.equal(d.records.length, b.recordCount);
      assert.equal(d.lastOffset, b.lastOffset);
      for (const r of d.records) JSON.parse(r.value.toString('utf8'));
    }
  }
  assert.equal(splitBatches(cs.records).batches[0].codec, 'snappy');
  assert.ok(splitBatches(nrd.records).partial > 0, 'the NRD answer ends in a partial batch');
  assert.equal(splitBatches(nrd.records).batches[0].codec, 'none', 'the NRD topic is not compressed');
});

test('a batch of each supported codec decodes to its records, offsets and timestamps', () => {
  for (const codec of ['none', 'gzip', 'snappy', 'zstd']) {
    const recs = records(25);
    const bytes = buildBatch({ baseOffset: 42_000_000_000, records: recs, codec, xerialChunk: codec === 'snappy' ? 256 : 0 });
    const d = decodeBatch(bytes);
    assert.equal(d.codec, codec);
    assert.equal(d.recordCount, 25);
    assert.equal(d.lastOffset, 42_000_000_024);
    assert.deepEqual(
      d.records.map((r) => [r.offset, r.timestamp, r.value.toString('utf8')]),
      recs.map((r, i) => [42_000_000_000 + i, r.timestamp, r.value]),
    );
    const [b] = splitBatches(bytes).batches;
    assert.equal(b.size, bytes.length);
    assert.equal(b.firstTimestamp, recs[0].timestamp);
  }
});

test('a log-append-time batch gives every record its max timestamp, and a control batch is marked', () => {
  const d = decodeBatch(buildBatch({ baseOffset: 0, records: records(3), codec: 'none', logAppendTime: true }));
  assert.deepEqual(
    d.records.map((r) => r.timestamp),
    [1_793_000_002_000, 1_793_000_002_000, 1_793_000_002_000],
  );
  assert.equal(decodeBatch(buildBatch({ baseOffset: 0, records: records(1), codec: 'none', control: true })).isControl, true);
});

test('a batch with a flipped byte, a broken payload, an unknown codec or a wrong count throws its kind', () => {
  const kind = (bytes) => {
    try {
      decodeBatch(bytes);
    } catch (e) {
      assert.ok(e instanceof KafkaDecodeError, e.message);
      return e.kind;
    }
    return 'decoded';
  };
  const good = buildBatch({ baseOffset: 5, records: records(10), codec: 'snappy' });
  assert.equal(kind(good), 'decoded');
  const flipped = Buffer.from(good);
  flipped[flipped.length - 1] ^= 0x01;
  assert.equal(kind(flipped), 'crc');
  assert.equal(kind(good.subarray(0, 40)), 'truncated');
  const magic1 = Buffer.from(good);
  magic1[16] = 1;
  assert.equal(kind(magic1), 'magic');
  // Payloads that pass the CRC (it is recomputed) but do not decode.
  const reCrc = (b) => {
    b.writeUInt32BE(crc32c(b, 21), 17);
    return b;
  };
  const badSnappy = Buffer.concat([good.subarray(0, BATCH_HEADER), Buffer.from([0x20, 0x00, 0x61])]);
  badSnappy.writeInt32BE(badSnappy.length - 12, 8);
  assert.equal(kind(reCrc(badSnappy)), 'snappy');
  const lz4 = buildBatch({ baseOffset: 0, records: records(2), codec: 'lz4' });
  assert.equal(kind(lz4), 'codec');
  const gz = buildBatch({ baseOffset: 0, records: records(2), codec: 'gzip' });
  const badGz = Buffer.from(gz);
  badGz[BATCH_HEADER + 12] ^= 0xff;
  assert.equal(kind(reCrc(badGz)), 'gzip');
  const moreDeclared = Buffer.from(buildBatch({ baseOffset: 0, records: records(4), codec: 'none' }));
  moreDeclared.writeInt32BE(5, 57);
  assert.equal(kind(reCrc(moreDeclared)), 'records');
  const fewerDeclared = Buffer.from(buildBatch({ baseOffset: 0, records: records(4), codec: 'none' }));
  fewerDeclared.writeInt32BE(3, 57);
  assert.equal(kind(reCrc(fewerDeclared)), 'records');
  // A record whose length prefix disagrees with what it holds.
  const recBody = Buffer.concat([Buffer.from([0]), varint(0), varint(0), varint(-1), varint(1), Buffer.from('x'), varint(0)]);
  const badRecord = Buffer.concat([good.subarray(0, BATCH_HEADER), varint(recBody.length + 1), recBody, Buffer.from([0])]);
  badRecord.writeInt32BE(badRecord.length - 12, 8);
  badRecord.writeInt16BE(0, 21);
  badRecord.writeInt32BE(1, 57);
  assert.equal(kind(reCrc(badRecord)), 'records');
});

test('a response with bytes left over, or a count larger than what is left, is refused', () => {
  assert.throws(() => parseApiVersions(new Reader(Buffer.from('0000000000000099', 'hex'), 'av')), ProtocolError);
  assert.throws(() => parseMetadata(new Reader(Buffer.from('7fffffff', 'hex'), 'md')), ProtocolError);
  assert.throws(() => new Reader(Buffer.from('0000', 'hex'), 'short').int32(), ProtocolError);
  assert.throws(() => new Reader(Buffer.from('ffffffffffffffffffffffff', 'hex'), 'varint').varint(), ProtocolError);
  assert.throws(() => new Reader(Buffer.from('7fffffffffffffff', 'hex'), 'int64').int64(), ProtocolError, 'an int64 past 2^53');
  assert.throws(() => splitBatches(Buffer.from('000000000000000000000001ffffffff00', 'hex')), ProtocolError, 'a batch length too small to hold a header');
});

test('varints decode zigzag values of both signs', () => {
  for (const n of [0, -1, 1, 63, -64, 64, 300, -300, 2 ** 31 - 1, -(2 ** 31), 2 ** 40]) {
    const r = new Reader(varint(n), 'v');
    assert.equal(n > 2 ** 31 ? r.varlong() : r.varint(), n);
  }
});
