// scripts/state/hours.mjs — the hour packs of the feed a live run owes
// (D7, D8 and D9 of DOM-024; docs/architecture.md section 5.8 step 5,
// docs/format.md section 15). It runs in the job `push` of
// .github/workflows/ingest-live.yml, in the group root-writer, after
// scripts/state/advance.mjs wrote the next state, and rewrites that file: each
// hour pack it owes joins `owed`, and the job's promotion adds it to the root
// (D4 of DOM-024).
//
// In this order:
//   1. the closed hours of the lookback (each hour whose end is at or before
//      now, the last --lookback of them, oldest first), the tags of the
//      package feed, and the live root. A closed hour with a feed-h-HOUR build
//      that the root neither names nor covers with a feed pack of a higher
//      tier, and that --next does not owe, is owed: the build's pack is never
//      lost to a failure after its push (D9 of DOM-024, healing D4 of DOM-024);
//   2. the candidates: the closed hours with no build. Their segments are the
//      root's segments and --next's owed segments whose span lies in the hour,
//      by tag, once each. An hour with none is skipped without hour.mjs;
//   3. the ledger, read with no credential: the newest ledger-filter-YYYYMMDD
//      of state and ledger-delta, each layer held to its digest. With no
//      filter no hour pack is built (compact-daily.yml writes the first).
//      Candidates before the filter's as_of are dropped. A delta absent, or
//      paired with an older filter, is healed first: the filter's empty delta,
//      or the live one rebased onto it, moved under the guard (D8 of DOM-024);
//   4. each candidate, oldest first: scripts/compact/hour.mjs in process. Exit
//      3 (a source's segments leave a hole) stops the run: no later hour is
//      built, since the delta grows in hour order (D9 of DOM-024). A build of
//      the hour that hour.mjs finds is owed. A pack written is verified
//      (scripts/verify-pack.mjs, under the list its psl annotation names),
//      pushed as feed-h-HOUR, and only then is ledger-delta moved to the
//      hour's delta, expected the digest this hour read: a delta moved first
//      would hold the hour's domains, and a re-run would write an empty pack
//      under the hour's write-once tag (DOM-023's Found of 2026-10-30T08:30Z).
//      The pack is owed, and the next hour builds from the delta just moved;
//   5. --next is rewritten after each owed pack (a temporary file in its
//      directory, then a rename), so a failure later leaves it whole.
// A present hour does not derive and push its delta again (D7 of DOM-024).
//
// Usage:
//   node scripts/state/hours.mjs --next FILE --out DIR [--now ISO] [--lookback N] [--run ID] [--sources FILE]
// --out is a new or empty directory; --lookback 1 to 48, default 6; --run
// defaults to GITHUB_RUN_ID; --sources is the registry (config/sources.json).
// Environment: REGISTRY_TOKEN and GITHUB_ACTOR (the job's token, for the push
// and the moves), ORAS, RUNNER_TEMP.
// stdout, besides hour.mjs's own lines:
//   ledger filter state:TAG sha256:... delta sha256:...|none
//   rebased state:ledger-delta N to M hash(es) onto state:TAG | started state:ledger-delta empty, paired with state:TAG
//   hour HOUR skip: no segment | hour HOUR wait | hour HOUR present feed:TAG | hour HOUR built feed:TAG sha256:...
//   pushed REF DIGEST (push.mjs's own line) and moved state:ledger-delta OLD -> NEW, read back with no credential
//   owed feed:TAG
//   hours none to build | ledger none: ...
// Exit codes: 0 built, present, skipped or none · 1 a fault (hour.mjs 1, a
// verify that is not ok, a push that failed, a refused move) · 2 could not run
// (usage, a file that does not read, GHCR unreachable) · 3 an hour waits (the
// hours before it were built) · 4 PRIVATE PACKAGE · 70 an internal error, a
// defect of this script (its stack goes to stderr).
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompactError, DELTA_TITLE, FILTER_TITLE, tagDecision, WORKFLOW_RUN_ID } from '@domains/compact';
import { GhcrError, LEDGER_DELTA_TAG, repoOf } from '@domains/ghcr';
import { BloomFilter, EPOCH_MS, HashDelta, LedgerError } from '@domains/ledger';
import { encodeState, owe, parseState, StateError } from '@domains/state';
import { buildTags, freshDir } from '../compact/plan.mjs';
import { main as hourMain } from '../compact/hour.mjs';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { orasRunner } from '../ghcr/push.mjs';
import { RateLimitError, readPaused, realSleep } from '../ghcr/rate.mjs';
import { pslFile, pushFiles, pushPlanOf, verifyDir } from '../ingest/pack.mjs';
import { isoSecond, nowIso } from '../ingest/plan.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { Fault, PrivateRoot, tempDir, UsageError } from '../root/lib.mjs';
import { DEFAULT_SOURCES } from '../verify-pack.mjs';
import { heldBy, ledgerOnto, liveRootOf, moveDelta, moveStamp, newestFilterTag, PrivateState, Refused, readLedgerObject, tokenFrom } from './lib.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, wait: 3, private: 4, internal: 70 });
export const LOOKBACK_HOURS = 6;
const LOOKBACK_RANGE = Object.freeze({ min: 1, max: 48 });
const HOUR_MS = 3_600_000;
const USAGE = 'usage: node scripts/state/hours.mjs --next FILE --out DIR [--now ISO] [--lookback N] [--run ID] [--sources FILE]';
const VALUED = ['next', 'out', 'now', 'lookback', 'run', 'sources'];
// The checks every hour pack's verify names (DOM-020's Found of 2026-10-29T15:30Z);
// precision for a pack of one source, time for one that holds records.
export const REQUIRE = Object.freeze(['dataset', 'length', 'count', 'sha256', 'psl', 'sources']);

