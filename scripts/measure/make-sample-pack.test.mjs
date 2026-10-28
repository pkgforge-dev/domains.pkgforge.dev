// scripts/measure/make-sample-pack.test.mjs — DOM-008's sample pack writer, run
// as a process on names from stdin: the packs it writes decode, block by block,
// to the names normalised, sorted and merged, with the CRC-32 chain of their raw
// bytes in the table; its bounded selection keeps what a full sort keeps; and
// each refusal exits with its own code. The names are synthetic: the fixture
// scripts/measure/fixtures/decode/names.synthetic.txt was written by hand to hold
// the cases of normalisation (case, wildcards, a trailing dot, an IDN, refused
// lines), and the larger sets are generated here. No THC file made them.
//
//   node scripts/test.mjs scripts/measure --name "sample pack"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { HEAD_BYTES, MAX_BLOCKS, readSampleEntries, readSampleHead, samplePackKey } from '../../probes/worker/src/decode.ts';
import { decodeBlock } from './blockenc.mjs';
import { buildPack, createSelector, DEFAULT_NAMES, MANIFEST_FORMAT, parseFlags, selectFromStream, UsageError, uploadCommand, verifyPack } from './make-sample-pack.mjs';
import { normaliseName } from './revlabel.mjs';

const SCRIPT = fileURLToPath(new URL('./make-sample-pack.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/decode/names.synthetic.txt', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'sample-pack-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// The script as a process, with stdin fed from a file byte for byte.
function run(args, stdinPath) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
    if (stdinPath) createReadStream(stdinPath).pipe(child.stdin);
    else child.stdin.end();
  });
}

// The records a full sort keeps, computed apart from the selector: each line
// normalised, the flags of one key merged, the keys sorted.
function expected(lines, { from = '', limit = Infinity } = {}) {
  const flags = new Map();
  for (const line of lines) {
    const n = normaliseName(line);
    if (n.refused || n.key < from) continue;
    flags.set(n.key, (flags.get(n.key) ?? 0) | (n.wild ? 2 : 1));
  }
  return [...flags.keys()]
    .sort()
    .slice(0, limit)
    .map((key) => [key, flags.get(key)]);
}

// Names that a file of lines holds, some twice, some as wildcards.
function syntheticLines(n) {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const name = `h${(i * 7919) % 100_003}.zone${i % 53}.example${i % 3 === 0 ? '.co.uk' : '.com'}`;
    lines.push(i % 11 === 0 ? `*.${name}` : name);
    if (i % 17 === 0) lines.push(name.toUpperCase());
  }
  return lines;
}

let n = 0;
function linesFile(lines) {
  const path = join(dir, `names-${n++}.txt`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

// Every block of a pack file, decoded with blockenc.mjs's decoder, and the CRC
// chain recomputed with zlib: the records, the head and the table.
function readPack(bytes) {
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = readSampleHead(view, 'pack');
  const entries = readSampleEntries(view, head, head.blocks, 'pack');
  const records = [];
  let crc = 0;
  for (const e of entries) {
    const packed = bytes.subarray(e.offset, e.offset + e.packed);
    crc = crc32(inflateRawSync(packed), crc);
    assert.equal(crc, e.crcThrough, `the CRC-32 through the block at ${e.offset}`);
    const block = decodeBlock(packed);
    assert.equal(block.keys.length, e.records);
    for (const [i, k] of block.keys.entries()) records.push([k, block.flags[i]]);
  }
  return { head, entries, records };
}

test('make sample pack: the fixture names become three packs that decode to the names normalised, merged and sorted', async () => {
  const want = expected(readFileSync(FIXTURE, 'latin1').split('\n').slice(0, -1));
  // api.example.com twice, example.com plain and wild, and the IDN in both spellings merge.
  assert.equal(want.length, 13);
  const out = join(dir, 'fixture');
  const r = await run(['--out', out, '--names', String(want.length)], FIXTURE);
  assert.equal(r.code, 0, r.stderr);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, MANIFEST_FORMAT);
  assert.equal(manifest.names, want.length);
  assert.equal(manifest.input.lines, 27);
  assert.equal(manifest.input.accepted, 21);
  assert.deepEqual(manifest.input.refused, { empty: 2, charset: 1, idn: 0, 'label-empty': 2, 'label-long': 0, 'name-long': 0, 'no-dot': 1 });
  assert.deepEqual(
    manifest.packs.map((p) => [p.per, p.key, p.blocks, p.records]),
    [
      [1024, 'sample/v1/per-1024.pack', 1, 13],
      [4096, 'sample/v1/per-4096.pack', 1, 13],
      [16384, 'sample/v1/per-16384.pack', 1, 13],
    ],
  );
  for (const p of manifest.packs) {
    const bytes = readFileSync(join(out, p.file));
    assert.equal(bytes.length, p.bytes);
    const read = readPack(bytes);
    assert.deepEqual(read.records, want);
    assert.deepEqual(
      p.crc_through,
      read.entries.map((e) => e.crcThrough.toString(16).padStart(8, '0')),
    );
  }
  assert.ok(
    want.some(([k, f]) => k === 'com.example' && f === 3),
    'example.com seen plain and as a wildcard has flags 3',
  );
  assert.ok(
    want.some(([k]) => k === 'example.xn--bcher-kva'),
    'the IDN is converted',
  );
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.packs[0].crc_last, manifest.packs[0].crc_through.at(-1));
  assert.match(r.stderr, /npx wrangler@4\.150\.0 r2 object put domains-probe\/sample\/v1\/per-4096\.pack --file .*\/per-4096\.pack --content-type application\/octet-stream --remote/);
  assert.deepEqual(readdirSync(out).sort(), ['manifest.json', 'per-1024.pack', 'per-16384.pack', 'per-4096.pack']);
});

