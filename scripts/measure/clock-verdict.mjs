// scripts/measure/clock-verdict.mjs — which clock starts the live ingest?
// (DOM-003, TODO/ops.md; the decision rule is docs/architecture.md section 5.2.)
//
// Reads the three 48-hour results, judges each again from its p90 gap and its
// largest gap with RULE of clock-gaps.mjs, and takes the first that passes of
// A, the schedule, then B, the self-dispatch chain, then C, the Cloudflare cron
// Worker. The verdict is actions-schedule, actions-chain or worker, and none
// when all three fail. The numbers decide: a result judged by the same rule
// must say the verdict its numbers give, and a result judged by another rule
// is judged again by this one. A result names the rule it was judged by, and
// its window runs from `from` to `to` over exactly its `hours`.
//
// --check holds config/clock.json to the verdict. The file must read as
// scripts/ingest/chain.mjs reads it (readClock), name the verdict, the evidence
// DOM-001 and DOM-002, the rule, and the p90 and largest gap of the clock that
// won, give the interval INTERVAL_MIN (its interval_min, or chain.mjs's
// default when the key is absent), and hold no other key. Its `decided` is a
// UTC time not earlier than the end of the last window the verdict rests on
// and not later than now. A verdict of none never agrees: no clock is written
// then (DOM-003's Approach).
//
// A UTC time here is written as toISOString writes it, with or without its
// milliseconds: YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DDTHH:MM:SS.mmmZ. A time the
// calendar does not hold, such as 2026-02-30 or 24:00, is refused.
//
// TABLE_HEAD and tableRows give the table of docs/clock.md, and its test holds
// the document to them, so the numbers there are the files' numbers.
//
// Usage:
//   node scripts/measure/clock-verdict.mjs [--check [--clock config/clock.json]]
//     [--schedule docs/research/measure/DOM-001/schedule.json]
//     [--chain docs/research/measure/DOM-001/chain.json]
//     [--worker docs/research/measure/DOM-002/worker.json]
//
// stdout: one line per clock, a `rule:` line and a `clock:` line; with --check,
// a `check:` line, and one line per difference.
// Exit codes: 0 judged (with --check, config/clock.json agrees) · 1 --check:
// config/clock.json is missing, does not read, or differs · 2 could not run
// (usage, or a result that is missing, malformed, not complete, shorter than
// 48 hours, of another clock, or whose verdict disagrees with its numbers).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ROOT } from '../files.mjs';
import { readClock } from '../ingest/chain.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { RULE } from './clock-gaps.mjs';

export const HOURS = 48;
export const EVIDENCE = Object.freeze(['DOM-001', 'DOM-002']);
// The interval of the chain in minutes: DOM-003's Decision of
// 2026-10-31T01:27Z. Each run pushes segments and nothing is deleted from
// GHCR, so a shorter interval keeps more for ever.
export const INTERVAL_MIN = 10;
export const DEFAULT_CLOCK_FILE = join(ROOT, 'config', 'clock.json');
const MEASURE = join(ROOT, 'docs', 'research', 'measure');

// The clocks in the order the rule reads them, each with its result file and
// the name of that file in docs/clock.md.
export const CLOCKS = Object.freeze([
  Object.freeze({
    flag: 'schedule',
    letter: 'A',
    name: '`schedule`',
    clock: 'actions-schedule',
    file: join(MEASURE, 'DOM-001', 'schedule.json'),
    shown: 'docs/research/measure/DOM-001/schedule.json',
  }),
  Object.freeze({ flag: 'chain', letter: 'B', name: 'Self-dispatch chain', clock: 'actions-chain', file: join(MEASURE, 'DOM-001', 'chain.json'), shown: 'docs/research/measure/DOM-001/chain.json' }),
  Object.freeze({ flag: 'worker', letter: 'C', name: 'Cloudflare cron Worker', clock: 'worker', file: join(MEASURE, 'DOM-002', 'worker.json'), shown: 'docs/research/measure/DOM-002/worker.json' }),
]);

