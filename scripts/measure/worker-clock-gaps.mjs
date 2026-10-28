// scripts/measure/worker-clock-gaps.mjs — how late does a Cloudflare cron tick?
// (DOM-002, TODO/ops.md; the decision rule is architecture section 5.2.)
//
// Asks the probe Worker's /gaps route (DOM-061) for the first --hours of its cron
// ticks with every tick the answer read, recomputes the result from those ticks
// with the probe's own arithmetic, refuses an answer whose numbers differ from the
// recomputation (a probe deployed from other code than this tree's), and writes
// the result. PASS when the minute cron's p90 gap is at most 15 min and its
// longest gap at most 60 min, else FAIL; the 5-minute cron is in `beside`.
//
// The arithmetic is probes/worker/src/gaps.ts, imported here: the probe's own copy
// of DOM-001's definitions in scripts/measure/clock-gaps.mjs, and the result
// carries them in `definitions`. This script keeps DOM-001's output and exit codes.
//
// Usage:
//   node scripts/measure/worker-clock-gaps.mjs --url "$PROBE_URL/gaps" --hours 48 --out docs/research/measure/DOM-002/worker.json
//   node scripts/measure/worker-clock-gaps.mjs --input <a saved /gaps?ticks=1 answer> [--out <file.json>]
//
// --url asks the probe (the script adds hours and ticks=1). --input reads a saved
// answer instead, so a result is computed again offline; its window is the
// answer's own unless --hours is given. --out writes the result there and, when the
// answer came from the probe, the answer beside it as <name>.ticks.json (the
// input that --input reads).
//
// stdout: the result, one JSON object. stderr: one `verdict=` line.
// Exit codes: 0 the window is complete and measured (PASS or FAIL is the finding,
// and --out is written) · 1 the window is not complete yet, nothing is written ·
// 2 could not run (usage, the probe unreachable or not 200, a malformed answer, or
// numbers that differ from the recomputation).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkHours, DEFAULT_HOURS, gapsResult, parseIso, tickFromJson } from '../../probes/worker/src/gaps.ts';
import { parseArgs } from '../lib/args.mjs';

const FETCH_TIMEOUT_MS = 120_000;
const USAGE = 'usage: node scripts/measure/worker-clock-gaps.mjs (--url <probe>/gaps | --input <file>) [--hours 48] [--out <file.json>]';

export class UsageError extends Error {}

