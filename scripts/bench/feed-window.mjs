// scripts/bench/feed-window.mjs — DOM-022's bench of one page of a window over a
// feed day pack with its time copy (TODO/storage.md, docs/format.md section
// 14): the bytes of the two copies, and the blocks one page in first_seen order
// reads.
//
// The rows are synthetic, from a seeded generator (`--seed`, default 1): N
// distinct registrable domains under a weighted list of public suffixes, all of
// the day 2026-10-26. A share `--day-share S` of them (default 0.4) are
// day-precision rows of a day source (bit 8, as isc-new) at the start of the
// day; the rest are second-precision rows of a second source (bit 1, as oi-nrd)
// at a random second of the day. No row is provisional. By default no row is
// suspect, so every row of the window passes the default filters;
// `--suspect-share S` flags that share of the rows suspect, with the reason
// suspect-cert (drawn from a second generator of the seed, so the keys and
// times are those of the same seed without it), and `--suspect only` reads a
// page of them alone: a selective filter. `--source IDS` keeps the rows that
// one of those sources carries (oi-nrd, isc-new): another filter.
//
// `--names FILE` takes the keys from a list of names instead, one a line: each
// name normalised (@domains/names, under the pinned list
// packages/names/test/fixtures/psl-2026-10-27.dat) and reduced to its
// registrable domain, refused and repeated names counted and left out. Their
// first_seen times and sources are still synthetic, from the seed, as above.
//
// The pack is written with the production writer (@domains/pack, node:zlib at
// level 9) through writeFeedPack (@domains/feed), both copies at
// `--records-per-block`. The page is read with readFeed and its production
// defaults (the block budget 2,000, the copy chosen by keyCopyFirst unless
// `--copy` forces one), over the window from `--from` (default the start of
// the day) to the end of the day, with `--suffix` as the key range when given.
// Every read of a part and of an index of either copy is counted. The page is
// compared, row by row and field by field, with a sort of every row of the
// window that passes the filter; a page that differs exits 3.
//
// Usage:
//   node scripts/bench/feed-window.mjs --rows 500000 [--order first_seen.desc|first_seen.asc] [--limit 1000]
//     [--seed 1] [--records-per-block 4096] [--suffix com.np] [--suspect-share 0.01]
//     [--suspect exclude|include|only] [--copy auto|key|time] [--names FILE] [--day-share 0.4]
//     [--from 2026-10-26T12:00:00Z] [--source oi-nrd,isc-new] [--out PATH]
// stdout: one JSON object, schema domains.bench.feed-window.v3. stderr: a table.
// --out writes the same object to PATH.
// Exit codes: 0 the page read at most 40 blocks · 1 it read more · 2 usage ·
// 3 the page differs from a sort of every row · 70 any other error.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COPY_CHOICES, compareRows, DEFAULT_LIMIT, FEED_ORDERS, inRange, inWindow, planWindow, readFeed, rowMatches, SUSPECT_FILTERS, sourceTable, writeFeedPack } from '@domains/feed';
import { key as keyOf, loadPsl, normalise, split } from '@domains/names';
import { DEFAULT_RECORDS_PER_BLOCK, FEED_CODEC, FEED_SUSPECT, FEED_SUSPECT_CERT, FEED_TIME_CODEC, MemorySink, PackReader } from '@domains/pack';
import { nodeCompress, writerId } from '@domains/pack/node';
import { ROOT } from '../files.mjs';
import { parseArgs } from '../lib/args.mjs';

export const SCHEMA = 'domains.bench.feed-window.v3';
export const MAX_BLOCKS_A_PAGE = 40;
export const DAY = 298;
export const PSL_FILE = join(ROOT, 'packages', 'names', 'test', 'fixtures', 'psl-2026-10-27.dat');
const DAY_SECONDS = 86_400;
export const DEFAULT_DAY_SHARE = 0.4;
const DAY_ISO = '2026-10-26';
const EPOCH_MS = Date.UTC(2026, 0, 1);
const FLAGS = ['rows', 'order', 'limit', 'seed', 'records-per-block', 'suffix', 'suspect-share', 'suspect', 'copy', 'names', 'day-share', 'from', 'source', 'out'];
// The largest seed: the flag takes at most nine digits.
export const MAX_SEED = 999_999_999;
// A share of 0 to 1, at most six decimals.
const SHARE = /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/;