const REQUIRED_KEYS = Object.freeze(['clock', 'decided', 'evidence', 'p90_gap_min', 'max_gap_min', 'rule']);
const OPTIONAL_KEYS = Object.freeze(['interval_min']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const USAGE = 'usage: node scripts/measure/clock-verdict.mjs [--check [--clock config/clock.json]] [--schedule FILE] [--chain FILE] [--worker FILE]';

export class UsageError extends Error {}
export class CouldNotRun extends Error {}

export const passes = (p90, max, rule = RULE) => p90 !== null && max !== null && p90 <= rule.p90_max_min && max <= rule.max_max_min;

// The milliseconds of a UTC time, or null when `v` is not one: it must write
// back to the same text, so a time the calendar does not hold is refused.
export function utcMs(v) {
  if (typeof v !== 'string' || !ISO.test(v)) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const back = new Date(ms).toISOString();
  return back === v || back.replace('.000Z', 'Z') === v ? ms : null;
}

export function parseFlags(argv) {
  const a = parseArgs(argv);
  const known = ['check', 'clock', ...CLOCKS.map((c) => c.flag)];
  for (const k of Object.keys(a)) if (k !== '_' && !known.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given more than once`);
  if (a._.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(a._[0])}`);
  if (a.check !== undefined && a.check !== true) throw new UsageError('--check takes no value');
  for (const k of known.slice(1)) if (a[k] === true || a[k] === '') throw new UsageError(`--${k} needs a value`);
  if (a.clock !== undefined && a.check === undefined) throw new UsageError('--clock needs --check: without it nothing reads the file');
  return {
    check: a.check === true,
    clock: a.clock === undefined ? DEFAULT_CLOCK_FILE : resolve(a.clock),
    clockShown: a.clock ?? 'config/clock.json',
    files: Object.fromEntries(CLOCKS.map((c) => [c.flag, a[c.flag] === undefined ? c.file : resolve(a[c.flag])])),
  };
}

// One result as the rule reads it, or CouldNotRun.
export function judge(doc, { letter, clock }) {
  const where = `clock ${letter}`;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new CouldNotRun(`${where}: the result is not a JSON object`);
  if (doc.version !== 1) throw new CouldNotRun(`${where}: the result is version ${JSON.stringify(doc.version ?? null)}, not 1`);
  if (doc.clock !== clock) throw new CouldNotRun(`${where}: the result is of the clock ${JSON.stringify(doc.clock ?? null)}, not ${clock}`);
  if (doc.complete !== true) throw new CouldNotRun(`${where}: the result's window has not ended (complete is not true)`);
  if (doc.rule === null || typeof doc.rule !== 'object' || Array.isArray(doc.rule)) throw new CouldNotRun(`${where}: the result names no rule it was judged by`);
  if (typeof doc.hours !== 'number' || !Number.isFinite(doc.hours) || doc.hours < HOURS)
    throw new CouldNotRun(`${where}: the result covers ${typeof doc.hours === 'number' ? doc.hours : JSON.stringify(doc.hours ?? null)} hours, not at least ${HOURS}`);
  const at = {};
  for (const k of ['from', 'to']) {
    at[k] = utcMs(doc[k]);
    if (at[k] === null) throw new CouldNotRun(`${where}: the result's ${k} is not a UTC time`);
  }
  if (at.to - at.from !== doc.hours * 3_600_000) throw new CouldNotRun(`${where}: the result's window, ${doc.from} to ${doc.to}, is not its ${doc.hours} hours`);
  for (const [k, least] of [
    ['runs', 0],
    ['expected', 1],
    ['interval_min', 1],
  ])
    if (!Number.isSafeInteger(doc[k]) || doc[k] < least) throw new CouldNotRun(`${where}: the result's ${k} is not a whole number of ${least} or more`);
  const gap = (k) => {
    const v = doc.gaps_min?.[k];
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new CouldNotRun(`${where}: the result's gaps_min.${k} is not a number of minutes`);
    return v;
  };
  const median = gap('median');
  const p90 = gap('p90');
  const max = gap('max');
  const verdict = passes(p90, max) ? 'PASS' : 'FAIL';
  const sameRule = isDeepStrictEqual(doc.rule, { ...RULE });
  if (sameRule && doc.verdict !== verdict) throw new CouldNotRun(`${where}: the result says ${JSON.stringify(doc.verdict ?? null)}, and its numbers under its own rule say ${verdict}`);
  return { letter, clock, verdict, median, p90, max, runs: doc.runs, expected: doc.expected, interval: doc.interval_min, from: doc.from, to: doc.to, rule: sameRule ? null : doc.rule };
}

// The first clock that passes, in the rule's order, or none; and `through`,
// the latest end of the windows judged, which a decision cannot precede.
export function decide(judged) {
  const won = judged.find((j) => j.verdict === 'PASS');
  const through = judged.reduce((t, j) => (t === null || utcMs(j.to) > utcMs(t) ? j.to : t), null);
  return won === undefined ? { clock: 'none', won: null, through } : { clock: won.clock, won, through };
}

const gapText = (v) => (v === null ? 'none' : String(v));

export function lines(judged, verdict) {
  const out = judged.map((j) => {
    const again = j.rule === null ? '' : ` (judged again: its file was judged by ${JSON.stringify(j.rule)})`;
    return `${j.letter} ${j.clock} ${j.verdict} p90_gap_min=${gapText(j.p90)} max_gap_min=${gapText(j.max)} runs=${j.runs}/${j.expected} window=${j.from}..${j.to}${again}`;
  });
  out.push(`rule: the first of A, B and C whose p90 gap is at most ${RULE.p90_max_min} min and whose max gap is at most ${RULE.max_max_min} min`);
  out.push(`clock: ${verdict.clock}`);
  return out;
}

// config/clock.json against the verdict: a list of differences, empty when it agrees.
export function checkClockFile(path, verdict, { now = Date.now(), readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  if (verdict.clock === 'none') return ['no clock passes the rule, so no config/clock.json is written for it'];
  let read;
  try {
    read = readClock(path, readFile);
  } catch (err) {
    return [`it does not read as scripts/ingest/chain.mjs reads it: ${err.message}`];
  }
  if (read === null) return ['it does not exist'];
  const v = JSON.parse(readFile(path));
  const diffs = [];
  for (const k of REQUIRED_KEYS) if (!Object.hasOwn(v, k)) diffs.push(`it has no ${k}`);
  for (const k of Object.keys(v)) if (!REQUIRED_KEYS.includes(k) && !OPTIONAL_KEYS.includes(k)) diffs.push(`it has the key ${k}, which no reader reads`);
  if (v.clock !== verdict.clock) diffs.push(`its clock is ${JSON.stringify(v.clock)}, and the verdict is ${verdict.clock}`);
  if (read.interval !== INTERVAL_MIN) diffs.push(`its interval is ${read.interval} min, and DOM-003 decided ${INTERVAL_MIN} (INTERVAL_MIN)`);
  if (Object.hasOwn(v, 'evidence') && !isDeepStrictEqual(v.evidence, [...EVIDENCE])) diffs.push(`its evidence is ${JSON.stringify(v.evidence)}, not ${JSON.stringify(EVIDENCE)}`);
  if (Object.hasOwn(v, 'rule') && !isDeepStrictEqual(v.rule, { ...RULE })) diffs.push(`its rule is ${JSON.stringify(v.rule)}, not ${JSON.stringify(RULE)}`);
  if (Object.hasOwn(v, 'p90_gap_min') && v.p90_gap_min !== verdict.won.p90) diffs.push(`its p90_gap_min is ${JSON.stringify(v.p90_gap_min)}, and clock ${verdict.won.letter}'s is ${verdict.won.p90}`);
  if (Object.hasOwn(v, 'max_gap_min') && v.max_gap_min !== verdict.won.max) diffs.push(`its max_gap_min is ${JSON.stringify(v.max_gap_min)}, and clock ${verdict.won.letter}'s is ${verdict.won.max}`);
  if (Object.hasOwn(v, 'decided')) {
    const at = utcMs(v.decided);
    if (at === null) diffs.push(`its decided is ${JSON.stringify(v.decided)}, not a UTC time`);
    else if (at > now) diffs.push(`its decided, ${v.decided}, is later than now`);
    else if (verdict.through !== null && at < utcMs(verdict.through)) diffs.push(`its decided, ${v.decided}, is earlier than ${verdict.through}, the end of the last window the verdict rests on`);
  }
  return diffs;
}

// The head of the table of docs/clock.md, and its rows, one per clock, in the
// rule's order.
export const TABLE_HEAD = Object.freeze([
  '| Clock | Result | Window, UTC | Interval | Runs / expected | Median gap | p90 gap | Max gap | Verdict |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
]);

export function tableRows(judged) {
  const whole = (n) => n.toLocaleString('en-US');
  const min = (v) => (v === null ? 'none' : `${v} min`);
  return judged.map((j) => {
    const c = CLOCKS.find((x) => x.letter === j.letter);
    return `| ${j.letter}. ${c.name} | \`${c.shown}\` | ${j.from} to ${j.to} | ${j.interval} min | ${whole(j.runs)} / ${whole(j.expected)} | ${min(j.median)} | ${min(j.p90)} | ${min(j.max)} | ${j.verdict} |`;
  });
}

export function judgeFiles(files, readFile = (p) => readFileSync(p, 'utf8')) {
  return CLOCKS.map((c) => {
    let doc;
    try {
      doc = JSON.parse(readFile(files[c.flag]));
    } catch (err) {
      throw new CouldNotRun(`clock ${c.letter}: --${c.flag} ${err instanceof SyntaxError ? 'is not JSON' : `cannot be read: ${err.code ?? err.message}`}`);
    }
    return judge(doc, c);
  });
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr, now = Date.now() } = {}) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`clock-verdict: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let judged;
  try {
    judged = judgeFiles(flags.files);
  } catch (err) {
    if (!(err instanceof CouldNotRun)) throw err;
    stderr.write(`clock-verdict: could not run: ${err.message}\n`);
    return 2;
  }
  const verdict = decide(judged);
  stdout.write(`${lines(judged, verdict).join('\n')}\n`);
  if (!flags.check) return 0;
  const diffs = checkClockFile(flags.clock, verdict, { now });
  if (diffs.length === 0) {
    stdout.write(`check: ${flags.clockShown} agrees\n`);
    return 0;
  }
  stdout.write(`check: ${flags.clockShown} differs\n${diffs.map((d) => `  ${d}`).join('\n')}\n`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
