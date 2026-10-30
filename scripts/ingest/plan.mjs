// scripts/ingest/plan.mjs — plan one run of .github/workflows/ingest-live.yml
// (DOM-024): which adapters each lane runs, and the backfill window.
//
// The lanes are config/lanes.json (domains.lanes.v1): exactly the lanes
// kafka, tiles and feeds, each a sorted list of adapter directories that hold
// adapters/<dir>/source.json, no directory in two lanes. Every adapter entry
// (DOM-026 and later) adds its directory to one lane. --only keeps the lanes'
// adapters that hold one of the named sources (the dispatch input `sources`);
// each must be a row of the registry (config/sources.json, validated with
// config/source-bits.json), and one whose adapter is in no lane is refused.
// --from and --to are a backfill window (D17 of DOM-024): both or neither, ISO
// 8601 UTC to the second, from before to, to not after the run's now, and only
// with --only; run.mjs calls each adapter's `backfill` over it.
//
// Usage:
//   node scripts/ingest/plan.mjs --out FILE [--only IDS] [--from ISO --to ISO]
//                                [--lanes FILE] [--sources FILE] [--adapters DIR] [--now ISO]
// Writes FILE: { "format": "domains.ingest-plan.v1", "lanes": { "kafka": [...],
// "tiles": [...], "feeds": [...] }, "any": BOOL, "from": ISO|null, "to": ISO|null }.
// stdout: `lane LANE ADAPTER...` or `lane LANE none`, one a lane, then
// `window FROM TO` or `window none`.
// Exit codes: 0 planned (an adapter included or none) · 2 could not run
// (usage, a lanes file or registry that does not read or validate, an
// unknown source id, a source in no lane, a window that breaks D17 of DOM-024,
// an output that cannot be written) · 70 an internal error, a defect of this
// script (its stack goes to stderr).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ID_GRAMMAR, MAX_ID, SourceError } from '@domains/adapter';
import { isSecond, LANES } from '@domains/state';
import { checkOutFile, onOutput } from '../compact/plan.mjs';
import { ROOT } from '../files.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { UsageError } from '../root/lib.mjs';
import { DEFAULT_SOURCES, loadRegistry, UsageError as RegistryUsage } from '../verify-pack.mjs';

export const EXIT = Object.freeze({ ok: 0, usage: 2, internal: 70 });
export const PLAN_FORMAT = 'domains.ingest-plan.v1';
export const LANES_FORMAT = 'domains.lanes.v1';
export const DEFAULT_LANES = join(ROOT, 'config', 'lanes.json');
export const DEFAULT_ADAPTERS = join(ROOT, 'adapters');
const USAGE = 'usage: node scripts/ingest/plan.mjs --out FILE [--only IDS] [--from ISO --to ISO] [--lanes FILE] [--sources FILE] [--adapters DIR] [--now ISO]';
const VALUED = ['out', 'only', 'from', 'to', 'lanes', 'sources', 'adapters', 'now'];

// The run's clock to the whole second, as ISO 8601 UTC.
export const nowIso = (ms = Date.now()) => `${new Date(ms - (ms % 1000)).toISOString().slice(0, 19)}Z`;

// An ISO 8601 UTC time to the second that names a real instant (isSecond of
// @domains/state, the grammar of every time of the state), or UsageError.
export function isoSecond(v, what) {
  if (!isSecond(v)) throw new UsageError(`${what} ${JSON.stringify(v)} is not YYYY-MM-DDTHH:MM:SSZ`);
  return v;
}

// The backfill window from --from, --to and --only (D17 of DOM-024), or null.
export function windowOf(from, to, only, now) {
  if (from === undefined && to === undefined) return null;
  if (from === undefined || to === undefined) throw new UsageError('--from and --to come together: a backfill window has both ends (D17 of DOM-024)');
  if (only === undefined) throw new UsageError('a backfill window (--from, --to) names its sources with --only (D17 of DOM-024)');
  isoSecond(from, '--from');
  isoSecond(to, '--to');
  if (!(Date.parse(from) < Date.parse(to))) throw new UsageError(`--from ${from} is not before --to ${to}`);
  if (Date.parse(to) > Date.parse(now)) throw new UsageError(`--to ${to} is after the run's now, ${now}: a backfill reads what was published`);
  return { start: from, end: to };
}