// The two synthetic sources, with the families and precisions docs/sources.md
// gives isc-new and oi-nrd.
export const SOURCES = [
  { id: 'oi-nrd', bit: 1, family: 'ct', precision: 'second', kind: 'claimed_new' },
  { id: 'isc-new', bit: 8, family: 'isc', precision: 'day', kind: 'claimed_new' },
];

export class UsageError extends Error {}
export class WrongPage extends Error {}

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
  const rows = whole('rows', 1, 10_000_000);
  if (rows === undefined && a.names === undefined) throw new UsageError('give --rows N or --names FILE');
  const order = a.order ?? 'first_seen.desc';
  if (!FEED_ORDERS.includes(order)) throw new UsageError(`--order takes ${FEED_ORDERS.join(' or ')}`);
  if (a.suffix !== undefined && !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(a.suffix)) throw new UsageError('--suffix takes a lowercase suffix such as com.np');
  if (a['suspect-share'] !== undefined && !SHARE.test(a['suspect-share'])) throw new UsageError('--suspect-share takes a share of 0 to 1, such as 0.01');
  if (a['day-share'] !== undefined && !SHARE.test(a['day-share'])) throw new UsageError('--day-share takes a share of 0 to 1, such as 0.4');
  let from = DAY * DAY_SECONDS;
  if (a.from !== undefined) {
    const ms = /^2026-10-26T\d{2}:\d{2}:\d{2}Z$/.test(a.from) ? Date.parse(a.from) : Number.NaN;
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== a.from.replace('Z', '.000Z')) throw new UsageError(`--from takes a time of ${DAY_ISO}, such as ${DAY_ISO}T12:00:00Z`);
    from = (ms - EPOCH_MS) / 1000;
  }
  let sources = null;
  if (a.source !== undefined) {
    sources = a.source.split(',').map((id) => {
      const s = SOURCES.find((x) => x.id === id);
      if (s === undefined) throw new UsageError(`--source takes ${SOURCES.map((x) => x.id).join(' or ')}, separated by commas`);
      return s.bit;
    });
    if (new Set(sources).size !== sources.length) throw new UsageError('--source names a source twice');
  }
  const suspect = a.suspect ?? 'exclude';
  if (!SUSPECT_FILTERS.includes(suspect)) throw new UsageError(`--suspect takes ${SUSPECT_FILTERS.join(', ')}`);
  if (a.names !== undefined && !existsSync(a.names)) throw new UsageError(`--names: no file ${a.names}`);
  const copy = a.copy ?? 'auto';
  if (!COPY_CHOICES.includes(copy)) throw new UsageError(`--copy takes ${COPY_CHOICES.join(', ')}`);
  return {
    rows: rows ?? null,
    order,
    limit: whole('limit', 1, 10_000) ?? DEFAULT_LIMIT,
    seed: whole('seed', 0, MAX_SEED) ?? 1,
    recordsPerBlock: whole('records-per-block', 1, 65_535) ?? DEFAULT_RECORDS_PER_BLOCK,
    suffix: a.suffix ?? null,
    suspectShare: a['suspect-share'] === undefined ? 0 : Number(a['suspect-share']),
    suspect,
    copy,
    names: a.names ?? null,
    dayShare: a['day-share'] === undefined ? DEFAULT_DAY_SHARE : Number(a['day-share']),
    from,
    sources,
    out: a.out ?? null,
  };
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
  ['top', 4],
  ['nl', 2],
  ['com.br', 2],
];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// Synthetic times, sources and flags for keys in ascending order: a share
// `dayShare` of day rows at the start of the day, the rest at a random second;
// a share `suspectShare` suspect with the reason suspect-cert, drawn from a
// second generator so that the times do not depend on the share.
function timed(keys, next, seed, suspectShare, dayShare) {
  const flag = rng((seed ^ 0x9e3779b9) >>> 0);
  return keys.map((key) => {
    const day = next() < dayShare;
    return {
      key,
      flags: 0,
      firstSeen: DAY * DAY_SECONDS + (day ? 0 : Math.floor(next() * DAY_SECONDS)),
      sources: [day ? 8 : 1],
      basis: 4,
      confidence: 0,
      feedFlags: suspectShare > 0 && flag() < suspectShare ? FEED_SUSPECT | FEED_SUSPECT_CERT : 0,
    };
  });
}

