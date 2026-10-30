// scripts/ingest/run.mjs — run one adapter once (DOM-024, TODO/ingest.md;
// docs/architecture.md sections 3.4, 5.4, 5.6 and 5.8). It reads the
// adapter's cursor, runs its module with the disk writer
// (scripts/ingest/writer.mjs), verifies every segment it wrote, pushes the raw
// lane objects and then the segments, and writes the cursor proposal of the
// run. It never writes `state`: only scripts/state/advance.mjs and move.mjs,
// in the group root-writer, move a cursor.
//
// In this order:
//   1. adapters/<ID>/source.json (validateSourceFile) and each of its sources'
//      registry row (--sources), whose adapter must be ID and whose fields must
//      be the source.json's; with --lane, ID must be in that lane of --lanes.
//      A push needs REGISTRY_TOKEN and GITHUB_ACTOR: their absence is exit 2
//      before the adapter runs;
//   2. the live state: --state FILE, or state:latest read with no credential,
//      the job's token telling an absent state (the first, cursor none) from a
//      private one (exit 4) (D21 of DOM-024);
//   3. the list the segments are written under: --psl FILE, or `root`, the
//      list root:latest pins (D23 of DOM-024), read with no credential;
//   4. the module adapters/<ID>/src/index.ts (D22 of DOM-024): `run`, or
//      `backfill` for a window (D17 of DOM-024);
//   5. ctx: the recordings of --recordings DIR replayed, or the global fetch
//      (liveFetch); --now or the clock to the second; the contact User-Agent;
//      the disk writer under --out/work/<ID>/;
//   6. run(cursor, ctx), or backfill({ start, end }, ctx): the result held to
//      checkResult and checkSources of @domains/adapter and to the segments
//      the writer wrote; a live run that wrote segments and returned the
//      cursor it started from is `continuation`; a live run's cursor is held
//      to annotationProblem of @domains/ghcr (`cursor`), since it is the next
//      run's annotation cursor.before; a backfill's segments lie in its window;
//   7. every segment verified before any push (D18 of DOM-024):
//      scripts/verify-pack.mjs in process, --json, under the list and the
//      registry, --require dataset,length,count,sha256,psl,sources,precision,
//      and volume with the source's history (the live state's, less the day
//      checked) for a one-day segment of a day source (D5 of DOM-024). ok and
//      quarantine go on; hold, fail or unverified on any segment pushes nothing
//      and writes no proposal, exit 1;
//   8. unless --no-push: each raw lane object, then each segment, with
//      scripts/ghcr/push.mjs in process; a quarantined segment carries
//      dev.pkgforge.domains.quarantine=1 (DOM-024's Decision of 2026-10-29T06:00Z);
//   9. unless --no-push, --out/proposals/proposal.<ID>.json (propose of
//      @domains/state) when a segment was written or the cursor moved; a
//      backfill's before and after are both the live cursor (D17 of DOM-024);
//  10. the adapter's own faults (result.errors), printed, make the exit 1
//      after the proposal: the progress the run returned is real.
// A contract fault of the module or the writer (ContractError, WriteFault,
// PackError) pushes nothing and writes no proposal: exit 1. The run is
// --run, else GITHUB_RUN_ID: a workflow run id, as each manifest names it.
//
// Usage:
//   node scripts/ingest/run.mjs --adapter ID --out DIR [--lane LANE] [--adapters DIR] [--lanes FILE]
//                               [--sources FILE] [--psl FILE|root] [--state FILE] [--recordings DIR]
//                               [--from ISO --to ISO] [--now ISO] [--run ID] [--no-push]
// --psl is required; --lanes is read with --lane alone; a flag is given once.
// --out may hold other adapters' runs: --out/work/<ID>/ is new or empty, and
// --out/proposals/proposal.<ID>.json is written once: one already there is
// exit 2 before the adapter runs.
// Environment: REGISTRY_TOKEN and GITHUB_ACTOR (the job's token, for a push
// and for the token read, D21 of DOM-024), GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
// ORAS, RUNNER_TEMP. REGISTRY_TOKEN leaves process.env before the adapter
// module runs, and the token read's registry config is removed before it: the
// module runs in this process and parses remote input.
// stdout, one line each:
//   cursor ID <canonical cursor JSON | none> (state:latest sha256:... | state:latest none | FILE)
//   psl <64 hex> (root:latest sha256:... | FILE)
//   segment obs:TAG SOURCE DATASET START END records N verdict ok|quarantine|hold|fail|unverified
//   raw obs:TAG SOURCE START END bytes N members N
//   push.mjs's own line for each push: pushed REF DIGEST, present REF DIGEST (WHY), replaced ..., PRIVATE PACKAGE
//   fault SOURCE CODE DETAIL           (one line: a control character is written as an escape)
//   proposal FILE segments N raw N history N cursor moved|kept
//   no proposal: no segment was written and the cursor did not move
//   no push: --no-push; N segment(s) and N raw object(s) verified
// Exit codes: 0 ran (a proposal or none) · 1 a fault (a contract fault, a
// verdict other than ok or quarantine, a push that failed or found another
// manifest under its tag, adapter errors) · 2 could not run (usage, no such
// adapter, a file that does not read, no token for a push, a module with no
// run or no backfill for a window, GHCR unreachable) · 4 PRIVATE PACKAGE (the
// state, the root, the list or a pushed object did not read with no
// credential) · 70 an internal error, a defect of this script (its stack goes
// to stderr).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BandError,
  ContractError,
  canonicalJson,
  checkResult,
  checkSources,
  ID_GRAMMAR,
  JsonError,
  jsonEqual,
  liveFetch,
  MAX_ID,
  replayFetch,
  SourceError,
  validateBits,
  validateSourceFile,
} from '@domains/adapter';
import { readRecordings } from '@domains/adapter/node';
import { CompactError, WORKFLOW_RUN_ID } from '@domains/compact';
import { annotationProblem, GhcrError, LayoutError } from '@domains/ghcr';
import { PackError } from '@domains/pack';
import { cursorOf, encodeProposal, historyOf, LANES, parseState, propose, proposalFile, StateError } from '@domains/state';
import { checkOutDir, freshDir, writeOut } from '../compact/plan.mjs';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { orasRunner } from '../ghcr/push.mjs';
import { RateLimitError, realSleep } from '../ghcr/rate.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { oneLine } from '../lib/line.mjs';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { Fault, runAttempt, tempDir, UsageError } from '../root/lib.mjs';
import { liveState, PrivateState, tokenFrom } from '../state/lib.mjs';
import { BITS, DEFAULT_SOURCES, loadRegistry, UsageError as RegistryUsage } from '../verify-pack.mjs';
import { pushFiles, pushPlanOf, rootPsl, verifyDir } from './pack.mjs';
import { DEFAULT_ADAPTERS, DEFAULT_LANES, isoSecond, nowIso, readLanes, windowOf } from './plan.mjs';
import { diskWriter, RAW_TYPE, WriteFault } from './writer.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, private: 4, internal: 70 });
// The checks every segment's verify names (DOM-024's Found of 2026-10-29T06:00Z),
// and `volume` for a one-day segment of a day source (D5 of DOM-024).
export const REQUIRE = Object.freeze(['dataset', 'length', 'count', 'sha256', 'psl', 'sources', 'precision']);
export const QUARANTINE = 'dev.pkgforge.domains.quarantine';
const PUSHED_VERDICTS = new Set(['ok', 'quarantine']);
const DATASET_ORDER = ['names', 'domains'];
const DAY_MS = 86_400_000;
const USAGE =
  'usage: node scripts/ingest/run.mjs --adapter ID --out DIR --psl FILE|root [--lane LANE] [--adapters DIR] [--lanes FILE] [--sources FILE] [--state FILE] [--recordings DIR] [--from ISO --to ISO] [--now ISO] [--run ID] [--no-push]';
