// scripts/bench/pack.mjs — DOM-017's bench of the pack format (TODO/storage.md,
// docs/format.md section 13): the bytes a name, the blocks, the index size and
// the decode time of packs of the same names written four times, with the key
// and its flags alone and then with 1, 2 and 3 sources a record, and the range
// reads of one lookup.
//
// The names. `--names N` makes N synthetic names from a seeded generator
// (`--seed`, default 1): registrable domains of random labels under a weighted
// list of suffixes, each with up to five names below it. `--sample cs2` reads
// the first 20,000,000 bytes of https://cs2.ip.thc.org/2026-10-26.txt.gz by
// Range with the contact User-Agent (scripts/lib/user-agent.mjs; ruling 11),
// requires the 206 and its Content-Range, decompresses the gzip member it cuts
// (at most MAX_SAMPLE_TEXT_BYTES), keeps the whole lines, and normalises each
// with @domains/names against the pinned PSL fixture
// (packages/names/test/fixtures/psl-2026-10-27.dat); `--names N` then keeps
// the N smallest keys. A sample of the dump's first lines is not the whole day:
// the dump runs roughly in forward name order, so its first lines are spread
// thin over the reversed keys, and they share less with each other than the
// day's keys do.
//
// The source fields are synthetic in both modes, from the seed: bit 0 is a day
// source that saw every name on day 298 (2026-10-26), bit 1 a second source
// that saw it at a random second of that day and again within the rest of the
// day, bit 2 a day source that first saw it 0 to 298 days earlier, from day 0
// (2026-01-01), the earliest day the format holds. Their cost
// is the difference against the keys-only pack, and it depends on these
// values: a real source's times compress as their own spread allows.
//
// Every pack is read back through the package's reader and compared record by
// record with its input; a pack that does not read back exits 2. Lookups: 1,000
// keys drawn from the seed, each through an index opened once (its head held)
// with no page cache, counting the range reads of the index and of the parts.
//
// Usage:
//   node scripts/bench/pack.mjs --names 1000000 [--seed 1] [--records-per-block 4096] [--out PATH]
//   node scripts/bench/pack.mjs --sample cs2 [--names N] [--seed 1] [--out PATH]
// stdout: one JSON object, schema domains.bench.pack.v1. stderr: a table.
// --out writes the same object to PATH.
// Exit codes: 0 the 1-source pack is at most 12 B a name (parts and index) and
// no lookup read more than 2 ranges · 1 a criterion failed · 2 could not run
// (usage, the fetch, the sample, or a pack that does not read back).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants, gunzipSync } from 'node:zlib';
import { key as keyOf, loadPsl, normalise } from '@domains/names';
import { nodeCompress, writerId } from '../../packages/pack/node/index.ts';
import { DEFAULT_RECORDS_PER_BLOCK, MemorySink, NAMES_CODEC, PackIndex, PackReader, readKey, writeKey, writePack } from '../../packages/pack/src/index.ts';
import { parseArgs } from '../lib/args.mjs';
import { USER_AGENT } from '../lib/user-agent.mjs';

export const SCHEMA = 'domains.bench.pack.v1';
export const CS2_URL = 'https://cs2.ip.thc.org/2026-10-26.txt.gz';
// 20 MB, MB being 10^6 B: the range of DOM-017's Approach.
export const SAMPLE_BYTES = 20_000_000;
export const MAX_BYTES_PER_NAME = 12;
export const MAX_LOOKUP_READS = 2;
export const LOOKUPS = 1000;
export const DAY = 298;
// The most text a sample may decompress to: several times what the 20 MB
// prefix gives (docs/format.md section 13), so a hostile or broken answer
// stops here instead of inflating without a bound.
export const MAX_SAMPLE_TEXT_BYTES = 512 * 1024 * 1024;
const ROOT = resolve(import.meta.dirname, '..', '..');
const PSL_FIXTURE = join(ROOT, 'packages', 'names', 'test', 'fixtures', 'psl-2026-10-27.dat');
const FLAGS = ['names', 'sample', 'seed', 'records-per-block', 'out'];

export class UsageError extends Error {}
export class BenchError extends Error {}

