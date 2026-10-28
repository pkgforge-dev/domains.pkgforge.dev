// scripts/measure/clock-gaps.mjs — how late does a GitHub Actions clock tick?
// (DOM-001, TODO/ops.md; the decision rule is architecture section 5.2.)
//
// Reads the runs of one workflow, of one event, on main, with the jobs of each
// run's first attempt, and measures the first --hours from the first tick:
// the gaps between ticks, how long a run waited for a runner, and, for a cron,
// how many of its own slots held a run. PASS when the p90 gap is at most 15 min
// and the longest gap at most 60 min, else FAIL.
//
// A run's tick is the earliest `started_at` among the jobs of its first attempt
// that a runner took (`runner_name` set). The run's own `run_started_at` is not
// read: it equals `created_at` on every run read (40 runs of mirror-archlinux's
// sync.yml, queued ones among them, 2026-10-28T10:27Z), so it does not say when
// work began. A run that no runner took (cancelled while it waited) is no tick;
// it is counted in `runs_not_started`.
//
// The window is [from, from + hours), `from` being the first tick. Its gaps are
// those between consecutive ticks inside it, plus the closing gap from its last
// tick to the first tick at or after its end, or to its end when no tick came:
// a clock that stops inside the window fails it, never passes it by leaving no
// gaps. The window is complete when the run list was read at or after its end.
//
// Usage:
//   node scripts/measure/clock-gaps.mjs --workflow measure-clock-schedule.yml --event schedule \
//     --interval-min 5 --hours 48 [--out docs/research/measure/DOM-001/schedule.json]
//     [--repo pkgforge-dev/domains.pkgforge.dev] [--runs <a saved .runs.json>]
//
// --event is `schedule` (clock actions-schedule) or `workflow_dispatch` (clock
// actions-chain). --out writes the result there and, when the runs were read
// from GitHub, the run list beside it as <name>.runs.json. --runs reads such a
// file instead of GitHub, so a result is computed again offline. Reading GitHub
// needs `gh`, signed in.
//
// stdout: the result, one JSON object. stderr: one `verdict=` line.
// Exit codes: 0 the window is complete and measured (PASS or FAIL is the
// finding, and --out is written) · 1 the window is not complete yet, nothing is
// written · 2 could not run (usage, gh, a malformed or truncated run list).
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';

export const DEFAULT_REPO = 'pkgforge-dev/domains.pkgforge.dev';
export const RULE = Object.freeze({ p90_max_min: 15, max_max_min: 60 });
export const BREAK_MIN = 30;
export const RUNS_VERSION = 1;
export const RESULT_VERSION = 1;
const CLOCKS = { schedule: 'actions-schedule', workflow_dispatch: 'actions-chain' };
// The runs endpoint answers at most 1,000 runs for a query filtered by event or
// branch (GitHub REST documentation, "List workflow runs for a workflow").
const LISTING_CAP = 1000;
const JOB_FETCHES_AT_ONCE = 8;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const DEFINITIONS = Object.freeze({
  tick: "the earliest started_at among the jobs of the run's first attempt that a runner took",
  window: '[from, from + hours), from being the first tick',
  gaps_min: 'minutes between consecutive ticks in the window, plus the closing gap from the last tick in the window to the first tick at or after its end (or to its end when none came)',
  start_lag_s: "seconds from the run's created_at to its tick, for the ticks in the window",
  slots:
    "schedule only: the slot of a run is floor(created_at / interval); hit counts the expected slots, from the slot of the first tick's run, that hold a run, started or not; missed is a lower bound of the slots the cron lost",
  quantiles: 'the value at index floor(n * q) of the ascending list: the median is the upper middle value of an even count, the p90 is index floor(0.9 n)',
  verdict: `PASS when the p90 gap is at most ${RULE.p90_max_min} min and the max gap at most ${RULE.max_max_min} min, else FAIL; INCOMPLETE before the window has ended`,
});

export class UsageError extends Error {}

