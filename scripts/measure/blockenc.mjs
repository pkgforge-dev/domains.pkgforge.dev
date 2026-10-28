// scripts/measure/blockenc.mjs — front-coded blocks compressed with deflate-raw,
// after design B's blockenc.mjs (docs/research/2026-10-27-design-b/scripts/blockenc.mjs),
// for the THC day measurement (DOM-009): encode a sorted record file into a
// measurement pack, decode it, and check it against the file it came from.
//
// A record is varint(shared prefix length with the previous key of the block),
// varint(suffix length << 2 | flags), then the suffix bytes. flags is 1 (seen
// plain), 2 (seen as a wildcard) or 3, as revlabel.mjs merges them. The first
// key of a block shares nothing, so a block decodes alone. A block of
// `perBlock` records (4,096 by default, docs/architecture.md section 4.4) is
// compressed with deflate-raw at level 9, the setting of design B M10.
//
// The measurement pack is the blocks back to back, and an index beside it
// (PACK.idx.json, format domains.measure.thc-pack.v1) that names the codec, the
// level, the records a block and each block's first key, offset, length and
// count. It is not the DPK1 format of DOM-017: it measures the bytes a name of
// the blocks that format stores.
//
// Usage:
//   import { createBlockEncoder, decodeBlock, writePack, verifyPack } from './blockenc.mjs'
//   node scripts/measure/blockenc.mjs SORTED.tsv [PER] [--compare]   prints the sizes as JSON;
//     --compare also compresses every block with brotli 9 and zstd 12, as design B M10 did
// Exit codes: 0 measured, 1 the input is not a sorted record file, 2 could not run.
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, constants, deflateRawSync, inflateRawSync, zstdCompressSync } from 'node:zlib';
import { parseArgs } from '../lib/args.mjs';
import { RecordError, readRecords } from './revlabel.mjs';
import { createByteWriter } from './thc-lines.mjs';

export class BlockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockError';
  }
}

export const PACK_FORMAT = 'domains.measure.thc-pack.v1';
export const CODEC = 'deflate-raw';
const MAX_KEY = 253;

function putVarint(buf, pos, value) {
  let v = value;
  let p = pos;
  while (v >= 128) {
    buf[p++] = (v & 127) | 128;
    v >>>= 7;
  }
  buf[p++] = v;
  return p;
}

// add(key, flags) takes the records in strictly ascending key order; when a
// block is full it calls onBlock(packed, { firstKey, count, raw }) and returns
// what onBlock returns (a promise when the writer is full). finish() flushes the
// last block the same way.
export function createBlockEncoder({ perBlock = 4096, level = 9, onBlock }) {
  if (!Number.isInteger(perBlock) || perBlock < 1) throw new BlockError(`records a block must be a positive integer, got ${perBlock}`);
  const buf = Buffer.allocUnsafe(perBlock * (MAX_KEY + 11));
  let pos = 0;
  let count = 0;
  let prev = '';
  let firstKey = null;
  let last = null;
  let records = 0;
  let blocks = 0;
  let frontBytes = 0;
  let packedBytes = 0;
  function flush() {
    if (count === 0) return null;
    const raw = buf.subarray(0, pos);
    const packed = deflateRawSync(raw, { level });
    const info = { firstKey, count, raw };
    blocks += 1;
    frontBytes += pos;
    packedBytes += packed.length;
    pos = 0;
    count = 0;
    prev = '';
    firstKey = null;
    return onBlock(packed, info);
  }
  return {
    add(key, flags) {
      if (last !== null && !(key > last)) throw new BlockError(`key ${records + 1} is not above the key before it`);
      if (key.length === 0 || key.length > MAX_KEY) throw new BlockError(`key ${records + 1} is ${key.length} B`);
      if (flags < 1 || flags > 3) throw new BlockError(`key ${records + 1} has flags ${flags}`);
      last = key;
      let shared = 0;
      const max = Math.min(prev.length, key.length);
      while (shared < max && prev.charCodeAt(shared) === key.charCodeAt(shared)) shared += 1;
      const suffix = key.length - shared;
      pos = putVarint(buf, pos, shared);
      pos = putVarint(buf, pos, (suffix << 2) | flags);
      pos += buf.write(key.slice(shared), pos, 'latin1');
      if (firstKey === null) firstKey = key;
      prev = key;
      count += 1;
      records += 1;
      return count >= perBlock ? flush() : null;
    },
    finish: flush,
    stats() {
      return { records, blocks, front_bytes: frontBytes, packed_bytes: packedBytes };
    },
  };
}

// One packed block to { keys, flags }. Every length is checked against the
// bytes that are there: a short or corrupt block is a BlockError.
export function decodeBlock(packed) {
  let raw;
  try {
    raw = inflateRawSync(packed);
  } catch (err) {
    throw new BlockError(`block does not inflate: ${err.message}`);
  }
  const keys = [];
  const flags = [];
  let pos = 0;
  let prev = '';
  const varint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= raw.length) throw new BlockError('block ends inside a varint');
      const b = raw[pos++];
      value += (b & 127) * 2 ** shift;
      if (b < 128) return value;
      shift += 7;
      if (shift > 28) throw new BlockError('varint too long');
    }
  };
  while (pos < raw.length) {
    const shared = varint();
    const x = varint();
    const suffix = x >>> 2;
    const f = x & 3;
    if (shared > prev.length) throw new BlockError(`record ${keys.length + 1} shares ${shared} B of a ${prev.length} B key`);
    if (f === 0) throw new BlockError(`record ${keys.length + 1} has flags 0`);
    if (pos + suffix > raw.length) throw new BlockError(`record ${keys.length + 1} runs past the block`);
    const key = prev.slice(0, shared) + raw.toString('latin1', pos, pos + suffix);
    pos += suffix;
    keys.push(key);
    flags.push(f);
    prev = key;
  }
  return { keys, flags };
}

