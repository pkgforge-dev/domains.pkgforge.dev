// scripts/measure/ct-rates.mjs — entries a day of every CT log, from two reads
// of its tree size some minutes apart, and whether each tiled log serves names
// tile 0 (DOM-011, TODO/ingest.md).
//
// Copied from docs/research/2026-10-27-design-a/scripts/ct-rates.mjs. What
// changed: the rows come from --logs FILE (ct-logs.mjs's rows, or a log list),
// or from the list fetched now, instead of ../ct/logs.json; the result goes to
// --out FILE instead of ../ct/rates.json; the gap is --gap-s (design A took
// milliseconds as its first argument; DOM-011 asks for 10 minutes); every
// request sends the project's User-Agent; a checkpoint is parsed by
// ct-tiles.mjs, which refuses a body that is not one; and the second read of
// each log is timed by its own clock, so a slow first pass does not shrink the
// span a rate is divided by.
//
// A tiled log's size is line 2 of its checkpoint; an RFC 6962 log's is
// tree_size of `ct/v1/get-sth`. Logs in state `rejected` or `retired` are
// left out, as design A left them out.
//
// Usage: node scripts/measure/ct-rates.mjs --out FILE [--logs FILE] [--gap-s 600]
// Exit codes: 0 at least one rate measured · 1 none, or the list could not be
// had · 2 bad arguments.
import { resolve } from 'node:path';
import { baseOf, createClient, parseCheckpoint, tilePath } from './ct-tiles.mjs';
import { loadRows } from './ct-logs.mjs';
import { intArg, isMain, run, UsageError, writeJson } from './kafka-cli.mjs';
import { parseArgs } from '../lib/args.mjs';

export const SCHEMA = 'dom-011-rates/1';
const CONCURRENCY = 12;

// { size, at } of one log now, or { err, at }.
export async function sizeOf(client, row, clock = Date.now) {
  const at = clock();
  if (row.kind === 'tiled') {
    const o = await client.get(`${baseOf(row.mon)}checkpoint`);
    if (o.status !== 200) return { err: o.status ?? o.error, at };
    try {
      return { size: parseCheckpoint(o.text).size, at };
    } catch (e) {
      return { err: e.message, at };
    }
  }
  const o = await client.get(`${baseOf(row.url)}ct/v1/get-sth`);
  if (o.status !== 200) return { err: o.status ?? o.error, at };
  try {
    const n = JSON.parse(o.text).tree_size;
    return Number.isSafeInteger(n) && n >= 0 ? { size: n, at } : { err: 'tree_size is not a count', at };
  } catch {
    return { err: 'get-sth is not JSON', at };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// The rates of `rows`: two passes `gapMs` apart. `sleep` and `clock` are the
// test's to replace.
export async function measureRates(client, rows, { gapMs, clock = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const live = rows.filter((r) => r.state !== 'rejected' && r.state !== 'retired');
  const t0 = clock();
  const a = await pool(live, CONCURRENCY, (r) => sizeOf(client, r, clock));
  const names = await pool(live, CONCURRENCY, (r) => (r.kind === 'tiled' ? client.get(`${baseOf(r.mon)}tile/names/${tilePath(0)}`).then((o) => o.status ?? o.error) : null));
  const wait = gapMs - (clock() - t0);
  if (wait > 0) await sleep(wait);
  const b = await pool(live, CONCURRENCY, (r) => sizeOf(client, r, clock));
  const res = live.map((r, i) => {
    const x = a[i];
    const y = b[i];
    const dt = (y.at - x.at) / 1000;
    const rate = x.size !== undefined && y.size !== undefined && dt > 0 ? (y.size - x.size) / dt : null;
    return {
      op: r.op,
      desc: r.desc,
      name: r.name,
      kind: r.kind,
      state: r.state,
      size: y.size ?? x.size ?? null,
      dt_s: +dt.toFixed(3),
      rate_per_s: rate,
      per_day_M: rate === null ? null : +((rate * 86400) / 1e6).toFixed(2),
      names_tile: names[i],
      err: x.err ?? y.err ?? null,
    };
  });
  return { schema: SCHEMA, t0: new Date(t0).toISOString(), gap_s: gapMs / 1000, res };
}

// The totals design A printed: every measured log (a log whose reads failed
// counts in `logs` and not in `measured`, and adds nothing, so the sum is a
// lower bound when they differ), and the measured logs whose tile 0 answered
// 200.
export function totals(result) {
  let all = 0;
  let names = 0;
  for (const x of result.res) {
    if (x.per_day_M) {
      all += x.per_day_M;
      if (x.names_tile === 200) names += x.per_day_M;
    }
  }
  return { logs: result.res.length, measured: result.res.filter((x) => x.per_day_M !== null).length, total_M_per_day: +all.toFixed(1), names_tile_logs_M_per_day: +names.toFixed(1) };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (typeof args.out !== 'string' || (args.logs !== undefined && typeof args.logs !== 'string'))
    throw new UsageError('usage: node scripts/measure/ct-rates.mjs --out FILE [--logs FILE] [--gap-s 600]');
  const gapS = args['gap-s'] === undefined ? 600 : intArg(args['gap-s'], '--gap-s', 1);
  const client = createClient();
  let rows;
  try {
    rows = await loadRows(args.logs, client);
  } catch (e) {
    console.error(`ct-rates: ${e.message}`);
    return 1;
  }
  const result = await measureRates(client, rows, { gapMs: gapS * 1000 });
  writeJson(resolve(args.out), result);
  const t = totals(result);
  console.log(JSON.stringify(t));
  for (const x of result.res.filter((r) => r.per_day_M > 0.5).sort((p, q) => q.per_day_M - p.per_day_M))
    console.log(x.op.padEnd(16), x.desc.padEnd(40), x.kind.padEnd(8), x.state.padEnd(10), String(x.per_day_M).padStart(7), 'M/day', `names:${x.names_tile}`);
  return t.measured > 0 ? 0 : 1;
}

if (isMain(import.meta.url)) await run('ct-rates', main);