// The flags, checked. Throws UsageError.
export function parseFlags(argv) {
  const a = parseArgs(argv);
  const str = (k) => (typeof a[k] === 'string' ? a[k] : undefined);
  const workflow = str('workflow');
  const event = str('event');
  const repo = str('repo') ?? DEFAULT_REPO;
  if (!workflow || !/^[a-z0-9][a-z0-9_.-]*\.ya?ml$/.test(workflow)) throw new UsageError('--workflow must be a file name in .github/workflows, such as measure-clock-chain.yml');
  if (!event || !(event in CLOCKS)) throw new UsageError(`--event must be one of ${Object.keys(CLOCKS).join(', ')}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new UsageError('--repo must be OWNER/NAME');
  const intervalMin = Number(str('interval-min'));
  const hours = Number(str('hours'));
  if (!Number.isInteger(intervalMin) || intervalMin < 1) throw new UsageError('--interval-min must be a whole number of minutes, 1 or more');
  if (!Number.isInteger(hours) || hours < 1) throw new UsageError('--hours must be a whole number of hours, 1 or more');
  if ((hours * 60) % intervalMin !== 0) throw new UsageError('--hours must hold a whole number of intervals');
  for (const k of ['out', 'runs']) if (a[k] === true) throw new UsageError(`--${k} needs a path`);
  return { workflow, event, repo, intervalMin, hours, out: str('out'), runs: str('runs') };
}

// Runs `gh` with the given arguments and resolves to its stdout. `cmd` is the
// program and its leading arguments: ['gh'] in production.
export function makeGh(cmd = ['gh']) {
  return (args) =>
    new Promise((done, fail) => {
      execFile(cmd[0], [...cmd.slice(1), ...args], { encoding: 'utf8', maxBuffer: 256 << 20, windowsHide: true }, (err, stdout, stderr) => {
        if (err) fail(new Error(`gh ${args.join(' ')}: ${String(stderr ?? '').trim() || err.message}`));
        else done(stdout);
      });
    });
}

// Each item through `fn`, at most `limit` at once, results in input order. The
// first failure rejects, and no new item is started after it.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const keepJob = (j) => ({ name: j.name, started_at: j.started_at ?? null, completed_at: j.completed_at ?? null, runner_name: j.runner_name ?? null, conclusion: j.conclusion ?? null });
const keepRun = (r, jobs) => ({
  id: r.id,
  created_at: r.created_at,
  run_started_at: r.run_started_at ?? null,
  status: r.status,
  conclusion: r.conclusion ?? null,
  event: r.event,
  head_branch: r.head_branch,
  run_attempt: r.run_attempt ?? null,
  jobs: jobs.map(keepJob),
});

// The run list of `workflow` for `event` on main, with each run's first-attempt
// jobs, as the object a .runs.json file holds. Throws when GitHub cannot answer
// or the listing may be truncated.
export async function fetchRuns({ gh, repo, workflow, event, now = () => new Date() }) {
  const fetchedAt = now().toISOString();
  const ghVersion = (await gh(['--version'])).split('\n')[0].trim();
  const byId = new Map();
  let total = null;
  for (let page = 1; ; page++) {
    const body = JSON.parse(await gh(['api', `repos/${repo}/actions/workflows/${workflow}/runs?event=${event}&branch=main&exclude_pull_requests=true&per_page=100&page=${page}`]));
    if (!Number.isInteger(body?.total_count) || !Array.isArray(body?.workflow_runs)) throw new Error(`page ${page} of the run list is not a workflow run listing`);
    total ??= body.total_count;
    for (const r of body.workflow_runs) byId.set(r.id, r);
    if (body.workflow_runs.length < 100) break;
  }
  if (total >= LISTING_CAP) throw new Error(`${workflow} has ${total} runs for event ${event}; GitHub lists at most ${LISTING_CAP}, so the oldest may be missing`);
  // A run added while the pages were read shifts them, and appears twice; the
  // map holds it once. A run is never removed, so fewer than the first count is a loss.
  if (byId.size < total) throw new Error(`read ${byId.size} runs of ${workflow}, GitHub counted ${total}`);
  const listed = [...byId.values()].sort((x, y) => x.id - y.id);
  const runs = await mapPool(listed, JOB_FETCHES_AT_ONCE, async (r) => {
    const body = JSON.parse(await gh(['api', `repos/${repo}/actions/runs/${r.id}/attempts/1/jobs?per_page=100`]));
    if (!Number.isInteger(body?.total_count) || !Array.isArray(body?.jobs)) throw new Error(`the jobs of run ${r.id} are not a job listing`);
    if (body.jobs.length < body.total_count) throw new Error(`run ${r.id} has ${body.total_count} jobs, more than one page holds`);
    return keepRun(r, body.jobs);
  });
  return { version: RUNS_VERSION, repo, workflow, event, branch: 'main', fetched_at: fetchedAt, gh: ghVersion, total_count: total, runs };
}

const isIso = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));

// Throws unless `doc` is a run list of the version this script writes.
export function checkRunsFile(doc) {
  const bad = (why) => {
    throw new Error(`not a run list of version ${RUNS_VERSION}: ${why}`);
  };
  if (doc?.version !== RUNS_VERSION) bad(`version is ${JSON.stringify(doc?.version)}`);
  for (const k of ['repo', 'workflow', 'event', 'branch']) if (typeof doc[k] !== 'string') bad(`${k} is not a string`);
  if (!isIso(doc.fetched_at)) bad('fetched_at is not an ISO 8601 UTC instant');
  if (!Array.isArray(doc.runs)) bad('runs is not an array');
  for (const r of doc.runs) {
    if (!Number.isInteger(r?.id)) bad('a run has no integer id');
    if (!isIso(r.created_at)) bad(`run ${r.id} created_at is not an ISO 8601 UTC instant`);
    if (typeof r.event !== 'string' || typeof r.head_branch !== 'string') bad(`run ${r.id} has no event or head_branch`);
    if (!Array.isArray(r.jobs)) bad(`run ${r.id} jobs is not an array`);
    for (const j of r.jobs) {
      if (j.runner_name && !isIso(j.started_at)) bad(`a job of run ${r.id} has a runner and no started_at`);
      if (j.completed_at !== null && j.completed_at !== undefined && !isIso(j.completed_at)) bad(`a job of run ${r.id} has a malformed completed_at`);
    }
  }
  return doc;
}

// A run's tick, or null when no runner took any of its jobs.
export function tickOf(run) {
  const ran = run.jobs.filter((j) => j.runner_name);
  if (ran.length === 0) return null;
  const t = Math.min(...ran.map((j) => Date.parse(j.started_at)));
  const runnerS = ran.reduce((s, j) => s + (j.completed_at ? Math.max(0, Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000 : 0), 0);
  return { id: run.id, t, created: Date.parse(run.created_at), runnerS };
}

// The value at index floor(n * q) of the ascending list: the rule of design B's
// actions_history.mjs, which measured this premise, and of DOM-002's probe
// (probes/worker/src/gaps.ts), so that the two clocks compare. The median of an
// even count is the upper of the two middle values.
export function quantile(xs, q) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

const round = (x, places) => (x === null ? null : Math.round(x * 10 ** places) / 10 ** places);
const spread = (xs, places) => ({ median: round(quantile(xs, 0.5), places), p90: round(quantile(xs, 0.9), places), max: round(xs.length ? Math.max(...xs) : null, places) });
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

// The measurement of one run list. Returns {complete, result}; `result` is the
// object written to --out. Throws when the list is not of `workflow` and `event`.
export function measure(doc, { workflow, event, intervalMin, hours }) {
  if (doc.workflow !== workflow || doc.event !== event) throw new Error(`the run list is of ${doc.workflow} for event ${doc.event}, not ${workflow} for ${event}`);
  const other = doc.runs.find((r) => r.event !== event || r.head_branch !== 'main');
  if (other) throw new Error(`run ${other.id} is of event ${other.event} on ${other.head_branch}, not ${event} on main`);
  const intervalMs = intervalMin * 60_000;
  const spanMs = hours * 3_600_000;
  const expected = (hours * 60) / intervalMin;
  const fetchedAt = Date.parse(doc.fetched_at);

  const ticks = doc.runs
    .map(tickOf)
    .filter(Boolean)
    .sort((a, b) => a.t - b.t || a.id - b.id);
  const clock = CLOCKS[event];
  if (ticks.length === 0) {
    const why = `no run of ${workflow} for event ${event} has started`;
    return {
      complete: false,
      result: {
        version: RESULT_VERSION,
        clock,
        workflow,
        event,
        hours,
        runs: 0,
        expected,
        verdict: 'INCOMPLETE',
        rule: { ...RULE },
        why,
        complete: false,
        repo: doc.repo,
        conditions: conditionsOf(doc),
      },
    };
  }

  const from = ticks[0].t;
  const to = from + spanMs;
  const complete = fetchedAt >= to;
  const inWindow = ticks.filter((k) => k.t < to);
  const after = ticks.find((k) => k.t >= to);
  const gapsMs = [];
  for (let i = 1; i < inWindow.length; i++) gapsMs.push(inWindow[i].t - inWindow[i - 1].t);
  const last = inWindow[inWindow.length - 1].t;
  if (after) gapsMs.push(after.t - last);
  else if (complete) gapsMs.push(to - last);
  const gapsMin = gapsMs.map((g) => g / 60_000);
  const p90 = quantile(gapsMin, 0.9);
  const max = gapsMin.length ? Math.max(...gapsMin) : null;

  const notStarted = doc.runs.filter((r) => !tickOf(r)).filter((r) => Date.parse(r.created_at) >= from && Date.parse(r.created_at) < to).length;
  let slots = null;
  if (event === 'schedule') {
    const first = Math.floor(inWindow[0].created / intervalMs);
    const hit = new Set();
    for (const r of doc.runs) {
      const s = Math.floor(Date.parse(r.created_at) / intervalMs) - first;
      if (s >= 0 && s < expected) hit.add(s);
    }
    slots = { expected, hit: hit.size, missed: expected - hit.size };
  }
  const runnerS = inWindow.map((k) => k.runnerS);
  const verdict = !complete ? 'INCOMPLETE' : p90 !== null && p90 <= RULE.p90_max_min && max <= RULE.max_max_min ? 'PASS' : 'FAIL';

  const result = {
    version: RESULT_VERSION,
    clock,
    workflow,
    event,
    from: iso(from),
    to: iso(to),
    hours,
    runs: inWindow.length,
    expected,
    gaps_min: spread(gapsMin, 2),
    start_lag_s: spread(
      inWindow.map((k) => (k.t - k.created) / 1000),
      0,
    ),
    slots,
    breaks_over_30min: gapsMin.filter((g) => g > BREAK_MIN).length,
    verdict,
    rule: { ...RULE },
    complete,
    hours_seen: round((Math.min(fetchedAt, to) - from) / 3_600_000, 2),
    repo: doc.repo,
    branch: 'main',
    interval_min: intervalMin,
    gaps: gapsMin.length,
    runs_not_started: notStarted,
    cost: {
      runner_s_total: Math.round(runnerS.reduce((s, x) => s + x, 0)),
      runner_s_median: round(quantile(runnerS, 0.5), 0),
      note:
        event === 'workflow_dispatch'
          ? "the chain holds one of the 20 jobs that the organisation's Free plan runs at once, for the whole window; runner time is free for a public repository"
          : 'each tick is one short job; runner time is free for a public repository',
    },
    conditions: conditionsOf(doc),
    definitions: { ...DEFINITIONS },
  };
  return { complete, result };
}

function conditionsOf(doc) {
  return { fetched_at: doc.fetched_at, gh: doc.gh ?? null, listed_runs: doc.runs.length, node: process.version };
}

export function verdictLine(r) {
  if (r.runs === 0) return `verdict=INCOMPLETE clock=${r.clock} runs=0 why="${r.why}"`;
  const head = `verdict=${r.verdict} clock=${r.clock} runs=${r.runs}/${r.expected} p90_gap_min=${r.gaps_min.p90} max_gap_min=${r.gaps_min.max} breaks_over_30min=${r.breaks_over_30min}`;
  return r.complete ? head : `${head} hours_seen=${r.hours_seen}/${r.hours}`;
}

// The run list beside a result: x.json -> x.runs.json.
export const runsPathFor = (out) => (out.endsWith('.json') ? `${out.slice(0, -'.json'.length)}.runs.json` : `${out}.runs.json`);

// Writes through a temporary file in the same directory, so a killed process
// leaves the old file whole.
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export async function main(argv, { gh = makeGh(), stdout = process.stdout, stderr = process.stderr } = {}) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(
      `clock-gaps: ${err.message}\nusage: node scripts/measure/clock-gaps.mjs --workflow <file.yml> --event schedule|workflow_dispatch --interval-min N --hours N [--out <file.json>] [--repo OWNER/NAME] [--runs <file.runs.json>]\n`,
    );
    return 2;
  }
  let doc;
  let measured;
  try {
    doc = checkRunsFile(flags.runs ? JSON.parse(readFileSync(resolve(flags.runs), 'utf8')) : await fetchRuns({ gh, repo: flags.repo, workflow: flags.workflow, event: flags.event }));
    measured = measure(doc, flags);
  } catch (err) {
    stderr.write(`clock-gaps: could not run: ${err.message}\n`);
    return 2;
  }
  const { complete, result } = measured;
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!complete) {
    stderr.write(`${verdictLine(result)}\nclock-gaps: the window of ${flags.hours} h has not ended; nothing written\n`);
    return 1;
  }
  if (flags.out) {
    const out = resolve(flags.out);
    writeAtomic(out, `${JSON.stringify(result, null, 2)}\n`);
    if (!flags.runs) writeAtomic(runsPathFor(out), `${JSON.stringify(doc, null, 2)}\n`);
    stderr.write(`clock-gaps: wrote ${basename(out)}${flags.runs ? '' : ` and ${basename(runsPathFor(out))}`}\n`);
  }
  stderr.write(`${verdictLine(result)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
