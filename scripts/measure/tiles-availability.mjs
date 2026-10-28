// scripts/measure/tiles-availability.mjs — which CT logs serve names tiles,
// over 24 hours, and the verdict of DOM-011 (TODO/ingest.md).
//
// The rounds. One round reads the log list (its log_list_timestamp, its
// version, the state of each log) and probes every tiled log in state usable
// or qualified with tiles-probe.mjs: the checkpoint, names tile 0, the last
// full names tile, the partial tile, and the first served tile when tile 0 is
// not served (the round before's answer is the hint). Every request sends the
// project's User-Agent with its contact address. A round has a deadline of 10
// minutes; a request still open then is recorded as `timeout`.
//
// The rounds come from inside a job that loops, never from a cron (DOM-011's
// "The sample clock"): .github/workflows/measure-tiles.yml runs this with
// --start at the job's own start, 30 minutes apart, for 340 minutes, and never
// at or after --until. Each round is appended to --out as soon as it ends, so a
// job that is ended keeps every round it took. A slot whose time has passed
// when the round before ends is skipped, so a late round never sends two
// rounds back to back.
//
// The verdict reads the rounds and the overlap job's files of every run
// (`gh run download` lays them out as RUNS/tiles-rounds-<run>-<attempt>/rounds.jsonl
// and RUNS/tiles-overlap-<run>-<attempt>/{overlap,geomys-window,rates}.json),
// takes the 24 hours from the first round, and prints one row per log
// (statuses over the 24 hours, the first served tile, entries a day), the
// Geomys window, the overlap matrices and the rates. DEFINITIONS below is
// written into the result, so the file says what each number means. The 24
// hours are complete when a job's rounds stopped at until (the chain has
// ended) or six hours after their end (a job lasts at most 350 minutes); an
// incomplete window is printed and not written. PASS needs the Prove's three
// conditions (44 of 48 slots, Geomys at 200 with no 429, a reliable log) and
// two more, so a run that measured neither is not a pass: a whole read of the
// Geomys window with no 429, and one whole overlap window.
//
// Usage:
//   node scripts/measure/tiles-availability.mjs --once --out FILE
//   node scripts/measure/tiles-availability.mjs --out FILE [--start ISO] [--for-min 340] [--interval-min 30] [--until ISO]
//   node scripts/measure/tiles-availability.mjs --verdict FILE [--download] [--runs DIR] [--repo OWNER/NAME]
//     --runs     default docs/research/measure/DOM-011/runs, so the committed
//                artifacts are the evidence the result is computed from
//     --download first fetch the artifacts of every completed run of
//                measure-tiles.yml on main with `gh run download` into
//                DIR/<artifact name>/
//     --verdict  write the result to FILE; with no rounds under DIR, read FILE,
//                check that its verdict follows from its rows, and judge it
//
// Exit codes, the rounds: 0 every round ran and each had an answer (or until
// had passed, and no round was due) · 1 a round had no answer at all · 2 bad
// arguments, or FILE cannot be written.
// Exit codes, the verdict: 0 PASS · 1 FAIL, or the 24 hours are not complete ·
// 2 could not run (a bad argument, no rounds and no result, an unknown schema,
// a result whose verdict does not follow from its rows, `gh` failing).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { createClient, errorText, USER_AGENT } from './ct-tiles.mjs';
import { fetchLogList, logRows } from './ct-logs.mjs';
import { DEFAULT_STATES, pickLogs, probeLog } from './tiles-probe.mjs';

export const SCHEMA = 'dom-011-round/1';
export const RESULT_SCHEMA = 'dom-011-tiles/1';
export const OVERLAP_SCHEMA = 'dom-011-overlap/1';
export const WINDOW_SCHEMA = 'dom-011-window/1';
export const RATES_SCHEMA = 'dom-011-rates/1';
export const DEFAULT_REPO = 'pkgforge-dev/domains.pkgforge.dev';
export const WORKFLOW = 'measure-tiles.yml';
export const DEFAULT_RUNS = 'docs/research/measure/DOM-011/runs';
export const ROUND_DEADLINE_MS = 10 * 60_000;
// The pass rule of DOM-011: 44 of the 48 half hours of the 24 hours hold a round.
export const SLOT_MIN = 30;
export const SLOTS = 48;
export const MIN_SLOTS = 44;
// The fixed Geomys window of DOM-011's Approach.
export const GEOMYS_WINDOW = Object.freeze({ log: 'tuscolo2027h1', from: '2026-10-26T12:00:00Z', to: '2026-10-26T12:05:00Z' });
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MIN = 60_000;
const DAY = 86_400_000;
const COMPLETE_AFTER_MS = 6 * 60 * MIN;
const GAP_LIST_MIN = 35;
const LISTING_LIMIT = 200;
const NON_200_LIST_MAX = 20;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// The headers kept on a 404, the answer most rounds repeat; any other status
// other than 200 keeps every header (ct-tiles.mjs pickHeaders).
const HEADERS_404 = Object.freeze(['server', 'content-type', 'content-length', 'content-encoding', 'cache-control', 'retry-after', 'skylight-rate-limited', 'x-ipng-upstream-status']);
export const KINDS = Object.freeze(['checkpoint', 'tile0', 'tail', 'partial']);