// Encodes a sorted record file into PACK and PACK.idx.json. Returns the counts.
export async function writePack(sortedPath, packPath, { perBlock = 4096, level = 9 } = {}) {
  const out = createByteWriter(packPath);
  const index = [];
  let offset = 0;
  const onBlock = (packed, info) => {
    index.push([info.firstKey, offset, packed.length, info.count]);
    offset += packed.length;
    return out.write(packed);
  };
  const enc = createBlockEncoder({ perBlock, level, onBlock });
  const read = await readRecords(sortedPath, (key, flags) => enc.add(key, flags));
  await enc.finish();
  await out.close();
  const idx = JSON.stringify({ format: PACK_FORMAT, codec: CODEC, level, per_block: perBlock, records: read.records, pack_bytes: offset, blocks: index });
  writeFileSync(packPath + '.idx.json', idx + '\n');
  const s = enc.stats();
  return { records: s.records, blocks: s.blocks, front_bytes: s.front_bytes, pack_bytes: s.packed_bytes, index_bytes: Buffer.byteLength(idx) + 1, sorted_lines: read.lines };
}

// Decodes every block of PACK and checks each record against the sorted file it
// was made from: the same keys, the same flags, the same count, and blocks that
// tile the file. The first difference is a BlockError.
export async function verifyPack(packPath, sortedPath) {
  const idx = JSON.parse(readFileSync(packPath + '.idx.json', 'utf8'));
  if (idx.format !== PACK_FORMAT || idx.codec !== CODEC) throw new BlockError(`${packPath}.idx.json: format ${idx.format} codec ${idx.codec}`);
  const fd = openSync(packPath, 'r');
  try {
    const size = fstatSync(fd).size;
    let expectOffset = 0;
    for (const [, off, len] of idx.blocks) {
      if (off !== expectOffset) throw new BlockError(`block at ${off} where ${expectOffset} was expected`);
      expectOffset += len;
    }
    if (expectOffset !== size || size !== idx.pack_bytes) throw new BlockError(`blocks cover ${expectOffset} B of a ${size} B pack (index says ${idx.pack_bytes})`);
    let b = -1;
    let block = { keys: [], flags: [] };
    let i = 0;
    let records = 0;
    const next = () => {
      b += 1;
      if (b >= idx.blocks.length) throw new BlockError(`the sorted file has more records than the pack's ${records}`);
      const [firstKey, off, len, count] = idx.blocks[b];
      const packed = Buffer.allocUnsafe(len);
      if (readSync(fd, packed, 0, len, off) !== len) throw new BlockError(`block ${b} is short`);
      block = decodeBlock(packed);
      if (block.keys.length !== count || block.keys[0] !== firstKey)
        throw new BlockError(`block ${b} holds ${block.keys.length} records from ${JSON.stringify(block.keys[0])}, the index says ${count} from ${JSON.stringify(firstKey)}`);
      i = 0;
    };
    await readRecords(sortedPath, (key, flags) => {
      if (i >= block.keys.length) next();
      if (block.keys[i] !== key || block.flags[i] !== flags)
        throw new BlockError(`record ${records + 1}: pack has ${JSON.stringify(block.keys[i])}/${block.flags[i]}, file has ${JSON.stringify(key)}/${flags}`);
      i += 1;
      records += 1;
    });
    if (b !== idx.blocks.length - 1 || i !== block.keys.length) throw new BlockError(`the pack has records past the sorted file's ${records}`);
    if (records !== idx.records) throw new BlockError(`${records} records checked, the index says ${idx.records}`);
    return { records, blocks: idx.blocks.length, pack_bytes: size };
  } finally {
    closeSync(fd);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const [input, per] = args._;
  if (!input) {
    console.error('usage: node scripts/measure/blockenc.mjs SORTED.tsv [PER] [--compare]');
    return 2;
  }
  const perBlock = per === undefined ? 4096 : Number(per);
  const compare = args.compare === true;
  let brotli = 0;
  let zstd = 0;
  let raw = 0;
  const enc = createBlockEncoder({
    perBlock,
    onBlock: (_packed, info) => {
      if (!compare) return null;
      brotli += brotliCompressSync(info.raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: info.raw.length } }).length;
      zstd += zstdCompressSync(info.raw, { params: { [constants.ZSTD_c_compressionLevel]: 12 } }).length;
      return null;
    },
  });
  try {
    await readRecords(input, (key, flags) => {
      raw += key.length + 1;
      return enc.add(key, flags);
    });
    enc.finish();
  } catch (err) {
    console.error(`blockenc: ${err.message}`);
    return err instanceof RecordError || err instanceof BlockError ? 1 : 2;
  }
  const s = enc.stats();
  const bpn = (x) => (s.records === 0 ? 0 : +(x / s.records).toFixed(2));
  const out = {
    per: perBlock,
    names: s.records,
    blocks: s.blocks,
    raw_bytes: raw,
    front_bytes: s.front_bytes,
    deflate9_bytes: s.packed_bytes,
    bpn_front: bpn(s.front_bytes),
    bpn_deflate: bpn(s.packed_bytes),
  };
  if (compare) Object.assign(out, { brotli9_bytes: brotli, zstd12_bytes: zstd, bpn_brotli: bpn(brotli), bpn_zstd: bpn(zstd) });
  console.log(JSON.stringify(out));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