const readJson = (path, what) => {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`${what} ${path} does not read: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what} ${path} is not JSON: ${e.message}`);
  }
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// config/lanes.json, validated as the header above states: { kafka, tiles, feeds }.
export function readLanes(path, adaptersDir) {
  const v = readJson(path, 'the lanes file');
  const bad = (what) => new UsageError(`the lanes file ${path}: ${what}`);
  if (!isObj(v) || Object.keys(v).sort().join(',') !== 'comment,format,lanes') throw bad('it holds exactly format, comment and lanes');
  if (v.format !== LANES_FORMAT) throw bad(`format is ${JSON.stringify(v.format)}, not ${LANES_FORMAT}`);
  if (typeof v.comment !== 'string') throw bad('comment is not a string');
  if (!isObj(v.lanes) || Object.keys(v.lanes).sort().join(',') !== [...LANES].sort().join(',')) throw bad(`lanes holds exactly ${LANES.join(', ')}`);
  const seen = new Map();
  const out = {};
  for (const lane of LANES) {
    const list = v.lanes[lane];
    if (!Array.isArray(list)) throw bad(`the lane ${lane} is not a list`);
    list.forEach((dir, i) => {
      if (typeof dir !== 'string' || !ID_GRAMMAR.test(dir) || dir.length > MAX_ID) throw bad(`${lane}[${i}] ${JSON.stringify(dir)} is not an adapter directory's name`);
      if (i > 0 && !(dir > list[i - 1])) throw bad(`the lane ${lane} is not sorted and distinct at ${dir}`);
      if (seen.has(dir)) throw bad(`${dir} is in the lanes ${seen.get(dir)} and ${lane}; an adapter runs in one lane`);
      seen.set(dir, lane);
      const sourceFile = join(adaptersDir, dir, 'source.json');
      if (!existsSync(sourceFile)) throw bad(`${lane} names ${dir}, and ${sourceFile} does not exist`);
      if (!statSync(sourceFile).isFile()) throw bad(`${lane} names ${dir}, and ${sourceFile} is not a file`);
    });
    out[lane] = [...list];
  }
  return out;
}

// The lane an adapter runs in, or null.
export const laneOf = (lanes, adapter) => LANES.find((l) => lanes[l].includes(adapter)) ?? null;

function parse(argv) {
  const a = parseArgs(argv);
  for (const k of Object.keys(a)) if (k !== '_' && !VALUED.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  if (a.out === undefined) throw new UsageError('--out is needed');
  checkOutFile(a.out, '--out');
  const now = a.now === undefined ? nowIso() : isoSecond(a.now, '--now');
  let only;
  if (a.only !== undefined) {
    only = [...new Set(a.only.split(/[\s,]+/).filter((s) => s !== ''))];
    if (only.length === 0) throw new UsageError('--only names no source; leave it out to run every adapter of every lane');
  }
  return {
    out: a.out,
    only,
    window: windowOf(a.from, a.to, only, now),
    lanes: a.lanes ?? DEFAULT_LANES,
    sources: a.sources ?? DEFAULT_SOURCES,
    adapters: a.adapters ?? DEFAULT_ADAPTERS,
  };
}

// The plan file of `lanes` (each lane's adapters), kept to the adapters of `only`.
export function planOf(lanes, registry, only, window) {
  let keep = lanes;
  if (only !== undefined) {
    const wanted = new Set();
    for (const id of only) {
      const row = registry.find((r) => r.id === id);
      if (row === undefined) throw new UsageError(`--only names ${id}, which is not a source of the registry`);
      if (laneOf(lanes, row.adapter) === null) throw new UsageError(`--only names ${id}, whose adapter ${row.adapter} runs in no lane of ingest-live.yml`);
      wanted.add(row.adapter);
    }
    keep = Object.fromEntries(LANES.map((l) => [l, lanes[l].filter((d) => wanted.has(d))]));
  }
  const out = Object.fromEntries(LANES.map((l) => [l, keep[l]]));
  return { format: PLAN_FORMAT, lanes: out, any: LANES.some((l) => out[l].length > 0), from: window?.start ?? null, to: window?.end ?? null };
}

// An error plan does not know is a defect, exit 70: never 2.
export async function main(argv, deps = {}) {
  try {
    return plan(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`plan: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

function plan(argv, { out = console.log, err = console.error }) {
  try {
    const args = parse(argv);
    const lanes = readLanes(args.lanes, args.adapters);
    let registry;
    try {
      registry = loadRegistry(args.sources);
    } catch (e) {
      if (e instanceof SourceError || e instanceof RegistryUsage) throw new UsageError(`the registry ${args.sources} does not read or validate: ${e.message}`);
      throw e;
    }
    const file = planOf(lanes, registry, args.only, args.window);
    onOutput(args.out, '--out', () => writeFileSync(args.out, `${JSON.stringify(file)}\n`));
    for (const l of LANES) out(`lane ${l} ${file.lanes[l].length > 0 ? file.lanes[l].join(' ') : 'none'}`);
    out(file.from === null ? 'window none' : `window ${file.from} ${file.to}`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`plan: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