export const DEFINITIONS = Object.freeze({
  round: 'one look at the log list and at every tiled log in state usable or qualified, with the contact User-Agent; its time is its start',
  window: 'the 24 hours from the first round; a slot is a half hour of it counted from that round, and a slot is present when a round started in it',
  status:
    'per log and per probe, the count of each answer over the rounds of the window: an HTTP status; `bad` (200 with a body that is not a checkpoint, or not a names tile of its width); `error` (no answer: a timeout, a reset, the round deadline); `skipped` (no such tile: the tree is smaller than a tile, or its size is a multiple of 256); `absent` (the probe never ran: the checkpoint failed)',
  checkpoint: 'GET <monitoring URL>checkpoint; 200 counts only when the body parses as a checkpoint',
  tile0: 'GET tile/names/000',
  tail: 'GET tile/names/<the last full tile>, from that round checkpoint',
  partial: 'GET tile/names/<N>.p/<W>, the partial tile of that round checkpoint; a 404 can be the log replacing it by the full tile, which the static CT API allows',
  first_served:
    'the lowest names tile the log answers 200 for, by binary search between tile 0 (404) and the tail (200), assuming one contiguous range; first and last over the window, and its move in tiles a day',
  entries_per_day: 'the growth of the tree size from the first to the last checkpoint of the window, per 86,400 s of round time',
  tail_age_min: 'the median over the rounds of the minutes from the round start to the Timestamp of the last entry of the last full tile',
  reliable: 'a log in state usable in every round of the window, whose checkpoint and last full names tile answered 200 in every round of the window, and that never answered 429',
  geomys:
    'every answer of a Geomys log in the rounds: the checkpoint, tile 0 and the tail must answer 200 and no request may answer 429 (a partial tile may answer 404, see partial); and every Geomys window read must see no 429',
  geomys_window: 'Tuscolo2027h1 from 2026-10-26T12:00:00Z to 12:05:00Z, read by tiles-window.mjs; gz_bytes counts declared lengths only, gzip_local_bytes is the tiles gzipped here at level 6',
  overlap:
    'for a 5-minute window inside the Kafka retention, picked at run time: each set is the distinct names (lower case, without a leading `*.`) of a log family (every usable shard of Sycamore, Willow, Tuscolo, Gouda), their union, the Kafka window of certstream_domains, and THC dump of the window day; a cell is the percentage of the row set that is in the column set, hashed by ct-window.mjs hashName',
  rates:
    'ct-rates.mjs: entries a day of every log not rejected or retired, from two tree sizes 10 minutes apart, once per run; a run total sums the logs measured, so it is a lower bound when a log was not',
  verdict:
    'PASS when at least 44 of the 48 slots are present, Geomys answered as `geomys` says, the reliable list is not empty, a whole Geomys window was read with no 429, and at least one overlap window holds all four families, an uncut Kafka window and THC day',
});

class InputError extends Error {}

const iso = (ms) => new Date(ms).toISOString();

// One probe as a round line keeps it. A 404 keeps the headers of HEADERS_404
// only, and keeps them and its body only when they differ from the last 404 of
// the same log and probe in this job (`seen`); a repeat says `repeat: true`.
// `tries` and `throttled` are kept only when they are not 1 and 0.
function compact(o, key, seen) {
  if (!o || o.skipped || o.same_as) return o;
  const out = { ...o };
  if (out.tries === 1) delete out.tries;
  if (out.throttled === 0) delete out.throttled;
  if (out.status !== 404 || !out.headers) return out;
  const headers = {};
  for (const k of HEADERS_404) if (out.headers[k] !== undefined) headers[k] = out.headers[k];
  const fp = JSON.stringify([headers, out.body]);
  if (seen.get(key) === fp) {
    delete out.headers;
    delete out.body;
    out.repeat = true;
  } else {
    out.headers = headers;
    seen.set(key, fp);
  }
  return out;
}

function compactLog(rec, seen) {
  const out = { ...rec };
  delete out.mon;
  for (const k of KINDS) if (out[k]) out[k] = compact(out[k], `${rec.name}/${k}`, seen);
  return out;
}

