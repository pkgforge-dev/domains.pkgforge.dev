// scripts/measure/kafka-client.mjs against the fake broker of
// fixtures/kafka/broker.mjs: the four requests, a range read whose counts
// describe whole batches, a read that stops at its stop offset, at the head and
// at the wall cap, a corrupt batch counted rather than lost, responses split
// into single bytes, and the failures (a wrong correlation id, an unanswered
// request, a broker error) that must reject rather than hang or guess.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildBatch } from './fixtures/kafka/build.mjs';
import { closedPort, FakeBroker, makePartition } from './fixtures/kafka/broker.mjs';
import { consumeRange, FrameReader, fetchRecords, KafkaClient, newDecodeStats, offsetSummary, rangesBetween, rangesFromEarliest, reach, userTopics } from './kafka-client.mjs';
import { KafkaError } from './kafka-protocol.mjs';

const brokers = [];
after(async () => {
  for (const b of brokers) await b.stop();
});

const T0 = Date.parse('2026-10-28T00:00:00Z');
const series = (n, step = 1000) => Array.from({ length: n }, (_, i) => ({ timestamp: T0 + i * step, value: JSON.stringify({ i }) }));

async function broker(topics, faults) {
  const b = new FakeBroker(topics, faults);
  await b.start();
  brokers.push(b);
  return b;
}

const connect = (b, extra = {}) => KafkaClient.connect({ host: '127.0.0.1', port: b.port, ...extra });

test('reach reports an open port with its time and a closed port with its error code', async () => {
  const b = await broker({});
  const open = await reach('127.0.0.1', b.port, 5000);
  assert.equal(open.ok, true);
  assert.equal(typeof open.ms, 'number');
  const closed = await reach('127.0.0.1', await closedPort(), 5000);
  assert.deepEqual({ ok: closed.ok, error: closed.error }, { ok: false, error: 'ECONNREFUSED' });
  assert.equal(Object.keys(open).includes('address'), false, 'no address is recorded');
});

test('the client speaks ApiVersions, Metadata, ListOffsets and Fetch with its client id', async () => {
  const b = await broker({ t: [makePartition({ baseOffset: 100, records: series(30), perBatch: 10 })] });
  const c = await connect(b);
  try {
    const apis = await c.apiVersions();
    assert.equal(apis.get(1).max, 16);
    const md = await c.metadata();
    assert.deepEqual(
      userTopics(md).map((t) => [t.name, t.partitions.length]),
      [['t', 1]],
    );
    const lo = await c.listOffsets([
      {
        topic: 't',
        partitions: [{ partition: 0, timestamp: -2 }],
      },
    ]);
    assert.equal(lo[0].partitions[0].offset, 100);
    const f = await fetchRecords(c, 't', 0, 115, 1 << 20);
    assert.equal(f.highWatermark, 130);
    assert.deepEqual(
      f.records.map((r) => r.offset),
      Array.from({ length: 15 }, (_, i) => 115 + i),
      'the records at and after the offset; the batch holding it starts at 110',
    );
    assert.ok(b.requests.every((r) => r.clientId === 'domains.pkgforge.dev'));
  } finally {
    c.close();
  }
});

test('the client refuses a broker that cannot speak Fetch v4', async () => {
  const b = await broker(
    {},
    {
      apis: [
        { key: 1, min: 5, max: 16 },
        { key: 2, min: 0, max: 8 },
        { key: 3, min: 0, max: 12 },
        { key: 18, min: 0, max: 4 },
      ],
    },
  );
  const c = await connect(b);
  try {
    await assert.rejects(c.apiVersions(), /API 1 at 5\.\.16/);
  } finally {
    c.close();
  }
});

test('a range read counts whole batches: messages and wire bytes describe the same batches', async () => {
  const part = makePartition({ baseOffset: 1000, records: series(100), perBatch: 10 });
  const b = await broker({ t: [part] });
  const c = await connect(b);
  try {
    const stats = newDecodeStats();
    const r = await consumeRange(c, { topic: 't', ranges: [{ partition: 0, start: 1015, stop: 1042 }], stats, fetchBytes: 64 });
    // Batches 1010, 1020, 1030 and 1040 reach into [1015, 1042).
    assert.equal(r.batches, 4);
    assert.equal(r.messages, 40);
    assert.equal(r.first_offset, 1010);
    assert.equal(r.last_offset, 1049);
    assert.equal(
      r.wire_bytes,
      part.batches.slice(1, 5).reduce((a, x) => a + x.bytes.length, 0),
    );
    assert.equal(
      r.raw_bytes,
      Array.from({ length: 40 }, (_, i) => JSON.stringify({ i: 10 + i }).length).reduce((a, n) => a + n, 0),
    );
    assert.equal(r.ended_by, 'window');
    assert.ok(r.fetches >= 4, 'a 64-byte limit returns one batch a fetch');
    assert.ok(r.bytes > r.wire_bytes, 'socket bytes include the framing');
    assert.deepEqual(stats.by_codec, { snappy: 4 });
  } finally {
    c.close();
  }
});