const VALUED = ['adapter', 'out', 'lane', 'adapters', 'lanes', 'sources', 'psl', 'state', 'recordings', 'from', 'to', 'now', 'run'];
const FLAGS = [...VALUED, 'no-push'];

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readJson(path, what) {
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
}

function parse(argv, env, clock) {
  const a = parseArgs(argv);
  if (typeof a['no-push'] === 'string') throw new UsageError(`--no-push takes no value, and it was given ${JSON.stringify(a['no-push'])}`);
  for (const k of Object.keys(a)) if (k !== '_' && !FLAGS.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  for (const k of ['adapter', 'out', 'psl']) if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  if (!ID_GRAMMAR.test(a.adapter) || a.adapter.length > MAX_ID) throw new UsageError(`--adapter ${JSON.stringify(a.adapter)} is not an adapter directory's name`);
  if (a.lane !== undefined && !LANES.includes(a.lane)) throw new UsageError(`--lane ${JSON.stringify(a.lane)} is not one of ${LANES.join(', ')}`);
  if (a.lanes !== undefined && a.lane === undefined) throw new UsageError('--lanes is read for --lane alone: give --lane, or no --lanes');
  checkOutDir(a.out, '--out');
  const now = a.now === undefined ? nowIso(clock()) : isoSecond(a.now, '--now');
  const run = a.run ?? env.GITHUB_RUN_ID;
  if (run === undefined || !WORKFLOW_RUN_ID.test(run)) throw new UsageError(`the run ${JSON.stringify(run ?? null)} is not a workflow run id: give --run or GITHUB_RUN_ID`);
  // D17 of DOM-024: --from and --to are a window of their own; the sources are
  // --adapter's.
  const window = windowOf(a.from, a.to, a.from === undefined && a.to === undefined ? undefined : [a.adapter], now);
  return {
    adapter: a.adapter,
    out: a.out,
    lane: a.lane ?? null,
    adapters: a.adapters ?? DEFAULT_ADAPTERS,
    lanes: a.lanes ?? DEFAULT_LANES,
    sources: a.sources ?? DEFAULT_SOURCES,
    psl: a.psl,
    state: a.state,
    recordings: a.recordings,
    window,
    now,
    run,
    push: a['no-push'] !== true,
  };
}

// The adapter's sources, each with its registry row (step 1).
function sourcesOf(args) {
  const dir = join(args.adapters, args.adapter);
  const path = join(dir, 'source.json');
  if (!existsSync(path)) throw new UsageError(`no adapter ${args.adapter}: ${path} does not exist`);
  let file;
  let registry;
  try {
    file = validateSourceFile(readJson(path, 'the source file'), validateBits(readJson(BITS, 'the bit map')));
    registry = loadRegistry(args.sources);
  } catch (e) {
    if (e instanceof SourceError || e instanceof RegistryUsage) throw new UsageError(`${e.message}`);
    throw e;
  }
  return file.sources.map((s) => {
    const row = registry.find((r) => r.id === s.id);
    if (row === undefined) throw new UsageError(`${args.adapter} holds the source ${s.id}, which is not a row of the registry ${args.sources}`);
    const { adapter, ...fields } = row;
    if (adapter !== args.adapter) throw new UsageError(`the registry ${args.sources} gives ${s.id} to the adapter ${adapter}, not ${args.adapter}`);
    if (!jsonEqual(fields, s)) throw new UsageError(`the registry row of ${s.id} is not ${path}'s: run node scripts/sources/build.mjs`);
    return row;
  });
}

// The list of step 3: { path, sha256, from }.
async function listOf(args, reader, work, d) {
  if (args.psl === 'root') return rootPsl(reader, join(work, 'psl'), d);
  let bytes;
  try {
    bytes = readFileSync(args.psl);
  } catch (e) {
    throw new UsageError(`--psl ${args.psl} does not read: ${e.message}`);
  }
  return { path: args.psl, sha256: sha256Of(bytes), from: args.psl };
}

// The module of step 4.
async function moduleOf(args) {
  const path = join(args.adapters, args.adapter, 'src', 'index.ts');
  if (!existsSync(path)) throw new UsageError(`no adapter module ${path}`);
  let mod;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (e) {
    throw new UsageError(`the adapter module ${path} does not load: ${e.message}`);
  }
  if (typeof mod.run !== 'function') throw new UsageError(`the adapter module ${path} exports no run function`);
  if (args.window !== null && typeof mod.backfill !== 'function')
    throw new UsageError(`the adapter module ${path} exports no backfill function, and --from and --to ask for a backfill (D17 of DOM-024)`);
  return mod;
}

// Steps 6: the module run, its result held to the contract.
async function runModule(args, mod, cursor, ctx, rows, writer) {
  let result;
  try {
    result = args.window !== null ? await mod.backfill({ start: args.window.start, end: args.window.end }, ctx) : await mod.run(cursor === null ? null : JSON.parse(canonicalJson(cursor)), ctx);
  } catch (e) {
    if (e instanceof WriteFault || e instanceof ContractError || e instanceof PackError) throw e;
    throw new ContractError('threw', `${args.adapter}: ${args.window !== null ? 'backfill' : 'run'}() threw: ${e?.message ?? String(e)}`, { cause: e });
  }
  const checked = checkResult(result, args.adapter);
  checkSources(checked.segments, rows, args.adapter);
  // The cursor a live run returns is the next run's cursorBefore, an
  // annotation of each segment it writes: held to the push tool's rule now,
  // so a cursor no later run could write is refused here, never proposed.
  if (args.window === null) {
    const text = canonicalJson(checked.cursor);
    const problem = annotationProblem(text);
    if (problem !== null)
      throw new ContractError(
        'cursor',
        `${args.adapter}: the cursor returned, as canonical JSON, ${problem}; it is the next run's annotation dev.pkgforge.domains.cursor.before, so the adapter keeps its cursor within it`,
      );
  }
  const wrote = writer.segments.map((w) => w.segment);
  if (!jsonEqual(checked.segments, wrote))
    throw new ContractError('reported', `${args.adapter}: the module returned ${checked.segments.length} segments and wrote ${wrote.length}, or not the same ones`);
  if (args.window === null && checked.segments.length > 0 && jsonEqual(checked.cursor, cursor))
    throw new ContractError('continuation', `${args.adapter} wrote segments and returned the cursor it started from`);
  if (args.window !== null)
    for (const s of checked.segments)
      if (Date.parse(s.window.start) < Date.parse(args.window.start) || Date.parse(s.window.end) > Date.parse(args.window.end))
        throw new ContractError('segment', `${args.adapter}: the backfill wrote ${s.source} ${s.window.start} to ${s.window.end}, outside the window ${args.window.start} to ${args.window.end}`);
  return checked;
}

// Step 7: one verdict a segment; the history item of a one-day segment of a day source.
async function verifyAll(args, writer, rows, state, list, work, d) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const verified = [];
  for (const w of writer.segments) {
    const seg = w.segment;
    const row = byId.get(seg.source);
    const oneDay = seg.precision === 'day' && Date.parse(seg.window.end) - Date.parse(seg.window.start) === DAY_MS;
    let history = null;
    let rawBytes = null;
    let value = null;
    const day = seg.window.start.slice(0, 10);
    if (oneDay) {
      history = historyOf(state, seg.source).filter((h) => h.day !== day);
      if (row.band.metric === 'bytes') {
        if (seg.raw === undefined) throw new ContractError('segment', `obs:${w.tag}: the band of ${seg.source} measures the raw file's bytes, and the segment carries no raw bytes`);
        rawBytes = seg.raw.bytes;
        value = rawBytes;
      } else value = seg.count;
    }
    const require = oneDay ? [...REQUIRE, 'volume'] : [...REQUIRE];
    const v = await verifyDir({ blobs: w.blobs, annotations: w.manifest.annotations, require, psl: list.path, sources: args.sources, history, rawBytes, work: join(work, 'verify') }, d);
    for (const l of v.lines) d.err(l);
    if (v.verdict === null) throw new UsageError(`scripts/verify-pack.mjs exited ${v.code} for obs:${w.tag}; nothing was pushed`);
    d.out(`segment obs:${w.tag} ${seg.source} ${seg.dataset} ${seg.window.start} ${seg.window.end} records ${seg.count} verdict ${v.verdict}`);
    if (!PUSHED_VERDICTS.has(v.verdict)) {
      for (const f of v.result.errors) d.err(`run: obs:${w.tag} FAIL ${f.check} ${f.detail}`);
      const skipped = v.result.unverified.filter((c) => require.includes(c));
      if (skipped.length > 0) d.err(`run: obs:${w.tag} required and skipped: ${skipped.join(', ')}`);
    }
    verified.push({ w, verdict: v.verdict, day: oneDay ? { source: seg.source, day, count: value, quarantined: v.verdict === 'quarantine', dataset: seg.dataset } : null });
  }
  return verified;
}