export function parseFlags(argv) {
  const a = parseArgs(argv);
  for (const k of Object.keys(a)) if (k !== '_' && !FLAGS.includes(k)) throw new UsageError(`unknown flag --${k}`);
  if (a._.length > 0) throw new UsageError(`unexpected argument ${a._[0]}`);
  for (const k of FLAGS) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  const whole = (k, min, max) => {
    if (a[k] === undefined) return undefined;
    if (!/^\d{1,9}$/.test(a[k]) || Number(a[k]) < min || Number(a[k]) > max) throw new UsageError(`--${k} must be a whole number of ${min} to ${max}`);
    return Number(a[k]);
  };
  const sample = a.sample;
  if (sample !== undefined && sample !== 'cs2') throw new UsageError('--sample takes cs2');
  const names = whole('names', 1, 50_000_000);
  if (sample === undefined && names === undefined) throw new UsageError('give --names N, or --sample cs2');
  return { names, sample: sample ?? null, seed: whole('seed', 0, 2 ** 31) ?? 1, recordsPerBlock: whole('records-per-block', 1, 65_535) ?? DEFAULT_RECORDS_PER_BLOCK, out: a.out ?? null };
}

// mulberry32: a small seeded generator.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- names

const SUFFIXES = [
  ['com', 40],
  ['net', 6],
  ['org', 5],
  ['de', 5],
  ['co.uk', 3],
  ['ru', 3],
  ['io', 2],
  ['com.np', 1],
  ['xyz', 2],
  ['fr', 2],
  ['nl', 2],
  ['com.br', 2],
];
const SUB = ['www', 'mail', 'api', 'cdn', 'dev', 'm', 'shop', 'blog', 'app', 'static', 'autodiscover', 'cpanel', 'webmail'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// n distinct synthetic keys, ascending, from the seed.
export function syntheticKeys(n, seed) {
  const next = rng(seed);
  const total = SUFFIXES.reduce((s, [, w]) => s + w, 0);
  const suffix = () => {
    let r = next() * total;
    for (const [sfx, w] of SUFFIXES) if ((r -= w) < 0) return sfx;
    return 'com';
  };
  const word = () => {
    const len = 4 + Math.floor(next() * 9);
    let w = '';
    for (let i = 0; i < len; i += 1) w += LETTERS[Math.floor(next() * 26)];
    return next() < 0.2 ? `${w}${Math.floor(next() * 100)}` : w;
  };
  const keys = new Set();
  while (keys.size < n) {
    const reg = `${suffix()}`.split('.').reverse().join('.') + `.${word()}`;
    keys.add(reg);
    const below = Math.floor(next() * next() * 6);
    for (let i = 0; i < below && keys.size < n; i += 1) {
      const label = next() < 0.7 ? SUB[Math.floor(next() * SUB.length)] : Math.floor(next() * 2 ** 32).toString(16);
      keys.add(`${reg}.${label}`);
    }
  }
  return [...keys].sort();
}

// The first `bytes` bytes of the cs2 file, by Range. `fetchFn` is the test's.
export async function fetchSample({ fetchFn = fetch, url = CS2_URL, bytes = SAMPLE_BYTES } = {}) {
  const range = `bytes=0-${bytes - 1}`;
  const res = await fetchFn(url, { headers: { 'user-agent': USER_AGENT, range, 'accept-encoding': 'identity' }, redirect: 'error', signal: AbortSignal.timeout(300_000) });
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new BenchError(`${url} answered ${res.status} to ${range}, not 206`);
  }
  const contentRange = res.headers.get('content-range') ?? '';
  const m = contentRange.match(/^bytes 0-(\d+)\/(\d+|\*)$/);
  if (m === null || Number(m[1]) !== bytes - 1) throw new BenchError(`${url}: Content-Range "${contentRange}" is not bytes 0-${bytes - 1}/SIZE`);
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.length !== bytes) throw new BenchError(`${url}: ${body.length} B arrived for a range of ${bytes} B`);
  return {
    url,
    range,
    status: res.status,
    content_range: contentRange,
    total: m[2] === '*' ? null : Number(m[2]),
    last_modified: res.headers.get('last-modified'),
    etag: res.headers.get('etag'),
    body,
  };
}

