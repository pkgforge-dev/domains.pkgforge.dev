// scripts/state/lib.mjs — what scripts/state/advance.mjs, hours.mjs and
// move.mjs share, and scripts/ingest/run.mjs reads (DOM-024; docs/architecture.md
// sections 4.1, 4.7 and 5.4):
//
//   liveState(reader, withToken, deps)   state:latest read with no credential, the token telling absent from private (D21 of DOM-024)
//   readStateAt(reader, ref, deps)       one state object: its manifest, its layer state.json held to its digest, parsed
//   heldBy(root)                         the `held` of settle from the live root (docs/architecture.md section 5.4, Owed packs)
//   newestFilterTag(tags)                the newest ledger-filter-YYYYMMDD of a tag list
//   readLedgerObject(reader, tag, title, dir, deps)   a filter or delta of state, its layer held to its digest, as a file
//   liveRootOf(reader, withToken, deps) the live root, or null before the first promotion
//   filterTagOf(filter), moveStamp(nowMs, after)   a filter's tag; the time of a move's run tag
//   ledgerOnto(ctx, { filter, filterTag, live, dir, stamp, run })   D8 of DOM-024: the live delta made to pair with a filter, and moved
//   moveDelta(ctx, { path, bytes, expected, filterTag, stamp, run }) a delta file moved to ledger-delta
//   moveTag(ctx, { tag, expected, runTag, files, artifactType, created, annotations })
//                                        the one guarded move of a moving tag of state
//
// The move of moveTag, in this order (D2 of DOM-024; the mirror's writer guard):
//   1. log in with the job's token (login of scripts/root/lib.mjs, the token on stdin);
//   2. read the tag with the token (fetchTag, so a private package counts) and
//      `guard` it against `expected`, the digest the caller read: another
//      digest is StateError stale, and nothing is written;
//   3. push the run object under its write-once run tag with
//      scripts/ghcr/push.mjs (in process);
//   4. read the tag again and guard it, immediately before the move: a refusal
//      here leaves the run tag unreferenced, which is harmless;
//   5. `oras tag` the run object, by its digest, as the tag (tagAs of
//      scripts/root/lib.mjs);
//   6. read the tag back as a consumer does, with no credential: its manifest
//      is the pushed digest, and its one layer hashes to the file pushed.
// Every job that runs move.mjs or hours.mjs holds the concurrency group
// root-writer (rule 13 of scripts/check-workflows.mjs). Nothing here deletes
// anything from GHCR (AGENTS.md absolute 13).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DELTA_TITLE } from '@domains/compact';
import { artifactType, LATEST, LEDGER_DELTA_TAG, ledgerDeltaRunTag, ledgerFilterTag, MANIFEST_LIMIT_BYTES, REGISTRY_HOST, repoOf } from '@domains/ghcr';
import { EPOCH_MS, HashDelta } from '@domains/ledger';
import { guard, parseState, STATE_MAX_BYTES, STATE_TITLE, StateError } from '@domains/state';
import { isNotPublic } from '../ghcr/check-public.mjs';
import { READBACK_ATTEMPTS, RETRY_PAUSE_S } from '../ghcr/push.mjs';
import { readPaused } from '../ghcr/rate.mjs';
import { pushFiles } from '../ingest/pack.mjs';
import { nowIso } from '../ingest/plan.mjs';
import { Fault, fetchTag, liveRoot, login, parsePackRef, readBlob, readRoot, tagAs } from '../root/lib.mjs';

export const STATE_PKG = 'state';
export const STATE_REPO = repoOf(STATE_PKG);
export const STATE_REF = `${REGISTRY_HOST}/${STATE_REPO}`;
export const STATE_TYPE = artifactType('state');
export const FILTER_TAG = /^ledger-filter-([0-9]{8})$/;
const TITLE = 'org.opencontainers.image.title';
const HIGHER_TIERS = new Set(['d', 'w', 'm', 'y']);
const DAY_MS = 86_400_000;
// A filter is about 1.2 MB a million domains at 10 bits a key [E]; the
// table's 300 million would be about 375 MB.
export const LEDGER_MAX_BYTES = 1024 * 1024 * 1024;

// A move refused because of what the tag holds: the guard's, or a delta of a
// newer filter (D8 of DOM-024). Exit 1, and the line goes to stdout.
export class Refused extends Fault {
  constructor(message) {
    super(message);
    this.name = 'Refused';
  }
}

// The state does not read with no credential, and it exists (or no token is
// there to tell): PRIVATE PACKAGE, exit 4.
export class PrivateState extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrivateState';
  }
}

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const pausing = (deps) => ({ sleep: deps.sleep, random: deps.random, log: deps.log });

