// scripts/measure/first-names-tile.mjs — the lowest names tile a log serves,
// by binary search between a tile it does not serve (404) and one it serves
// (200) (DOM-011, TODO/ingest.md). Copied from
// docs/research/2026-10-27-record/scripts/first-names-tile.mjs, which found
// that IPng Gouda2026h2 serves tiles 366,929 to 4,810,099 (MEASURED
// 2026-10-27T08:24:45Z). What changed: the search is a function the round of
// tiles-availability.mjs and the window read of ct-window.mjs call; it takes
// what the caller already knows (tile 0 missing, the tail served) and a hint,
// the answer of the round before, which settles in two probes when the first
// served tile has not moved; every request sends the project's User-Agent; and
// `probes` counts every request, where the record's script counted only the
// halvings (its 22 probes for Gouda2026h2 are 24 requests here).
//
// The search assumes a log serves one contiguous range up to its tail. A
// status other than 200 or 404 (a 429, a 5xx, no answer) ends the search with
// an error rather than reading as "not served".
//
// Usage:
//   import { firstServedTile } from './first-names-tile.mjs'
//   node scripts/measure/first-names-tile.mjs MONITORING_URL TAIL
//     prints {firstServedTile, tail, servedTiles, entriesServed, probes} as JSON
// Exit codes: 0 found (or tile 0 is served, or the tail is not) · 1 a probe got
// a status other than 200 or 404 · 2 bad arguments.
import { baseOf, CtError, createClient, TILE_WIDTH, tilePath } from './ct-tiles.mjs';
import { intArg, isMain, run, UsageError } from './kafka-cli.mjs';

// A probe function for firstServedTile over one log: true for 200, false for
// 404, a CtError for anything else.
export function servedProbe(client, mon) {
  const base = baseOf(mon);
  return async (i) => {
    const o = await client.get(`${base}tile/names/${tilePath(i)}`);
    if (o.status === 200) return true;
    if (o.status === 404) return false;
    throw new CtError(`tile ${i} answered ${o.status ?? o.error}`);
  };
}

// { first, probes, how } with `first` the lowest served tile in [lo, hi]:
// `lo` is a tile known missing (or null: probe tile 0 first), `hi` one known
// served (or null: probe it first). `first` is null when hi is not served.
export async function firstServedTile(probe, { hi, lo = null, hint = null }) {
  if (!Number.isSafeInteger(hi) || hi < 0) throw new CtError(`the tail must be a tile number, got ${hi}`);
  let probes = 0;
  const ok = async (i) => {
    probes += 1;
    return probe(i);
  };
  let low = lo;
  if (low === null) {
    if (await ok(0)) return { first: 0, probes, how: 'tile 0' };
    low = 0;
  }
  if (!(await ok(hi))) return { first: null, probes, how: 'tail not served' };
  let high = hi;
  if (Number.isSafeInteger(hint) && hint > low && hint <= high) {
    if (await ok(hint)) {
      if (!(await ok(hint - 1))) return { first: hint, probes, how: 'hint' };
      high = hint - 1;
    } else low = hint;
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await ok(mid)) high = mid;
    else low = mid;
  }
  return { first: high, probes, how: 'search' };
}

async function main(argv) {
  const [mon, tailArg] = argv;
  if (typeof mon !== 'string' || !/^https:\/\//.test(mon)) throw new UsageError('usage: node scripts/measure/first-names-tile.mjs MONITORING_URL TAIL');
  const tail = intArg(tailArg, 'TAIL');
  let r;
  try {
    r = await firstServedTile(servedProbe(createClient(), mon), { hi: tail });
  } catch (e) {
    if (e instanceof CtError) {
      console.error(`first-names-tile: ${e.message}`);
      return 1;
    }
    throw e;
  }
  if (r.first === 0) console.log('tile 0 exists');
  else if (r.first === null) console.log('tail missing');
  else console.log(JSON.stringify({ firstServedTile: r.first, tail, servedTiles: tail - r.first + 1, entriesServed: (tail - r.first + 1) * TILE_WIDTH, probes: r.probes }));
  return 0;
}

if (isMain(import.meta.url)) await run('first-names-tile', main);
