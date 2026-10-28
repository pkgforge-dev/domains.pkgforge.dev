// The blocks of scripts/measure/blockenc.mjs: a round trip across block
// boundaries, the refusals of the encoder and the decoder, and a pack checked
// against its sorted file, including planted defects in either.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { BlockError, createBlockEncoder, decodeBlock, verifyPack, writePack } from './blockenc.mjs';

const SCRIPT = fileURLToPath(new URL('./blockenc.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'thc-blockenc-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const RECORDS = [
  ['com.example', 3],
  ['com.example-x', 1],
  ['com.example.api', 1],
  ['com.example.www', 2],
  ['jp.kawasaki.city', 1],
  ['np.com.example', 1],
  ['np.com.example.api', 3],
];

function sortedFile(name, records) {
  const lines = [];
  for (const [key, flags] of records) {
    if (flags & 1) lines.push(`${key}\t0`);
    if (flags & 2) lines.push(`${key}\t1`);
  }
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

test('thc blockenc: a round trip across block boundaries keeps every key and flag', () => {
  const blocks = [];
  const enc = createBlockEncoder({
    perBlock: 3,
    onBlock: (packed, info) => {
      blocks.push({ packed, info: { firstKey: info.firstKey, count: info.count } });
      return null;
    },
  });
  for (const [k, f] of RECORDS) enc.add(k, f);
  enc.finish();
  assert.deepEqual(
    blocks.map((b) => b.info),
    [
      { firstKey: 'com.example', count: 3 },
      { firstKey: 'com.example.www', count: 3 },
      { firstKey: 'np.com.example.api', count: 1 },
    ],
  );
  const decoded = blocks.flatMap((b) => {
    const d = decodeBlock(b.packed);
    return d.keys.map((k, i) => [k, d.flags[i]]);
  });
  assert.deepEqual(decoded, RECORDS);
  assert.equal(enc.stats().records, 7);
  assert.equal(enc.stats().blocks, 3);
});

test('thc blockenc: the encoder refuses a key that does not rise, an empty key and bad flags', () => {
  const enc = () => createBlockEncoder({ perBlock: 4, onBlock: () => null });
  const e1 = enc();
  e1.add('com.b', 1);
  assert.throws(() => e1.add('com.a', 1), BlockError);
  assert.throws(() => e1.add('com.b', 1), BlockError);
  assert.throws(() => enc().add('', 1), BlockError);
  assert.throws(() => enc().add('com.a', 0), BlockError);
  assert.throws(() => enc().add('com.a', 4), BlockError);
});

test('thc blockenc: the decoder refuses a block that is cut, corrupt or points past its key', () => {
  let packed;
  const enc = createBlockEncoder({
    perBlock: 10,
    onBlock: (p) => {
      packed = p;
      return null;
    },
  });
  enc.add('com.example', 1);
  enc.add('com.example.www', 1);
  enc.finish();
  assert.throws(() => decodeBlock(packed.subarray(0, 3)), BlockError);
  assert.throws(() => decodeBlock(Buffer.from([0xff, 0xff, 0xff])), BlockError);
  // shared prefix 5 with no key before it
  assert.throws(() => decodeBlock(deflateRawSync(Buffer.from([5, (3 << 2) | 1, 0x61, 0x62, 0x63]))), BlockError);
  // a suffix that runs past the block
  assert.throws(() => decodeBlock(deflateRawSync(Buffer.from([0, (9 << 2) | 1, 0x61]))), BlockError);
  // flags 0
  assert.throws(() => decodeBlock(deflateRawSync(Buffer.from([0, 1 << 2, 0x61]))), BlockError);
});

test('thc blockenc: writePack and verifyPack agree on a sorted file', async () => {
  const sorted = sortedFile('ok.sorted', RECORDS);
  const pack = join(dir, 'ok.pack');
  const w = await writePack(sorted, pack, { perBlock: 2 });
  assert.equal(w.records, 7);
  assert.equal(w.blocks, 4);
  assert.equal(w.pack_bytes, readFileSync(pack).length);
  const idx = JSON.parse(readFileSync(`${pack}.idx.json`, 'utf8'));
  assert.equal(idx.format, 'domains.measure.thc-pack.v1');
  assert.equal(idx.per_block, 2);
  assert.deepEqual(await verifyPack(pack, sorted), { records: 7, blocks: 4, pack_bytes: w.pack_bytes });
});

test('thc blockenc: verifyPack refuses a changed flag, a missing record, an extra record and a corrupt byte', async () => {
  const sorted = sortedFile('base.sorted', RECORDS);
  const pack = join(dir, 'base.pack');
  await writePack(sorted, pack, { perBlock: 3 });
  const flagged = sortedFile(
    'flag.sorted',
    RECORDS.map(([k, f], i) => [k, i === 4 ? 3 : f]),
  );
  await assert.rejects(verifyPack(pack, flagged), BlockError);
  await assert.rejects(verifyPack(pack, sortedFile('short.sorted', RECORDS.slice(0, 6))), BlockError);
  await assert.rejects(verifyPack(pack, sortedFile('long.sorted', [...RECORDS, ['zz.example', 1]])), BlockError);
  const bytes = readFileSync(pack);
  bytes[1] ^= 0x55;
  writeFileSync(pack, bytes);
  await assert.rejects(verifyPack(pack, sorted), BlockError);
});

test('thc blockenc: the command line prints the bytes a name of each codec', () => {
  const sorted = sortedFile('cli.sorted', RECORDS);
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, sorted, '4', '--compare'], { encoding: 'utf8' }));
  assert.equal(out.per, 4);
  assert.equal(out.names, 7);
  assert.equal(out.blocks, 2);
  for (const k of ['deflate9_bytes', 'brotli9_bytes', 'zstd12_bytes', 'bpn_front']) assert.ok(out[k] > 0, k);
});

