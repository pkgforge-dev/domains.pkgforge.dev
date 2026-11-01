// scripts/ingest/chain.mjs — the chain of .github/workflows/ingest-live.yml
// (DOM-024, docs/architecture.md section 5.2): the job `chain` dispatches the
// successor at the START of a run, so a crash later in the run cannot break
// the chain (the entry's Decision), then sleeps to the next boundary of the
// interval, which keeps the chain on the grid of the clock.
//
// It is the one reader of config/clock.json here (DOM-003 writes it): with
// no file, or a clock other than actions-chain, every verb prints `chain off`
// and exits 0, and only the crons and workflow_dispatch start runs (D14 of
// DOM-024). The interval is the optional whole number interval_min of the
// file, 1 to 30, default 30, the interval of ruling 27 (the job's timeout of
// 36 minutes holds the start and the due step, 2 minutes each at most, a
// sleep of 30, the checkout and the setup).
//
// start, in this order:
//   1. the clock: absent or another clock is `chain off`;
//   2. a run of a ref other than refs/heads/main starts no successor;
//   3. a re-run (GITHUB_RUN_ATTEMPT above 1) starts none: attempt 1 did;
//   4. another run of this workflow on main that waits (any status but
//      in_progress and completed) holds the dispatch: the chain goes on
//      through it, and the backstop never starts a second chain. A listing
//      that fails is a warning, and the successor is dispatched anyway: a dead
//      chain is worse than a doubled one, which the group merges
//      (.github/workflows/measure-clock-chain.yml decides the same);
//   5. `gh workflow run FILE --ref main`, at most DISPATCH_TRIES tries
//      DISPATCH_PAUSE_S apart.
// due: the guards 1 to 3 of start, then for each row of DUE, a scheduled
// workflow and its cron (DOM-023's Decision of 2026-11-01: GitHub started the
// crons of compact-daily.yml and ref-refresh.yml hours late, and the chain
// runs once an interval):
//   1. the row's last instant, the latest at or before now that its cron
//      names (lastInstant). One before DUE_SINCE is never due: the chain owes
//      no dispatch for it, so its first runs dispatch no workflow for an
//      instant whose workflow had no cron yet or whose cron ran, such as the
//      yearly's 2026-01-01T05:50:00Z or the monthly's 2026-10-01T04:50:00Z;
//   2. before the instant plus DUE_GRACE_S, the row waits, so a cron that
//      fires on time runs first;
//   3. `gh run list --workflow FILE --branch main`: a run of any event and
//      any status created at or after the instant meets the row, so a failed
//      run, or a dispatch by hand of one day or span, is not dispatched again:
//      the cron's late run and the next instant retry. A listing that fails or
//      does not parse dispatches nothing: a listing that fails on every run
//      of the chain must not dispatch on every run;
//   4. else `gh workflow run FILE --ref main`, one try: the next run of the
//      chain tries again. A dispatch and the cron's late run of the same
//      instant write each pack and each tag once: a compaction plans its last
//      units and finds a built unit present (so the late run adds no source
//      whose pack came after the dispatch), and ref-refresh.yml leaves a tag
//      that holds the same file as it is.
// sleep: the clock as in start, then until the first multiple of
// interval_min minutes since 1970-01-01T00:00:00Z strictly after now.
//
// It imports nothing from the workspace packages, so its job needs no npm ci.
//
// Usage:
//   node scripts/ingest/chain.mjs start [--clock FILE] [--workflow ingest-live.yml]
//   node scripts/ingest/chain.mjs due [--clock FILE] [--now ISO]
//   node scripts/ingest/chain.mjs sleep [--clock FILE] [--now ISO]
// start dispatches ingest-live.yml alone (--workflow names it or nothing), and
// due the workflows of DUE alone, a constant that no flag widens, so the job's
// actions: write token dispatches no other workflow of the repository.
// Environment: GITHUB_REF, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
// GITHUB_REPOSITORY, GH_TOKEN (read by gh itself).
// stdout: start and sleep one line, `chain off: ...`, `chain held: ...`,
// `chain started: ...`, `chain broken: ...`, or `sleep N s to BOUNDARY`;
// `chain warn: ...` before a dispatch whose listing failed. due: `chain off:
// ...`, or one line a row: `due FILE: not before DUE_SINCE ...`, `due FILE:
// next INSTANT ...`, `due FILE: met by run ID (EVENT, CREATED)`, `due FILE:
// dispatched for INSTANT` or `due FILE: warn ...`.
// Exit codes: 0 off, held, dispatched or slept, and due whatever its rows did,
// a warning among them (the start ran before it) · 1 start:
// the dispatch failed DISPATCH_TRIES times · 2 could not run (usage, a clock
// file that does not read, parse or validate, no GITHUB_REPOSITORY, a cron of
// DUE that lastInstant refuses) · 70 an internal error, a defect of this
// script (its stack goes to stderr).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../files.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';

