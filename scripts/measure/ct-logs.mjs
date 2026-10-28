// scripts/measure/ct-logs.mjs — the CT log list reshaped into the rows the
// names-tile measurement reads (DOM-011, TODO/ingest.md). It replaces design
// A's `../ct/logs.json`, which was never kept: an array of
// { op, desc, kind, state, mon, url, name, interval } where `op` is the
// operator's name, `desc` the log's description, `kind` is `tiled` for an entry
// of `tiled_logs` (its monitoring_url is `mon`) or `rfc6962` for an entry of
// `logs` (its url is `url`), `state` the one key of the log's `state` object,
// `name` the last word of the description in lower case (`tuscolo2027h1`,
// `halloumi2026h2a`), the handle the other scripts take with --log, and
// `interval` the log's temporal interval.
//
// The list is https://www.gstatic.com/ct/log_list/v3/log_list.json (62,375 B,
// log_list_timestamp 2026-10-28T13:37:58Z, MEASURED 2026-10-28T15:34:22Z). A
// list whose shape differs (no operators array, a log with no single state, a
// URL that is not https) is refused rather than read in part, and so is a list
// where two tiled logs share a name.
//
// Usage:
//   import { LOG_LIST_URL, fetchLogList, logRows, tiledByName } from './ct-logs.mjs'
//   node scripts/measure/ct-logs.mjs --out FILE [--in LIST.json]
//     writes the rows of the list (fetched, or read from --in) to FILE and
//     prints the count of each kind and state
// Exit codes: 0 written · 1 the list could not be fetched or read as a list ·
// 2 bad arguments.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, CtError } from './ct-tiles.mjs';
import { isMain, run, UsageError, writeJson } from './kafka-cli.mjs';
import { parseArgs } from '../lib/args.mjs';

export const LOG_LIST_URL = 'https://www.gstatic.com/ct/log_list/v3/log_list.json';

const https = (u) => typeof u === 'string' && /^https:\/\/[^\s/]+\//.test(u.endsWith('/') ? u : `${u}/`);

// The one key of a log's state object.
function stateOf(log, where) {
  const keys = log.state && typeof log.state === 'object' ? Object.keys(log.state) : [];
  if (keys.length !== 1) throw new CtError(`${where}: the state holds ${keys.length} keys, not one`);
  return keys[0];
}

// The handle of a log: the last word of its description, lower case.
export function shortName(desc) {
  const word = String(desc).trim().split(/\s+/).at(-1)?.toLowerCase() ?? '';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(word)) throw new CtError(`the description ${JSON.stringify(desc)} gives no usable name`);
  return word;
}

// The rows of a parsed log list. Throws a CtError on a list of another shape.
export function logRows(list) {
  if (!list || !Array.isArray(list.operators)) throw new CtError('the log list has no operators array');
  const rows = [];
  const tiledNames = new Set();
  for (const op of list.operators) {
    if (typeof op?.name !== 'string') throw new CtError('an operator has no name');
    for (const [kind, key, urlKey] of [
      ['tiled', 'tiled_logs', 'monitoring_url'],
      ['rfc6962', 'logs', 'url'],
    ]) {
      const logs = op[key] ?? [];
      if (!Array.isArray(logs)) throw new CtError(`${op.name}: ${key} is not an array`);
      for (const log of logs) {
        const where = `${op.name} ${log?.description}`;
        if (typeof log?.description !== 'string') throw new CtError(`${op.name}: a log has no description`);
        if (!https(log[urlKey])) throw new CtError(`${where}: ${urlKey} is not an https URL`);
        const name = shortName(log.description);
        if (kind === 'tiled') {
          if (tiledNames.has(name)) throw new CtError(`two tiled logs are named ${name}`);
          tiledNames.add(name);
        }
        rows.push({
          op: op.name,
          desc: log.description,
          kind,
          state: stateOf(log, where),
          mon: kind === 'tiled' ? log[urlKey] : null,
          url: kind === 'rfc6962' ? log[urlKey] : null,
          name,
          interval: log.temporal_interval ?? null,
        });
      }
    }
  }
  return rows;
}

// The tiled row named `name`, or a CtError naming the names there are.
export function tiledByName(rows, name) {
  const row = rows.find((r) => r.kind === 'tiled' && r.name === name);
  if (!row) throw new CtError(`no tiled log is named ${name}; the list holds ${rows.filter((r) => r.kind === 'tiled').length} tiled logs`);
  return row;
}

// Fetches and parses the list: { obs (status, ms, bytes), list, sha256,
// timestamp, version }. Throws a CtError when the list cannot be had.
export async function fetchLogList(client = createClient()) {
  const o = await client.get(LOG_LIST_URL);
  if (o.status !== 200) throw new CtError(`the log list answered ${o.status ?? o.error}`);
  let list;
  try {
    list = JSON.parse(o.text);
  } catch {
    throw new CtError('the log list is not JSON');
  }
  const { text, ...obs } = o;
  return { obs, list, sha256: createHash('sha256').update(text).digest('hex'), timestamp: list.log_list_timestamp ?? null, version: list.version ?? null };
}

// Rows from --in FILE (a log list or the rows this script writes) or fetched.
export async function loadRows(file, client) {
  if (typeof file === 'string') {
    const json = JSON.parse(readFileSync(resolve(file), 'utf8'));
    return Array.isArray(json) ? json : logRows(json);
  }
  return logRows((await fetchLogList(client)).list);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (typeof args.out !== 'string' || (args.in !== undefined && typeof args.in !== 'string')) throw new UsageError('usage: node scripts/measure/ct-logs.mjs --out FILE [--in LIST.json]');
  let rows;
  try {
    rows = await loadRows(args.in);
  } catch (e) {
    console.error(`ct-logs: ${e.message}`);
    return 1;
  }
  writeJson(resolve(args.out), rows);
  const counts = {};
  for (const r of rows) counts[`${r.kind} ${r.state}`] = (counts[`${r.kind} ${r.state}`] ?? 0) + 1;
  console.log(JSON.stringify({ rows: rows.length, counts }));
  return 0;
}

if (isMain(import.meta.url)) await run('ct-logs', main);
