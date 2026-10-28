// scripts/measure/tiles-probe.mjs — one look at one tiled CT log: its
// checkpoint, names tile 0, the last full names tile, the partial names tile,
// and, when tile 0 is not served, the lowest tile that is (DOM-011,
// TODO/ingest.md). A round of tiles-availability.mjs probes every tiled log of
// the list with this.
//
// Copied from docs/research/2026-10-27-record/scripts/tiles-probe.mjs, which
// made the table of DOM-011's premise (MEASURED 2026-10-27T08:23:41Z to
// 08:24:07Z). What changed: the partial tile is probed too; tile 0 is probed
// only when the tree holds a full tile; each answer is kept as a record (status,
// time, sizes, and the headers and the start of the body of any answer other
// than 200) instead of a printed line; a body that answers 200 is checked as a
// names tile of the expected width; and every request sends the project's
// User-Agent, where the record's script sent none.
//
// A partial tile can answer 404 for a moment when the log has completed it
// between the checkpoint read and the request: the static CT API lets a log
// drop a partial tile once the full one exists. So a 404 there is recorded,
// and tiles-availability.mjs does not judge Geomys by it.
//
// Usage:
//   import { probeLog } from './tiles-probe.mjs'
//   node scripts/measure/tiles-probe.mjs [--list FILE] [--name REGEX] [--states usable,qualified]
//     prints one JSON line per tiled log of the list (fetched, or the log list or
//     ct-logs.mjs rows in FILE) whose name matches and whose state is listed
// Exit codes: 0 every checkpoint answered 200 · 1 one did not, or the list could
// not be had · 2 bad arguments.
import { brief, baseOf, createClient, parseCheckpoint, parseNamesTile, partialPath, TILE_WIDTH, tilePath, tilesOf } from './ct-tiles.mjs';
import { loadRows } from './ct-logs.mjs';
import { firstServedTile, servedProbe } from './first-names-tile.mjs';
import { isMain, run, UsageError } from './kafka-cli.mjs';
import { parseArgs } from '../lib/args.mjs';

export const DEFAULT_STATES = Object.freeze(['usable', 'qualified']);

// A names tile answer as a record: the observation without its text, and for a
// 200 the entry count and the first and last Timestamp, or why the body is not
// a names tile of `width` entries.
function tileRecord(n, o, width, extra = {}) {
  const r = { n, ...extra, ...brief(o) };
  if (o.status === 200) {
    try {
      const entries = parseNamesTile(o.text, width);
      r.entries = entries.length;
      r.first_ts = entries[0]?.ts ?? null;
      r.last_ts = entries.at(-1)?.ts ?? null;
    } catch (e) {
      r.bad = e.message;
    }
  }
  return r;
}

// One log: { name, op, state, mon, checkpoint, size, tile0, tail, partial,
// first_served }. `hint` is the first served tile the round before found.
// Never rejects: a failure is a field of the record.
export async function probeLog(client, log, { hint = null } = {}) {
  const base = baseOf(log.mon);
  const rec = { name: log.name, op: log.op, state: log.state, mon: log.mon };
  const cp = await client.get(`${base}checkpoint`);
  rec.checkpoint = brief(cp);
  if (cp.status !== 200) return rec;
  let size;
  try {
    const c = parseCheckpoint(cp.text);
    size = c.size;
    rec.checkpoint.origin = c.origin;
  } catch (e) {
    rec.checkpoint.bad = e.message;
    return rec;
  }
  rec.size = size;
  const { last, partial } = tilesOf(size);
  const tile = (n, width, extra) => client.get(`${base}tile/names/${extra?.p ? partialPath(n, width) : tilePath(n)}`).then((o) => tileRecord(n, o, width, extra?.p ? { w: width } : {}));
  const [tile0, tail, part] = await Promise.all([last >= 0 ? tile(0, TILE_WIDTH) : null, last >= 1 ? tile(last, TILE_WIDTH) : null, partial > 0 ? tile(last + 1, partial, { p: true }) : null]);
  rec.tile0 = tile0 ?? { skipped: 'the tree holds no full tile' };
  rec.tail = tail ?? (last === 0 ? { n: 0, same_as: 'tile0' } : { skipped: 'the tree holds no full tile' });
  rec.partial = part ?? { skipped: 'the size is a multiple of 256' };
  if (tile0?.status === 404 && tail?.status === 200) {
    try {
      const f = await firstServedTile(servedProbe(client, log.mon), { lo: 0, hi: last, hint });
      rec.first_served = { tile: f.first, probes: f.probes, how: f.how };
    } catch (e) {
      rec.first_served = { tile: null, error: e.message };
    }
  } else if (tile0?.status === 200) rec.first_served = { tile: 0, probes: 0, how: 'tile 0' };
  else if (tile0?.status === 404) rec.first_served = { tile: null, probes: 0, how: 'tail not served' };
  return rec;
}

// The tiled rows of `rows` in one of `states`, whose name matches `nameRe`.
export function pickLogs(rows, { states = DEFAULT_STATES, nameRe = null } = {}) {
  return rows.filter((r) => r.kind === 'tiled' && states.includes(r.state) && (!nameRe || nameRe.test(r.name)));
}

async function main(argv) {
  const args = parseArgs(argv);
  if ((args.list !== undefined && typeof args.list !== 'string') || (args.name !== undefined && typeof args.name !== 'string') || (args.states !== undefined && typeof args.states !== 'string'))
    throw new UsageError('usage: node scripts/measure/tiles-probe.mjs [--list FILE] [--name REGEX] [--states usable,qualified]');
  const client = createClient();
  let rows;
  try {
    rows = await loadRows(args.list, client);
  } catch (e) {
    console.error(`tiles-probe: ${e.message}`);
    return 1;
  }
  const logs = pickLogs(rows, { states: args.states ? args.states.split(',') : DEFAULT_STATES, nameRe: args.name ? new RegExp(args.name) : null });
  const recs = await Promise.all(logs.map((l) => probeLog(client, l)));
  for (const r of recs) console.log(JSON.stringify(r));
  return recs.every((r) => r.checkpoint.status === 200) ? 0 : 1;
}

if (isMain(import.meta.url)) await run('tiles-probe', main);
