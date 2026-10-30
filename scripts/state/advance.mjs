// scripts/state/advance.mjs — the next state of the ingest from one run's
// cursor proposals (DOM-024, docs/architecture.md section 5.4). It pushes
// nothing: scripts/state/move.mjs moves state:latest to the file it writes,
// under the guard, in the job `push` of .github/workflows/ingest-live.yml.
//
// In this order:
//   1. every DIR/*.json, parsed as a proposal (parseProposal of
//      @domains/state); one that does not parse is dropped `invalid` with a
//      warning and the others still advance (D24 of DOM-024); an absent or
//      empty DIR is no proposal;
//   2. the live state, state:latest read with no credential, the job's token
//      telling an absent state (the first) from a private one (D21 of DOM-024),
//      and its digest, which move.mjs --expect takes;
//   3. the live root, root:latest read with no credential; then settle: the
//      owed packs the root holds, withdrew or covers, and those owed more than
//      OWED_DAYS, leave `owed`;
//   4. an anonymous HEAD of every ref the proposals name, HEAD_CONCURRENCY at
//      once (a tag that reads as absent answers null);
//   5. advance of @domains/state: the accepted proposals move their cursors,
//      merge their history and owe their segments; the others are dropped.
// Writes OUT/next.json (domains.state.v1) and OUT/advance.json
// (domains.advance.v1: live, changed, accepted, dropped, settled).
//
// Usage:
//   node scripts/state/advance.mjs --proposals DIR --out DIR [--now ISO] [--run ID]
// --out is a new or empty directory. --run defaults to GITHUB_RUN_ID, else local.
// Environment: REGISTRY_TOKEN and GITHUB_ACTOR (the job's token, for the token
// reads, D21 of DOM-024), ORAS, RUNNER_TEMP.
// stdout:
//   live state:latest sha256:... | live state:latest none
//   settled REF CODE DETAIL
//   accepted ADAPTER segments N raw N history N cursor moved|kept
//   dropped ADAPTER|- CODE DETAIL
//   next changed|unchanged owed N
// The settled, accepted and dropped lines follow the encoding of the next
// state: a next state over STATE_MAX_BYTES prints none of them.
// Exit codes: 0 written, changed or not · 1 a live state or root that does
// not validate, or a next state over STATE_MAX_BYTES (the packs owed, and the
// oldest, are named; nothing is written) · 2 could not run (usage, an output that cannot be written,
// GHCR unreachable or answering another error) · 4 PRIVATE PACKAGE (the state
// or the root did not read with no credential) · 70 an internal error, a
// defect of this script (its stack goes to stderr).
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, jsonEqual } from '@domains/adapter';
import { GhcrError } from '@domains/ghcr';
import { advance, encodeState, OWED_DAYS, parseProposal, proposedRefs, RUN_ID, sameState, settle, StateError } from '@domains/state';
import { freshDir, writeOut } from '../compact/plan.mjs';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { orasRunner } from '../ghcr/push.mjs';
import { RateLimitError, readPaused, realSleep } from '../ghcr/rate.mjs';
import { isoSecond, nowIso } from '../ingest/plan.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { Fault, HEAD_CONCURRENCY, parsePackRef, PrivateRoot, tempDir, UsageError } from '../root/lib.mjs';
import { oneLine } from '../lib/line.mjs';
import { heldBy, liveRootOf, liveState, PrivateState, tokenFrom } from './lib.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, private: 4, internal: 70 });
export const ADVANCE_FORMAT = 'domains.advance.v1';
const USAGE = 'usage: node scripts/state/advance.mjs --proposals DIR --out DIR [--now ISO] [--run ID]';
const VALUED = ['proposals', 'out', 'now', 'run'];

function parse(argv, env, clock) {
  const a = parseArgs(argv);
  for (const k of Object.keys(a)) if (k !== '_' && !VALUED.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  for (const k of ['proposals', 'out']) if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  const run = a.run ?? env.GITHUB_RUN_ID ?? 'local';
  if (!RUN_ID.test(run)) throw new UsageError(`the run ${JSON.stringify(run)} is not a workflow run id nor local`);
  return { proposals: a.proposals, out: a.out, now: a.now === undefined ? nowIso(clock()) : isoSecond(a.now, '--now'), run };
}

// The proposals of DIR/*.json in name order, and a drop for each that does not parse (D24 of DOM-024).
export function readProposals(dir) {
  const proposals = [];
  const dropped = [];
  if (!existsSync(dir)) return { proposals, dropped };
  if (!statSync(dir).isDirectory()) throw new UsageError(`--proposals ${dir} is not a directory`);
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    // A directory or anything else that is no file under a .json name is no proposal.
    if (!statSync(join(dir, name)).isFile()) {
      dropped.push({ adapter: null, code: 'invalid', detail: `${name}: not a file` });
      continue;
    }
    try {
      proposals.push(parseProposal(new Uint8Array(readFileSync(join(dir, name)))));
    } catch (e) {
      if (!(e instanceof StateError)) throw e;
      dropped.push({ adapter: null, code: 'invalid', detail: `${name}: ${e.message}` });
    }
  }
  return { proposals, dropped };
}