// One round. `state.rows` is the last list read, used when this round's read
// fails; `state.hints` the first served tile of each log; `state.seen` the
// last 404 of each log and probe (compact).
export async function roundOnce(state, { fetchFn = globalThis.fetch, clock = Date.now, deadlineMs = ROUND_DEADLINE_MS, states = DEFAULT_STATES } = {}) {
  const started = clock();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const client = createClient({ fetchFn, clock, signal: deadline.signal });
  const line = { started: iso(started) };
  try {
    try {
      const l = await fetchLogList(client);
      const rows = logRows(l.list);
      state.rows = rows;
      const tiled = rows.filter((r) => r.kind === 'tiled');
      const byState = {};
      for (const r of tiled) byState[r.state] = (byState[r.state] ?? 0) + 1;
      line.list = { status: l.obs.status, ms: l.obs.ms, bytes: l.obs.bytes, sha256: l.sha256, timestamp: l.timestamp, version: l.version, tiled: tiled.length, states: byState };
    } catch (e) {
      line.list = { error: errorText(e), rows_from: state.rows ? 'the round before' : null };
    }
    const logs = state.rows ? pickLogs(state.rows, { states }) : [];
    const recs = await Promise.all(logs.map((log) => probeLog(client, log, { hint: state.hints.get(log.name) ?? null })));
    for (const r of recs) if (Number.isSafeInteger(r.first_served?.tile) && r.first_served.tile > 0) state.hints.set(r.name, r.first_served.tile);
    line.logs = recs.map((r) => compactLog(r, state.seen));
  } finally {
    clearTimeout(timer);
  }
  line.ended = iso(clock());
  line.deadline_hit = deadline.signal.aborted;
  line.requests = client.counts.requests;
  line.failed = client.counts.failed;
  line.throttled = client.counts.throttled;
  return line;
}

const sleepFor = (ms) => delay(ms);

// The rounds of one job: slot i at start + i * interval, while the slot is
// before start + forMin and before until. Resolves to { ran, skipped, silent,
// stopped_by }.
export async function runRounds({
  out,
  start,
  forMs,
  intervalMs,
  until = null,
  once = false,
  fetchFn = globalThis.fetch,
  clock = Date.now,
  sleep = sleepFor,
  env = process.env,
  log = console.log,
  deadlineMs = ROUND_DEADLINE_MS,
}) {
  mkdirSync(dirname(out), { recursive: true });
  const write = (o) => appendFileSync(out, `${JSON.stringify(o)}\n`);
  const ids = { run_id: env.GITHUB_RUN_ID ?? null, run_attempt: env.GITHUB_RUN_ATTEMPT ?? null };
  write({
    schema: SCHEMA,
    kind: 'start',
    ...ids,
    at: iso(clock()),
    start: iso(start),
    for_min: forMs / MIN,
    interval_min: intervalMs / MIN,
    until: until === null ? null : iso(until),
    once,
    user_agent: USER_AGENT,
    states: DEFAULT_STATES,
    node: process.version,
    runner_os: env.RUNNER_OS ?? process.platform,
  });
  const state = { rows: null, hints: new Map(), seen: new Map() };
  let ran = 0;
  let skipped = 0;
  let silent = 0;
  let stoppedBy = once ? 'once' : 'for-min';
  for (let i = 0; ; i++) {
    const slot = start + i * intervalMs;
    if (once ? i > 0 : slot >= start + forMs) break;
    if (until !== null && Math.max(slot, clock()) >= until) {
      stoppedBy = 'until';
      break;
    }
    const nextSlot = slot + intervalMs;
    if (!once && clock() >= nextSlot && nextSlot < start + forMs && (until === null || nextSlot < until)) {
      skipped += 1;
      continue;
    }
    const wait = slot - clock();
    if (wait > 0) await sleep(wait);
    let r;
    try {
      r = await roundOnce(state, { fetchFn, clock, deadlineMs });
    } catch (e) {
      // probeLog and the list read catch their own failures, so this is a
      // defect of the round; it is recorded as a round with no answer.
      r = { started: iso(clock()), error: errorText(e), logs: [], requests: 0, failed: 0, throttled: 0 };
    }
    write({ schema: SCHEMA, kind: 'round', ...ids, round: i, slot: iso(slot), late_ms: Math.max(0, Date.parse(r.started) - slot), ...r });
    ran += 1;
    const answered = r.requests - r.failed;
    if (answered <= 0) silent += 1;
    log(`round ${i + 1} ${r.started} logs=${r.logs.length} answered ${answered}/${r.requests} throttled=${r.throttled}`);
  }
  write({ schema: SCHEMA, kind: 'end', ...ids, at: iso(clock()), ran, skipped, silent, stopped_by: stoppedBy });
  return { ran, skipped, silent, stopped_by: stoppedBy };
}

// --- reading the artifacts ---------------------------------------------------

function readJsonl(file) {
  const out = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      throw new InputError(`${file}:${i + 1} is not JSON`);
    }
    if (o.schema !== SCHEMA) throw new InputError(`${file}:${i + 1} has the schema ${JSON.stringify(o.schema)}, not ${SCHEMA}`);
    out.push(o);
  }
  return out;
}

function readJson(file, schema) {
  let o;
  try {
    o = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new InputError(`${file} is not JSON`);
  }
  if (o.schema !== schema) throw new InputError(`${file} has the schema ${JSON.stringify(o.schema)}, not ${schema}`);
  return o;
}

