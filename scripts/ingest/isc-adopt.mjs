// DOM-027: prepare one state move from the completed manual ISC stage runs.
// The caller holds root-writer and sends next.json to scripts/state/move.mjs
// with the exact state digest read here. This command only reads GHCR. Exit 3
// means the exact proven prefix already ends at the existing cursor.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContractError, jsonEqual } from '@domains/adapter';
import { GhcrError, LATEST, repoOf } from '@domains/ghcr';
import { advance, cursorOf, encodeProposal, encodeState, HISTORY_DAYS, isSecond, propose, StateError } from '@domains/state';
import { DAY_MS, parseCursor } from '../../adapters/isc-new/src/cursor.ts';
import { datedUrl, isDay, MAX_GZIP_BYTES } from '../../adapters/isc-new/src/http.ts';
import { INDEX_GRACE_DAYS } from '../../adapters/isc-new/src/run.ts';
import { DPK1_EPOCH_DAY, isVerifiedEmptyDay } from '../../adapters/isc-new/src/snapshot.ts';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { RateLimitError } from '../ghcr/rate.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { Fault, readRootJson, runAttempt, UsageError } from '../root/lib.mjs';
import { moveStamp, readStateAt } from '../state/lib.mjs';

const SOURCE = 'isc-new';
const DATASET = 'domains';
const OBS = repoOf('obs');
const SHA = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const STAGE = /^(?<run>[1-9][0-9]*)-(?<attempt>[1-9][0-9]*)$/;
const MAX_STAGE_BYTES = 256 * 1024;
const MAX_STAGES = 100;
const USAGE = 'usage: node scripts/ingest/isc-adopt.mjs --target YYYY-MM-DD --expect-state sha256:<64 hex> --expect-cursor JSON --evidence DIR --out DIR';

const midnight = (day) => `${day}T00:00:00Z`;
const dayAfter = (day, days = 1) => new Date(Date.parse(midnight(day)) + days * DAY_MS).toISOString().slice(0, 10);
const digest = (v) => typeof v === 'string' && DIGEST.test(v);
const hash = (v) => typeof v === 'string' && SHA.test(v);
const whole = (v, max) => Number.isSafeInteger(v) && v > 0 && v <= max;
const isMidnight = (v) => isSecond(v) && v.endsWith('T00:00:00Z');
const tagOf = (day, sha) => `${SOURCE}.${day.replaceAll('-', '')}.${sha.slice(0, 12)}-d`;

function json(text, at) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Fault(`${at} is not JSON`);
  }
}

// Every stage run supplies the full window and ends with a completion row.
// The path is assigned only after the workflow authenticates the run attempt.
export function parseStage(text, { run, attempt }) {
  const at = `stage ${run} attempt ${attempt}`;
  const rows = text
    .trimEnd()
    .split(/\r?\n/)
    .map((line, i) => json(line, `${at} row ${i + 1}`));
  const head = rows.shift();
  const tail = rows.pop();
  if (head?.type !== 'stage' || head.format !== 'domains.isc-stage.v1') throw new Fault(`${at} has no stage header of format domains.isc-stage.v1`);
  if (head.run !== run || head.attempt !== attempt) throw new Fault(`${at} has a different workflow run attempt`);
  if (!digest(head.rootDigest) || !digest(head.stateDigest) || !hash(head.psl) || !isSecond(head.at) || (head.domainsSince !== null && !isSecond(head.domainsSince))) {
    throw new Fault(`${at} has invalid root, state, or PSL anchors`);
  }
  const { start, end } = head.window ?? {};
  if (!isMidnight(start) || !isMidnight(end) || start < midnight(DPK1_EPOCH_DAY) || start >= end) throw new Fault(`${at} has an invalid half-open indexed UTC window`);
  if (tail?.type !== 'complete' || tail.segments !== rows.length) throw new Fault(`${at} has no completion row matching its segment count`);
  let day = start.slice(0, 10);
  const staged = rows.map((r) => {
    if (r?.type !== 'segment' || r.day !== day || midnight(day) >= end) throw new Fault(`${at} needs the next segment for ${day} in its window`);
    if (r.verdict !== 'ok') throw new Fault(`${at} ${day} requires an ok segment, got ${JSON.stringify(r.verdict ?? null)}`);
    if (!hash(r.rawSha256) || !whole(r.rawBytes, MAX_GZIP_BYTES) || r.ref !== `obs:${tagOf(day, r.rawSha256)}`) throw new Fault(`${at} ${day} has an invalid raw identity`);
    const verifiedEmpty = isVerifiedEmptyDay(day, r.rawBytes, r.rawSha256);
    if (!digest(r.digest) || (verifiedEmpty ? r.count !== 0 : !whole(r.count, Number.MAX_SAFE_INTEGER))) throw new Fault(`${at} ${day} has an invalid manifest digest or record count`);
    if (r.url !== datedUrl(day)) throw new Fault(`${at} ${day} does not name the dated URL`);
    day = dayAfter(day);
    const { ref, digest: manifest, rawSha256, rawBytes, count } = r;
    return { day: r.day, ref, digest: manifest, rawSha256, rawBytes, count, psl: head.psl };
  });
  if (midnight(day) !== end) throw new Fault(`${at} needs the next segment for ${day} in its window`);
  return staged;
}

