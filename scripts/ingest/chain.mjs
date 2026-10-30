// scripts/ingest/chain.mjs — the chain of .github/workflows/ingest-live.yml
// (DOM-024, docs/architecture.md section 5.2): the job `chain` dispatches the
// successor at the START of a run, so a crash later in the run cannot break
// the chain (the entry's Decision), then sleeps to the next boundary of the
// interval, which keeps the chain on the grid of the clock.
//
// It is the one reader of config/clock.json here (DOM-003 writes it): with
// no file, or a clock other than actions-chain, both verbs print `chain off`
// and exit 0, and only the cron backstop and workflow_dispatch start runs
// (D14 of DOM-024). The interval is the optional whole number interval_min of
// the file, 1 to 12, default 10 (12 fits the job's timeout of 15 minutes).
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
// sleep: the clock as in start, then until the first multiple of
// interval_min minutes since 1970-01-01T00:00:00Z strictly after now.
//
// It imports nothing from the workspace packages, so its job needs no npm ci.
//
// Usage:
//   node scripts/ingest/chain.mjs start [--clock FILE] [--workflow ingest-live.yml]
//   node scripts/ingest/chain.mjs sleep [--clock FILE] [--now ISO]
// The chain starts ingest-live.yml alone: --workflow names it or nothing, so
// the job's actions: write token dispatches no other workflow of the repository.
// Environment: GITHUB_REF, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
// GITHUB_REPOSITORY, GH_TOKEN (read by gh itself).
// stdout: one line, `chain off: ...`, `chain held: ...`, `chain started: ...`,
// `chain broken: ...`, or `sleep N s to BOUNDARY`; `chain warn: ...` before
// a dispatch whose listing failed.
// Exit codes: 0 off, held, dispatched or slept · 1 start: the dispatch failed
// DISPATCH_TRIES times · 2 could not run (usage, a clock file that does not
// read, parse or validate, no GITHUB_REPOSITORY) · 70 an internal error, a
// defect of this script (its stack goes to stderr).
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
export const DEFAULT_INTERVAL_MIN = 10;
export const INTERVAL_MIN_RANGE = Object.freeze({ min: 1, max: 12 });
export const DISPATCH_TRIES = 3;
export const DISPATCH_PAUSE_S = 15;
// The runs of the workflow one listing reads: a queue longer than this holds
// the dispatch anyway.
export const LIST_LIMIT = 50;
const MAIN = 'refs/heads/main';
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const USAGE = 'usage: node scripts/ingest/chain.mjs start [--clock FILE] [--workflow ingest-live.yml] | sleep [--clock FILE] [--now ISO]';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// The production gh: `gh ARGS`, its exit code and output; a gh that does not
// start answers 127. GH_TOKEN reaches it through the environment, as gh reads it.
export function ghRunner(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
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

function parse(argv) {
  const a = parseArgs(argv);
  const verb = a._[0];
  if (verb !== 'start' && verb !== 'sleep') throw new UsageError(`name a verb, start or sleep${verb === undefined ? '' : `, not ${JSON.stringify(verb)}`}`);
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

async function start(args, d) {
  const off = offLine(readClock(args.clock, d.readFile));
  if (off !== null) {
    d.out(off);
    return EXIT.ok;
  }
  const ref = d.env.GITHUB_REF ?? '';
  if (ref !== MAIN) {
    d.out(`chain off: a run on ${ref || 'no ref'} starts no successor`);
    return EXIT.ok;
  }
  const attempt = d.env.GITHUB_RUN_ATTEMPT ?? '1';
  if (attempt !== '1') {
    d.out(`chain off: attempt ${attempt} is a re-run; attempt 1 started the successor`);
    return EXIT.ok;
  }
  const repo = d.env.GITHUB_REPOSITORY;
  if (!repo) throw new UsageError('GITHUB_REPOSITORY is not set: gh needs the repository');
  const listed = d.gh(['run', 'list', '--repo', repo, '--workflow', args.workflow, '--branch', 'main', '--limit', String(LIST_LIMIT), '--json', 'databaseId,status']);
  const n = listed.code === 0 ? waiting(listed.stdout, d.env.GITHUB_RUN_ID ?? '') : null;
  if (n !== null && n > 0) {
    d.out(`chain held: ${n} run(s) wait; the chain goes on through them`);
    return EXIT.ok;
  }
  if (n === null) {
    const detail = listed.code === 0 ? 'the listing is not a list of runs' : `gh exited ${listed.code}: ${String(listed.stderr).trim().split('\n').at(-1) ?? ''}`;
    d.out(`chain warn: the runs did not list (${detail}); the successor is dispatched anyway`);
  }
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
    return args.verb === 'start' ? await start(args, d) : await sleepVerb(args, d);
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