// The one layer titled `title` of a manifest of state, or a Fault.
function layerOf(m, title, at) {
  if (m.json.artifactType !== STATE_TYPE) throw new Fault(`${at} is ${JSON.stringify(m.json.artifactType ?? null)}, not ${STATE_TYPE}`);
  const layers = m.json.layers ?? [];
  if (layers.length !== 1 || layers[0].annotations?.[TITLE] !== title) throw new Fault(`${at} does not hold the one layer ${title}`);
  return layers[0];
}

// The state object `ref` (a tag or a digest) names, read with no credential:
// { digest, state, bytes }. A state.json that does not validate is a Fault;
// GhcrError passes through, for the caller to tell absent from private.
export async function readStateAt(reader, ref, deps = {}) {
  const m = await readPaused(`the manifest ${ref} of ${STATE_REPO}`, () => reader.getManifest(STATE_REPO, ref, { maxBytes: MANIFEST_LIMIT_BYTES }), pausing(deps));
  const at = `${STATE_REF}:${ref}`;
  const bytes = await readBlob(reader, STATE_REPO, layerOf(m, STATE_TITLE, at), pausing(deps), STATE_MAX_BYTES);
  try {
    return { digest: m.digest, state: parseState(bytes), bytes };
  } catch (e) {
    if (e instanceof StateError) throw new Fault(`${at}: ${e.message}`);
    throw e;
  }
}

// The live state (D21 of DOM-024): state:latest read with no credential, as a
// consumer reads it: { digest, state }. When that read finds nothing,
// `withToken()` gives a token context ({ deps, config, work }) or null: with
// one, latest is read with the job's token, and absent too is the first state
// (null); present is a state that does not read publicly, PrivateState. With
// none (a local run) the anonymous failure is PrivateState: absent and private
// answer alike to a reader with no credential (scripts/ghcr/check-public.mjs).
export async function liveState(reader, withToken, deps = {}) {
  try {
    return await readStateAt(reader, LATEST, deps);
  } catch (e) {
    if (!isNotPublic(e)) throw e;
    const ctx = await withToken();
    if (ctx === null) throw new PrivateState(`${STATE_REF}:${LATEST} did not read with no credential (${e.message}), and no token is given to tell an absent state from a private one`);
    const held = await fetchTag(ctx, LATEST, STATE_REF);
    if (held === null) return null;
    throw new PrivateState(`${STATE_REF}:${LATEST} holds ${held.digest}, and it does not read with no credential (${e.message})`);
  }
}

// `withToken` of liveState for a job that has REGISTRY_TOKEN and
// GITHUB_ACTOR in `deps.env`: a login into `work`, once; null without them.
export function tokenFrom(work, deps) {
  let ctx;
  return async () => {
    if (!deps.env.REGISTRY_TOKEN || !deps.env.GITHUB_ACTOR) return null;
    if (ctx === undefined) ctx = { deps, work, config: await login(work, deps) };
    return ctx;
  };
}

// The `held` of settle (@domains/state) from the live root.json (null: no
// root yet, nothing is held). An item is `held` when a pack entry of the
// root has its repository and tag, `withdrawn` when the root's withdrawn
// lists its digest, `covered` when it is an hour pack of feed and a feed pack
// of tier d, w, m or y spans its hour. No manifest is read.
export function heldBy(root) {
  return (item) => {
    if (root === null) return null;
    const { repo, tag } = parsePackRef(item.ref);
    for (const packs of Object.values(root.datasets)) {
      const p = packs.find((x) => x.repo === repo && x.tag === tag);
      if (p !== undefined) return { code: 'held', detail: `root_seq ${root.root_seq} names ${item.ref} (${p.manifest})` };
    }
    const w = root.withdrawn.find((x) => x.manifest === item.digest);
    if (w !== undefined) return { code: 'withdrawn', detail: `root_seq ${root.root_seq} withdrew ${item.digest} at ${w.at}` };
    if (item.tier === 'h' && item.dataset === 'feed') {
      const over = (root.datasets.feed ?? []).find((p) => HIGHER_TIERS.has(p.tier) && p.span.start <= item.start && item.end <= p.span.end);
      if (over !== undefined) return { code: 'covered', detail: `feed:${over.tag} of tier ${over.tier} spans ${item.start} to ${item.end}` };
    }
    return null;
  };
}

// The newest ledger-filter-YYYYMMDD of `tags`, by its day, or null. The run
// tags of ledger-delta and anything else are not filters.
export function newestFilterTag(tags) {
  let best = null;
  for (const t of tags) {
    const m = FILTER_TAG.exec(t);
    if (m !== null && (best === null || m[1] > best.day)) best = { tag: t, day: m[1] };
  }
  return best?.tag ?? null;
}