export const EXIT = Object.freeze({ ok: 0, broken: 1, usage: 2, internal: 70 });
export const CLOCKS = Object.freeze(['actions-schedule', 'actions-chain', 'worker', 'none']);
export const CHAIN_CLOCK = 'actions-chain';
export const DEFAULT_CLOCK = join(ROOT, 'config', 'clock.json');
export const DEFAULT_WORKFLOW = 'ingest-live.yml';
// The interval of ruling 27, so a file with no interval_min runs the chain at
// it. The test of scripts/measure/clock-verdict.mjs holds its INTERVAL_MIN
// equal, since docs/clock.md calls the interval the default of this script.
export const DEFAULT_INTERVAL_MIN = 30;
// The top fits the chain job's timeout of 36 minutes in ingest-live.yml
// (scripts/workflows/ingest-live.test.mjs holds the two together).
export const INTERVAL_MIN_RANGE = Object.freeze({ min: 1, max: 30 });
export const DISPATCH_TRIES = 3;
export const DISPATCH_PAUSE_S = 15;
// The runs of the workflow one listing reads: a queue longer than this holds
// the dispatch anyway.
export const LIST_LIMIT = 50;
// The scheduled workflows that due dispatches, each with the one cron of its
// file (chain.test.mjs holds each row to the file, and every cron of the
// workflows to a row or a stated exclusion). The only forms lastInstant
// takes: a fixed minute and hour, and a day of the month, a month and a day
// of the week that are each `*` or one number.
export const DUE = Object.freeze([
  Object.freeze({ file: 'compact-daily.yml', cron: '35 1 * * *' }),
  Object.freeze({ file: 'compact-weekly.yml', cron: '50 3 * * 1' }),
  Object.freeze({ file: 'compact-monthly.yml', cron: '50 4 1 * *' }),
  Object.freeze({ file: 'compact-yearly.yml', cron: '50 5 1 1 *' }),
  Object.freeze({ file: 'ref-refresh.yml', cron: '13 5 * * *' }),
]);
// The first instant the chain owes a dispatch for: an earlier instant is never
// due, since its workflow had no cron yet or its cron ran (the header, due step 1).
export const DUE_SINCE = '2026-11-01T00:00:00Z';
// A row is due this long after its instant, so a cron that fires on time runs first.
export const DUE_GRACE_S = 1200;
// The newest runs of a workflow one listing of due reads. The listing is
// newest first, so a run at or after the instant is among them when one exists.
export const DUE_LIST_LIMIT = 20;
// lastInstant steps back at most this many days before today: a yearly cron's
// instant is at most 366 days back, from 1 January of the year after a leap year.
const INSTANT_DAYS = 366;
const DAY_MS = 86_400_000;
// The bound of one gh call: a gh that runs longer is killed.
export const GH_TIMEOUT_MS = 60_000;
const MAIN = 'refs/heads/main';
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// createdAt of a listed run: an instant of UTC to the second, a fraction allowed.
const CREATED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const USAGE = 'usage: node scripts/ingest/chain.mjs start [--clock FILE] [--workflow ingest-live.yml] | due [--clock FILE] [--now ISO] | sleep [--clock FILE] [--now ISO]';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// The production gh: `gh ARGS`, its exit code and output. A gh that does not
// start, or that runs past GH_TIMEOUT_MS and is killed, answers 127 (spawnSync
// sets `error` for both). GH_TOKEN reaches it through the environment, as gh
// reads it. `spawn` is spawnSync but in tests.
export function ghRunner(args, spawn = spawnSync) {
  const r = spawn('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, windowsHide: true });
  if (r.error) return { code: 127, stdout: r.stdout ?? '', stderr: `cannot run gh: ${r.error.message}` };
  return { code: r.status ?? 128, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// config/clock.json: { clock, interval } (minutes), or null when the file does
// not exist. A file that does not read, parse or validate is UsageError.
export function readClock(path, readFile = (p) => readFileSync(p, 'utf8')) {
  let text;
  try {
    text = readFile(path);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new UsageError(`${path} does not read: ${e.message}`);
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${path} is not JSON: ${e.message}`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new UsageError(`${path} is not a JSON object`);
  if (!CLOCKS.includes(v.clock)) throw new UsageError(`${path}: clock is ${JSON.stringify(v.clock ?? null)}, not one of ${CLOCKS.join(', ')}`);
  let interval = DEFAULT_INTERVAL_MIN;
  if (Object.hasOwn(v, 'interval_min')) {
    const n = v.interval_min;
    if (!Number.isSafeInteger(n) || n < INTERVAL_MIN_RANGE.min || n > INTERVAL_MIN_RANGE.max)
      throw new UsageError(`${path}: interval_min is ${JSON.stringify(n)}, not a whole number of ${INTERVAL_MIN_RANGE.min} to ${INTERVAL_MIN_RANGE.max}`);
    interval = n;
  }
  return { clock: v.clock, interval };
}

// The first multiple of `intervalMin` minutes since the epoch strictly after `nowMs`.
export function nextBoundary(nowMs, intervalMin) {
  const step = intervalMin * 60_000;
  return Math.floor(nowMs / step) * step + step;
}

const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const lastLine = (text) => String(text).trim().split('\n').at(-1) ?? '';

// One field of a cron: `*` (null) when `star`, else one number of lo to hi.
function cronField(cron, text, name, lo, hi, star) {
  if (star && text === '*') return null;
  if (/^\d{1,2}$/.test(text) && Number(text) >= lo && Number(text) <= hi) return Number(text);
  throw new UsageError(`the cron ${JSON.stringify(cron)}: the ${name} ${JSON.stringify(text)} is not ${star ? '* or ' : ''}a number of ${lo} to ${hi}`);
}

// The latest instant at or before `nowMs` that `cron` names, in ms. Only the
// forms of DUE: a cron of another form is UsageError, a defect of the table
// that its test finds. A day of the month and a day of the week both fixed is
// refused too: cron then takes a day that matches either, a rule no row needs.
export function lastInstant(cron, nowMs) {
  const f = String(cron).split(' ');
  if (f.length !== 5) throw new UsageError(`the cron ${JSON.stringify(cron)} is not 5 fields split by single spaces`);
  const minute = cronField(cron, f[0], 'minute', 0, 59, false);
  const hour = cronField(cron, f[1], 'hour', 0, 23, false);
  const dom = cronField(cron, f[2], 'day of the month', 1, 31, true);
  const month = cronField(cron, f[3], 'month', 1, 12, true);
  const dow = cronField(cron, f[4], 'day of the week', 0, 6, true);
  if (dom !== null && dow !== null) throw new UsageError(`the cron ${JSON.stringify(cron)} fixes both the day of the month and the day of the week`);
  // A day of UTC is DAY_MS long, so the candidates need no calendar fields
  // (Date.UTC would read a year below 100 as 1900 and more).
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  for (let back = 0; back <= INSTANT_DAYS; back++) {
    const t = today - back * DAY_MS + (hour * 60 + minute) * 60_000;
    if (t > nowMs) continue;
    const day = new Date(t);
    if ((dom === null || day.getUTCDate() === dom) && (month === null || day.getUTCMonth() + 1 === month) && (dow === null || day.getUTCDay() === dow)) return t;
  }
  throw new UsageError(`the cron ${JSON.stringify(cron)} names no instant in the ${INSTANT_DAYS + 1} days up to ${iso(nowMs)}`);
}

function parse(argv) {
  const a = parseArgs(argv);
  const verb = a._[0];
  if (verb !== 'start' && verb !== 'due' && verb !== 'sleep') throw new UsageError(`name a verb, start, due or sleep${verb === undefined ? '' : `, not ${JSON.stringify(verb)}`}`);
  if (a._.length > 1) throw new UsageError(`${JSON.stringify(a._[1])} is not a flag`);
  const allowed = verb === 'start' ? ['clock', 'workflow'] : ['clock', 'now'];
  for (const k of Object.keys(a)) if (k !== '_' && !allowed.includes(k)) throw new UsageError(`${verb} takes no flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  for (const k of allowed) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a.workflow !== undefined && a.workflow !== DEFAULT_WORKFLOW) throw new UsageError(`--workflow ${JSON.stringify(a.workflow)} is not ${DEFAULT_WORKFLOW}: the chain starts that workflow alone`);
  if (a.now !== undefined && (!ISO_SECOND.test(a.now) || !Number.isFinite(Date.parse(a.now)) || iso(Date.parse(a.now)) !== a.now))
    throw new UsageError(`--now ${JSON.stringify(a.now)} is not YYYY-MM-DDTHH:MM:SSZ`);
  return { verb, clock: a.clock ?? DEFAULT_CLOCK, workflow: a.workflow ?? DEFAULT_WORKFLOW, now: a.now };
}

// The off line of a clock, or null when the chain runs.
function offLine(clock) {
  if (clock === null) return 'chain off: config/clock.json does not exist; only the cron and dispatches start runs';
  if (clock.clock !== CHAIN_CLOCK) return `chain off: the clock is ${clock.clock}`;
  return null;
}

// The runs of `listing` (gh's JSON) that wait, besides this run: a count, or
// null when the listing is not a list of { databaseId, status }.
function waiting(stdout, runId) {
  let runs;
  try {
    runs = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(runs) || runs.some((r) => r === null || typeof r !== 'object' || typeof r.status !== 'string' || !Number.isSafeInteger(r.databaseId))) return null;
  return runs.filter((r) => String(r.databaseId) !== runId && r.status !== 'in_progress' && r.status !== 'completed').length;
}

// The guards 1 to 3 of start, which due keeps too: the off line of the clock,
// of a run of another ref or of a re-run, or null when the verb goes on.
// `other` and `rerun` say what such a run does not do.
function guardLine(args, d, other, rerun) {
  const off = offLine(readClock(args.clock, d.readFile));
  if (off !== null) return off;
  const ref = d.env.GITHUB_REF ?? '';
  if (ref !== MAIN) return `chain off: a run on ${ref || 'no ref'} ${other}`;
  const attempt = d.env.GITHUB_RUN_ATTEMPT ?? '1';
  if (attempt !== '1') return `chain off: attempt ${attempt} is a re-run; ${rerun}`;
  return null;
}

function repoOf(d) {
  const repo = d.env.GITHUB_REPOSITORY;
  if (!repo) throw new UsageError('GITHUB_REPOSITORY is not set: gh needs the repository');
  return repo;
}

// The detail of a listing that is no list of runs: gh's exit and its last
// line of stderr, or that its output did not parse.
const listFault = (listed) => (listed.code === 0 ? 'the listing is not a list of runs' : `gh exited ${listed.code}: ${lastLine(listed.stderr)}`);

async function start(args, d) {
  const off = guardLine(args, d, 'starts no successor', 'attempt 1 started the successor');
  if (off !== null) {
    d.out(off);
    return EXIT.ok;
  }
  const repo = repoOf(d);
  const listed = d.gh(['run', 'list', '--repo', repo, '--workflow', args.workflow, '--branch', 'main', '--limit', String(LIST_LIMIT), '--json', 'databaseId,status']);
  const n = listed.code === 0 ? waiting(listed.stdout, d.env.GITHUB_RUN_ID ?? '') : null;
  if (n !== null && n > 0) {
    d.out(`chain held: ${n} run(s) wait; the chain goes on through them`);
    return EXIT.ok;
  }
  if (n === null) d.out(`chain warn: the runs did not list (${listFault(listed)}); the successor is dispatched anyway`);
  for (let attemptNo = 1; attemptNo <= DISPATCH_TRIES; attemptNo++) {
    const r = d.gh(['workflow', 'run', args.workflow, '--ref', 'main', '--repo', repo]);
    if (r.code === 0) {
      d.out(`chain started: the successor is dispatched (try ${attemptNo})`);
      return EXIT.ok;
    }
    d.err(`chain: gh workflow run exited ${r.code} (try ${attemptNo} of ${DISPATCH_TRIES}): ${String(r.stderr).trim()}`);
    if (attemptNo < DISPATCH_TRIES) await d.sleep(DISPATCH_PAUSE_S * 1000);
  }
  d.out(`chain broken: the successor was not dispatched in ${DISPATCH_TRIES} tries; the cron backstop restarts the chain`);
  return EXIT.broken;
}

// The runs of a listing of due (gh's JSON), or null when it is not a list of
// { databaseId, createdAt, status, event }.
function runsOf(stdout) {
  let runs;
  try {
    runs = JSON.parse(stdout);
  } catch {
    return null;
  }
  const valid = (r) =>
    r !== null &&
    typeof r === 'object' &&
    Number.isSafeInteger(r.databaseId) &&
    typeof r.createdAt === 'string' &&
    CREATED.test(r.createdAt) &&
    Number.isFinite(Date.parse(r.createdAt)) &&
    typeof r.status === 'string' &&
    typeof r.event === 'string';
  return Array.isArray(runs) && runs.every(valid) ? runs : null;
}

// One row of DUE at `nowMs`: its line, after a dispatch when it is due and no
// run meets it.
function dueRow(row, nowMs, repo, d) {
  const instant = lastInstant(row.cron, nowMs);
  if (instant < Date.parse(DUE_SINCE)) return `due ${row.file}: not before ${DUE_SINCE} (its last instant is ${iso(instant)})`;
  const at = instant + DUE_GRACE_S * 1000;
  if (nowMs < at) return `due ${row.file}: next ${iso(at)} (the instant ${iso(instant)} and ${DUE_GRACE_S} s of grace)`;
  const listed = d.gh(['run', 'list', '--repo', repo, '--workflow', row.file, '--branch', 'main', '--limit', String(DUE_LIST_LIMIT), '--json', 'databaseId,createdAt,status,event']);
  const runs = listed.code === 0 ? runsOf(listed.stdout) : null;
  if (runs === null) return `due ${row.file}: warn the runs did not list (${listFault(listed)}); nothing is dispatched, and the next run of the chain lists them again`;
  // The first run at or after the instant: the one that met it.
  const met = runs.filter((r) => Date.parse(r.createdAt) >= instant).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  if (met !== undefined) return `due ${row.file}: met by run ${met.databaseId} (${met.event}, ${met.createdAt})`;
  const r = d.gh(['workflow', 'run', row.file, '--ref', 'main', '--repo', repo]);
  if (r.code === 0) return `due ${row.file}: dispatched for ${iso(instant)}`;
  d.err(`chain: gh workflow run ${row.file} exited ${r.code}: ${String(r.stderr).trim()}`);
  return `due ${row.file}: warn gh workflow run exited ${r.code} (${lastLine(r.stderr)}); the next run of the chain tries again`;
}

function due(args, d) {
  const off = guardLine(args, d, 'dispatches no scheduled workflow', 'the next run of the chain dispatches what is due');
  if (off !== null) {
    d.out(off);
    return EXIT.ok;
  }
  const repo = repoOf(d);
  const nowMs = args.now === undefined ? d.now() : Date.parse(args.now);
  for (const row of DUE) d.out(dueRow(row, nowMs, repo, d));
  return EXIT.ok;
}

async function sleepVerb(args, d) {
  const clock = readClock(args.clock, d.readFile);
  const off = offLine(clock);
  if (off !== null) {
    d.out(off);
    return EXIT.ok;
  }
  const nowMs = args.now === undefined ? d.now() : Date.parse(args.now);
  const boundary = nextBoundary(nowMs, clock.interval);
  const seconds = Math.ceil((boundary - nowMs) / 1000);
  d.out(`sleep ${seconds} s to ${iso(boundary)}`);
  await d.sleep(seconds * 1000);
  return EXIT.ok;
}

// An error chain does not know is a defect, exit 70: never 1 or 2.
export async function main(argv, deps = {}) {
  const d = {
    gh: deps.gh ?? ghRunner,
    sleep: deps.sleep ?? realSleep,
    now: deps.now ?? (() => Date.now()),
    readFile: deps.readFile ?? ((p) => readFileSync(p, 'utf8')),
    env: deps.env ?? process.env,
    out: deps.out ?? console.log,
    err: deps.err ?? console.error,
  };
  try {
    const args = parse(argv);
    const verbs = { start, due, sleep: sleepVerb };
    return await verbs[args.verb](args, d);
  } catch (e) {
    if (e instanceof UsageError) {
      d.err(`chain: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    d.err(`chain: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