test('make sample pack: --from and --names keep a contiguous run of the sorted keys, cut into blocks that tile it', async () => {
  const lines = syntheticLines(9000);
  const want = expected(lines, { from: 'com.', limit: 2500 });
  assert.equal(want.length, 2500);
  assert.ok(want[0][0] >= 'com.' && want.at(-1)[0] < 'uk.', 'every kept key is a .com key');
  const out = join(dir, 'from');
  const r = await run(['--out', out, '--names', '2500', '--from', 'com.'], linesFile(lines));
  assert.equal(r.code, 0, r.stderr);
  for (const [per, blocks] of [
    [1024, 3],
    [4096, 1],
    [16384, 1],
  ]) {
    const read = readPack(readFileSync(join(out, `per-${per}.pack`)));
    assert.equal(read.head.blocks, blocks);
    assert.equal(read.entries[0].offset, HEAD_BYTES + 20 * blocks);
    assert.deepEqual(read.records, want);
  }
});

test('make sample pack: the bounded selection keeps the same records as a full sort, across many compactions', () => {
  const lines = syntheticLines(4000);
  for (const [limit, from, batch] of [
    [1, '', 2],
    [100, '', 7],
    [500, 'com.example.zone2', 13],
    [3000, '', 101],
  ]) {
    const selector = createSelector({ limit, from, batch });
    for (const line of lines) {
      const n = normaliseName(line);
      if (!n.refused) selector.add(n.key, n.wild ? 2 : 1);
    }
    assert.deepEqual(selector.finish(), expected(lines, { from, limit }), `limit ${limit} from ${from} batch ${batch}`);
  }
  // The largest kept key seen again, as a wildcard, after the compaction that
  // made it the ceiling: it is kept, so its flags merge.
  const selector = createSelector({ limit: 2, batch: 2 });
  selector.add('com.x.b', 1);
  selector.add('com.x.a', 1);
  selector.add('com.x.c', 1);
  selector.add('com.x.b', 2);
  assert.deepEqual(selector.counts, { offered: 4, below_from: 0, above_ceiling: 1 });
  assert.deepEqual(selector.finish(), [
    ['com.x.a', 1],
    ['com.x.b', 3],
  ]);
});

test('make sample pack: selectFromStream reads a stream of Buffers cut anywhere, a last line without a newline included', async () => {
  const text = 'b.example.com\n*.a.example.com\nA.example.com\nc.example.com';
  const chunks = [...Buffer.from(text)].map((byte) => Buffer.from([byte]));
  const { records, input } = await selectFromStream(Readable.from(chunks), { names: 10 });
  assert.deepEqual(records, [
    ['com.example.a', 3],
    ['com.example.b', 1],
    ['com.example.c', 1],
  ]);
  assert.equal(input.lines, 4);
});

test('make sample pack: fewer names than --names exits 1 and writes nothing', async () => {
  const out = join(dir, 'short');
  const r = await run(['--out', out, '--names', '14'], FIXTURE);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /holds 13 distinct names at or above "", fewer than --names 14; nothing written/);
  assert.equal(existsSync(out), false);
  assert.equal(r.stdout, '');
});

test('make sample pack: usage faults exit 2', async () => {
  for (const [args, re] of [
    [[], /--out DIR is required/],
    [['--out', join(dir, 'u'), '--names', '0'], /--names must be a whole number of at least 1/],
    [['--out', join(dir, 'u'), '--names', 'x'], /--names must be a whole number/],
    [['--out', join(dir, 'u'), '--from', 'COM.'], /--from must be a reversed key/],
    [['--out', join(dir, 'u'), '--level', '6'], /unknown flag --level/],
    [['--out', join(dir, 'u'), 'names.txt'], /the names come on stdin/],
  ]) {
    const r = await run(args, null);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re);
  }
  assert.throws(() => parseFlags(['--out']), UsageError);
  assert.deepEqual(parseFlags(['--out', 'x']), { out: 'x', names: DEFAULT_NAMES, from: '' });
  assert.equal(DEFAULT_NAMES, MAX_BLOCKS * 16384);
});

test('make sample pack: the read-back refuses a pack whose block is not the records it was given', () => {
  const records = expected(syntheticLines(3000), { limit: 2100 });
  const pack = buildPack(records, 1024);
  assert.doesNotThrow(() => verifyPack(pack.bytes, records, 1024));
  // A record changed after the pack was built: the decode differs, the table does not.
  const changed = records.map(([k, f], i) => (i === 1500 ? [k, f === 1 ? 2 : 1] : [k, f]));
  assert.throws(() => verifyPack(pack.bytes, changed, 1024), /per-1024 block 1 record 476/);
  // A byte of the CRC chain changed: the table differs, the blocks do not.
  const bytes = Buffer.from(pack.bytes);
  const at = HEAD_BYTES + 20 * 2 + 16;
  bytes.writeUInt32LE(bytes.readUInt32LE(at) ^ 1, at);
  assert.throws(() => verifyPack(bytes, records, 1024), /per-1024 block 2: CRC-32 [0-9a-f]{8}, the table says [0-9a-f]{8}/);
  assert.throws(() => buildPack(records, 2048), /the route reads 1024, 4096, 16384/);
  assert.equal(
    uploadCommand('.tmp/measure/DOM-008/sample', 4096),
    `npx wrangler@4.150.0 r2 object put domains-probe/${samplePackKey(4096)} --file .tmp/measure/DOM-008/sample/per-4096.pack --content-type application/octet-stream --remote`,
  );
});