// One history item a (source, day): the names segment's when the day has
// one, else the domains segment's (open item of DOM-024).
function historyItems(verified) {
  const best = new Map();
  for (const v of verified) {
    if (v.day === null) continue;
    const key = `${v.day.source} ${v.day.day}`;
    const was = best.get(key);
    if (was === undefined || DATASET_ORDER.indexOf(v.day.dataset) < DATASET_ORDER.indexOf(was.dataset)) best.set(key, v.day);
  }
  return [...best.values()].map(({ source, day, count, quarantined }) => ({ source, day, count, quarantined }));
}

// Step 8: the raw lane objects, then the segments. Returns { code, digests }.
async function pushAll(writer, verified, d, tmp) {
  const deps = { env: d.env, oras: d.oras, reader: d.reader, sleep: d.sleep, random: d.random, tmp, err: d.err };
  const digests = new Map();
  const one = async (tag, plan) => {
    const r = await pushFiles({ pkg: 'obs', tag, ...plan }, deps);
    d.out(r.line);
    if (r.code === 0) digests.set(tag, r.digest);
    else if (r.code === 3) d.err(`run: obs:${tag} holds another manifest; nothing more of this adapter run is pushed, and no proposal is written`);
    return r.code;
  };
  const codeOf = (c) => (c === 3 ? EXIT.fault : c);
  for (const raw of writer.raws) {
    const c = await one(raw.tag, { artifactType: RAW_TYPE, created: raw.end, annotations: Object.entries(raw.annotations), files: raw.files });
    if (c !== 0) return { code: codeOf(c), digests };
  }
  for (const v of verified) {
    const plan = pushPlanOf(v.w.manifest.json, v.w.blobs);
    const annotations = v.verdict === 'quarantine' ? [...plan.annotations, [QUARANTINE, '1']] : plan.annotations;
    const c = await one(v.w.tag, { ...plan, annotations });
    if (c !== 0) return { code: codeOf(c), digests };
  }
  return { code: EXIT.ok, digests };
}

