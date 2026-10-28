// scripts/measure/make-sample-pack.mjs — the sample packs that DOM-008's /decode
// route reads from the probe's bucket (TODO/storage.md, probes/worker/src/decode.ts).
//
// Reads names from stdin, one a line, and normalises each as the THC day
// measurement does (revlabel.mjs: lowercase, a leading `*.` stripped and
// flagged, labels reversed; a refused line is counted, never kept). It keeps
// the --names smallest distinct keys at or above --from, with the flags of a
// name seen plain and as a wildcard merged, so the sample is one contiguous run
// of the input's sorted key space, blocks as a real pack cuts them. A run's
// bytes a name need not be the whole day's mean (front coding alone gave 11.98
// B a name over THC's 2026-10-26 day at 4,096, design B M10, TODO/storage.md),
// so the manifest records each pack's own (`bytes_per_name`); carrying a CPU
// figure read on it over to the day's mean block assumes CPU linear in raw
// bytes, which nothing here measures. It front codes them with blockenc.mjs's
// encoder (the one record writer of the measurement) into blocks of 1,024,
// 4,096 and 16,384 names, each
// compressed with deflate-raw at level 9, and writes one sample pack per block
// size in the layout of probes/worker/src/decode.ts (its writeSampleHead is the
// one writer of the head and the table). It then reads every pack back with the
// route's own table reader, inflates every block with node:zlib and decodes it
// with blockenc.mjs's decodeBlock, and refuses the output unless each block
// holds the names it was given and the CRC-32 through it matches the table.
//
// The selection holds at most --names keys plus one batch in memory, so a whole
// THC day (38 million lines) streams through it.
//
// Usage:
//   gzip -dc .tmp/measure/DOM-009/2026-10-26.txt.gz | node scripts/measure/make-sample-pack.mjs --out .tmp/measure/DOM-008/sample [--names 262144] [--from com.]
// --names defaults to 262,144, 16 blocks of 16,384 names: the most blocks the
// route reads. --from is a reversed key (`com.` keeps .com names first). --out
// receives per-1024.pack, per-4096.pack, per-16384.pack and manifest.json; the
// packs go to the probe's bucket under the keys the manifest names (stderr
// prints the upload commands).
// stdout: the summary, one JSON object.
// Exit codes: 0 written and read back · 1 the input holds fewer names than
// --names at or above --from, and nothing is written · 2 could not run (usage,
// input or output, or a pack that does not read back).
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { BLOCK_SIZES, ENTRY_BYTES, HEAD_BYTES, hex32, MAX_BLOCKS, readSampleEntries, readSampleHead, samplePackKey, writeSampleHead } from '../../probes/worker/src/decode.ts';
import { parseArgs } from '../lib/args.mjs';
import { BlockError, createBlockEncoder, decodeBlock } from './blockenc.mjs';
import { MAX_RECORD, normaliseInto, normaliseName, REFUSALS } from './revlabel.mjs';
import { forEachLineBytes } from './thc-lines.mjs';

export const MANIFEST_FORMAT = 'domains.measure.decode-sample.v1';
export const LEVEL = 9;
export const DEFAULT_NAMES = MAX_BLOCKS * Math.max(...BLOCK_SIZES);
const USAGE = 'usage: node scripts/measure/make-sample-pack.mjs --out DIR [--names N] [--from KEY] < names.txt';

export class UsageError extends Error {}
export class ShortInputError extends Error {}

// The flags, checked. Throws UsageError.
export function parseFlags(argv) {
  const a = parseArgs(argv);
  for (const k of Object.keys(a)) if (k !== '_' && !['out', 'names', 'from'].includes(k)) throw new UsageError(`unknown flag --${k}`);
  if (a._.length > 0) throw new UsageError(`unexpected argument ${a._[0]}: the names come on stdin`);
  for (const k of ['out', 'names', 'from']) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (typeof a.out !== 'string' || a.out === '') throw new UsageError('--out DIR is required');
  let names = DEFAULT_NAMES;
  if (a.names !== undefined) {
    if (!/^\d{1,9}$/.test(a.names) || Number(a.names) < 1) throw new UsageError('--names must be a whole number of at least 1');
    names = Number(a.names);
  }
  const from = a.from ?? '';
  if (!/^[a-z0-9_.-]{0,253}$/.test(from)) throw new UsageError('--from must be a reversed key of a-z, 0-9, dot, underscore and hyphen');
  return { out: a.out, names, from };
}

