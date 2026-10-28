// scripts/measure/tiles-window.mjs — a window of one CT log by its name, and
// the overlap of the four-log union with the Kafka window and THC's day
// (DOM-011, TODO/ingest.md).
//
// --log: reads the window [--from, --to) of the tiled log named NAME in the log
// list (ct-logs.mjs names it: `tuscolo2027h1`) with ct-window.mjs, prints the
// counts, and with --out writes them as JSON. The Prove's Geomys window is
// `--log tuscolo2027h1 --from 2026-10-26T12:00:00Z --to 2026-10-26T12:05:00Z`.
//
// --overlap: for one 5-minute window, the distinct names of each log family
// (every usable shard of Sycamore, Willow, Tuscolo and Gouda in the list),
// their union, the Kafka window of certstream_domains (kafka-window.mjs, run as
// a child process), and THC's dump of the window's UTC day, hashed by
// ct-window.mjs's hashName; then the share of each set in each other, with
// f64cmp.mjs's compareF64. THC's day is not kept: it is streamed once, and only
// the hashes that are in a window set are kept, which is all a share needs.
//
// The window is picked at run time (DOM-011's Found of 2026-10-28T14:36Z):
// certstream_domains keeps about 24 hours (24.2 h at 2026-10-28T14:22:26Z,
// `node scripts/measure/kafkaprobe.mjs`, and it moves), and THC publishes a
// day's dump at about 00:05 UTC on the next day. So the window starts at the
// pick time less 22 hours, rounded up to 5 minutes, which leaves 2 hours of the
// retention as a margin and puts the window on the day before the pick for any
// pick before 21:25 UTC. A pick that gives a window within 30 minutes of either
// end of its UTC day, or on the pick's own day, or at or after --until, is
// skipped and the file says why. A Kafka window that the retention has cut (its
// first message more than 120 s after the start, or its last more than 120 s
// before the end) is left out of the matrix and marked `cut`. THC's day is
// awaited up to --thc-wait-min, its listing read every 5 minutes.
//
// Usage:
//   node scripts/measure/tiles-window.mjs --log NAME --from ISO --to ISO [--out FILE] [--list FILE] [--data DIR]
//   node scripts/measure/tiles-window.mjs --overlap --out FILE [--from ISO --to ISO | --until ISO]
//        [--list FILE] [--data DIR] [--thc-wait-min 120] [--keep]
// --data defaults to .tmp/measure/DOM-011/ (gitignored): the names files of
// each set, and THC's day while it is read (removed after, unless --keep).
// Exit codes: 0 the window was read whole (or the overlap was skipped, and the
// file says why) · 1 a read failed or is not whole (the file is still written)
// · 2 bad arguments.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { createClient, CtError, errorText } from './ct-tiles.mjs';
import { loadRows, tiledByName } from './ct-logs.mjs';
import { byteKey, dataDir, readWindow, writeNames } from './ct-window.mjs';
import { compareF64, createF64, h53, sortUnique } from './f64cmp.mjs';
import { isMain, run, timeArg, UsageError, writeJson } from './kafka-cli.mjs';
import { download as downloadThcFile } from './thc-day.mjs';
import { forEachLineOfFile } from './thc-lines.mjs';
import { cs2Url, hfUrl, LISTING_URL, parseListing } from './thc-list.mjs';
import { OVERLAP_SCHEMA, overlapWhole, WINDOW_SCHEMA } from './tiles-availability.mjs';

export const FAMILIES = Object.freeze(['sycamore', 'willow', 'tuscolo', 'gouda']);
export const WINDOW_MS = 5 * 60_000;
export const KAFKA_LAG_MS = 22 * 3_600_000;
export const DAY_EDGE_MS = 30 * 60_000;
export const KAFKA_SLACK_MS = 120_000;
export const THC_POLL_MS = 5 * 60_000;
const DAY = 86_400_000;
const KAFKA_WINDOW = join(dirname(fileURLToPath(import.meta.url)), 'kafka-window.mjs');
const KAFKA_TIMEOUT_MS = 20 * 60_000;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const iso = (ms) => new Date(ms).toISOString();