// n synthetic feed rows of the day, in key order.
export function syntheticRows(n, seed, suspectShare = 0, dayShare = DEFAULT_DAY_SHARE) {
  const next = rng(seed);
  const total = SUFFIXES.reduce((s, [, w]) => s + w, 0);
  const suffixKey = () => {
    let r = next() * total;
    for (const [sfx, w] of SUFFIXES) if ((r -= w) < 0) return sfx.split('.').reverse().join('.');
    return 'com';
  };
  const word = () => {
    const len = 5 + Math.floor(next() * 10);
    let w = '';
    for (let i = 0; i < len; i += 1) w += LETTERS[Math.floor(next() * 26)];
    return next() < 0.2 ? `${w}${Math.floor(next() * 1000)}` : w;
  };
  const keys = new Set();
  while (keys.size < n) keys.add(`${suffixKey()}.${word()}`);
  return timed([...keys].sort(), next, seed, suspectShare, dayShare);
}

// The keys of a list of names, one a line: each normalised and reduced to its
// registrable domain under `psl`; refused and repeated names counted. At most
// `limit` keys, the first ones in key order, when a limit is given.
export function keysOfNames(text, psl, limit = null) {
  const keys = new Set();
  const refused = {};
  let lines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    lines += 1;
    const n = normalise(line, psl);
    if ('refused' in n) {
      refused[n.refused] = (refused[n.refused] ?? 0) + 1;
      continue;
    }
    const reg = split(n.name, psl).reg;
    if (reg === null) {
      refused['public-suffix'] = (refused['public-suffix'] ?? 0) + 1;
      continue;
    }
    keys.add(keyOf(reg));
  }
  const sorted = [...keys].sort();
  return { keys: limit === null ? sorted : sorted.slice(0, limit), lines, refused, distinct: sorted.length };
}

// The rows of a list of names: their keys, and synthetic times from the seed.
export function rowsOfNames(keys, seed, suspectShare = 0, dayShare = DEFAULT_DAY_SHARE) {
  return timed(keys, rng(seed), seed, suspectShare, dayShare);
}

// The verdict of DOM-022's Prove on a result.
export function judge(page) {
  const pass = page.blocks_read <= MAX_BLOCKS_A_PAGE;
  return { criteria: [{ name: 'one-page-at-most-40-blocks', value: page.blocks_read, limit: MAX_BLOCKS_A_PAGE, pass }], pass };
}

// A row whole, every field of it, as one line.
const rowText = (r) => JSON.stringify([r.firstSeen, r.key, r.flags, r.sources, r.basis, r.confidence, r.feedFlags]);

// The page against the first `limit` rows of a sort of every row, row by row
// and field by field; a page that differs throws WrongPage.
export function checkPage(got, want) {
  if (got.length !== want.length) throw new WrongPage(`the page holds ${got.length} rows, a sort of every row gives ${want.length}`);
  for (let i = 0; i < got.length; i += 1) {
    const [g, w] = [rowText(got[i]), rowText(want[i])];
    if (g !== w) throw new WrongPage(`row ${i} of the page is ${g}; the sort gives ${w}`);
  }
}

const round = (x, places = 3) => Math.round(x * 10 ** places) / 10 ** places;

// A copy held in memory as a counted source: every read of its index and of
// its parts.
function counted(summary, parts) {
  const count = { idx: 0, idxBytes: 0, parts: 0, partBytes: 0 };
  return {
    count,
    idx: {
      size: summary.idx.length,
      read: async (o, n) => {
        count.idx += 1;
        count.idxBytes += n;
        return summary.idx.subarray(o, o + n);
      },
    },
    parts: {
      read: async (p, o, n) => {
        count.parts += 1;
        count.partBytes += n;
        return parts[p].subarray(o, o + n);
      },
    },
  };
}

const bytesOf = (summary) => summary.partBytes + summary.idx.length;
const isoOf = (t) => new Date(EPOCH_MS + t * 1000).toISOString().replace('.000Z', 'Z');
const sourceIds = (bits) => (bits === null ? null : bits.map((b) => SOURCES.find((s) => s.bit === b).id));