// The object `tag` of state (a ledger filter or delta), read with no
// credential: its manifest, its one layer `title` held to its digest and
// written to DIR/<title>. { digest, path, bytes, annotations }, or null when
// it reads as absent. ⚠ An absent tag and a private package answer alike; a
// move of the object reads it again with the token (moveTag).
export async function readLedgerObject(reader, tag, title, dir, deps = {}) {
  let m;
  try {
    m = await readPaused(`the manifest ${tag} of ${STATE_REPO}`, () => reader.getManifest(STATE_REPO, tag, { maxBytes: MANIFEST_LIMIT_BYTES }), pausing(deps));
  } catch (e) {
    if (isNotPublic(e)) return null;
    throw e;
  }
  const bytes = await readBlob(reader, STATE_REPO, layerOf(m, title, `${STATE_REF}:${tag}`), pausing(deps), LEDGER_MAX_BYTES);
  const path = join(dir, title);
  writeFileSync(path, bytes);
  return { digest: m.digest, path, bytes, annotations: m.json.annotations ?? {} };
}

// The guard of moveTag: the tag read with the token holds `expected`.
export async function guarded(c, tag, expected) {
  const found = (await fetchTag(c, tag, STATE_REF))?.digest ?? null;
  try {
    guard(`${STATE_PKG}:${tag}`, expected, found);
  } catch (e) {
    if (e instanceof StateError && e.code === 'stale') throw new Refused(`refused ${e.message}`);
    throw e;
  }
  return found;
}

// Steps 1 to 6 of the header for the moving `tag` of state. `files` is the one
// [{ path, mediaType }] of the run object (its title the file's name), pushed
// under `runTag`. ctx: { deps, reader, work }. Returns { digest, lines }: the
// push line and the `moved` line. StateError stale (the guard), Fault (a push
// or tag that failed, a read-back that differs), PrivateState (the read-back
// with no credential) or a push.mjs code it cannot act on pass to the caller.
export async function moveTag(ctx, { tag, expected, runTag, files, artifactType: type, created, annotations }) {
  const { deps, reader, work } = ctx;
  const c = { deps, work, config: await login(work, deps) };
  const lines = [];
  await guarded(c, tag, expected);
  const pushed = await pushFiles(
    { pkg: STATE_PKG, tag: runTag, artifactType: type, created, annotations, files },
    { env: deps.env, oras: deps.oras, reader, sleep: deps.sleep, random: deps.random, tmp: work, err: deps.err },
  );
  if (pushed.code !== 0) {
    const e = new Fault(`scripts/ghcr/push.mjs exited ${pushed.code} for ${STATE_PKG}:${runTag}: ${pushed.line || 'see its error above'}`);
    e.pushCode = pushed.code;
    throw e;
  }
  lines.push(pushed.line);
  await guarded(c, tag, expected);
  await tagAs(c, { ref: STATE_REF, from: runTag, digest: pushed.digest, tag, expected });
  const want = sha(readFileSync(files[0].path));
  for (let attempt = 1; ; attempt++) {
    try {
      const m = await readPaused(`the anonymous read of ${tag}`, () => reader.getManifest(STATE_REPO, tag, { maxBytes: MANIFEST_LIMIT_BYTES }), pausing(deps));
      if (m.digest !== pushed.digest) throw new Fault(`${STATE_REF}:${tag} reads as ${m.digest} with no credential, not ${pushed.digest}`);
      const layer = (m.json.layers ?? [])[0];
      const bytes = await readBlob(reader, STATE_REPO, layer, pausing(deps), LEDGER_MAX_BYTES);
      if (sha(bytes) !== want) throw new Fault(`${STATE_REF}:${tag} reads back a layer hashing to ${sha(bytes)}, not the ${want} of ${files[0].path}`);
      lines.push(`moved ${STATE_PKG}:${tag} ${expected ?? 'none'} -> ${pushed.digest}, read back with no credential`);
      return { digest: pushed.digest, lines };
    } catch (e) {
      if (!isNotPublic(e) || attempt >= READBACK_ATTEMPTS) {
        if (isNotPublic(e)) throw new PrivateState(`${STATE_REF}:${tag} did not read with no credential after ${READBACK_ATTEMPTS} attempts: ${e.message}`);
        throw e;
      }
      deps.log(`the anonymous read of ${STATE_PKG}:${tag}: ${e.message}; again in ${RETRY_PAUSE_S} s`);
      await deps.sleep(RETRY_PAUSE_S * 1000);
    }
  }
}