// { from, to, day } of the window picked at `now`, or { skipped }.
export function pickWindow(now, until = null) {
  if (until !== null && now >= until) return { skipped: `until ${iso(until)} has passed` };
  const from = Math.ceil((now - KAFKA_LAG_MS) / WINDOW_MS) * WINDOW_MS;
  const to = from + WINDOW_MS;
  const day = iso(from).slice(0, 10);
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  if (day >= iso(now).slice(0, 10)) return { skipped: `the window ${iso(from)} falls on the pick's own UTC day, whose THC dump is not out until the next day` };
  if (from < dayStart + DAY_EDGE_MS || to > dayStart + DAY - DAY_EDGE_MS) return { skipped: `the window ${iso(from)} is within 30 minutes of an end of its UTC day` };
  return { from, to, day };
}

// The usable tiled shards of each family, from the list's rows.
export function familyShards(rows) {
  const out = {};
  for (const f of FAMILIES) out[f] = rows.filter((r) => r.kind === 'tiled' && r.state === 'usable' && r.name.startsWith(f)).map((r) => r.name);
  return out;
}

// The command that reads the Kafka window: kafka-window.mjs of this directory.
export function kafkaCommand(from, to, data) {
  return [process.execPath, [KAFKA_WINDOW, iso(from), iso(to), 'kafka', '--data', data]];
}

const runKafkaDefault = (from, to, data) => {
  const [cmd, args] = kafkaCommand(from, to, data);
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: KAFKA_TIMEOUT_MS, windowsHide: true });
};

// The Kafka window's names and stat as kafka-window.mjs wrote them under
// `data`, with `cut` judged against [from, to).
export function readKafka(data, from, to) {
  const stat = JSON.parse(readFileSync(join(data, 'kafka.stat.json'), 'utf8'));
  const text = readFileSync(join(data, 'kafka.names.txt'), 'utf8');
  const names = new Set(text === '' ? [] : text.split('\n'));
  const first = stat.first_seen ? Date.parse(stat.first_seen) : null;
  const last = stat.last_seen ? Date.parse(stat.last_seen) : null;
  const cut = !(stat.messages > 0) || first === null || last === null || first > from + KAFKA_SLACK_MS || last < to - KAFKA_SLACK_MS;
  return { names, stat, cut };
}

