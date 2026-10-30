// scripts/state/move.mjs — move a moving tag of the package state under the
// guard (D2, D6 and D8 of DOM-024): state:latest to the next state, or
// ledger-delta to a delta. moveTag of scripts/state/lib.mjs is the one move:
// the tag read with the job's token and held to the digest the caller read,
// the run object pushed under its write-once run tag, the guard again, `oras
// tag`, and the read back with no credential. Every job that runs this holds
// the concurrency group root-writer (rule 13 of scripts/check-workflows.mjs).
//
//   state --file FILE --expect DIGEST|none
//       FILE is a state.json (parseState). The live state equal to it but for
//       `updated` (sameState) is `unchanged`: nothing is written. A FILE
//       updated before the live state is refused: a state never moves back.
//       Otherwise state:latest moves to the run object state-<updated>, and
//       the first move of a UTC day also tags it state-YYYYMMDD
//       (D6 of DOM-024), never again.
//   ledger-delta --file FILE --expect DIGEST|none --filter ledger-filter-YYYYMMDD
//       FILE is a delta (HashDelta.decode), and --filter the tag of the
//       filter it pairs with (its own as_of). The live delta of the same
//       bytes is `unchanged`; a live delta of a newer filter, or of another
//       filter of FILE's as_of, refuses the move (D8 of DOM-024: a delta never
//       moves back to an older filter). Otherwise ledger-delta moves to the run
//       object ledger-delta-<now>, annotated with the filter it pairs with.
//   ledger-delta --onto FILTER_FILE
//       D8 of DOM-024: the live delta, read in this job, made to pair with the
//       filter FILTER_FILE (the newest a compaction pushed): absent, the
//       filter's empty delta; paired with it already, `present`; paired with an
//       older filter, rebased onto it; paired with a newer one, refused. It
//       moves expected the digest it read.
//
// Usage:
//   node scripts/state/move.mjs state --file FILE --expect DIGEST|none
//   node scripts/state/move.mjs ledger-delta --file FILE --expect DIGEST|none --filter ledger-filter-YYYYMMDD
//   node scripts/state/move.mjs ledger-delta --onto FILTER_FILE
// Environment: REGISTRY_TOKEN and GITHUB_ACTOR (the job's GITHUB_TOKEN, to
// oras on stdin only), GITHUB_RUN_ID (the run annotation, default local),
// ORAS, RUNNER_TEMP.
// stdout:
//   live state:TAG sha256:... | live state:TAG none
//   unchanged state:TAG sha256:...|none
//   pushed REF DIGEST                  (scripts/ghcr/push.mjs's own line)
//   moved state:TAG OLD|none -> NEW, read back with no credential
//   snapshot state:state-YYYYMMDD sha256:... | snapshot state:state-YYYYMMDD present
//   present state:ledger-delta sha256:...: it pairs with state:ledger-filter-YYYYMMDD already
//   rebased state:ledger-delta N to M hash(es) onto state:ledger-filter-YYYYMMDD
//   started state:ledger-delta empty, paired with state:ledger-filter-YYYYMMDD
//   refused state:TAG holds X, and this run read Y: another writer moved it. The live one is kept
// Exit codes: 0 moved, unchanged or present · 1 refused (the guard, a newer
// filter, a state older than the live one) or a fault (a push or tag that failed, a read-back that differs, a
// run tag that holds another manifest) · 2 could not run (usage, no token, a
// file that does not read or validate) · 4 PRIVATE PACKAGE · 70 an internal
// error, a defect of this script (its stack goes to stderr).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DELTA_TITLE } from '@domains/compact';
import { GhcrError, LayoutError, LEDGER_DELTA_TAG, LATEST, stateRunTag, stateTag } from '@domains/ghcr';
import { BloomFilter, HashDelta, LedgerError } from '@domains/ledger';
import { encodeState, parseState, RUN_ID, sameState, STATE_MEDIA_TYPE, STATE_TITLE, StateError } from '@domains/state';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { orasRunner } from '../ghcr/push.mjs';
import { RateLimitError, realSleep } from '../ghcr/rate.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { Fault, fetchTag, login, tagAs, tempDir, UsageError } from '../root/lib.mjs';
import { FILTER_TAG, filterTagOf, guarded, ledgerOnto, moveDelta, moveStamp, moveTag, PrivateState, Refused, readLedgerObject, readStateAt, STATE_PKG, STATE_REF, STATE_TYPE } from './lib.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, private: 4, internal: 70 });
const USAGE =
  'usage: node scripts/state/move.mjs state --file FILE --expect DIGEST|none | ledger-delta --file FILE --expect DIGEST|none --filter ledger-filter-YYYYMMDD | ledger-delta --onto FILTER_FILE';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readFile(path, what) {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (e) {
    throw new UsageError(`${what} ${path} does not read: ${e.message}`);
  }
}