// The flags, checked. Throws UsageError.
export function parseFlags(argv) {
  const a = parseArgs(argv);
  const str = (k) => (typeof a[k] === 'string' ? a[k] : undefined);
  for (const k of ['url', 'input', 'out', 'hours']) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  const url = str('url');
  const input = str('input');
  if ((url === undefined) === (input === undefined)) throw new UsageError('give exactly one of --url and --input');
  if (url !== undefined && !/^https?:\/\//.test(url)) throw new UsageError('--url must be an http or https URL of the probe, ending in /gaps');
  let hours = null;
  if (a.hours !== undefined) {
    hours = /^\d{1,4}$/.test(str('hours') ?? '') ? Number(a.hours) : Number.NaN;
    try {
      checkHours(hours);
    } catch (err) {
      throw new UsageError(`--hours: ${err.message}`);
    }
  }
  return { url, input, hours, out: str('out') };
}

// The /gaps URL for the first `hours` of ticks, with every tick the answer read.
export function gapsUrl(base, hours) {
  const url = new URL(base);
  url.searchParams.set('hours', String(hours));
  url.searchParams.set('ticks', '1');
  return url.href;
}

async function fetchAnswer(url) {
  let response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`could not read ${url}: ${err.message}`);
  }
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${url} answered ${response.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} answered 200 with a body that is not JSON`);
  }
}

// The result recomputed from the answer's own ticks, window start and clock, after
// checking that every member of it equals the answer's. The members the probe adds
// beside the result (read_from, list_calls, ticks) are not part of it.
export function recompute(answer, hours) {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) throw new Error('the answer is not a JSON object');
  if (answer.version !== 1 || answer.clock !== 'worker') throw new Error(`the answer is not version 1 of the worker result (version ${answer.version}, clock ${answer.clock})`);
  if (answer.hours !== hours) throw new Error(`the answer covers ${answer.hours} hours, not ${hours}`);
  if (!Array.isArray(answer.ticks)) throw new Error('the answer carries no ticks array: ask /gaps with ticks=1');
  const nowMs = parseIso(answer.now);
  if (nowMs === null) throw new Error(`the answer's now ${JSON.stringify(answer.now)} is not a toISOString time`);
  const fromMs = answer.from === null ? null : parseIso(answer.from);
  if (answer.from !== null && fromMs === null) throw new Error(`the answer's from ${JSON.stringify(answer.from)} is not a toISOString time`);
  let ticks;
  try {
    ticks = answer.ticks.map((tick, i) => tickFromJson(tick, `#${i}`));
  } catch (err) {
    throw new Error(`the answer holds a bad tick: ${err.message}`);
  }
  const result = gapsResult({ ticks, hours, fromMs, nowMs });
  const differ = Object.keys(result).filter((key) => !isDeepStrictEqual(result[key], answer[key]));
  if (differ.length > 0) throw new Error(`the probe's numbers differ from the recomputation in ${differ.join(', ')}: the deployed probe runs other code than probes/worker/src/gaps.ts`);
  return result;
}

export function verdictLine(r) {
  if (r.from === null) return 'verdict=INCOMPLETE clock=worker runs=0 why="the probe holds no tick yet"';
  const head = `verdict=${r.verdict} clock=worker cron="${r.event}" runs=${r.runs}/${r.expected} p90_gap_min=${r.gaps_min.p90} max_gap_min=${r.gaps_min.max} breaks_over_30min=${r.breaks_over_30min} missed=${r.slots.missed} put_ms_p90=${r.put_ms.p90} class_a_ops=${r.class_a_ops}`;
  return r.complete ? head : `${head} hours_seen=${r.hours_seen}/${r.hours}`;
}

// The saved answer beside a result: x.json -> x.ticks.json.
export const ticksPathFor = (out) => (out.endsWith('.json') ? `${out.slice(0, -'.json'.length)}.ticks.json` : `${out}.ticks.json`);

// Writes through a temporary file in the same directory, so a killed process
// leaves the old file whole.
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`worker-clock-gaps: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let answer;
  let result;
  try {
    answer = flags.url ? await fetchAnswer(gapsUrl(flags.url, flags.hours ?? DEFAULT_HOURS)) : JSON.parse(readFileSync(resolve(flags.input), 'utf8'));
    // A saved answer states its own window; --hours that disagrees is refused by recompute.
    const hours = flags.hours ?? (flags.input && typeof answer?.hours === 'number' ? answer.hours : DEFAULT_HOURS);
    result = recompute(answer, hours);
  } catch (err) {
    stderr.write(`worker-clock-gaps: could not run: ${err.message}\n`);
    return 2;
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.complete) {
    stderr.write(`${verdictLine(result)}\nworker-clock-gaps: the window of ${result.hours} h has not ended; nothing written\n`);
    return 1;
  }
  if (flags.out) {
    const out = resolve(flags.out);
    writeAtomic(out, `${JSON.stringify(result, null, 2)}\n`);
    // Compact: 48 hours are about 3,460 ticks, and the file is kept as evidence.
    if (flags.url) writeAtomic(ticksPathFor(out), `${JSON.stringify(answer)}\n`);
    stderr.write(`worker-clock-gaps: wrote ${basename(out)}${flags.url ? ` and ${basename(ticksPathFor(out))}` : ''}\n`);
  }
  stderr.write(`${verdictLine(result)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