// Every rounds.jsonl and overlap file under dir, one directory level down (as
// gh run download lays them out) or in dir itself.
export function loadRuns(dir) {
  const out = { rounds: [], starts: [], ends: [], overlaps: [], windows: [], rates: [], files: 0 };
  if (!existsSync(dir)) return out;
  const dirs = [
    dir,
    ...readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name)),
  ];
  for (const d of dirs.sort()) {
    const at = (f) => join(d, f);
    if (existsSync(at('rounds.jsonl'))) {
      out.files += 1;
      for (const o of readJsonl(at('rounds.jsonl'))) {
        if (o.kind === 'round') out.rounds.push(o);
        else if (o.kind === 'start') out.starts.push(o);
        else if (o.kind === 'end') out.ends.push(o);
        else throw new InputError(`${at('rounds.jsonl')}: a line of kind ${JSON.stringify(o.kind)}`);
      }
    }
    if (existsSync(at('overlap.json'))) out.overlaps.push({ dir: basename(d), ...readJson(at('overlap.json'), OVERLAP_SCHEMA) });
    if (existsSync(at('geomys-window.json'))) out.windows.push({ dir: basename(d), ...readJson(at('geomys-window.json'), WINDOW_SCHEMA) });
    if (existsSync(at('rates.json'))) out.rates.push({ dir: basename(d), ...readJson(at('rates.json'), RATES_SCHEMA) });
  }
  return out;
}

// --- the analysis --------------------------------------------------------------

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

// The answer of one probe as a tally key.
function answerOf(p) {
  if (!p) return 'absent';
  if (p.skipped || p.same_as) return 'skipped';
  if (p.status === null || p.status === undefined) return 'error';
  if (p.status === 200 && p.bad) return 'bad';
  return String(p.status);
}

function tally(xs) {
  const t = {};
  for (const x of xs) t[x] = (t[x] ?? 0) + 1;
  return t;
}

// The rows of every log over the window's rounds.
function logTable(rounds) {
  const byName = new Map();
  for (const r of rounds) {
    for (const rec of r.logs ?? []) {
      let e = byName.get(rec.name);
      if (!e) byName.set(rec.name, (e = { name: rec.name, op: rec.op, recs: [] }));
      e.recs.push({ at: Date.parse(r.started), rec });
    }
  }
  const rows = [];
  for (const e of [...byName.values()].sort((a, b) => (a.op === b.op ? (a.name < b.name ? -1 : 1) : a.op < b.op ? -1 : 1))) {
    const status = {};
    for (const k of KINDS) status[k] = tally(e.recs.map((x) => answerOf(x.rec[k])));
    const sized = e.recs.filter((x) => Number.isSafeInteger(x.rec.size));
    let entriesPerDay = null;
    if (sized.length >= 2 && sized.at(-1).at > sized[0].at) entriesPerDay = Math.round(((sized.at(-1).rec.size - sized[0].rec.size) / (sized.at(-1).at - sized[0].at)) * DAY);
    const fs = e.recs.filter((x) => Number.isSafeInteger(x.rec.first_served?.tile));
    const firstServed = fs.length
      ? {
          first: fs[0].rec.first_served.tile,
          last: fs.at(-1).rec.first_served.tile,
          min: Math.min(...fs.map((x) => x.rec.first_served.tile)),
          max: Math.max(...fs.map((x) => x.rec.first_served.tile)),
          tiles_per_day: fs.length >= 2 && fs.at(-1).at > fs[0].at ? Math.round(((fs.at(-1).rec.first_served.tile - fs[0].rec.first_served.tile) / (fs.at(-1).at - fs[0].at)) * DAY) : null,
        }
      : null;
    const ages = e.recs.filter((x) => x.rec.tail?.status === 200 && typeof x.rec.tail.last_ts === 'number').map((x) => (x.at - x.rec.tail.last_ts) / MIN);
    const statesSeen = [...new Set(e.recs.map((x) => x.rec.state))];
    const throttled = KINDS.reduce((n, k) => n + (status[k]['429'] ?? 0), 0);
    const all200 = (k) => e.recs.every((x) => x.rec[k]?.status === 200 && !x.rec[k].bad);
    const tailOk = e.recs.every((x) => (x.rec.tail?.status === 200 && !x.rec.tail.bad) || x.rec.tail?.same_as === 'tile0');
    rows.push({
      name: e.name,
      op: e.op,
      states: statesSeen,
      rounds: e.recs.length,
      status,
      first_served: firstServed,
      entries_per_day: entriesPerDay,
      tail_age_min: round1(median(ages)),
      throttled,
      reliable_parts: { usable: statesSeen.length === 1 && statesSeen[0] === 'usable', checkpoint: all200('checkpoint'), tail: tailOk, no_429: throttled === 0 },
    });
  }
  return rows;
}