// Keeps the `limit` smallest distinct keys at or above `from`, merging the
// flags of one key seen more than once. Tokens are `KEY\tF`: a tab sorts below
// every byte a key holds, so a string sort orders them by key, and the tokens
// of one key sit together. Once `limit` keys are kept, a key above the largest
// of them can never be kept, and it is dropped as it arrives.
export function createSelector({ limit, from = '', batch = Math.max(4 * limit, 1 << 20) }) {
  let tokens = [];
  let ceiling = null;
  const counts = { offered: 0, below_from: 0, above_ceiling: 0 };
  function compact() {
    tokens.sort();
    const out = [];
    let lastKey = null;
    let flags = 0;
    for (const token of tokens) {
      const key = token.slice(0, -2);
      const f = token.charCodeAt(token.length - 1) - 48;
      if (key === lastKey) {
        flags |= f;
        continue;
      }
      if (lastKey !== null) out.push(`${lastKey}\t${flags}`);
      if (out.length === limit) {
        lastKey = null;
        break;
      }
      lastKey = key;
      flags = f;
    }
    if (lastKey !== null) out.push(`${lastKey}\t${flags}`);
    tokens = out;
    if (tokens.length === limit) ceiling = tokens[limit - 1].slice(0, -2);
  }
  return {
    add(key, flags) {
      counts.offered += 1;
      if (key < from) {
        counts.below_from += 1;
        return;
      }
      if (ceiling !== null && key > ceiling) {
        counts.above_ceiling += 1;
        return;
      }
      tokens.push(`${key}\t${flags}`);
      if (tokens.length >= batch) compact();
    },
    // The kept records, ascending, as [key, flags].
    finish() {
      compact();
      return tokens.map((token) => [token.slice(0, -2), token.charCodeAt(token.length - 1) - 48]);
    },
    counts,
  };
}

// Normalises one line and offers it to the selector. A line normaliseInto
// cannot finish (a byte above 0x7f) goes through normaliseName, which converts
// it with domainToASCII first.
function createLineReader(selector) {
  const out = Buffer.allocUnsafe(MAX_RECORD);
  const refused = Object.fromEntries(REFUSALS.map((r) => [r, 0]));
  let accepted = 0;
  return {
    line(buf, start, end) {
      const at = normaliseInto(buf, start, end, out, 0);
      let key;
      let wild;
      if (at > 0) {
        key = out.toString('latin1', 0, at - 3);
        wild = out[at - 2] === 49;
      } else if (REFUSALS[-1 - at] !== undefined) {
        refused[REFUSALS[-1 - at]] += 1;
        return;
      } else {
        const n = normaliseName(buf.toString('latin1', start, end));
        if (n.refused) {
          refused[n.refused] += 1;
          return;
        }
        key = n.key;
        wild = n.wild;
      }
      accepted += 1;
      selector.add(key, wild ? 2 : 1);
    },
    result: () => ({ accepted, refused }),
  };
}

// The kept records of an iterable of Buffers (stdin), and the counts.
export async function selectFromStream(source, { names, from = '', batch }) {
  const selector = createSelector({ limit: names, from, batch });
  const reader = createLineReader(selector);
  const read = await forEachLineBytes(source, (buf, start, end) => reader.line(buf, start, end));
  const records = selector.finish();
  return { records, input: { lines: read.lines, bytes: read.bytes, ...reader.result(), ...selector.counts, from } };
}

// One sample pack of `per` names a block, as bytes, with its table and sizes.
export function buildPack(records, per) {
  if (!BLOCK_SIZES.includes(per)) throw new UsageError(`blocks of ${per} names: the route reads ${BLOCK_SIZES.join(', ')}`);
  const blocks = [];
  let crc = 0;
  let frontBytes = 0;
  const encoder = createBlockEncoder({
    perBlock: per,
    level: LEVEL,
    onBlock: (packed, info) => {
      crc = crc32(info.raw, crc);
      frontBytes += info.raw.length;
      blocks.push({ packed, raw: info.raw.length, records: info.count, crcThrough: crc });
      return null;
    },
  });
  for (const [key, flags] of records) encoder.add(key, flags);
  encoder.finish();
  let offset = HEAD_BYTES + ENTRY_BYTES * blocks.length;
  const entries = blocks.map((b) => {
    const entry = { offset, packed: b.packed.length, raw: b.raw, records: b.records, crcThrough: b.crcThrough };
    offset += b.packed.length;
    return entry;
  });
  const head = writeSampleHead({ per, blocks: blocks.length, records: records.length, bytes: offset }, entries);
  const bytes = Buffer.concat([head, ...blocks.map((b) => b.packed)]);
  return { per, bytes, entries, records: records.length, frontBytes, packedBytes: offset - HEAD_BYTES - ENTRY_BYTES * blocks.length };
}