// The names of a gzip prefix: the member is decompressed as far as the bytes
// go, at most `maxText` bytes, and the last line, which the cut may split, is
// dropped. decompressed_bytes is the length of the inflated buffer in bytes,
// not the UTF-16 units of its text.
export function linesOfSample(gz, maxText = MAX_SAMPLE_TEXT_BYTES) {
  let inflated;
  try {
    inflated = gunzipSync(gz, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: maxText });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw new BenchError(`the sample decompresses to more than ${maxText} B`);
    throw error;
  }
  const text = new TextDecoder().decode(inflated);
  const cut = text.lastIndexOf('\n');
  if (cut < 0) throw new BenchError('the sample holds no whole line');
  return { lines: text.slice(0, cut).split('\n'), decompressed_bytes: inflated.length };
}

// Normalises lines to keys with their flags (1 exact, 2 wildcard, 3 both).
export function keysOfLines(lines, psl) {
  const flags = new Map();
  const refused = {};
  for (const line of lines) {
    const n = normalise(line, psl);
    if ('refused' in n) {
      refused[n.refused] = (refused[n.refused] ?? 0) + 1;
      continue;
    }
    const k = keyOf(n.name);
    flags.set(k, (flags.get(k) ?? 0) | (n.wild ? 2 : 1));
  }
  const keys = [...flags.keys()].sort();
  return { keys, flags: keys.map((k) => flags.get(k)), refused };
}

// ---- records

// The synthetic times of each name, drawn once so every variant shares them.
export function syntheticTimes(n, seed) {
  const next = rng(seed ^ 0x5eed);
  const second = new Uint32Array(n);
  const span = new Uint32Array(n);
  const older = new Uint16Array(n);
  for (let i = 0; i < n; i += 1) {
    second[i] = Math.floor(next() * 86_400);
    span[i] = next() < 0.5 ? 0 : Math.floor(next() * (86_400 - second[i]));
    // Day 0 is 2026-01-01: an unsigned day count holds no earlier day.
    older[i] = Math.floor(next() * (DAY + 1));
  }
  return { second, span, older };
}

export function recordOf(i, key, flags, sources, times) {
  const out = [];
  if (sources >= 1) out.push({ bit: 0, first: DAY, last: DAY });
  if (sources >= 2) {
    const first = DAY * 86_400 + times.second[i];
    out.push({ bit: 1, first, last: first + times.span[i] });
  }
  if (sources >= 3) out.push({ bit: 2, first: DAY - times.older[i], last: DAY });
  return { key, flags, sources: out };
}

// The keys and flags alone: the record of design B's density measurement.
// Never published: it exists to price the fields.
export const KEYS_CODEC = Object.freeze({
  id: 255,
  name: 'bench-keys',
  key: (r) => r.key,
  idxKey: (r) => r.key,
  maxKeyBytes: NAMES_CODEC.maxKeyBytes,
  encodeRecord: (prev, r, out) => writeKey(prev === null ? null : prev.key, r.key, r.flags, out, NAMES_CODEC.maxKeyBytes),
  decodeRecord: (prev, input) => {
    const k = readKey(prev === null ? null : prev.key, input, NAMES_CODEC.maxKeyBytes);
    return { key: k.key, flags: k.flags, sources: [] };
  },
  merge: (a) => a,
});

const sameRecord = (a, b) =>
  a.key === b.key &&
  a.flags === b.flags &&
  a.sources.length === b.sources.length &&
  a.sources.every((s, j) => s.bit === b.sources[j].bit && s.first === b.sources[j].first && s.last === b.sources[j].last);

// ---- one variant

