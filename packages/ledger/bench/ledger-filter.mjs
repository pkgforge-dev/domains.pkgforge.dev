// packages/ledger/bench/ledger-filter.mjs — DOM-021's bench of the provisional
// filter (TODO/storage.md): its false-positive rate, its size, the time to build,
// query, encode and decode it, and the size of a day's delta.
//
// The keys are synthetic and distinct: `<suffix>.b<seed>k<n>` in base 36, the
// present keys for n below --keys and the absent keys above. The filter is sized
// for --keys at --bits-per-key bits a key with --hashes hashes (10 and 7, the
// entry's design), every present key is added, every present key is asked again
// (a Bloom filter has no false negative, so one miss fails the run), and
// --absent keys it never held are asked: the share it claims is the
// false-positive rate. The theory beside it is (1 - e^(-n/P))^k for the
// partition size P the filter chose. The filter is encoded and decoded and must
// give its own bytes back. A delta of --delta hashes (the entry's 0.8 million a
// day) is encoded and decoded the same way. Times are Node wall time in this
// process.
//
// Usage:
//   node packages/ledger/bench/ledger-filter.mjs --keys 10000000 [--absent 1000000] [--delta 800000] [--seed 1] [--bits-per-key 10] [--hashes 7] [--out PATH]
// stdout: one JSON object, schema domains.bench.ledger-filter.v1. stderr: a summary.
// --out writes the same object to PATH.
// Exit codes: 0 the rate is 0.8% to 1.2%, the encoded filter is at most 1% above
// bits-per-key / 8 bytes a key, no present key was missed, and the filter and
// the delta decode to their own bytes · 1 a criterion failed · 2 could not run
// (usage, or an error).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BloomFilter, DEFAULT_BITS_PER_KEY, DEFAULT_HASHES, HashDelta, hashKey } from '../src/index.ts';

export const SCHEMA = 'domains.bench.ledger-filter.v1';
export const RATE_MIN = 0.008;
export const RATE_MAX = 0.012;
export const SIZE_SLACK = 1.01;
const FLAGS = ['keys', 'absent', 'delta', 'seed', 'bits-per-key', 'hashes', 'out'];
const SUFFIXES = ['com', 'net', 'org', 'de', 'uk.co', 'ru', 'io', 'np.com', 'xyz', 'fr'];
// as_of of the bench filter: 2026-10-26T00:00:00Z, which no criterion reads.
const AS_OF = 298 * 86_400;

export class UsageError extends Error {}