// The listed THC day, waiting for it up to waitMs. { entry, waited_min } or a
// CtError.
export async function awaitThcDay(client, day, { waitMs, clock = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const t0 = clock();
  for (;;) {
    const o = await client.get(LISTING_URL);
    if (o.status === 200) {
      const entry = parseListing(JSON.parse(o.text)).days.find((d) => d.day === day);
      if (entry) return { entry, waited_min: Math.round((clock() - t0) / 60_000) };
    }
    if (clock() - t0 + THC_POLL_MS > waitMs) throw new CtError(`THC's listing does not hold ${day} after ${Math.round((clock() - t0) / 60_000)} min (last answer ${o.status ?? o.error})`);
    await sleep(THC_POLL_MS);
  }
}

// Streams THC's day file and keeps the hashes of its lines that are in `wanted`.
export async function scanThc(file, wanted) {
  const hits = createF64(1 << 16);
  const r = await forEachLineOfFile(
    file,
    (line) => {
      const h = h53(byteKey(line));
      if (wanted.has(h)) hits.push(h);
    },
    { gzip: true },
  );
  return { lines: r.lines, text_bytes: r.bytes, hits: sortUnique(hits.array().slice()) };
}

const pct = (n, d) => (d === 0 ? null : +((100 * n) / d).toFixed(2));

// The matrix of shares: rows and cols name sets of `sets` (sorted hash
// arrays); `thcHits`, when given, adds the column `thc`.
export function shareMatrix(sets, thcHits = null) {
  const rows = Object.keys(sets);
  const cols = thcHits ? [...rows, 'thc'] : rows;
  const cells = rows.map((r) => cols.map((c) => (c === 'thc' ? pct(compareF64(sets[r], thcHits).both, sets[r].length) : compareF64(sets[r], sets[c]).pctOfA)));
  return { rows, cols, cells };
}

// The union of sorted hash arrays.
function unionOf(arrays) {
  const f = createF64(arrays.reduce((n, a) => n + a.length, 0) || 16);
  for (const a of arrays) for (const x of a) f.push(x);
  return sortUnique(f.array().slice());
}

// The whole overlap of one window. Never rejects for a failed part: each
// part's failure is a field and an entry of `errors`.
export async function overlap({ from, to, day, data, rows, client, runKafka = runKafkaDefault, downloadThc = downloadThcFile, thcWaitMs, keep = false, clock = Date.now, sleep }) {
  const out = { window: { from: iso(from), to: iso(to), day }, families: {}, logs: {}, errors: [] };
  mkdirSync(data, { recursive: true });

  // Kafka first: the retention moves while the rest is read.
  const kafkaDir = join(data, 'kafka');
  mkdirSync(kafkaDir, { recursive: true });
  let kafka = null;
  const k = runKafka(from, to, kafkaDir);
  if (k.error || k.status !== 0) {
    out.kafka = {
      ok: false,
      error: `kafka-window.mjs exited ${k.status ?? errorText(k.error)}: ${String(k.stderr ?? '')
        .trim()
        .slice(0, 200)}`,
    };
    out.errors.push(out.kafka.error);
  } else {
    try {
      kafka = readKafka(kafkaDir, from, to);
      const { names, stat, cut } = kafka;
      out.kafka = { ok: !cut, cut, messages: stat.messages, distinct_names: names.size, first_seen: stat.first_seen, last_seen: stat.last_seen, json_errors: stat.json_errors ?? null };
      if (cut) out.errors.push(`the Kafka window is cut: messages ${stat.messages}, first ${stat.first_seen}, last ${stat.last_seen}`);
    } catch (e) {
      out.kafka = { ok: false, error: `the Kafka outputs cannot be read: ${errorText(e)}` };
      out.errors.push(out.kafka.error);
    }
  }

  const shards = familyShards(rows);
  const reads = await Promise.all(
    Object.values(shards)
      .flat()
      .map(async (name) => {
        try {
          return { name, ...(await readWindow(client, { mon: tiledByName(rows, name).mon, from, to })) };
        } catch (e) {
          return { name, error: errorText(e) };
        }
      }),
  );
  const sets = {};
  for (const [family, names] of Object.entries(shards)) {
    const mine = reads.filter((r) => names.includes(r.name));
    const union = new Set();
    for (const r of mine) {
      if (r.error) {
        out.logs[r.name] = { error: r.error };
        out.errors.push(`${r.name}: ${r.error}`);
        continue;
      }
      out.logs[r.name] = r.stat;
      for (const n of r.names) union.add(n);
    }
    const complete = names.length > 0 && mine.every((r) => !r.error && r.stat.complete);
    out.families[family] = { logs: names, complete, entries: mine.reduce((n, r) => n + (r.stat?.entries ?? 0), 0), distinct_names: union.size };
    if (names.length === 0) out.errors.push(`no usable shard of ${family} in the list`);
    sets[family] = writeNames(join(data, 'sets'), family, union);
  }
  sets.union4 = unionOf(FAMILIES.map((f) => sets[f]));
  if (kafka && !kafka.cut) sets.kafka = writeNames(join(data, 'sets'), 'kafka', kafka.names);
  out.sets = Object.fromEntries(Object.entries(sets).map(([n, a]) => [n, a.length]));

  // THC's day: only the hashes that are in a window set matter.
  let thcHits = null;
  const thcFile = join(data, 'thc', `${day}.txt.gz`);
  try {
    const listed = await awaitThcDay(client, day, { waitMs: thcWaitMs, clock, sleep });
    mkdirSync(dirname(thcFile), { recursive: true });
    const sources = [
      { source: 'cs2', url: cs2Url(day) },
      { source: 'hf', url: hfUrl(listed.entry.path) },
    ];
    const t0 = clock();
    const got = await downloadThc({ sources, dest: thcFile, size: listed.entry.size });
    if (!got.ok) throw new CtError(`no source served THC's ${day}: ${JSON.stringify(got.attempts).slice(0, 300)}`);
    const wanted = new Set();
    for (const a of Object.values(sets)) for (const x of a) wanted.add(x);
    const scan = await scanThc(thcFile, wanted);
    thcHits = scan.hits;
    out.thc = {
      ok: true,
      day,
      source: got.source,
      gz_bytes: got.bytes,
      waited_min: listed.waited_min,
      lines: scan.lines,
      text_bytes: scan.text_bytes,
      hits: scan.hits.length,
      seconds: Math.round((clock() - t0) / 1000),
    };
  } catch (e) {
    out.thc = { ok: false, day, error: errorText(e) };
    out.errors.push(`THC: ${out.thc.error}`);
  } finally {
    if (!keep) rmSync(thcFile, { force: true });
  }
  out.matrix = shareMatrix(sets, thcHits);
  return out;
}

const USAGE = [
  'usage: node scripts/measure/tiles-window.mjs --log NAME --from ISO --to ISO [--out FILE] [--list FILE] [--data DIR]',
  '       node scripts/measure/tiles-window.mjs --overlap --out FILE [--from ISO --to ISO | --until ISO] [--list FILE] [--data DIR] [--thc-wait-min 120] [--keep]',
].join('\n');

async function logMain(args, deps) {
  if (typeof args.log !== 'string' || typeof args.from !== 'string' || typeof args.to !== 'string') throw new UsageError(USAGE);
  const from = timeArg(args.from, '--from');
  const to = timeArg(args.to, '--to');
  if (to <= from) throw new UsageError('--to must be after --from');
  const client = deps.client ?? createClient();
  const doc = { schema: WINDOW_SCHEMA, at: iso((deps.clock ?? Date.now)()), log: args.log, from: iso(from), to: iso(to) };
  let names = null;
  try {
    const rows = await loadRows(args.list, client);
    const r = await readWindow(client, { mon: tiledByName(rows, args.log).mon, from, to });
    doc.stat = r.stat;
    names = r.names;
  } catch (e) {
    doc.error = errorText(e);
  }
  if (typeof args.out === 'string') writeJson(resolve(args.out), doc);
  if (doc.error) {
    console.error(`tiles-window: ${args.log}: ${doc.error}`);
    return 1;
  }
  writeNames(join(dataDir(args.data), 'ct'), args.log, names);
  console.log(JSON.stringify(doc.stat));
  console.log(
    `${args.log} ${doc.from} to ${doc.to}: entries=${doc.stat.entries} names=${doc.stat.distinct_names} tiles=${doc.stat.tiles_read} 429=${doc.stat.throttled}${doc.stat.complete ? '' : ' (not whole)'}`,
  );
  return doc.stat.complete ? 0 : 1;
}

async function overlapMain(args, deps) {
  if (typeof args.out !== 'string') throw new UsageError(USAGE);
  const clock = deps.clock ?? Date.now;
  const now = clock();
  const waitMin = args['thc-wait-min'] === undefined ? 120 : Number(args['thc-wait-min']);
  if (!(waitMin >= 0)) throw new UsageError('--thc-wait-min needs a number of minutes');
  let picked;
  if (args.from !== undefined || args.to !== undefined) {
    const from = timeArg(args.from, '--from');
    const to = timeArg(args.to, '--to');
    if (to <= from) throw new UsageError('--to must be after --from');
    picked = { from, to, day: iso(from).slice(0, 10), by: 'arguments' };
  } else {
    if (args.until !== undefined && (typeof args.until !== 'string' || !INSTANT.test(args.until))) throw new UsageError('--until needs a UTC instant like 2026-10-30T12:00:00Z');
    picked = { ...pickWindow(now, args.until === undefined ? null : Date.parse(args.until)), by: 'run time' };
  }
  const doc = { schema: OVERLAP_SCHEMA, at: iso(now) };
  if (picked.skipped) {
    doc.skipped = picked.skipped;
    writeJson(resolve(args.out), doc);
    console.log(`tiles-window: overlap skipped: ${picked.skipped}`);
    return 0;
  }
  const client = deps.client ?? createClient();
  let rows;
  try {
    rows = await loadRows(args.list, client);
  } catch (e) {
    Object.assign(doc, { window: { from: iso(picked.from), to: iso(picked.to), day: picked.day }, errors: [`the log list: ${errorText(e)}`] });
    writeJson(resolve(args.out), doc);
    console.error(`tiles-window: the log list: ${errorText(e)}`);
    return 1;
  }
  const r = await overlap({ ...picked, data: dataDir(args.data), rows, client, thcWaitMs: waitMin * 60_000, keep: args.keep === true, clock, ...deps.overlap });
  Object.assign(doc, r);
  doc.window.picked_by = picked.by;
  writeJson(resolve(args.out), doc);
  console.log(
    `tiles-window: overlap ${doc.window.from} to ${doc.window.to}: ${Object.entries(doc.sets)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')}`,
  );
  for (const [i, row] of doc.matrix.rows.entries()) console.log(`  ${row.padEnd(9)} ${doc.matrix.cols.map((c, j) => `${c}=${doc.matrix.cells[i][j]}`).join(' ')}`);
  for (const e of doc.errors) console.error(`  ${e}`);
  return overlapWhole(doc) ? 0 : 1;
}

// `deps` replaces the client, the clock or the overlap's runners in a test.
export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  if (args.overlap === true) return overlapMain(args, deps);
  return logMain(args, deps);
}

if (isMain(import.meta.url)) await run('tiles-window', main);