async function variant(label, sources, keys, flags, times, recordsPerBlock, seed) {
  const codec = sources === 0 ? KEYS_CODEC : NAMES_CODEC;
  const records = function* () {
    for (let i = 0; i < keys.length; i += 1) yield recordOf(i, keys[i], flags[i], sources, times);
  };
  const sink = new MemorySink();
  const t0 = performance.now();
  const summary = await writePack(records(), { codec, compress: nodeCompress, sink, recordsPerBlock });
  const writeMs = performance.now() - t0;
  const parts = sink.parts();
  const idxBytes = summary.idx.length;
  // Read back: every block, every record against its input.
  const reader = await PackReader.open(summary.idx, { read: async (p, o, n) => parts[p].subarray(o, o + n) }, codec);
  let decodeMs = 0;
  let i = 0;
  for await (const e of reader.index.entries()) {
    const t = performance.now();
    const block = reader.decodeBlock(await reader.readBlock(e), e);
    decodeMs += performance.now() - t;
    for (const r of block) {
      if (!sameRecord(r, recordOf(i, keys[i], flags[i], sources, times))) throw new BenchError(`${label}: record ${i} does not read back`);
      i += 1;
    }
  }
  if (i !== keys.length) throw new BenchError(`${label}: ${i} records read back of ${keys.length}`);
  const lookups = sources === 1 ? await lookup(summary, parts, codec, keys, flags, times, seed) : null;
  const n = keys.length;
  return {
    variant: {
      name: label,
      sources,
      records: summary.records,
      blocks: summary.blocks,
      parts: parts.length,
      raw_bytes: summary.rawBytes,
      part_bytes: summary.partBytes,
      idx_bytes: idxBytes,
      front_bytes_per_name: round(summary.rawBytes / n),
      bytes_per_name: round(summary.partBytes / n),
      bytes_per_name_with_idx: round((summary.partBytes + idxBytes) / n),
      sha256: summary.sha256,
      write_ms: round(writeMs),
      decode_ms: round(decodeMs),
      decode_ms_per_1000_names: round((decodeMs * 1000) / n, 4),
    },
    lookups,
  };
}

// 1,000 lookups through an index opened once (head held), no page cache: each
// read of the index or of a part is counted.
async function lookup(summary, parts, codec, keys, flags, times, seed) {
  const count = { idx: 0, parts: 0 };
  const idx = { size: summary.idx.length, read: async (o, n) => (count.idx++, summary.idx.subarray(o, o + n)) };
  const source = { read: async (p, o, n) => (count.parts++, parts[p].subarray(o, o + n)) };
  const index = await PackIndex.open(idx, { pageCache: 0 });
  const headReads = count.idx;
  const reader = new PackReader(index, source, codec);
  const next = rng(seed ^ 0x100c);
  let max = 0;
  let total = 0;
  const t0 = performance.now();
  for (let j = 0; j < LOOKUPS; j += 1) {
    const i = Math.floor(next() * keys.length);
    count.idx = 0;
    count.parts = 0;
    const got = await reader.get(keys[i]);
    if (got === null || !sameRecord(got, recordOf(i, keys[i], flags[i], 1, times))) throw new BenchError(`lookup of record ${i} does not answer its record`);
    const reads = count.idx + count.parts;
    max = Math.max(max, reads);
    total += reads;
  }
  return { count: LOOKUPS, head_reads: headReads, reads_max: max, reads_mean: round(total / LOOKUPS), ms_per_lookup: round((performance.now() - t0) / LOOKUPS, 4) };
}

const round = (x, places = 3) => Math.round(x * 10 ** places) / 10 ** places;

// The two criteria of DOM-017's Prove, from a result.
export function judge(variants, lookups) {
  const one = variants.find((v) => v.sources === 1);
  const criteria = [
    {
      name: 'one-source-at-most-12-bytes-a-name',
      value: one === undefined ? null : one.bytes_per_name_with_idx,
      limit: MAX_BYTES_PER_NAME,
      pass: one !== undefined && one.bytes_per_name_with_idx <= MAX_BYTES_PER_NAME,
    },
    {
      name: 'lookup-at-most-2-range-reads',
      value: lookups === null ? null : lookups.reads_max,
      limit: MAX_LOOKUP_READS,
      pass: lookups !== null && lookups.count > 0 && lookups.reads_max <= MAX_LOOKUP_READS,
    },
  ];
  return { criteria, pass: criteria.every((c) => c.pass) };
}

