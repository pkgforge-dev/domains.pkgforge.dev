// scripts/measure/ct-window.mjs — read the names tiles of one static CT log
// for a UTC window and count what design A's M10 counted: tiles, entries,
// bytes, distinct names (DOM-011, TODO/ingest.md).
//
// Copied from docs/research/2026-10-27-design-a/scripts/ct-window.mjs. What
// changed: every request sends the project's User-Agent (design A's sent none,
// and Geomys answered 429); a 429 is retried after its Retry-After, capped
// (ct-tiles.mjs); a log that does not serve tile 0 is searched from its first
// served tile (first-names-tile.mjs), where design A's binary search failed on
// the 404; the read goes on through the partial tile and stops there, where
// design A's workers asked for tiles past the end; a window that starts before
// the served range, or that the tree does not yet hold to its end, is marked
// not whole rather than counted as whole; each tile must hold its width of
// entries; the outputs go under --data DIR (default .tmp/measure/DOM-011/)
// instead of ./ct/; and the hash file uses one hash for every set of the
// overlap (below), where design A used its own.
//
// The end: a shard that receives few entries can hold the window's end only in
// its partial tile, so the read goes on into it. The read of
// docs/research/measure/DOM-011/local-2026-10-28/overlap.json (at
// 2026-10-28T15:48:30Z, made before this change) shows the case:
// Sycamore2027h2, Willow2027h2 and Gouda2027h2 for 2026-10-27T17:50Z to 17:55Z
// have no full tile with an entry at or after the window's start (start_tile
// is the last full tile plus one, tiles_read 0), and that read stopped there,
// not whole. The read into the partial tile is tested in ct-window.test.mjs
// over a synthetic log, and has not been run against those logs. A read that
// finds no entry at or after the window's end has read the whole tree; its
// window is whole when it closed at least SEQUENCED_MS before the checkpoint
// was read, since a static log sequences an entry within seconds of its
// timestamp.
//
// Bytes: `gz_bytes` sums the Content-Length of the tiles that declared one.
// Whether a tile declares one varies by log, so no host rule is drawn: in the
// overlap read above, every tile of Tuscolo2026h2, Tuscolo2027h1, Gouda2026h2
// and Gouda2027h1 came without a length and the five of Tuscolo2027h2 came
// with one, and the 193 tiles of the Geomys window (geomys-window.json, at
// 2026-10-28T15:47:42Z) came without. So `gz_unknown_tiles` counts the tiles
// without one, and `gzip_local_bytes` is the size of each decoded tile
// gzipped here at level 6, an estimate of the wire size and labelled as one.
//
// The hash: every set the overlap compares (each log, the Kafka window, THC's
// day) is hashed by hashName below, f64cmp.mjs's h53 over nameKey: the name's
// UTF-8 bytes as a latin1 string, one trailing CR dropped, ASCII upper case
// lowered, one leading `*.` dropped. DOM-011's Found of 2026-10-28T14:36Z: the
// two h53 functions of the tree do not compare, so one is used throughout.
//
// Usage:
//   import { readWindow, hashName, byteKey, writeNames } from './ct-window.mjs'
//   node scripts/measure/ct-window.mjs MONITORING_URL T0 T1 OUTNAME [--data DIR]
//     writes DIR/ct/OUTNAME.names.txt (one name a line) and DIR/ct/OUTNAME.names.f64
//     (sorted hashes, f64cmp.mjs's format) and prints the window's counts as JSON
// Exit codes: 0 read, and the window is whole · 1 a read failed, or the window
// is not whole · 2 bad arguments.
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT } from '../files.mjs';
import { baseOf, CtError, createClient, parseCheckpoint, parseNamesTile, partialPath, TILE_WIDTH, tilePath, tilesOf } from './ct-tiles.mjs';
import { createF64, h53, sortUnique, writeF64 } from './f64cmp.mjs';
import { firstServedTile, servedProbe } from './first-names-tile.mjs';
import { isMain, run, timeArg, UsageError, writeFileAtomic } from './kafka-cli.mjs';
import { normaliseName } from './kafka-window.mjs';
import { parseArgs } from '../lib/args.mjs';

export const DEFAULT_DATA = '.tmp/measure/DOM-011';
export const WORKERS = 6;
export const RETRY_429 = 4;
// A window that closed this long before the checkpoint was read is in the tree whole.
export const SEQUENCED_MS = 5 * 60_000;

// The key of one name as bytes in a latin1 string (see the header).
export function byteKey(bytes) {
  let s = bytes.endsWith('\r') ? bytes.slice(0, -1) : bytes;
  if (/[A-Z]/.test(s)) s = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  return s.startsWith('*.') ? s.slice(2) : s;
}

export const nameKey = (name) => byteKey(Buffer.from(name, 'utf8').toString('latin1'));
export const hashName = (name) => h53(nameKey(name));

// The sorted, duplicate-free hashes of a set of names.
export function hashSet(names) {
  const f = createF64(names.size);
  for (const n of names) f.push(hashName(n));
  return sortUnique(f.array().slice());
}

// Writes DIR/NAME.names.txt and DIR/NAME.names.f64; returns the hashes.
export function writeNames(dir, name, names) {
  writeFileAtomic(join(dir, `${name}.names.txt`), [...names].join('\n'));
  const hashes = hashSet(names);
  writeF64(join(dir, `${name}.names.f64`), hashes);
  return hashes;
}