// Reads a pack back with the route's table reader and blockenc.mjs's decoder,
// and throws a BlockError at the first block that does not hold the records
// it was given, or whose CRC-32 through it is not the table's.
export function verifyPack(bytes, records, per) {
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let head;
  let entries;
  try {
    head = readSampleHead(view, `per-${per}`);
    entries = readSampleEntries(view, head, head.blocks, `per-${per}`);
  } catch (err) {
    throw new BlockError(err.message);
  }
  if (head.per !== per || head.records !== records.length || head.bytes !== bytes.length)
    throw new BlockError(`per-${per}: the head says ${head.per} a block, ${head.records} records, ${head.bytes} B`);
  let crc = 0;
  let at = 0;
  for (const [i, entry] of entries.entries()) {
    const packed = bytes.subarray(entry.offset, entry.offset + entry.packed);
    crc = crc32(inflateRawSync(packed), crc);
    if (crc !== entry.crcThrough) throw new BlockError(`per-${per} block ${i}: CRC-32 ${hex32(crc)}, the table says ${hex32(entry.crcThrough)}`);
    const block = decodeBlock(packed);
    if (block.keys.length !== entry.records) throw new BlockError(`per-${per} block ${i} holds ${block.keys.length} records, the table says ${entry.records}`);
    for (let j = 0; j < block.keys.length; j += 1, at += 1) {
      const [key, flags] = records[at];
      if (block.keys[j] !== key || block.flags[j] !== flags) throw new BlockError(`per-${per} block ${i} record ${j}: ${block.keys[j]}/${block.flags[j]}, expected ${key}/${flags}`);
    }
  }
  if (at !== records.length) throw new BlockError(`per-${per} holds ${at} records of ${records.length}`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const perName = (bytes, names) => +(bytes / names).toFixed(2);
export const packFile = (per) => `per-${per}.pack`;

// Writes through a temporary file in the same directory, so a killed process
// leaves no half-written file under the final name.
function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function manifestOf(input, records, packs) {
  return {
    format: MANIFEST_FORMAT,
    entry: 'DOM-008',
    written: new Date().toISOString(),
    node: process.version,
    zlib: process.versions.zlib,
    codec: 'deflate-raw',
    level: LEVEL,
    input,
    names: records.length,
    first_key: records[0][0],
    last_key: records[records.length - 1][0],
    packs: packs.map((p) => ({
      per: p.per,
      key: samplePackKey(p.per),
      file: packFile(p.per),
      bytes: p.bytes.length,
      sha256: sha256(p.bytes),
      blocks: p.entries.length,
      records: p.records,
      front_bytes: p.frontBytes,
      packed_bytes: p.packedBytes,
      bytes_per_name: { front: perName(p.frontBytes, p.records), deflate: perName(p.packedBytes, p.records) },
      crc_through: p.entries.map((e) => hex32(e.crcThrough)),
    })),
  };
}

export const uploadCommand = (dir, per) =>
  `npx wrangler@4.150.0 r2 object put domains-probe/${samplePackKey(per)} --file ${join(dir, packFile(per)).split('\\').join('/')} --content-type application/octet-stream --remote`;

export async function main(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`make-sample-pack: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const { records, input } = await selectFromStream(stdin, { names: flags.names, from: flags.from });
    if (records.length < flags.names)
      throw new ShortInputError(`the input holds ${records.length} distinct names at or above ${JSON.stringify(flags.from)}, fewer than --names ${flags.names}; nothing written`);
    const packs = BLOCK_SIZES.map((per) => buildPack(records, per));
    for (const pack of packs) verifyPack(pack.bytes, records, pack.per);
    const dir = resolve(flags.out);
    mkdirSync(dir, { recursive: true });
    for (const pack of packs) writeAtomic(join(dir, packFile(pack.per)), pack.bytes);
    const manifest = manifestOf(input, records, packs);
    writeAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    const summary = { ...manifest, packs: manifest.packs.map(({ crc_through, ...rest }) => ({ ...rest, crc_last: crc_through[crc_through.length - 1] })) };
    stdout.write(`${JSON.stringify(summary)}\n`);
    stderr.write(`make-sample-pack: wrote ${packs.length} packs and manifest.json to ${flags.out}; upload them to the probe's bucket with\n`);
    for (const pack of packs) stderr.write(`  ${uploadCommand(flags.out, pack.per)}\n`);
    return 0;
  } catch (err) {
    stderr.write(`make-sample-pack: ${err.message}\n`);
    return err instanceof ShortInputError ? 1 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