// An error run does not know is a defect, exit 70: never 1, 2 or 4.
export async function main(argv, deps = {}) {
  try {
    return await runJob(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`run: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

// The environment the run reads, as a copy. With the process's own, the
// job's token leaves process.env: the adapter module runs in this process and
// parses remote input, and it needs no credential. The push and the token read
// take it from the copy.
function envOf(deps) {
  if (deps.env !== undefined) return deps.env;
  const env = { ...process.env };
  delete process.env.REGISTRY_TOKEN;
  return env;
}

async function runJob(argv, deps) {
  const err = deps.err ?? console.error;
  const d = {
    reader: deps.reader ?? anonymousReader(),
    oras: deps.oras ?? orasRunner(),
    env: envOf(deps),
    out: deps.out ?? console.log,
    err,
    sleep: deps.sleep ?? realSleep,
    random: deps.random ?? Math.random,
    now: deps.now ?? (() => Date.now()),
    log: (l) => err(`run: ${l}`),
    verify: deps.verify,
  };
  let temp = null;
  try {
    const args = parse(argv, d.env, d.now);
    const rows = sourcesOf(args);
    if (args.lane !== null && !readLanes(args.lanes, args.adapters)[args.lane].includes(args.adapter)) throw new UsageError(`${args.adapter} is not in the lane ${args.lane} of ${args.lanes}`);
    if (args.push && (!d.env.REGISTRY_TOKEN || !d.env.GITHUB_ACTOR)) throw new UsageError("a push needs REGISTRY_TOKEN (the job's own GITHUB_TOKEN) and GITHUB_ACTOR; give --no-push to verify alone");
    const work = join(args.out, 'work', args.adapter);
    freshDir(work, 'run');
    // The proposal is written once: one already there stops the run before anything is pushed.
    const proposalPath = join(args.out, 'proposals', proposalFile(args.adapter));
    if (args.push && existsSync(proposalPath)) throw new UsageError(`${proposalPath} exists: run writes into a new directory`);
    if (args.recordings !== undefined && (!existsSync(args.recordings) || !statSync(args.recordings).isDirectory())) throw new UsageError(`--recordings ${args.recordings} is not a directory`);
    // The pushes' registry configs live here, and go with it.
    temp = tempDir(deps.tmp ?? d.env.RUNNER_TEMP, 'ingest-run-');

    // 2. The live state.
    let state;
    let from;
    if (args.state !== undefined) {
      let bytes;
      try {
        bytes = readFileSync(args.state);
      } catch (e) {
        throw new UsageError(`--state ${args.state} does not read: ${e.message}`);
      }
      try {
        state = parseState(bytes);
      } catch (e) {
        if (e instanceof StateError) throw new UsageError(`--state ${args.state}: ${e.message}`);
        throw e;
      }
      from = args.state;
    } else {
      // The registry config of a token read is removed before the adapter module runs.
      const readTemp = tempDir(deps.tmp ?? d.env.RUNNER_TEMP, 'ingest-state-');
      let live;
      try {
        live = await liveState(d.reader, tokenFrom(readTemp, d), d);
      } finally {
        rmSync(readTemp, { recursive: true, force: true });
      }
      state = live?.state ?? null;
      from = live === null ? 'state:latest none' : `state:latest ${live.digest}`;
    }
    const cursor = cursorOf(state, args.adapter);
    d.out(`cursor ${args.adapter} ${cursor === null ? 'none' : canonicalJson(cursor)} (${from})`);

    // 3. The list.
    const list = await listOf(args, d.reader, work, d);
    d.out(`psl ${list.sha256} (${list.from})`);

    // 4 to 6. The module, run once.
    const mod = await moduleOf(args);
    const writer = diskWriter({ dir: work, adapter: args.adapter, sources: rows, psl: list.sha256, run: args.run, fetched: args.now });
    const fetch = args.recordings !== undefined ? replayFetch(readRecordings(args.recordings)).fetch : liveFetch;
    const ctx = Object.freeze({ fetch, now: args.now, userAgent: USER_AGENT, writer: Object.freeze({ write: (draft, records, raw) => writer.write(draft, records, raw) }) });
    const result = await runModule(args, mod, cursor, ctx, rows, writer);

    // 7. Every segment verified before any push.
    const verified = await verifyAll(args, writer, rows, state, list, work, d);
    for (const r of writer.raws) d.out(`raw obs:${r.tag} ${r.source} ${r.start} ${r.end} bytes ${r.bytes} members ${r.members}`);
    // An adapter's fault quotes remote text: one line each, whatever it holds.
    for (const f of result.errors) d.out(oneLine(`fault ${f.source} ${f.code} ${f.detail}`));
    const stopped = verified.filter((v) => !PUSHED_VERDICTS.has(v.verdict));
    if (stopped.length > 0) {
      d.err(`run: ${stopped.map((v) => `obs:${v.w.tag} ${v.verdict}`).join(', ')}: nothing of this adapter run is pushed, and no proposal is written (D18 of DOM-024)`);
      return EXIT.fault;
    }
    const faults = result.errors.length > 0 ? EXIT.fault : EXIT.ok;
    if (!args.push) {
      d.out(`no push: --no-push; ${verified.length} segment(s) and ${writer.raws.length} raw object(s) verified`);
      return faults;
    }

    // 8. The pushes.
    const pushed = await pushAll(writer, verified, d, temp);
    if (pushed.code !== EXIT.ok) return pushed.code;

    // 9. The proposal.
    const before = cursor;
    const after = args.window !== null ? cursor : result.cursor;
    const moved = !jsonEqual(before, after);
    if (verified.length === 0 && !moved) {
      d.out('no proposal: no segment was written and the cursor did not move');
      return faults;
    }
    const proposal = propose({
      adapter: args.adapter,
      lane: args.lane,
      run: args.run,
      attempt: runAttempt(d.env),
      at: args.now,
      before,
      after,
      segments: verified.map((v) => ({
        ref: `obs:${v.w.tag}`,
        digest: pushed.digests.get(v.w.tag),
        source: v.w.segment.source,
        dataset: v.w.segment.dataset,
        start: v.w.segment.window.start,
        end: v.w.segment.window.end,
        count: v.w.segment.count,
        quarantined: v.verdict === 'quarantine',
      })),
      raw: writer.raws.map((r) => ({ ref: `obs:${r.tag}`, digest: pushed.digests.get(r.tag), source: r.source, start: r.start, end: r.end })),
      history: historyItems(verified),
    });
    mkdirSync(join(args.out, 'proposals'), { recursive: true });
    const file = proposalPath;
    writeOut(file, encodeProposal(proposal), 'run');
    d.out(`proposal ${file} segments ${proposal.segments.length} raw ${proposal.raw.length} history ${proposal.history.length} cursor ${moved ? 'moved' : 'kept'}`);
    return faults;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`run: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof ContractError || e instanceof WriteFault || e instanceof PackError || e instanceof JsonError || e instanceof BandError || e instanceof CompactError || e instanceof LayoutError) {
      // ContractError and WriteFault messages start `CODE: `; the code is printed once.
      const code = e.check ?? e.code ?? 'contract';
      const text = e.message.startsWith(`${code}: `) ? e.message : `${code} ${e.message}`;
      err(oneLine(`run: FAIL ${text}; nothing of this adapter run is pushed, and no proposal is written`));
      return EXIT.fault;
    }
    if (e instanceof PrivateState || isNotPublic(e)) {
      d.out(PRIVATE_LINE);
      err(`run: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof Fault) {
      err(`run: FAIL ${e.message}`);
      return EXIT.fault;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`run: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  } finally {
    if (temp !== null) rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