function geomysOf(rounds, windows) {
  const listed = [];
  let non200 = 0;
  let probes = 0;
  let throttled = 0;
  for (const r of rounds) {
    for (const rec of r.logs ?? []) {
      if (rec.op !== 'Geomys') continue;
      for (const k of KINDS) {
        const p = rec[k];
        const a = answerOf(p);
        if (a === 'skipped' || a === 'absent') continue;
        if (a === '429') throttled += 1;
        if (k === 'partial' && (a === '200' || a === '404')) {
          probes += 1;
          continue;
        }
        probes += 1;
        if (a === '200') continue;
        non200 += 1;
        if (listed.length < NON_200_LIST_MAX) listed.push({ log: rec.name, probe: k, answer: a, round: r.started });
      }
    }
  }
  const windowThrottled = windows.reduce((n, w) => n + (w.stat?.throttled ?? 0), 0);
  return { probes, non_200: non200, non_200_listed: listed, throttled, window_reads: windows.length, window_throttled: windowThrottled };
}

function listOf(rounds) {
  const stamps = [];
  let failures = 0;
  const changes = [];
  const lastState = new Map();
  for (const r of rounds) {
    if (!r.list || r.list.error) failures += 1;
    else if (!stamps.some((s) => s.timestamp === r.list.timestamp)) stamps.push({ timestamp: r.list.timestamp, version: r.list.version, first_round: r.started });
    for (const rec of r.logs ?? []) {
      const was = lastState.get(rec.name);
      if (was !== undefined && was !== rec.state) changes.push({ log: rec.name, from: was, to: rec.state, round: r.started });
      lastState.set(rec.name, rec.state);
    }
  }
  return { timestamps: stamps, failures, state_changes: changes };
}

function windowOf(windows) {
  const reads = windows.map((w) => ({ dir: w.dir, at: w.at ?? null, ok: Boolean(w.stat?.complete), error: w.error ?? null, ...(w.stat ? pickWindow(w.stat) : {}) }));
  const whole = reads.filter((r) => r.ok);
  const agree = whole.every((r) => r.entries === whole[0].entries && r.distinct_names === whole[0].distinct_names);
  return { log: GEOMYS_WINDOW.log, from: GEOMYS_WINDOW.from, to: GEOMYS_WINDOW.to, reads, whole: whole.length, reads_agree: agree, first: whole[0] ?? null };
}

function pickWindow(s) {
  const keys = [
    'tiles_read',
    'entries',
    'distinct_names',
    'gz_bytes',
    'gz_unknown_tiles',
    'gzip_local_bytes',
    'raw_bytes',
    'bsearch_probes',
    'first_served_tile',
    'start_tile',
    'throttled',
    'first',
    'last',
  ];
  return Object.fromEntries(keys.map((k) => [k, s[k] ?? null]));
}

// A whole overlap window: every family read whole, a Kafka window not cut,
// and THC's day read.
export const overlapWhole = (o) => !o.skipped && Boolean(o.families) && Object.values(o.families).every((f) => f.complete) && o.kafka?.ok === true && o.thc?.ok === true;

function overlapOf(overlaps) {
  return overlaps
    .map((o) => ({
      dir: o.dir,
      at: o.at ?? null,
      skipped: o.skipped ?? null,
      window: o.window ?? null,
      whole: overlapWhole(o),
      sets: o.sets ?? null,
      matrix: o.matrix ?? null,
      errors: o.errors ?? [],
    }))
    .sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? -1 : 1));
}

function ratesOf(rates) {
  const runs = rates.map((r) => {
    let all = 0;
    let names = 0;
    for (const x of r.res ?? []) {
      if (x.per_day_M) {
        all += x.per_day_M;
        if (x.names_tile === 200) names += x.per_day_M;
      }
    }
    const res = r.res ?? [];
    const measured = res.filter((x) => x.per_day_M !== null && x.per_day_M !== undefined).length;
    return { dir: r.dir, t0: r.t0, gap_s: r.gap_s, logs: res.length, measured, total_M_per_day: +all.toFixed(1), names_tile_logs_M_per_day: +names.toFixed(1) };
  });
  const perLog = new Map();
  for (const r of rates) for (const x of r.res ?? []) if (x.per_day_M !== null && x.per_day_M !== undefined) perLog.set(x.name, [...(perLog.get(x.name) ?? []), x.per_day_M]);
  return { runs, median_per_day_M: Object.fromEntries([...perLog].map(([k, v]) => [k, median(v)])) };
}

// The verdict from the parts of a result; checkResult recomputes it with this.
export function verdictOf(r) {
  const reasons = [];
  if (r.rounds.present < MIN_SLOTS) reasons.push(`${r.rounds.present} of ${SLOTS} slots hold a round, fewer than ${MIN_SLOTS}`);
  if (r.geomys.probes === 0) reasons.push('no Geomys answer was recorded');
  if (r.geomys.non_200 > 0) reasons.push(`${r.geomys.non_200} Geomys answers were not 200`);
  if (r.geomys.throttled > 0 || r.geomys.window_throttled > 0) reasons.push(`Geomys answered 429 ${r.geomys.throttled + r.geomys.window_throttled} times`);
  if (r.reliable.length === 0) reasons.push('no log is reliable');
  if (r.geomys_window.whole === 0) reasons.push('no whole read of the Geomys window');
  else if (!r.geomys_window.reads_agree) reasons.push('the whole reads of the Geomys window disagree');
  if (!r.overlap.some((o) => o.whole)) reasons.push('no whole overlap window');
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}