export async function bench(flags, { fetchFn } = {}) {
  const startedAt = new Date().toISOString();
  let keys;
  let keyFlags;
  let names;
  if (flags.sample === 'cs2') {
    const sample = await fetchSample({ fetchFn });
    const { lines, decompressed_bytes } = linesOfSample(sample.body);
    const psl = await loadPsl(readFileSync(PSL_FIXTURE));
    const got = keysOfLines(lines, psl);
    const keep = flags.names ?? got.keys.length;
    keys = got.keys.slice(0, keep);
    keyFlags = got.flags.slice(0, keep);
    const { body, ...fetched } = sample;
    names = {
      mode: 'cs2',
      fetched: { ...fetched, bytes: body.length, user_agent: USER_AGENT },
      decompressed_bytes,
      whole_lines: lines.length,
      refused: got.refused,
      distinct_keys: got.keys.length,
      kept: keys.length,
      psl: 'packages/names/test/fixtures/psl-2026-10-27.dat',
    };
  } else {
    keys = syntheticKeys(flags.names, flags.seed);
    keyFlags = keys.map((_, i) => (i % 50 === 0 ? 3 : i % 17 === 0 ? 2 : 1));
    names = { mode: 'synthetic', seed: flags.seed, kept: keys.length };
  }
  const times = syntheticTimes(keys.length, flags.seed);
  const variants = [];
  let lookups = null;
  for (const [label, sources] of [
    ['keys', 0],
    ['1-source', 1],
    ['2-sources', 2],
    ['3-sources', 3],
  ]) {
    const v = await variant(label, sources, keys, keyFlags, times, flags.recordsPerBlock, flags.seed);
    variants.push(v.variant);
    if (v.lookups !== null) lookups = v.lookups;
  }
  const base = variants[0].bytes_per_name;
  for (const v of variants) v.field_bytes_per_name = round(v.bytes_per_name - base);
  const verdict = judge(variants, lookups);
  return {
    schema: SCHEMA,
    entry: 'DOM-017',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    runtime: { writer: writerId(), platform: process.platform, arch: process.arch },
    codec: 'deflate-raw',
    level: 9,
    records_per_block: flags.recordsPerBlock,
    names,
    fields:
      'synthetic, from the seed: bit 0 a day source at day 298 for every name; bit 1 a second source at a random second of day 298, last equal to first for half the names and later in the day for the rest; bit 2 a day source first seen 0 to 298 days before day 298, last day 298',
    bytes_per_name_of: 'the bytes of the parts (headers included) divided by the names; with_idx adds the index',
    decode_of: 'Node wall time of readBlock (range read from memory, inflate, CRC-32) and decodeBlock for every block, in this process; not workerd CPU time',
    variants,
    lookups,
    ...verdict,
  };
}

function table(result) {
  const rows = result.variants.map(
    (v) =>
      `${v.name.padEnd(10)} ${String(v.records).padStart(9)} ${String(v.blocks).padStart(6)} ${String(v.idx_bytes).padStart(9)} ${v.front_bytes_per_name.toFixed(3).padStart(7)} ${v.bytes_per_name.toFixed(3).padStart(7)} ${v.bytes_per_name_with_idx.toFixed(3).padStart(8)} ${v.field_bytes_per_name.toFixed(3).padStart(7)} ${v.decode_ms_per_1000_names.toFixed(4).padStart(9)}`,
  );
  const head = `${'variant'.padEnd(10)} ${'names'.padStart(9)} ${'blocks'.padStart(6)} ${'idx B'.padStart(9)} ${'front'.padStart(7)} ${'B/name'.padStart(7)} ${'+idx'.padStart(8)} ${'fields'.padStart(7)} ${'ms/1000'.padStart(9)}`;
  const l = result.lookups;
  const crit = result.criteria.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}  ${c.value} (limit ${c.limit})`);
  return [head, ...rows, `lookups: ${l.count}, range reads max ${l.reads_max}, mean ${l.reads_mean}, ${l.ms_per_lookup} ms each`, ...crit].join('\n');
}

async function main() {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`pack bench: ${error.message}`);
    return 2;
  }
  let result;
  try {
    result = await bench(flags);
  } catch (error) {
    console.error(`pack bench: could not run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (flags.out !== null) {
    mkdirSync(dirname(resolve(flags.out)), { recursive: true });
    writeFileSync(flags.out, text);
  }
  process.stdout.write(text);
  console.error(table(result));
  return result.pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