const hourTag = (ms) => nowIso(ms).slice(0, 13).replaceAll(/[-T]/g, '');

function parse(argv, env, clock) {
  const a = parseArgs(argv);
  for (const k of Object.keys(a)) if (k !== '_' && !VALUED.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  for (const k of ['next', 'out']) if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  let lookback = LOOKBACK_HOURS;
  if (a.lookback !== undefined) {
    if (!/^[0-9]{1,2}$/.test(a.lookback) || Number(a.lookback) < LOOKBACK_RANGE.min || Number(a.lookback) > LOOKBACK_RANGE.max)
      throw new UsageError(`--lookback ${JSON.stringify(a.lookback)} is not a whole number of ${LOOKBACK_RANGE.min} to ${LOOKBACK_RANGE.max}`);
    lookback = Number(a.lookback);
  }
  const run = a.run ?? env.GITHUB_RUN_ID;
  if (run === undefined || !WORKFLOW_RUN_ID.test(run)) throw new UsageError(`the run ${JSON.stringify(run ?? null)} is not a workflow run id: give --run or GITHUB_RUN_ID`);
  return { next: a.next, out: a.out, now: a.now === undefined ? nowIso(clock()) : isoSecond(a.now, '--now'), lookback, run, sources: a.sources ?? DEFAULT_SOURCES };
}

// The closed hours of the lookback, oldest first: { tag, start, end }.
export function closedHours(now, lookback) {
  const top = Math.floor(Date.parse(now) / HOUR_MS) * HOUR_MS;
  const out = [];
  for (let i = lookback; i >= 1; i -= 1) out.push({ tag: hourTag(top - i * HOUR_MS), start: nowIso(top - i * HOUR_MS), end: nowIso(top - (i - 1) * HOUR_MS) });
  return out;
}

// The tags of the segments of `hour`: the root's and the owed ones whose span lies in it.
function segmentsOf(hour, root, owed) {
  const tags = new Set();
  const inside = (start, end) => start >= hour.start && end <= hour.end;
  for (const packs of Object.values(root?.datasets ?? {})) for (const p of packs) if (p.tier === 'seg' && inside(p.span.start, p.span.end)) tags.add(p.tag);
  for (const o of owed) if (o.tier === 'seg' && inside(o.start, o.end)) tags.add(o.ref.slice(o.ref.indexOf(':') + 1));
  return [...tags].sort();
}

// An error hours does not know is a defect, exit 70: never 1 to 4.
export async function main(argv, deps = {}) {
  try {
    return await hoursJob(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`hours: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function hoursJob(argv, deps) {
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
    log: (l) => err(`hours: ${l}`),
    verify: deps.verify,
  };
  let temp = null;
  let args;
  let next;
  // --next with the owed packs so far: a temporary file beside it, renamed.
  const save = () => {
    const tmp = join(dirname(args.next), `.${Date.now()}.next.json.tmp`);
    writeFileSync(tmp, encodeState(next));
    renameSync(tmp, args.next);
  };
  try {
    args = parse(argv, d.env, d.now);
    try {
      next = parseState(new Uint8Array(readFileSync(args.next)));
    } catch (e) {
      if (e instanceof StateError || e?.syscall !== undefined) throw new UsageError(`--next ${args.next} does not read as a state: ${e.message}`);
      throw e;
    }
    freshDir(args.out, 'hours');
    if (!d.env.REGISTRY_TOKEN || !d.env.GITHUB_ACTOR)
      throw new UsageError("REGISTRY_TOKEN (the job's own GITHUB_TOKEN) and GITHUB_ACTOR are needed: an hour pack is pushed and ledger-delta moved with the job's token");
    temp = tempDir(deps.tmp ?? d.env.RUNNER_TEMP, 'state-hours-');
    const ctx = { deps: d, reader: d.reader, work: temp };
    const pushDeps = { env: d.env, oras: d.oras, reader: d.reader, sleep: d.sleep, random: d.random, tmp: temp, err };
    const owed = (ref) => next.owed.some((o) => o.ref === ref);
    const oweHour = async (hour, tag, digest) => {
      next = owe(next, { ref: `feed:${tag}`, digest, dataset: 'feed', tier: 'h', start: hour.start, end: hour.end, since: args.now }, args.now);
      save();
      d.out(`owed feed:${tag}`);
    };
    const headOf = async (tag) => (await readPaused(`the HEAD of feed:${tag}`, () => d.reader.headManifest(repoOf('feed'), tag), d)).digest;

    // 1. The builds of the lookback that the root lacks.
    const hours = closedHours(args.now, args.lookback);
    const feedTags = await buildTags('feed', 'hour', d.reader, d);
    const root = (await liveRootOf(d.reader, tokenFrom(temp, d), d))?.root ?? null;
    const held = heldBy(root);
    const candidates = [];
    for (const h of hours) {
      const dec = tagDecision('feed', 'h', h.start, feedTags, false);
      if (dec.action !== 'present') {
        candidates.push(h);
        continue;
      }
      const ref = `feed:${dec.tag}`;
      if (owed(ref)) continue;
      const digest = await headOf(dec.tag);
      if (held({ ref, digest, dataset: 'feed', tier: 'h', start: h.start, end: h.end, since: args.now }) === null) await oweHour(h, dec.tag, digest);
    }

    // 2. The candidates and their segments.
    const todo = [];
    for (const h of candidates) {
      const tags = segmentsOf(h, root, next.owed);
      if (tags.length === 0) d.out(`hour ${h.tag} skip: no segment`);
      else todo.push({ ...h, segments: tags });
    }
    if (todo.length === 0) {
      save();
      d.out('hours none to build');
      return EXIT.ok;
    }

    // 3. The ledger.
    const ledgerDir = mkdtempSync(join(args.out, 'ledger-'));
    const filterTag = newestFilterTag(await buildTags('state', 'ledger', d.reader, d));
    if (filterTag === null) {
      save();
      d.out('ledger none: state holds no ledger-filter tag; no hour pack is built until compact-daily.yml writes the first');
      return EXIT.ok;
    }
    const filterObj = await readLedgerObject(d.reader, filterTag, FILTER_TITLE, ledgerDir, d);
    if (filterObj === null) throw new Fault(`the tag list of state names ${filterTag}, whose manifest GHCR does not give with no credential`);
    const filter = BloomFilter.decode(filterObj.bytes);
    const asOf = nowIso(EPOCH_MS + filter.asOf * 1000);
    const build = todo.filter((h) => h.start >= asOf);
    if (build.length === 0) {
      save();
      d.out('hours none to build');
      return EXIT.ok;
    }
    const live = await readLedgerObject(d.reader, LEDGER_DELTA_TAG, DELTA_TITLE, mkdtempSync(join(args.out, 'delta-')), d);
    d.out(`ledger filter state:${filterTag} ${filterObj.digest} delta ${live?.digest ?? 'none'}`);
    let stamp = null;
    const onto = await ledgerOnto(ctx, { filter, filterTag, live, dir: mkdtempSync(join(args.out, 'onto-')), stamp: (stamp = moveStamp(d.now())), run: args.run });
    if (onto.outcome !== 'present') for (const l of onto.lines) d.out(l);
    let delta = { path: onto.path, digest: onto.digest };

    // 4. Each hour, oldest first.
    for (const h of build) {
      const hourDir = join(args.out, h.tag);
      const said = [];
      const code = await hourMain(
        ['--hour', h.tag, '--filter', filterObj.path, '--delta', delta.path, '--out', hourDir, '--obs-tags', h.segments.join(','), '--run', args.run, '--sources', args.sources],
        {
          reader: d.reader,
          out: (l) => {
            said.push(l);
            d.out(l);
          },
          err,
          env: d.env,
          sleep: d.sleep,
          random: d.random,
        },
      );
      if (code === EXIT.wait) {
        save();
        d.out(`hour ${h.tag} wait`);
        return EXIT.wait;
      }
      if (code !== 0) {
        save();
        err(`hours: scripts/compact/hour.mjs exited ${code} for the hour ${h.tag}; no later hour is built`);
        return code === EXIT.private || code === EXIT.usage ? code : EXIT.fault;
      }
      const present = said.map((l) => /^present feed:(\S+)/.exec(l)).find((m) => m !== null);
      if (present !== undefined) {
        d.out(`hour ${h.tag} present feed:${present[1]}`);
        const ref = `feed:${present[1]}`;
        if (!owed(ref)) {
          const digest = await headOf(present[1]);
          if (held({ ref, digest, dataset: 'feed', tier: 'h', start: h.start, end: h.end, since: args.now }) === null) await oweHour(h, present[1], digest);
        }
        continue;
      }
      const built = said.map((l) => /^hour feed:(\S+) /.exec(l)).find((m) => m !== null);
      if (built === undefined) {
        d.out(`hour ${h.tag} skip: no segment`);
        continue;
      }
      const tag = built[1];
      const manifest = JSON.parse(readFileSync(join(hourDir, 'manifest.json'), 'utf8'));
      const blobs = JSON.parse(readFileSync(join(hourDir, 'blobs.json'), 'utf8'));
      const a = manifest.annotations;
      const require = [...REQUIRE, ...(a['dev.pkgforge.domains.source'].split(',').length === 1 ? ['precision'] : []), ...(a['dev.pkgforge.domains.count'] !== '0' ? ['time'] : [])];
      const psl = await pslFile(d.reader, a['dev.pkgforge.domains.psl'], join(args.out, 'psl'), d);
      const v = await verifyDir({ blobs, annotations: a, require, psl, sources: args.sources, work: join(args.out, 'verify') }, d);
      for (const l of v.lines) err(l);
      if (v.verdict !== 'ok') {
        for (const f of v.result?.errors ?? []) err(`hours: feed:${tag} FAIL ${f.check} ${f.detail}`);
        save();
        err(`hours: feed:${tag} verdict ${v.verdict ?? `none (verify-pack.mjs exited ${v.code})`}: nothing of the hour is pushed, and ledger-delta stays`);
        return EXIT.fault;
      }
      const pushed = await pushFiles({ pkg: 'feed', tag, ...pushPlanOf(manifest, blobs) }, pushDeps);
      d.out(pushed.line);
      if (pushed.code !== 0) {
        save();
        return pushed.code === EXIT.private || pushed.code === EXIT.usage ? pushed.code : EXIT.fault;
      }
      d.out(`hour ${h.tag} built feed:${tag} ${pushed.digest}`);
      const deltaPath = join(hourDir, DELTA_TITLE);
      const bytes = new Uint8Array(readFileSync(deltaPath));
      HashDelta.decode(bytes);
      stamp = moveStamp(d.now(), stamp);
      const moved = await moveDelta(ctx, { path: deltaPath, bytes, expected: delta.digest, filterTag, stamp, run: args.run });
      for (const l of moved.lines) d.out(l);
      delta = { path: deltaPath, digest: moved.digest };
      await oweHour(h, tag, pushed.digest);
    }
    save();
    return EXIT.ok;
  } catch (e) {
    if (next !== undefined && args !== undefined) save();
    if (e instanceof UsageError) {
      err(`hours: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof Refused) {
      d.out(e.message);
      return EXIT.fault;
    }
    if (e instanceof PrivateState || e instanceof PrivateRoot || isNotPublic(e)) {
      d.out(PRIVATE_LINE);
      err(`hours: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof Fault || e instanceof LedgerError || e instanceof CompactError || e instanceof StateError) {
      err(`hours: FAIL ${e.message}`);
      return e.pushCode === EXIT.private ? EXIT.private : e.pushCode === EXIT.usage ? EXIT.usage : EXIT.fault;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`hours: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  } finally {
    if (temp !== null) rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