test('a range read sizes its fetches to what is left, so it reads little past its stop offset', async () => {
  // About 1.4 MB of log; the range is the first three quarters of it.
  const part = makePartition({ records: series(40000), perBatch: 10, codec: 'none' });
  const total = part.batches.reduce((a, x) => a + x.bytes.length, 0);
  const b = await broker({ t: [part] });
  const c = await connect(b);
  try {
    const r = await consumeRange(c, { topic: 't', ranges: [{ partition: 0, start: 0, stop: 30000 }] });
    assert.equal(r.messages, 30000);
    assert.ok(r.bytes > r.wire_bytes);
    assert.ok(r.bytes - r.wire_bytes < 0.1 * r.wire_bytes + (64 << 10), `read ${r.bytes} bytes for ${r.wire_bytes} counted, of ${total} in the log`);
    assert.ok(r.fetches >= 2, 'the first fetch asks for 256 KiB at most');
  } finally {
    c.close();
  }
});

test('a range read stops at the head when the range runs past it, and at the wall cap', async () => {
  const b = await broker({ t: [makePartition({ records: series(50), perBatch: 10 })] });
  const c = await connect(b);
  try {
    const head = await consumeRange(c, { topic: 't', ranges: [{ partition: 0, start: 20, stop: 500 }] });
    assert.equal(head.ended_by, 'head');
    assert.equal(head.messages, 30);
    const wall = await consumeRange(c, { topic: 't', ranges: [{ partition: 0, start: 0, stop: 50 }], wallCapMs: -1 });
    assert.equal(wall.ended_by, 'wall');
    assert.equal(wall.fetches, 0);
    const empty = await consumeRange(c, { topic: 't', ranges: [{ partition: 0, start: 30, stop: 30 }] });
    assert.deepEqual([empty.messages, empty.ended_by], [0, 'window']);
  } finally {
    c.close();
  }
});

test('a corrupt batch is counted as a failure of its codec and the read goes on past it', async () => {
  const b = await broker({ t: [makePartition({ records: series(40), perBatch: 10, corrupt: [10] })] });
  const c = await connect(b);
  try {
    const stats = newDecodeStats();
    const r = await consumeRange(c, { topic: 't', ranges: [{ partition: 0, start: 0, stop: 40 }], stats });
    assert.deepEqual([r.batches, r.messages, r.failed_batches], [3, 30, 1]);
    assert.deepEqual(stats.failures, { crc: 1 });
    assert.deepEqual(stats.failed_by_codec, { snappy: 1 });
    assert.match(r.first_failure, /offset 10: crc/);
  } finally {
    c.close();
  }
});

test('a range read covers every partition of a topic', async () => {
  const b = await broker({ t: [0, 1, 2].map((p) => makePartition({ baseOffset: p * 100, records: series(20), perBatch: 5 })) });
  const c = await connect(b);
  try {
    const ranges = await rangesBetween(c, 't', [0, 1, 2], T0 + 5000, T0 + 15000);
    assert.deepEqual(
      ranges.map((x) => [x.start, x.stop]),
      [
        [5, 15],
        [105, 115],
        [205, 215],
      ],
    );
    const r = await consumeRange(c, { topic: 't', ranges });
    assert.equal(r.messages, 30);
    const early = await rangesFromEarliest(c, 't', [0, 1, 2], T0, 3000);
    assert.deepEqual(
      early.map((x) => [x.start, x.stop]),
      [
        [0, 3],
        [100, 103],
        [200, 203],
      ],
    );
    const future = await rangesBetween(c, 't', [0], T0 + 10e6, T0 + 20e6);
    assert.deepEqual([future[0].start, future[0].stop], [20, 20], 'a window past the newest message is empty at the head');
  } finally {
    c.close();
  }
});

test('the offset summary counts the messages since each time and reads the earliest timestamp', async () => {
  const now = T0 + 99 * 60e3;
  const b = await broker({ t: [makePartition({ baseOffset: 10, records: series(100, 60e3), perBatch: 10 })] });
  const c = await connect(b);
  try {
    const s = (await offsetSummary(c, [{ name: 't', partitions: [{ partition: 0 }] }], now)).t;
    assert.equal(s.retained, 100);
    assert.equal(s.last_1h, 61, 'minutes 39 to 99 inclusive');
    assert.equal(s.last_24h, 100);
    assert.equal(s.earliest_ts, new Date(T0).toISOString());
    assert.equal(s.last_24h_capped, true, 'the earliest message is younger than 24 h');
    const later = (await offsetSummary(c, [{ name: 't', partitions: [{ partition: 0 }] }], now + 3 * 3600e3)).t;
    assert.equal(later.last_1h, 0, 'no message in the last hour counts 0');
  } finally {
    c.close();
  }
});