// Reads the window [from, to) (ms) of the log at `mon`. Resolves to
// { names, stat }; rejects with a CtError when the log cannot be read.
export async function readWindow(client, { mon, from, to, workers = WORKERS, retry429 = RETRY_429, clock = Date.now }) {
  if (!(from < to)) throw new CtError('the window must end after it starts');
  const base = baseOf(mon);
  const cp = await client.get(`${base}checkpoint`, { retry429 });
  if (cp.status !== 200) throw new CtError(`the checkpoint answered ${cp.status ?? cp.error}`);
  const { size } = parseCheckpoint(cp.text);
  const checkpointAt = clock();
  const { last, partial } = tilesOf(size);
  const stat = { mon, window: [new Date(from).toISOString(), new Date(to).toISOString()], log_size: size, last_full_tile: last, partial_width: partial };
  if (last < 0) throw new CtError('the log holds no full tile');

  const served = await firstServedTile(servedProbe(client, mon), { hi: last });
  if (served.first === null) throw new CtError(`the last full tile ${last} is not served`);
  stat.first_served_tile = served.first;
  stat.first_served_probes = served.probes;

  let throttled = 0;
  const counts = { tiles: 0, gz: 0, gzUnknown: 0, gzipLocal: 0, raw: 0 };
  // Tile i; the tile after the last full one is the partial tile.
  async function tile(i, count) {
    const width = i > last ? partial : TILE_WIDTH;
    const o = await client.get(`${base}tile/names/${i > last ? partialPath(i, width) : tilePath(i)}`, { retry429 });
    throttled += o.throttled ?? 0;
    if (o.status !== 200) throw new CtError(`tile ${i} answered ${o.status ?? o.error}`);
    if (count) {
      counts.tiles += 1;
      counts.raw += o.bytes;
      if (o.gz_bytes === null) counts.gzUnknown += 1;
      else counts.gz += o.gz_bytes;
      counts.gzipLocal += gzipSync(o.text, { level: 6 }).length;
    }
    return parseNamesTile(o.text, width);
  }

  // The first tile whose last entry is at or after `from`.
  let lo = served.first;
  let hi = last + 1;
  let probes = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    probes += 1;
    if ((await tile(mid, false)).at(-1).ts >= from) hi = mid;
    else lo = mid + 1;
  }
  const start = lo;
  stat.start_tile = start;
  stat.bsearch_probes = probes;
  // The window starts before what the log serves: its first entries are gone.
  stat.cut_before = start === served.first && served.first > 0 && (await tile(start, false))[0].ts > from;

  const names = new Set();
  let entries = 0;
  let first = null;
  let lastTs = null;
  // The tiles to read run to the partial tile, when there is one.
  const end = partial > 0 ? last + 1 : last;
  let next = start;
  let done = false;
  let reachedEnd = start > end;
  async function worker() {
    while (!done) {
      const i = next++;
      if (i > end) {
        reachedEnd = true;
        return;
      }
      for (const e of await tile(i, true)) {
        if (e.ts < from) continue;
        if (e.ts >= to) {
          done = true;
          continue;
        }
        entries += 1;
        if (first === null || e.ts < first) first = e.ts;
        if (lastTs === null || e.ts > lastTs) lastTs = e.ts;
        for (const d of e.dns) names.add(normaliseName(d));
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  // A read that found no entry at or after `to` has read the whole tree. The
  // tree holds every entry of the window when the window closed well before
  // the checkpoint was read (a static log sequences within seconds), so such a
  // window is whole: the log had nothing later. Otherwise it is not.
  stat.reached_end = reachedEnd && !done;
  stat.closed_before_checkpoint = checkpointAt - to >= SEQUENCED_MS;
  stat.complete = !stat.cut_before && (!stat.reached_end || stat.closed_before_checkpoint);
  Object.assign(stat, {
    tiles_read: counts.tiles,
    entries,
    distinct_names: names.size,
    gz_bytes: counts.gz,
    gz_unknown_tiles: counts.gzUnknown,
    gzip_local_bytes: counts.gzipLocal,
    raw_bytes: counts.raw,
    gz_per_entry: counts.gzUnknown === 0 ? +(counts.gz / Math.max(1, entries)).toFixed(1) : null,
    throttled,
    first: first === null ? null : new Date(first).toISOString(),
    last: lastTs === null ? null : new Date(lastTs).toISOString(),
  });
  return { names, stat };
}

// The data directory: --data resolved against the working directory, or the
// default under the repository root.
export function dataDir(arg) {
  if (arg === undefined) return join(ROOT, DEFAULT_DATA);
  if (typeof arg !== 'string') throw new UsageError('--data needs a directory');
  return resolve(arg);
}

async function main(argv) {
  const args = parseArgs(argv);
  const [mon, t0, t1, outname] = args._;
  if (typeof outname !== 'string' || !/^https:\/\//.test(mon)) throw new UsageError('usage: node scripts/measure/ct-window.mjs MONITORING_URL T0 T1 OUTNAME [--data DIR]');
  if (!/^[A-Za-z0-9._-]+$/.test(outname)) throw new UsageError('OUTNAME may hold letters, digits, dot, dash and underscore only');
  const from = timeArg(t0, 'T0');
  const to = timeArg(t1, 'T1');
  if (to <= from) throw new UsageError('T1 must be after T0');
  const data = dataDir(args.data);
  let r;
  try {
    r = await readWindow(createClient(), { mon, from, to });
  } catch (e) {
    if (e instanceof CtError) {
      console.error(`ct-window: ${e.message}`);
      return 1;
    }
    throw e;
  }
  writeNames(join(data, 'ct'), outname, r.names);
  console.log(JSON.stringify(r.stat));
  return r.stat.complete ? 0 : 1;
}

if (isMain(import.meta.url)) await run('ct-window', main);