export function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!FLAGS.includes(name)) throw new UsageError(`unknown flag --${name}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    out[name] = value;
  }
  const whole = (name, min, max, fallback) => {
    if (out[name] === undefined) return fallback;
    if (!/^\d{1,10}$/.test(out[name]) || Number(out[name]) < min || Number(out[name]) > max) throw new UsageError(`--${name} must be a whole number of ${min} to ${max}`);
    return Number(out[name]);
  };
  const keys = whole('keys', 1, 1_000_000_000, undefined);
  if (keys === undefined) throw new UsageError('give --keys N');
  return {
    keys,
    absent: whole('absent', 1, 100_000_000, 1_000_000),
    delta: whole('delta', 0, 10_000_000, 800_000),
    seed: whole('seed', 0, 2 ** 31, 1),
    bitsPerKey: whole('bits-per-key', 1, 64, DEFAULT_BITS_PER_KEY),
    hashes: whole('hashes', 1, 32, DEFAULT_HASHES),
    out: out.out ?? null,
  };
}

// The n-th synthetic key of a seed.
export const syntheticKey = (n, seed) => `${SUFFIXES[n % SUFFIXES.length]}.b${seed.toString(36)}k${n.toString(36)}`;

const round = (x, places = 6) => Number(x.toFixed(places));
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function judge(result) {
  const sizeLimit = (result.keys * result.bits_per_key) / 8;
  const criteria = [
    { name: 'false-positive-rate-0.8-to-1.2-percent', value: result.rate, limit: [RATE_MIN, RATE_MAX], pass: result.rate >= RATE_MIN && result.rate <= RATE_MAX },
    { name: 'filter-at-most-1-percent-above-bits-a-key', value: result.filter_bytes, limit: Math.floor(sizeLimit * SIZE_SLACK), pass: result.filter_bytes <= sizeLimit * SIZE_SLACK },
    { name: 'no-present-key-missed', value: result.missed, limit: 0, pass: result.missed === 0 },
    { name: 'filter-and-delta-decode-to-their-bytes', value: result.round_trip, limit: true, pass: result.round_trip === true },
  ];
  return { criteria, pass: criteria.every((c) => c.pass) };
}

export function bench(flags) {
  const startedAt = new Date().toISOString();
  let t = performance.now();
  const lap = () => {
    const now = performance.now();
    const ms = now - t;
    t = now;
    return round(ms, 1);
  };
  const filter = BloomFilter.forKeys(flags.keys, { asOf: AS_OF, bitsPerKey: flags.bitsPerKey, hashes: flags.hashes });
  for (let n = 0; n < flags.keys; n += 1) filter.add(hashKey(syntheticKey(n, flags.seed)));
  const buildMs = lap();
  let missed = 0;
  for (let n = 0; n < flags.keys; n += 1) if (!filter.has(hashKey(syntheticKey(n, flags.seed)))) missed += 1;
  const checkMs = lap();
  let claimed = 0;
  for (let n = flags.keys; n < flags.keys + flags.absent; n += 1) if (filter.has(hashKey(syntheticKey(n, flags.seed)))) claimed += 1;
  const queryMs = lap();
  const bytes = filter.encode();
  const encodeMs = lap();
  const back = BloomFilter.decode(bytes);
  const decodeMs = lap();
  const filterBack = sameBytes(back.encode(), bytes);
  lap();
  const delta = HashDelta.empty(filter);
  for (let n = 0; n < flags.delta; n += 1) delta.add(hashKey(`${syntheticKey(n, flags.seed)}.delta`));
  const deltaAddMs = lap();
  const deltaBytes = delta.encode();
  const deltaEncodeMs = lap();
  const deltaBack = HashDelta.decode(deltaBytes);
  const deltaDecodeMs = lap();
  const roundTrip = filterBack && deltaBack.size === delta.size && sameBytes(deltaBack.encode(), deltaBytes);
  const rate = claimed / flags.absent;
  const theory = (1 - Math.exp(-flags.keys / filter.partitionBits)) ** filter.hashes;
  const result = {
    schema: SCHEMA,
    entry: 'DOM-021',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    keys_of: 'synthetic: <suffix>.b<seed>k<n> in base 36; present n below keys, absent n from keys to keys + absent',
    times_of: 'Node wall time in this process, in ms',
    seed: flags.seed,
    keys: flags.keys,
    absent: flags.absent,
    bits_per_key: flags.bitsPerKey,
    hashes: filter.hashes,
    partition_bits: filter.partitionBits,
    filter_bytes: bytes.length,
    bytes_per_key: round(bytes.length / flags.keys),
    false_positives: claimed,
    rate: round(rate),
    theory: round(theory),
    sigma: round(Math.sqrt((theory * (1 - theory)) / flags.absent)),
    missed,
    delta_hashes: delta.size,
    delta_bytes: deltaBytes.length,
    round_trip: roundTrip,
    ms: { build: buildMs, check_present: checkMs, query_absent: queryMs, encode: encodeMs, decode: decodeMs, delta_add: deltaAddMs, delta_encode: deltaEncodeMs, delta_decode: deltaDecodeMs },
  };
  return { ...result, ...judge(result) };
}

function summary(r) {
  const crit = r.criteria.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}  ${JSON.stringify(c.value)} (limit ${JSON.stringify(c.limit)})`);
  return [
    `keys ${r.keys}, ${r.bits_per_key} bits a key, ${r.hashes} hashes: filter ${r.filter_bytes} B (${r.bytes_per_key} B a key), partitions of ${r.partition_bits} bits`,
    `absent ${r.absent}: false positives ${r.false_positives}, rate ${(100 * r.rate).toFixed(4)}% (theory ${(100 * r.theory).toFixed(4)}%, sigma ${(100 * r.sigma).toFixed(4)}%)`,
    `delta of ${r.delta_hashes} hashes: ${r.delta_bytes} B`,
    `ms: ${Object.entries(r.ms)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
    ...crit,
  ].join('\n');
}

function main() {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`ledger-filter bench: ${error.message}`);
    return 2;
  }
  let result;
  try {
    result = bench(flags);
  } catch (error) {
    console.error(`ledger-filter bench: could not run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (flags.out !== null) {
    mkdirSync(dirname(resolve(flags.out)), { recursive: true });
    writeFileSync(flags.out, text);
  }
  process.stdout.write(text);
  console.error(summary(result));
  return result.pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