// The digest each ref holds, by an anonymous HEAD, HEAD_CONCURRENCY at once;
// a tag that reads as absent (404, or 401 and 403 after the anonymous flow) is null.
async function headAll(reader, refs, deps) {
  const found = new Map();
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const ref = refs[next++];
      const { repo, tag } = parsePackRef(ref);
      try {
        found.set(ref, (await readPaused(`the HEAD of ${ref}`, () => reader.headManifest(repo, tag), deps)).digest);
      } catch (e) {
        if (isNotPublic(e)) found.set(ref, null);
        else throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HEAD_CONCURRENCY, refs.length) }, worker));
  return found;
}

const cursorWord = (p) => (jsonEqual(p.before, p.after) ? 'kept' : 'moved');

// An error advance does not know is a defect, exit 70: never 1, 2 or 4.
export async function main(argv, deps = {}) {
  try {
    return await advanceJob(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`advance: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function advanceJob(argv, deps) {
  const err = deps.err ?? console.error;
  const d = {
    reader: deps.reader ?? anonymousReader(),
    oras: deps.oras ?? orasRunner(),
    env: deps.env ?? process.env,
    out: deps.out ?? console.log,
    err,
    sleep: deps.sleep ?? realSleep,
    random: deps.random ?? Math.random,
    now: deps.now ?? (() => Date.now()),
    log: (l) => err(`advance: ${l}`),
  };
  let temp = null;
  try {
    const args = parse(argv, d.env, d.now);
    freshDir(args.out, 'advance');
    const { proposals, dropped: invalid } = readProposals(args.proposals);
    temp = tempDir(deps.tmp ?? d.env.RUNNER_TEMP, 'state-advance-');
    const withToken = tokenFrom(temp, d);
    const live = await liveState(d.reader, withToken, d);
    d.out(`live state:latest ${live?.digest ?? 'none'}`);
    const root = await liveRootOf(d.reader, withToken, d);
    let base = live?.state ?? null;
    let settled = [];
    if (base !== null) {
      const s = settle(base, heldBy(root?.root ?? null), args.now);
      base = s.state;
      settled = s.settled;
    }
    const refs = [...new Set(proposals.flatMap((p) => proposedRefs(p).map((r) => r.ref)))];
    const found = await headAll(d.reader, refs, d);
    const result = advance(base, proposals, (ref) => found.get(ref) ?? null, { now: args.now, run: args.run });
    const next = result.state;
    const dropped = [...invalid, ...result.dropped];
    const changed = !sameState(live?.state ?? null, next);
    // Encoded before any line of the outcome: a next state over the cap
    // writes nothing, so no line may say a proposal was accepted.
    let bytes;
    try {
      bytes = encodeState(next);
    } catch (e) {
      if (!(e instanceof StateError) || e.code !== 'size') throw e;
      const oldest = next.owed.reduce((a, o) => (a === null || o.since < a ? o.since : a), null);
      throw new Fault(
        `${e.message}: ${next.owed.length} pack(s) owed, the oldest since ${oldest ?? 'none'}; nothing is written, and the cursors stay until the root takes owed packs or they expire after ${OWED_DAYS} days`,
      );
    }
    for (const x of settled) d.out(oneLine(`settled ${x.item.ref} ${x.code} ${x.detail}`));
    for (const p of result.accepted) d.out(`accepted ${p.adapter} segments ${p.segments.length} raw ${p.raw.length} history ${p.history.length} cursor ${cursorWord(p)}`);
    for (const x of dropped) d.out(oneLine(`dropped ${x.adapter ?? '-'} ${x.code} ${x.detail}`));
    writeOut(join(args.out, 'next.json'), bytes, 'advance');
    const file = {
      format: ADVANCE_FORMAT,
      live: live?.digest ?? null,
      changed,
      accepted: result.accepted.map((p) => p.adapter),
      dropped,
      settled: settled.map((x) => ({ ref: x.item.ref, code: x.code, detail: x.detail })),
    };
    writeOut(join(args.out, 'advance.json'), `${canonicalJson(file)}\n`, 'advance');
    d.out(`next ${changed ? 'changed' : 'unchanged'} owed ${next.owed.length}`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`advance: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof PrivateState || e instanceof PrivateRoot || isNotPublic(e)) {
      d.out(PRIVATE_LINE);
      err(`advance: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof Fault) {
      err(`advance: FAIL ${e.message}`);
      return EXIT.fault;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`advance: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  } finally {
    if (temp !== null) rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