test('thc blockenc: verifyPack refuses a pack that the index does not describe, each for its own fault', async () => {
  const sorted = sortedFile('tile.sorted', RECORDS);
  const fresh = async (name) => {
    const pack = join(dir, `${name}.pack`);
    await writePack(sorted, pack, { perBlock: 3 });
    return { pack, idx: JSON.parse(readFileSync(`${pack}.idx.json`, 'utf8')) };
  };
  const ok = await fresh('tile-ok');
  assert.equal((await verifyPack(ok.pack, sorted)).records, 7);
  assert.ok(ok.idx.blocks.length >= 3);
  const refused = async (name, plant, re) => {
    const { pack, idx } = await fresh(name);
    plant(pack, idx);
    writeFileSync(`${pack}.idx.json`, `${JSON.stringify(idx)}\n`);
    await assert.rejects(verifyPack(pack, sorted), (e) => e instanceof BlockError && re.test(e.message), name);
  };
  // Trailing bytes after the last block.
  await refused('tile-tail', (pack) => writeFileSync(pack, Buffer.concat([readFileSync(pack), Buffer.from([0])])), /blocks cover \d+ B of a \d+ B pack/);
  // A block whose offset leaves a gap.
  await refused('tile-gap', (_pack, idx) => (idx.blocks[1][1] += 1), /block at \d+ where \d+ was expected/);
  // The index's own byte count.
  await refused('tile-bytes', (_pack, idx) => (idx.pack_bytes += 1), /\(index says \d+\)/);
  // Another format, and another codec.
  await refused('tile-format', (_pack, idx) => (idx.format = 'thc-pack/0'), /format thc-pack\/0 codec/);
  await refused('tile-codec', (_pack, idx) => (idx.codec = 'zstd'), /codec zstd/);
  // The record count the index states.
  await refused('tile-records', (_pack, idx) => (idx.records += 1), /7 records checked, the index says 8/);
});