function parse(argv, env) {
  const a = parseArgs(argv);
  const what = a._[0];
  if (what !== 'state' && what !== LEDGER_DELTA_TAG) throw new UsageError(`name the tag to move, state or ${LEDGER_DELTA_TAG}${what === undefined ? '' : `, not ${JSON.stringify(what)}`}`);
  if (a._.length > 1) throw new UsageError(`${JSON.stringify(a._[1])} is not a flag`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  const onto = what === LEDGER_DELTA_TAG && a.onto !== undefined;
  const allowed = what === 'state' ? ['file', 'expect'] : onto ? ['onto'] : ['file', 'expect', 'filter'];
  for (const k of Object.keys(a)) if (k !== '_' && !allowed.includes(k)) throw new UsageError(`${what}${onto ? ' --onto' : ''} takes no flag --${k}`);
  for (const k of allowed) {
    if (a[k] === true) throw new UsageError(`--${k} needs a value`);
    if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  }
  if (a.expect !== undefined && a.expect !== 'none' && !DIGEST.test(a.expect)) throw new UsageError(`--expect ${JSON.stringify(a.expect)} is neither sha256:<64 hex> nor none`);
  if (a.filter !== undefined && !FILTER_TAG.test(a.filter)) throw new UsageError(`--filter ${JSON.stringify(a.filter)} is not ledger-filter-YYYYMMDD`);
  const run = env.GITHUB_RUN_ID ?? 'local';
  if (!RUN_ID.test(run)) throw new UsageError(`GITHUB_RUN_ID ${JSON.stringify(run)} is not a workflow run id`);
  return { what, onto: a.onto, file: a.file, expect: a.expect === undefined || a.expect === 'none' ? null : a.expect, filter: a.filter, run };
}

// state --file: the state moved, unchanged when the live one is the same.
async function moveState(args, ctx) {
  const { deps } = ctx;
  let state;
  try {
    state = parseState(readFile(args.file, '--file'));
  } catch (e) {
    if (e instanceof StateError) throw new UsageError(`--file ${args.file}: ${e.message}`);
    throw e;
  }
  const c = { deps, work: ctx.work, config: await login(ctx.work, deps) };
  const found = await guarded(c, LATEST, args.expect);
  deps.out(`live ${STATE_PKG}:${LATEST} ${found ?? 'none'}`);
  const live = found === null ? null : (await readStateAt(ctx.reader, found, deps)).state;
  if (sameState(live, state)) {
    deps.out(`unchanged ${STATE_PKG}:${LATEST} ${found ?? 'none'}`);
    return EXIT.ok;
  }
  // The guard holds the digest; this holds the time: a state older than the live one would move its cursors back.
  if (live !== null && state.updated < live.updated)
    throw new Refused(`refused ${STATE_PKG}:${LATEST} ${found} is the state of ${live.updated}, and ${args.file} is of ${state.updated}: a state never moves back. The live one is kept`);
  // The pushed layer is titled state.json: the file's canonical bytes, whatever FILE is named.
  const bytes = encodeState(state);
  const path = join(ctx.work, STATE_TITLE);
  writeFileSync(path, bytes);
  const runTag = stateRunTag(state.updated);
  const moved = await moveTag(ctx, {
    tag: LATEST,
    expected: args.expect,
    runTag,
    files: [{ path, mediaType: STATE_MEDIA_TYPE }],
    artifactType: STATE_TYPE,
    created: state.updated,
    annotations: [
      ['dev.pkgforge.domains.sha256', sha(bytes)],
      ['dev.pkgforge.domains.run', args.run],
    ],
  });
  for (const l of moved.lines) deps.out(l);
  // D6 of DOM-024: the snapshot of the day of `updated`, tagged at the day's
  // first move.
  const snapshot = stateTag(state.updated.slice(0, 10));
  const held = await fetchTag(c, snapshot, STATE_REF);
  if (held === null) {
    await tagAs(c, { ref: STATE_REF, from: runTag, digest: moved.digest, tag: snapshot, expected: null });
    deps.out(`snapshot ${STATE_PKG}:${snapshot} ${moved.digest}`);
  } else deps.out(`snapshot ${STATE_PKG}:${snapshot} present`);
  return EXIT.ok;
}

// ledger-delta --file: the delta moved, unchanged when the live one holds the same bytes.
async function moveDeltaFile(args, ctx) {
  const { deps } = ctx;
  const bytes = readFile(args.file, '--file');
  let delta;
  try {
    delta = HashDelta.decode(bytes);
  } catch (e) {
    if (e instanceof LedgerError) throw new UsageError(`--file ${args.file} is not a delta: ${e.message}`);
    throw e;
  }
  // The annotation names the filter the delta pairs with: its own as_of's.
  let own;
  try {
    own = filterTagOf({ asOf: delta.filterAsOf });
  } catch (e) {
    if (e instanceof Fault || e instanceof LayoutError) throw new UsageError(`--file ${args.file}: ${e.message}`);
    throw e;
  }
  if (args.filter !== own) throw new UsageError(`--filter ${args.filter} is not the filter --file ${args.file} pairs with, which is ${own}`);
  const c = { deps, work: ctx.work, config: await login(ctx.work, deps) };
  const found = await guarded(c, LEDGER_DELTA_TAG, args.expect);
  deps.out(`live ${STATE_PKG}:${LEDGER_DELTA_TAG} ${found ?? 'none'}`);
  if (found !== null) {
    const live = await readLedgerObject(ctx.reader, found, DELTA_TITLE, ctx.work, deps);
    if (live !== null && sha(live.bytes) === sha(bytes)) {
      deps.out(`unchanged ${STATE_PKG}:${LEDGER_DELTA_TAG} ${found}`);
      return EXIT.ok;
    }
    // D8 of DOM-024, as ledgerOnto holds it: never back to an older filter, nor to another filter of the live one's as_of.
    const was = live === null ? null : HashDelta.decode(live.bytes);
    if (was !== null && (was.filterAsOf > delta.filterAsOf || (was.filterAsOf === delta.filterAsOf && was.filterCrc !== delta.filterCrc)))
      throw new Refused(
        `refused ${STATE_PKG}:${LEDGER_DELTA_TAG} ${found} pairs with the filter of as_of ${was.filterAsOf}, and ${args.file} with the filter of as_of ${delta.filterAsOf}: a delta never moves back to an older filter, nor to another filter of its own as_of`,
      );
  }
  const dir = mkdtempSync(join(ctx.work, 'delta-'));
  const path = join(dir, DELTA_TITLE);
  writeFileSync(path, bytes);
  const moved = await moveDelta(ctx, { path, bytes, expected: args.expect, filterTag: args.filter, stamp: moveStamp(deps.now()), run: args.run });
  for (const l of moved.lines) deps.out(l);
  return EXIT.ok;
}

// ledger-delta --onto: D8 of DOM-024.
async function moveOnto(args, ctx) {
  const { deps } = ctx;
  let filter;
  try {
    filter = BloomFilter.decode(readFile(args.onto, '--onto'));
  } catch (e) {
    if (e instanceof LedgerError) throw new UsageError(`--onto ${args.onto} is not a filter: ${e.message}`);
    throw e;
  }
  let filterTag;
  try {
    filterTag = filterTagOf(filter);
  } catch (e) {
    if (e instanceof Fault || e instanceof LayoutError) throw new UsageError(`--onto ${args.onto}: ${e.message}`);
    throw e;
  }
  const live = await readLedgerObject(ctx.reader, LEDGER_DELTA_TAG, DELTA_TITLE, mkdtempSync(join(ctx.work, 'live-')), deps);
  deps.out(`live ${STATE_PKG}:${LEDGER_DELTA_TAG} ${live?.digest ?? 'none'}`);
  const r = await ledgerOnto(ctx, { filter, filterTag, live, dir: mkdtempSync(join(ctx.work, 'onto-')), stamp: moveStamp(deps.now()), run: args.run });
  for (const l of r.lines) deps.out(l);
  return EXIT.ok;
}

// An error move does not know is a defect, exit 70: never 1, 2 or 4.
export async function main(argv, deps = {}) {
  try {
    return await moveJob(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`move: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function moveJob(argv, deps) {
  const err = deps.err ?? console.error;
  const d = {
    oras: deps.oras ?? orasRunner(),
    env: deps.env ?? process.env,
    out: deps.out ?? console.log,
    err,
    sleep: deps.sleep ?? realSleep,
    random: deps.random ?? Math.random,
    now: deps.now ?? (() => Date.now()),
    log: (l) => err(`move: ${l}`),
  };
  const reader = deps.reader ?? anonymousReader();
  let work = null;
  try {
    const args = parse(argv, d.env);
    if (!d.env.REGISTRY_TOKEN || !d.env.GITHUB_ACTOR) throw new UsageError("REGISTRY_TOKEN (the job's own GITHUB_TOKEN) and GITHUB_ACTOR are needed: a move reads and writes with the job's token");
    work = tempDir(deps.tmp ?? d.env.RUNNER_TEMP, 'state-move-');
    const ctx = { deps: d, reader, work };
    if (args.what === 'state') return await moveState(args, ctx);
    return args.onto !== undefined ? await moveOnto(args, ctx) : await moveDeltaFile(args, ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`move: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof Refused) {
      d.out(e.message);
      return EXIT.fault;
    }
    if (e instanceof PrivateState || isNotPublic(e)) {
      d.out(PRIVATE_LINE);
      err(`move: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof Fault) {
      err(`move: FAIL ${e.message}`);
      return e.pushCode === 4 ? EXIT.private : e.pushCode === 2 ? EXIT.usage : EXIT.fault;
    }
    if (e instanceof LedgerError) {
      err(`move: FAIL ${e.code} the live ${LEDGER_DELTA_TAG} does not read as a delta: ${e.message}`);
      return EXIT.fault;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`move: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  } finally {
    if (work !== null) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