export async function bench(flags) {
  const startedAt = new Date().toISOString();
  const table = sourceTable(SOURCES);
  let names = null;
  let rows;
  if (flags.names === null) rows = syntheticRows(flags.rows, flags.seed, flags.suspectShare, flags.dayShare);
  else {
    const psl = await loadPsl(readFileSync(PSL_FILE));
    names = keysOfNames(readFileSync(flags.names, 'utf8'), psl, flags.rows);
    rows = rowsOfNames(names.keys, flags.seed, flags.suspectShare, flags.dayShare);
  }
  const filter = flags.sources === null ? { suspect: flags.suspect } : { suspect: flags.suspect, sources: flags.sources };
  const sink = new MemorySink();
  const timeSink = new MemorySink();
  const t0 = performance.now();
  const pack = await writeFeedPack(rows, { codec: FEED_CODEC, compress: nodeCompress, sink, recordsPerBlock: flags.recordsPerBlock, time: { sink: timeSink, recordsPerBlock: flags.recordsPerBlock } });
  const writeMs = performance.now() - t0;
  const key = counted(pack.summary, sink.parts());
  const time = counted(pack.time, timeSink.parts());
  const timeParts = timeSink.parts();
  // The shape of root.json's datasets: per dataset, the list of its packs.
  const live = {
    feed: [
      {
        tag: 'feed-d-20261026',
        tier: 'd',
        span: { start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' },
        key_min: pack.summary.keyMin,
        key_max: pack.summary.keyMax,
        time: { idx: { digest: `sha256:${'0'.repeat(64)}`, size: pack.time.idx.length }, parts: timeParts.map((p) => ({ digest: `sha256:${'0'.repeat(64)}`, size: p.length })) },
      },
    ],
  };
  const plan = planWindow(live, { t0: flags.from, t1: (DAY + 1) * DAY_SECONDS, suffix: flags.suffix });
  const open = async (entry) => ({
    reader: await PackReader.open(key.idx, key.parts, FEED_CODEC, { pageCache: 16 }),
    time: await PackReader.open(time.idx, time.parts, FEED_TIME_CODEC, { pageCache: 16, partSizes: entry.time.parts.map((p) => p.size) }),
  });
  const t1 = performance.now();
  const page = await readFeed(plan, { open, table, order: flags.order, limit: flags.limit, filter, copy: flags.copy });
  const readMs = performance.now() - t1;
  const want = rows.filter((r) => inRange(plan.range, r.key) && inWindow(r, plan.window, table.precision) && rowMatches(r, filter));
  want.sort(flags.order === 'first_seen.asc' ? compareRows : (a, b) => compareRows(b, a));
  checkPage(page.rows, want.slice(0, flags.limit));
  if (page.stats.blocksRead !== key.count.parts + time.count.parts)
    throw new Error(`the reader counts ${page.stats.blocksRead} blocks and the parts answered ${key.count.parts + time.count.parts} reads`);
  if (page.stats.timeBlocksRead !== time.count.parts) throw new Error(`the reader counts ${page.stats.timeBlocksRead} blocks of the time copy and its parts answered ${time.count.parts} reads`);
  const n = rows.length;
  const copyOf = (summary) => ({
    blocks: summary.blocks,
    part_bytes: summary.partBytes,
    idx_bytes: summary.idx.length,
    bytes: bytesOf(summary),
    bytes_per_row: round(bytesOf(summary) / n),
  });
  const result = {
    rows: n,
    day_precision_rows: rows.filter((r) => r.sources[0] === 8).length,
    suspect_rows: rows.filter((r) => (r.feedFlags & FEED_SUSPECT) !== 0).length,
    records_per_block: flags.recordsPerBlock,
    key_copy: copyOf(pack.summary),
    time_copy: copyOf(pack.time),
    time_to_key_bytes: round(bytesOf(pack.time) / bytesOf(pack.summary)),
    write_ms: round(writeMs),
    window: { start: isoOf(flags.from), end: '2026-10-27T00:00:00Z', suffix: flags.suffix, suspect: flags.suspect, sources: sourceIds(flags.sources), rows: want.length },
    page: {
      order: flags.order,
      limit: flags.limit,
      copy_asked: flags.copy,
      copy_read: page.stats.copiesRead[0] ?? null,
      rows: page.rows.length,
      partial: page.partial,
      blocks_read: page.stats.blocksRead,
      key_blocks_read: key.count.parts,
      time_blocks_read: time.count.parts,
      blocks_read_share: round(page.stats.blocksRead / (page.stats.copiesRead[0] === 'time' ? pack.time.blocks : pack.summary.blocks)),
      block_bytes_read: key.count.partBytes + time.count.partBytes,
      rows_decoded: page.stats.rowsDecoded,
      idx_reads: key.count.idx + time.count.idx,
      idx_bytes_read: key.count.idxBytes + time.count.idxBytes,
      read_ms: round(readMs),
    },
  };
  const verdict = judge(result.page);
  const timesOf = `first_seen synthetic, from the seed: a share ${flags.dayShare} of day-precision rows of a day source (bit 8) at the start of 2026-10-26, the rest second-precision rows of a second source (bit 1) at a random second of it`;
  const suspectOf = flags.suspectShare === 0 ? 'no row suspect' : `a share ${flags.suspectShare} of the rows suspect (suspect-cert), drawn from a second generator of the seed`;
  return {
    schema: SCHEMA,
    entry: 'DOM-022',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    runtime: { writer: writerId(), platform: process.platform, arch: process.arch },
    seed: flags.seed,
    suspect_share: flags.suspectShare,
    day_share: flags.dayShare,
    rows_of:
      names === null
        ? `synthetic, from the seed: distinct registrable domains of 2026-10-26 under a weighted list of suffixes; ${timesOf}; no row provisional; ${suspectOf}`
        : `the keys of the names of ${flags.names} (${names.lines} lines, ${names.distinct} distinct registrable domains, refused ${JSON.stringify(names.refused)}${flags.rows === null ? '' : `, the first ${flags.rows} in key order`}); ${timesOf}; no row provisional; ${suspectOf}`,
    read_of: `readFeed of packages/feed with its defaults (block budget 2000, copy ${flags.copy}) and the filter suspect=${flags.suspect}${flags.sources === null ? '' : ` source=${sourceIds(flags.sources).join(',')}`}, over the window ${isoOf(flags.from)} to 2026-10-27T00:00:00Z, every read of a part and of an index of either copy counted; read_ms is Node wall time of one run in this process, not workerd CPU time, and moves with the load of the machine`,
    ...result,
    ...verdict,
  };
}

function tableOf(result) {
  const p = result.page;
  const k = result.key_copy;
  const t = result.time_copy;
  return [
    `rows ${result.rows} (${result.day_precision_rows} day-precision, ${result.suspect_rows} suspect), ${result.records_per_block} a block`,
    `key copy ${k.blocks} blocks, ${k.bytes} B (${k.bytes_per_row} B a row); time copy ${t.blocks} blocks, ${t.bytes} B (${t.bytes_per_row} B a row); time/key ${result.time_to_key_bytes}`,
    `window ${result.window.start} to ${result.window.end}${result.window.suffix === null ? '' : `, suffix ${result.window.suffix}`}, suspect=${result.window.suspect}${result.window.sources === null ? '' : `, source=${result.window.sources.join(',')}`}: ${result.window.rows} rows`,
    `page ${p.order} limit ${p.limit}, ${p.copy_read} copy: ${p.rows} rows, ${p.blocks_read} blocks read (${p.key_blocks_read} key, ${p.time_blocks_read} time, ${p.block_bytes_read} B), ${p.rows_decoded} rows decoded, ${p.idx_reads} index reads, ${p.read_ms} ms`,
    ...result.criteria.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}  ${c.value} (limit ${c.limit})`),
  ].join('\n');
}

// The run and its exit code. `run` is the bench; a test passes another to
// reach each exit code through the same mapping.
export async function main(argv = process.argv.slice(2), run = bench) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`feed-window bench: ${error.message}`);
    return 2;
  }
  let result;
  try {
    result = await run(flags);
  } catch (error) {
    if (error instanceof WrongPage) {
      console.error(`feed-window bench: ${error.message}`);
      return 3;
    }
    console.error(`feed-window bench: internal error: ${error instanceof Error ? error.stack : String(error)}`);
    return 70;
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (flags.out !== null) {
    mkdirSync(dirname(resolve(flags.out)), { recursive: true });
    writeFileSync(flags.out, text);
  }
  process.stdout.write(text);
  console.error(tableOf(result));
  return result.pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`feed-window bench: internal error: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 70;
  }
}