test('responses written one byte at a time are framed whole', async () => {
  const b = await broker({ t: [makePartition({ records: series(30), perBatch: 10 })] }, { chunkSize: 1 });
  const c = await connect(b);
  try {
    const [apis, md] = await Promise.all([c.apiVersions(), c.metadata()]);
    assert.equal(apis.size, 4);
    assert.equal(md.topics.length, 1);
    const r = await consumeRange(c, { topic: 't', ranges: [{ partition: 0, start: 0, stop: 30 }] });
    assert.equal(r.messages, 30);
  } finally {
    c.close();
  }
});

test('a wrong correlation id, an unanswered request and a broker error reject', async () => {
  const wrong = await broker({}, { wrongCorrelation: true });
  const c1 = await connect(wrong);
  await assert.rejects(c1.apiVersions(), /correlation id 1001/);
  await assert.rejects(c1.metadata(), /correlation id 1001/, 'the client refuses requests once the stream is broken');
  c1.close();
  const silent = await broker({}, { silentApi: 18 });
  const c2 = await connect(silent, { requestTimeoutMs: 200 });
  await assert.rejects(c2.apiVersions(), /timed out after 200 ms/);
  c2.close();
  const failing = await broker({ t: [makePartition({ records: series(10) })] }, { fetchError: { topic: 't', partition: 0, code: 6 } });
  const c3 = await connect(failing);
  await assert.rejects(consumeRange(c3, { topic: 't', ranges: [{ partition: 0, start: 0, stop: 10 }] }), (e) => e instanceof KafkaError && e.code === 6 && /NOT_LEADER_OR_FOLLOWER/.test(e.message));
  c3.close();
  await assert.rejects(KafkaClient.connect({ host: '127.0.0.1', port: await closedPort() }), /ECONNREFUSED/);
});

test('the frame reader joins frames split anywhere and refuses a size below the correlation id', () => {
  const frames = [];
  const fr = new FrameReader((f, n) => frames.push([f.toString('hex'), n]));
  const bytes = Buffer.from('00000005' + '0000000141' + '00000004' + '00000002', 'hex');
  for (const b of bytes) fr.push(Buffer.from([b]));
  assert.deepEqual(frames, [
    ['0000000141', 9],
    ['00000002', 8],
  ]);
  assert.throws(() => new FrameReader(() => {}).push(Buffer.from('00000002', 'hex')), /less than its correlation id/);
});

test('a broker that answers nothing below its high watermark five times in a row stops the read', async () => {
  const b = await broker({ t: [makePartition({ records: series(40), perBatch: 10 })] }, { emptyFetch: true });
  const c = await connect(b);
  try {
    await assert.rejects(consumeRange(c, { topic: 't', ranges: [{ partition: 0, start: 0, stop: 40 }], wallCapMs: 60e3 }), /Fetch t returned nothing below the high watermark five times in a row/);
    assert.equal(b.requests.filter((r) => r.apiKey === 1).length, 5);
  } finally {
    c.close();
  }
});

test('a control batch is read past and adds no message', async () => {
  const part = makePartition({ records: series(10), perBatch: 10 });
  const control = buildBatch({ baseOffset: 10, records: [{ timestamp: T0 + 10_000, key: Buffer.from([0, 0, 0, 0]), value: Buffer.from([0, 0, 0, 0, 0, 0]) }], control: true, codec: 'none' });
  part.batches.push({ baseOffset: 10, lastOffset: 10, timestamps: [T0 + 10_000], bytes: control });
  const tail = makePartition({ baseOffset: 11, records: series(5).map((r, i) => ({ ...r, timestamp: T0 + 11_000 + i * 1000 })), perBatch: 5 });
  part.batches.push(...tail.batches);
  part.hwm = 16;
  const b = await broker({ t: [part] });
  const c = await connect(b);
  try {
    const r = await consumeRange(c, { topic: 't', ranges: [{ partition: 0, start: 0, stop: 16 }] });
    assert.equal(r.batches, 3);
    assert.equal(r.control_batches, 1);
    assert.equal(r.messages, 15);
    assert.equal(r.ended_by, 'window');
  } finally {
    c.close();
  }
});

test('a range that ends after the newest message reads to the head, and an error from a record callback is not a decode failure', async () => {
  const b = await broker({ t: [makePartition({ records: series(20), perBatch: 5 })] });
  const c = await connect(b);
  try {
    // The start is a message; the stop is past the newest one, where ListOffsets answers -1.
    const tail = await rangesBetween(c, 't', [0], T0 + 5000, T0 + 10e6);
    assert.deepEqual([tail[0].start, tail[0].stop], [5, 20]);
    const r = await consumeRange(c, { topic: 't', ranges: tail });
    assert.equal(r.messages, 15);
    const stats = newDecodeStats();
    await assert.rejects(
      consumeRange(c, {
        topic: 't',
        ranges: [{ partition: 0, start: 0, stop: 20 }],
        stats,
        onRecord: () => {
          throw new TypeError('planted in the callback');
        },
      }),
      (e) => e instanceof TypeError && /planted/.test(e.message),
    );
    assert.deepEqual(stats.failures, {});
  } finally {
    c.close();
  }
});