export function analyse(loaded, { now = Date.now() } = {}) {
  const seen = new Set();
  const all = loaded.rounds
    .filter((r) => {
      const k = `${r.run_id}/${r.run_attempt}/${r.round}/${r.started}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
  if (all.length === 0) throw new InputError('no rounds');
  const from = Date.parse(all[0].started);
  const to = from + DAY;
  const rounds = all.filter((r) => Date.parse(r.started) < to);
  const slots = new Set(rounds.map((r) => Math.floor((Date.parse(r.started) - from) / (SLOT_MIN * MIN))));
  const gaps = [];
  let largest = { min: 0, from: null, to: null };
  for (let i = 1; i < rounds.length; i++) {
    const a = Date.parse(rounds[i - 1].started);
    const b = Date.parse(rounds[i].started);
    const g = (b - a) / MIN;
    const seam = rounds[i - 1].run_id !== rounds[i].run_id;
    if (g > largest.min) largest = { min: round1(g), from: rounds[i - 1].started, to: rounds[i].started };
    if (g > GAP_LIST_MIN || seam) gaps.push({ from: rounds[i - 1].started, to: rounds[i].started, min: round1(g), seam });
  }
  const complete = loaded.ends.some((e) => e.stopped_by === 'until') || now >= to + COMPLETE_AFTER_MS;
  const logs = logTable(rounds);
  // A round with no list and no list before it probed no log; it does not
  // count against a log.
  const probing = rounds.filter((r) => (r.logs?.length ?? 0) > 0).length;
  const reliable = logs.filter((l) => l.rounds === probing && Object.values(l.reliable_parts).every(Boolean)).map((l) => l.name);
  const result = {
    schema: RESULT_SCHEMA,
    computed: iso(now),
    definitions: DEFINITIONS,
    window: { from: iso(from), to: iso(to), complete },
    rounds: { expected: SLOTS, present: slots.size, in_window: rounds.length, total: all.length, runs: new Set(rounds.map((r) => r.run_id)).size, largest_gap: largest, gaps },
    list: listOf(rounds),
    logs,
    reliable,
    geomys: geomysOf(rounds, loaded.windows),
    geomys_window: windowOf(loaded.windows),
    overlap: overlapOf(loaded.overlaps),
    rates: ratesOf(loaded.rates),
  };
  return { ...result, ...verdictOf(result) };
}

// A result read back: its verdict must follow from its own rows.
export function checkResult(r) {
  if (r?.schema !== RESULT_SCHEMA) throw new InputError(`the result has the schema ${JSON.stringify(r?.schema)}, not ${RESULT_SCHEMA}`);
  for (const k of ['rounds', 'geomys', 'reliable', 'geomys_window', 'overlap']) if (r[k] === undefined) throw new InputError(`the result has no ${k}`);
  const v = verdictOf(r);
  if (v.verdict !== r.verdict) throw new InputError(`the result says ${r.verdict}, its rows say ${v.verdict}`);
  return r;
}

// --- the table -------------------------------------------------------------------

const cellOf = (t) =>
  Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}x${n}`)
    .join(' ');

export function formatTable(r) {
  const lines = [];
  lines.push(`DOM-011 names tiles, ${r.window.from} to ${r.window.to}${r.window.complete ? '' : ' (not complete)'}`);
  const lg = r.rounds.largest_gap;
  lines.push(
    `rounds: ${r.rounds.present} of ${r.rounds.expected} slots, ${r.rounds.in_window} rounds in ${r.rounds.runs} runs; largest gap ${lg.min} min${lg.from ? ` (${lg.from} to ${lg.to})` : ''}`,
  );
  for (const g of r.rounds.gaps) lines.push(`  ${g.seam ? 'seam' : 'gap '} ${g.from} to ${g.to}: ${g.min} min`);
  lines.push(`log list: ${r.list.timestamps.map((s) => `${s.timestamp} (v${s.version}, from ${s.first_round})`).join(', ') || '-'}; ${r.list.failures} failed reads`);
  for (const c of r.list.state_changes) lines.push(`  ${c.log}: ${c.from} to ${c.to} at ${c.round}`);
  lines.push('', 'log                  operator         rounds  checkpoint     tile0          tail           partial        first served         entries/day  tail age');
  for (const l of r.logs) {
    const fs = l.first_served ? (l.first_served.first === l.first_served.last ? String(l.first_served.first) : `${l.first_served.first}..${l.first_served.last}`) : '-';
    lines.push(
      [
        l.name.padEnd(20),
        l.op.slice(0, 16).padEnd(16),
        String(l.rounds).padStart(6),
        ...KINDS.map((k) => cellOf(l.status[k]).padEnd(14)),
        fs.padEnd(20),
        String(l.entries_per_day ?? '-').padStart(11),
        l.tail_age_min === null ? '-' : `${l.tail_age_min} min`,
      ].join(' '),
    );
  }
  lines.push('', `reliable (${r.reliable.length}): ${r.reliable.join(', ') || '-'}`);
  const g = r.geomys;
  lines.push(`Geomys: ${g.probes} answers in the rounds, ${g.non_200} not 200, ${g.throttled} 429; ${g.window_reads} window reads, ${g.window_throttled} 429`);
  for (const x of g.non_200_listed) lines.push(`  ${x.log} ${x.probe} ${x.answer} at ${x.round}`);
  const w = r.geomys_window;
  if (w.first) {
    const f = w.first;
    lines.push(
      `Geomys window ${w.log} ${w.from} to ${w.to}: ${f.tiles_read} tiles, ${f.entries} entries, ${f.distinct_names} names, ${f.gz_bytes ?? '-'} B gzip declared (${f.gz_unknown_tiles ?? '-'} tiles without a length; ${f.gzip_local_bytes ?? '-'} B gzipped here), ${f.bsearch_probes ?? '-'} search probes, ${f.throttled} 429; ${w.whole} whole reads${w.reads_agree ? '' : ', which disagree'}`,
    );
  } else lines.push(`Geomys window ${w.log} ${w.from} to ${w.to}: no whole read (${w.reads.length} reads)`);
  for (const o of r.overlap) {
    if (o.skipped) {
      lines.push(`overlap (${o.dir}): skipped, ${o.skipped}`);
      continue;
    }
    lines.push(
      `overlap ${o.window?.from} to ${o.window?.to} (THC day ${o.window?.day}, ${o.dir})${o.whole ? '' : ' not whole'}: ${Object.entries(o.sets ?? {})
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}`,
    );
    for (const e of o.errors) lines.push(`  error: ${e}`);
    if (o.matrix) {
      lines.push(`  % of row in column  ${o.matrix.cols.map((c) => c.padStart(9)).join('')}`);
      for (let i = 0; i < o.matrix.rows.length; i++) lines.push(`  ${o.matrix.rows[i].padEnd(19)}${o.matrix.cells[i].map((c) => String(c ?? '-').padStart(9)).join('')}`);
    }
  }
  for (const x of r.rates.runs)
    lines.push(
      `rates ${x.t0} over ${x.gap_s} s: ${x.total_M_per_day} M entries a day over the ${x.measured} measured logs of ${x.logs}, ${x.names_tile_logs_M_per_day} M in those whose tile 0 answers`,
    );
  lines.push('', r.verdict === 'PASS' ? 'PASS' : `FAIL: ${r.reasons.join('; ')}`);
  return lines;
}

// --- the download --------------------------------------------------------------

const runSync = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, windowsHide: true });

