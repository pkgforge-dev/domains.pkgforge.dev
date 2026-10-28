// scripts/measure/snappy.mjs: hand-written blocks of every element type decode
// to their bytes; a block from an independent compressor round-trips; every
// malformed input throws SnappyError rather than returning short or wrong
// bytes; and the real producer's xerial stream, recorded from the broker,
// decodes into exactly the records its batch declares.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { snappyCompress, xerial } from './fixtures/kafka/build.mjs';
import { decodeBatch, parseFetch, Reader, splitBatches } from './kafka-protocol.mjs';
import { isXerial, SnappyError, snappyKafka, snappyRaw } from './snappy.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'kafka');
const bytes = (...xs) => Uint8Array.from(xs);
const text = (u8) => Buffer.from(u8).toString('latin1');

test('snappy decodes a literal, a 1-byte-offset copy and an overlapping run', () => {
  // length 9: literal "abc", copy offset 3 length 4 ("abca"), copy offset 1 length... via type 2
  const block = bytes(9, 2 << 2, 0x61, 0x62, 0x63, 1 | (0 << 2), 3, 2 | (1 << 2), 1, 0);
  assert.equal(text(snappyRaw(block)), 'abcabcaaa');
});

test('snappy decodes the long literal forms and a 4-byte-offset copy', () => {
  for (const n of [60, 61, 255, 256, 300, 70000]) {
    const data = randomBytes(n);
    const out = snappyRaw(snappyCompress(data));
    assert.deepEqual(Buffer.from(out), data, `literal of ${n} bytes`);
  }
  const data = Buffer.from('0123456789'.repeat(50));
  const c4 = snappyCompress(data, { copy4: true });
  // A 2-byte length varint, a literal of the first 10 bytes, then the copy.
  assert.equal(c4[2], 9 << 2, 'a literal of 10 bytes comes first');
  assert.equal(c4[13] & 3, 3, 'the element after it is a 4-byte-offset copy');
  assert.deepEqual(Buffer.from(snappyRaw(c4)), data);
});

test('snappy round-trips data from an independent compressor, literals split and whole', () => {
  const samples = [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    Buffer.from(JSON.stringify({ domain_list: Array.from({ length: 200 }, (_, i) => `h${i}.example.com`) })),
    randomBytes(5000),
  ];
  for (const s of samples) {
    assert.deepEqual(Buffer.from(snappyRaw(snappyCompress(s))), s);
    assert.deepEqual(Buffer.from(snappyRaw(snappyCompress(s, { maxLiteral: 7 }))), s);
  }
});

test('snappy refuses a truncated, overflowing or out-of-range block', () => {
  const cases = [
    ['an empty input', bytes()],
    ['a varint that never ends', bytes(0x80, 0x80)],
    ['a varint longer than 5 bytes', bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x01)],
    ['a length far above the input', bytes(0xff, 0xff, 0x03, 0)],
    ['a literal past the input', bytes(4, 3 << 2, 0x61)],
    ['a literal past the declared length', bytes(1, 1 << 2, 0x61, 0x62)],
    ['a long literal length past the input', bytes(70, 61 << 2, 1)],
    ['a copy before the start', bytes(4, 0 << 2, 0x61, 1 | (0 << 2), 2)],
    ['a copy with offset 0', bytes(5, 0 << 2, 0x61, 1 | (0 << 2), 0)],
    ['a copy past the declared length', bytes(3, 0 << 2, 0x61, 1 | (0 << 2), 1)],
    ['a 2-byte-offset copy cut short', bytes(3, 0 << 2, 0x61, 2, 1)],
    ['a 4-byte-offset copy cut short', bytes(3, 0 << 2, 0x61, 3, 1, 0)],
    ['fewer bytes than declared', bytes(5, 1 << 2, 0x61, 0x62)],
  ];
  for (const [name, block] of cases) assert.throws(() => snappyRaw(block), SnappyError, name);
});

test('snappy reads a xerial stream of several blocks and refuses a broken one', () => {
  const a = Buffer.from('first block, first block, first block');
  const b = Buffer.from('second block');
  const stream = xerial([snappyCompress(a), snappyCompress(b)]);
  assert.ok(isXerial(stream));
  assert.equal(text(snappyKafka(stream)), a.toString('latin1') + b.toString('latin1'));
  assert.equal(text(snappyKafka(snappyCompress(a))), a.toString('latin1'), 'a raw block without the header');
  assert.throws(() => snappyKafka(stream.subarray(0, stream.length - 3)), SnappyError, 'a chunk cut short');
  assert.throws(() => snappyKafka(Buffer.concat([stream, Buffer.from([0, 0])])), SnappyError, 'trailing bytes');
  assert.throws(() => snappyKafka(Buffer.concat([stream.subarray(0, 16), Buffer.from([0, 0, 0, 0])])), SnappyError, 'a zero-length chunk');
});

test('snappy decodes the recorded certstream_domains batch of the real producer', () => {
  const raw = readFileSync(join(FIXTURES, 'fetch-v4-certstream_domains.bin'));
  const res = parseFetch(new Reader(raw.subarray(8), 'recorded fetch'));
  const { batches } = splitBatches(res.topics[0].partitions[0].records);
  assert.ok(batches.length >= 1);
  const payload = batches[0].bytes.subarray(61);
  assert.equal(batches[0].codec, 'snappy');
  assert.ok(isXerial(payload), 'the Java producer writes the xerial stream');
  const d = decodeBatch(batches[0].bytes);
  assert.equal(d.records.length, batches[0].recordCount);
  for (const r of d.records) assert.ok(Array.isArray(JSON.parse(r.value.toString('utf8')).domain_list));
});