function evidenceFrom(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0 || entries.length > MAX_STAGES) throw new Fault(`adoption needs 1 to ${MAX_STAGES} stage attempts`);
  return entries.map((entry) => {
    const match = STAGE.exec(entry.name);
    if (!entry.isDirectory() || match === null || !whole(Number(match.groups.attempt), Number.MAX_SAFE_INTEGER)) throw new Fault(`invalid stage directory ${entry.name}`);
    const path = join(dir, entry.name, 'stage.jsonl');
    if (statSync(path).size > MAX_STAGE_BYTES) throw new Fault(`${path} exceeds ${MAX_STAGE_BYTES} bytes`);
    return parseStage(readFileSync(path, 'utf8'), { run: match.groups.run, attempt: Number(match.groups.attempt) });
  });
}

export function provePrefix(stages, root, target) {
  const byDay = new Map();
  for (const stage of stages) {
    for (const row of stage) {
      const previous = byDay.get(row.day);
      if (previous !== undefined && !jsonEqual(previous, row)) throw new Fault(`conflicting stage evidence for ${row.day}`);
      byDay.set(row.day, row);
    }
  }
  const from = midnight(DPK1_EPOCH_DAY);
  const endOfTarget = midnight(dayAfter(target));
  const segments = (root.datasets.domains ?? []).filter((p) => p.tier === 'seg' && p.sources.includes(SOURCE) && p.span.start < endOfTarget && p.span.end > from);
  const withdrawn = new Set(root.withdrawn.map((w) => w.manifest));
  const proof = [];
  for (let day = DPK1_EPOCH_DAY; day <= target; day = dayAfter(day)) {
    const row = byDay.get(day);
    if (row === undefined) throw new Fault(`${day} has no staged evidence`);
    if (withdrawn.has(row.digest)) throw new Fault(`${day} ${row.ref}@${row.digest} is withdrawn`);
    const start = midnight(day);
    const end = midnight(dayAfter(day));
    const members = segments.filter((p) => p.span.start < end && p.span.end > start);
    const p = members[0];
    if (
      members.length !== 1 ||
      p.repo !== OBS ||
      `obs:${p.tag}` !== row.ref ||
      p.manifest !== row.digest ||
      p.span.start !== start ||
      p.span.end !== end ||
      p.count !== row.count ||
      p.psl !== row.psl ||
      p.sources.length !== 1 ||
      p.quarantine === true
    ) {
      throw new Fault(`${day} ${row.ref}@${row.digest} has no unique exact live ISC segment in root_seq ${root.root_seq}`);
    }
    proof.push(row);
  }
  return proof;
}