export const ARTIFACT_KINDS = Object.freeze([
  { prefix: 'tiles-rounds', file: 'rounds.jsonl' },
  { prefix: 'tiles-overlap', file: null },
]);

// The artifacts of every completed run of the workflow on main, one per job
// and attempt, each into dir/<name>/. A name is fetched when it is
// <prefix>-<run id>-<attempt> of the run it is listed under. A listed run that
// is not a workflow_dispatch on main is refused, as clock-gaps.mjs refuses
// one: the evidence is main's code alone.
export function download(repo, dir, run = runSync, log = console.log) {
  const fail = (what, r) =>
    new InputError(
      `${what} failed: ${String(r.error?.message ?? r.stderr)
        .trim()
        .slice(0, 200)}`,
    );
  const list = run('gh', [
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    WORKFLOW,
    '--branch',
    'main',
    '--limit',
    String(LISTING_LIMIT),
    '--json',
    'databaseId,status,conclusion,createdAt,headBranch,event',
  ]);
  if (list.error || list.status !== 0) throw fail('gh run list', list);
  let runs;
  try {
    runs = JSON.parse(list.stdout);
  } catch {
    throw new InputError('gh run list printed no JSON');
  }
  if (!Array.isArray(runs)) throw new InputError('gh run list printed no array');
  const other = runs.find((r) => r?.headBranch !== 'main' || r?.event !== 'workflow_dispatch');
  if (other)
    throw new InputError(`gh run list gave run ${JSON.stringify(other?.databaseId)} of event ${JSON.stringify(other?.event)} on ${JSON.stringify(other?.headBranch)}, not workflow_dispatch on main`);
  if (runs.length >= LISTING_LIMIT) log(`download: the listing holds ${runs.length} runs, its limit; older runs are not listed`);
  const out = { listed: runs.length, fetched: [], present: [], missing: [], running: runs.filter((r) => r.status !== 'completed').length };
  for (const r of runs.filter((x) => x.status === 'completed')) {
    const id = r.databaseId;
    if (!Number.isSafeInteger(id) || id <= 0) throw new InputError(`gh run list gave the run id ${JSON.stringify(id)}`);
    const arts = run('gh', ['api', `repos/${repo}/actions/runs/${id}/artifacts`, '--paginate', '--jq', '.artifacts[].name']);
    if (arts.error || arts.status !== 0) throw fail(`listing the artifacts of run ${id}`, arts);
    const own = new RegExp(`^(${ARTIFACT_KINDS.map((k) => k.prefix).join('|')})-${id}-[1-9][0-9]*$`);
    const names = [
      ...new Set(
        String(arts.stdout)
          .split(/\r?\n/)
          .filter((n) => own.test(n)),
      ),
    ].sort();
    let got = 0;
    for (const name of names) {
      const target = join(dir, name);
      if (existsSync(target) && readdirSync(target).length > 0) {
        out.present.push(name);
        got += 1;
        continue;
      }
      const d = run('gh', ['run', 'download', String(id), '--repo', repo, '--name', name, '--dir', target]);
      if (!d.error && d.status === 0 && existsSync(target) && readdirSync(target).length > 0) {
        out.fetched.push(name);
        got += 1;
      }
    }
    if (got === 0) out.missing.push({ id, conclusion: r.conclusion ?? null });
  }
  log(
    `download: ${out.listed} runs listed, ${out.fetched.length} artifacts fetched, ${out.present.length} already here, ${out.missing.length} runs without artifacts${out.missing.length ? ` (${out.missing.map((m) => `${m.id} ${m.conclusion}`).join(', ')})` : ''}, ${out.running} not completed`,
  );
  return out;
}

function writeAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

// --- the command line ----------------------------------------------------------

const USAGE = [
  'usage: node scripts/measure/tiles-availability.mjs --once --out FILE',
  '       node scripts/measure/tiles-availability.mjs --out FILE [--start ISO] [--for-min 340] [--interval-min 30] [--until ISO]',
  '       node scripts/measure/tiles-availability.mjs --verdict FILE [--download] [--runs DIR] [--repo OWNER/NAME]',
].join('\n');

function verdictMain(args, deps) {
  const log = deps.log ?? console.log;
  const err = deps.err ?? console.error;
  const repo = typeof args.repo === 'string' ? args.repo : DEFAULT_REPO;
  const runsDir = typeof args.runs === 'string' ? resolve(args.runs) : join(ROOT, DEFAULT_RUNS);
  if (typeof args.verdict !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || args.runs === true) {
    err(USAGE);
    return 2;
  }
  const verdictFile = resolve(args.verdict);
  try {
    if (args.download === true) download(repo, runsDir, deps.run ?? runSync, log);
    const loaded = loadRuns(runsDir);
    let result;
    if (loaded.rounds.length > 0) {
      result = analyse(loaded, { now: deps.now ?? Date.now() });
      if (!result.window.complete) {
        for (const l of formatTable(result)) log(l);
        log(`the 24 hours end ${result.window.to} and are not complete: the chain has not ended; nothing is written`);
        return 1;
      }
      writeAtomic(verdictFile, result);
    } else if (existsSync(verdictFile)) {
      result = checkResult(JSON.parse(readFileSync(verdictFile, 'utf8')));
      log(`no rounds under ${runsDir}: judging ${verdictFile}`);
    } else {
      err(`tiles-availability: no rounds under ${runsDir} and no result to judge; run with --download first`);
      return 2;
    }
    for (const l of formatTable(result)) log(l);
    return result.verdict === 'PASS' ? 0 : 1;
  } catch (e) {
    if (e instanceof InputError || e instanceof SyntaxError) {
      err(`tiles-availability: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

// `deps` replaces the network, `gh`, the clock or the log in a test; the
// command line passes none.
export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  if (args.verdict !== undefined) return verdictMain(args, deps);
  const err = deps.err ?? console.error;
  const once = args.once === true;
  const forMin = args['for-min'] === undefined ? 340 : Number(args['for-min']);
  const intervalMin = args['interval-min'] === undefined ? 30 : Number(args['interval-min']);
  const clock = deps.clock ?? Date.now;
  const start = typeof args.start === 'string' ? Date.parse(args.start) : clock();
  const until = typeof args.until === 'string' && INSTANT.test(args.until) ? Date.parse(args.until) : args.until === undefined ? null : Number.NaN;
  if (typeof args.out !== 'string' || !(forMin > 0) || !(intervalMin > 0) || Number.isNaN(start) || Number.isNaN(until)) {
    err(USAGE);
    return 2;
  }
  const out = resolve(args.out);
  let r;
  try {
    r = await runRounds({ out, start, forMs: forMin * MIN, intervalMs: intervalMin * MIN, until, once, ...deps, clock });
  } catch (e) {
    err(`tiles-availability: cannot write ${out}: ${errorText(e)}`);
    return 2;
  }
  (deps.log ?? console.log)(`tiles-availability: ran=${r.ran} skipped=${r.skipped} silent=${r.silent} stopped_by=${r.stopped_by} out=${out}`);
  return r.silent > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