// The live root (readRoot of `latest`), or null when no root was promoted.
// With a token (`withToken()` not null) it is liveRoot of scripts/root/lib.mjs:
// absent read with the token too is null, present and private PrivateRoot.
// Without one, a root that does not read with no credential is PrivateState.
export async function liveRootOf(reader, withToken, deps = {}) {
  const ctx = await withToken();
  if (ctx !== null) return liveRoot(reader, ctx);
  try {
    return await readRoot(reader, LATEST, deps);
  } catch (e) {
    if (isNotPublic(e)) throw new PrivateState(`root:${LATEST} did not read with no credential (${e.message}), and no token is given to tell an absent root from a private one`);
    throw e;
  }
}

// The run tag's time of a move made now: the clock to the second, and one
// second past `after` (the previous move's) when the clock has not passed it,
// so two moves of one run never share a write-once run tag (D2 of DOM-024).
export function moveStamp(nowMs, after = null) {
  const s = Math.floor(nowMs / 1000) * 1000;
  return nowIso(after === null ? s : Math.max(s, Date.parse(after) + 1000));
}

// The ledger-filter-YYYYMMDD tag of a filter: the day whose end is its as_of
// (docs/format.md section 15). A filter whose as_of is not the end of a day
// is a Fault.
export function filterTagOf(filter) {
  const endMs = EPOCH_MS + filter.asOf * 1000;
  if (!Number.isSafeInteger(endMs) || endMs % DAY_MS !== 0) throw new Fault(`the filter's as_of ${filter.asOf} (seconds since 2026-01-01) is not the end of a UTC day`);
  return ledgerFilterTag(new Date(endMs - DAY_MS));
}

// D8 of DOM-024: `live` (the ledger-delta read in this job: { digest, bytes }
// or null) made to pair with `filter` (BloomFilter, tagged `filterTag`) and
// moved, expected the digest read:
//   absent                              the empty delta of the filter: `started`
//   paired with this filter             nothing moves: `present`
//   paired with an older filter         rebased onto it (HashDelta.rebase): `rebased`
//   paired with a newer filter, or another of the same as_of   Fault, nothing moves
// Returns { outcome, digest, path, delta, lines }: the delta that pairs with
// the filter, as a file in `dir`, and its digest in state.
export async function ledgerOnto(ctx, { filter, filterTag, live, dir, stamp, run }) {
  const lines = [];
  let delta;
  if (live === null) {
    delta = HashDelta.empty(filter);
    lines.push(`started state:${LEDGER_DELTA_TAG} empty, paired with state:${filterTag}`);
  } else {
    const was = HashDelta.decode(live.bytes);
    if (was.filterAsOf === filter.asOf && was.filterCrc === filter.crc) {
      const path = join(dir, DELTA_TITLE);
      writeFileSync(path, live.bytes);
      return { outcome: 'present', digest: live.digest, path, delta: was, lines: [`present state:${LEDGER_DELTA_TAG} ${live.digest}: it pairs with state:${filterTag} already`] };
    }
    if (was.filterAsOf >= filter.asOf)
      throw new Refused(
        `refused state:${LEDGER_DELTA_TAG} ${live.digest} pairs with the filter of as_of ${was.filterAsOf}, and state:${filterTag} is as_of ${filter.asOf}: a delta never moves back to an older filter, nor to another filter of its own as_of`,
      );
    delta = was.rebase(filter);
    lines.push(`rebased state:${LEDGER_DELTA_TAG} ${was.size} to ${delta.size} hash(es) onto state:${filterTag}`);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DELTA_TITLE);
  const bytes = delta.encode();
  writeFileSync(path, bytes);
  const moved = await moveDelta(ctx, { path, bytes, expected: live?.digest ?? null, filterTag, stamp, run });
  return { outcome: live === null ? 'started' : 'rebased', digest: moved.digest, path, delta, lines: [...lines, ...moved.lines] };
}

// A delta file moved to ledger-delta under the guard: its run object
// ledger-delta-<stamp> (docs/format.md section 15).
export function moveDelta(ctx, { path, bytes, expected, filterTag, stamp, run }) {
  return moveTag(ctx, {
    tag: LEDGER_DELTA_TAG,
    expected,
    runTag: ledgerDeltaRunTag(stamp),
    files: [{ path, mediaType: 'application/octet-stream' }],
    artifactType: STATE_TYPE,
    created: stamp,
    annotations: [
      ['dev.pkgforge.domains.sha256', createHash('sha256').update(bytes).digest('hex')],
      ['dev.pkgforge.domains.run', run],
      ['dev.pkgforge.domains.filter', filterTag],
    ],
  });
}