export function adopt({ root, live, expectState, expectCursor, stages, target, now, run, attempt }) {
  if (live.digest !== expectState) throw new Fault(`state digest changed from ${expectState} to ${live.digest}`);
  const before = cursorOf(live.state, SOURCE);
  if (!jsonEqual(before, expectCursor)) throw new Fault(`ISC cursor changed from ${JSON.stringify(expectCursor)} to ${JSON.stringify(before)}`);
  const current = parseCursor(before);
  if (Date.parse(midnight(target)) + INDEX_GRACE_DAYS * DAY_MS > Date.parse(now)) throw new Fault(`${target} has not reached D+${INDEX_GRACE_DAYS}`);
  const next = dayAfter(target);
  if (next < current.next) throw new Fault(`the target would move the ISC cursor backward from ${current.next} to ${next}`);
  const proof = provePrefix(stages, root, target);
  if (next === current.next) return { state: live.state, proposal: null, proof };

  // A proposal carries the history the normal ingest path needs for the next
  // live run. Every segment in this proposal has already joined the root.
  const history = proof.slice(-HISTORY_DAYS);
  const proposal = propose({
    adapter: SOURCE,
    lane: null,
    run,
    attempt,
    at: now,
    before,
    after: { ...current, next, blockedHour: null },
    segments: history.map(({ ref, digest, day, count }) => ({ ref, digest, source: SOURCE, dataset: DATASET, start: midnight(day), end: midnight(dayAfter(day)), count, quarantined: false })),
    raw: [],
    history: history.map(({ day, rawBytes }) => ({ source: SOURCE, day, count: rawBytes, quarantined: false })),
  });
  const refs = new Map(history.map((p) => [p.ref, p.digest]));
  const applied = advance(live.state, [proposal], (ref) => refs.get(ref) ?? null, { now: moveStamp(Date.parse(now), live.state.updated), run });
  if (applied.accepted.length !== 1 || applied.dropped.length !== 0) throw new Fault(`adoption proposal was refused: ${applied.dropped.map((d) => d.detail).join('; ')}`);
  return { state: { ...applied.state, owed: live.state.owed }, proposal, proof };
}

function options(argv, env) {
  const a = parseArgs(argv);
  const keys = ['target', 'expect-state', 'expect-cursor', 'evidence', 'out'];
  if (a._.length > 0 || repeatedFlag(a) !== null || Object.keys(a).some((k) => k !== '_' && !keys.includes(k)) || keys.some((k) => typeof a[k] !== 'string' || a[k] === '')) {
    throw new UsageError('give each argument exactly once');
  }
  if (!isDay(a.target) || a.target < DPK1_EPOCH_DAY) throw new UsageError('--target must be an indexed UTC day');
  if (!digest(a['expect-state'])) throw new UsageError('--expect-state must be the latest public state manifest digest');
  const expectCursor = json(a['expect-cursor'], '--expect-cursor');
  parseCursor(expectCursor);
  return { target: a.target, expectState: a['expect-state'], expectCursor, evidence: a.evidence, out: a.out, run: env.GITHUB_RUN_ID ?? 'local', attempt: runAttempt(env) };
}

export async function main(argv, deps = {}) {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  try {
    const args = options(argv, deps.env ?? process.env);
    const stages = evidenceFrom(args.evidence);
    const reader = deps.reader ?? anonymousReader();
    const readRoot = deps.readRoot ?? ((ref) => readRootJson(reader, ref));
    const readState = deps.readState ?? ((ref) => readStateAt(reader, ref));
    const [liveRoot, live] = await Promise.all([readRoot(LATEST), readState(LATEST)]);
    const now = moveStamp((deps.now ?? Date.now)());
    const result = adopt({ ...args, root: liveRoot.root, live, stages, now });
    const [rootAfter, stateAfter] = await Promise.all([readRoot(LATEST), readState(LATEST)]);
    if (rootAfter.digest !== liveRoot.digest || stateAfter.digest !== live.digest) throw new Fault('root or state changed while proving the ISC prefix');
    if (result.proposal === null) {
      out(`already covered ${result.proof.length} ISC days through ${args.target}; state ${live.digest}, root ${liveRoot.digest}`);
      return 3;
    }
    const proposal = encodeProposal(result.proposal);
    const state = encodeState(result.state);
    mkdirSync(args.out);
    writeFileSync(join(args.out, 'proposal.isc-new.json'), proposal, { flag: 'wx' });
    writeFileSync(join(args.out, 'next.json'), state, { flag: 'wx' });
    out(`accepted 1 ISC proposal for ${result.proof.length} exact live days through ${args.target}; next ${result.proposal.after.next}; state ${live.digest}, root ${liveRoot.digest}`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`isc-adopt: ${e.message}\n${USAGE}`);
      return 2;
    }
    if (isNotPublic(e)) {
      out(PRIVATE_LINE);
      err(`isc-adopt: ${e.message}`);
      return 4;
    }
    if (e instanceof Fault || e instanceof StateError || e instanceof ContractError || e instanceof GhcrError || e instanceof RateLimitError || ['ENOENT', 'EEXIST'].includes(e?.code)) {
      err(`isc-adopt: ${e.message}`);
      return 1;
    }
    err(`isc-adopt: internal error: ${e?.stack ?? e}`);
    return 70;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
