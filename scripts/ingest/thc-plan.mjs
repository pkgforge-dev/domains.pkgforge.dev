// scripts/ingest/thc-plan.mjs — the plan of a backfill of THC's daily dumps
// (DOM-029, design D12, D19, D22 and section 6.3): the job `plan` of
// .github/workflows/ingest-thc.yml runs it for a dispatch with `from` and `to`.
// It decides what each calendar day of the window needs, writes the inputs of
// the legs, and writes itself the proposals that need no leg.
//
// It reads, each with no credential:
//   - state:latest (liveState of scripts/state/lib.mjs) and root:latest's
//     root.json (readRootJson of scripts/root/lib.mjs);
//   - the tags of obs (buildTags of scripts/compact/plan.mjs, every page), and
//     the manifest of each thc-ct tag a day to adopt or to re-run holds;
//   - the bucket's listing (readListing of adapters/thc-ct/src/locate.ts, the
//     adapter's own parser) and, only when a day the listing lacks is to be
//     decided, cs2's index page (cs2Index);
//   - the lists the legs build under (pslFile of scripts/ingest/pack.mjs).
// With --recordings DIR the hosts are answered by the *.http.json of DIR
// (replayFetch of @domains/adapter, as run.mjs --recordings), else by fetch.
//
// Each day of [from, to] gets one action, in this order (D22):
//   present  the root covers the day in names and in domains with a pack that
//            carries thc-ct (its segment, or a day or higher pack that took
//            it), or state owes the day's tag of that dataset; or the day has
//            no tag, no host lists it, and the root's gaps (or state's pending
//            gaps) name it. No leg.
//   adopt    the day's two tags thc-ct.<YYYYMMDD>.<sha12> and ...-d are in obs
//            and neither the root nor state holds them: the plan writes the
//            proposal from the two manifests (adoptProposal of
//            scripts/ingest/adopt.mjs), with no re-read. No leg.
//   run      a host lists the file (the bucket first, then cs2's index), or one
//            tag of the day's pair is in obs (a leg that died between its two
//            pushes): one leg, `run.mjs --from DAY --to DAY+1`.
//   gap      no tag, no host lists it, and now is at or past its gap instant
//            (D+2 12:00Z, gapAt of adapters/thc-ct): the plan writes a
//            proposal of that gap alone (gapProposal). No leg (see the
//            stage notes, S4-D2: a leg would declare it through the adapter,
//            whose declared gap is a fault, exit 1, so every backfill over a
//            known gap day would end red).
// A day is refused (exit 1) when no host lists it before its gap instant
// (unpublished: --to names a day not published yet), when its tags name two
// files that neither the root nor state holds, or when one tag of its pair is
// in obs and no host lists the file to build the other.
//
// The list a leg builds under (D19): the list of the day's existing thc-ct tag
// (dev.pkgforge.domains.psl of its manifest), so push.mjs finds a re-run
// `present`; else the one list the day's live domains packs share (10-22 to
// 10-31 hold oi-nrd's packs); else the list root:latest pins. Each list is
// written beside the plan as psl-<sha12>.dat.
//
// The band (design section 6.3): checkBand of @domains/adapter replayed in day
// order over state's thc-ct history before `from`, then each day of the window
// a host lists or a tag holds: an adopted day's own item (its raw layer's size
// and its mark), a present day's item of the live state when it has one, else
// the host's size with the replayed verdict. A run day is always replayed: its
// leg checks it so, and its proposal's day replaces a stored one at advance. A day source never holds (D26);
// a hold is still refused, exit 1, with its numbers. The legs read this
// history through --state (D14: each checks its day against the days before
// it), so the verdict printed for a run day is the one its leg will give the
// same bytes.
//
// Usage:
//   node scripts/ingest/thc-plan.mjs --from YYYY-MM-DD --to YYYY-MM-DD --out DIR
//                                    [--recordings DIR] [--now ISO] [--run ID]
// --from and --to are days, inclusive, at most MAX_DAYS apart. --out is a new
// or empty directory. The run is --run, else GITHUB_RUN_ID; the attempt
// GITHUB_RUN_ATTEMPT.
// Writes, only when no day is refused:
//   DIR/plan.json     domains.thc-plan.v1: from, to, now, the state and root
//                     digests read, and days [{ day, action, bytes, host,
//                     verdict, path, psl, tags }]
//   DIR/state.json    the live state, its thc-ct history the replayed one
//                     through `to` (the newest HISTORY_DAYS): a leg's --state
//   DIR/matrix.json   { "include": [{ "day": D, "psl": "<sha12>" }, ...] }, the run days
//   DIR/psl-<sha12>.dat   each list a leg builds under
//   DIR/proposals/proposal.thc-ct.<YYYYMMDD>.json   each adopt and gap day
// stdout, one line each:
//   state state:latest sha256:... cursor <canonical JSON | none>
//   root root:latest sha256:... root_seq N psl <sha256>
//   listing N day files                      (the bucket's)
//   index N day files                        (cs2's, when read)
//   tags N thc-ct tags of the window         (in obs)
//   day D run BYTES hf|cs2 ok|quarantine psl SHA12
//   day D present WHY
//   day D adopt TAG TAG-d
//   day D gap
//   day D unpublished|two-files|partial WHY  (each a refusal)
//   psl <sha256> ref:psl-<sha12>             (each list written)
//   legs N adopted N gaps N
// Exit codes: 0 planned · 1 a day refused, a hold, or a fault of what GHCR
// holds (a manifest that is not a segment of thc-ct, a list whose bytes are
// not its hash) · 2 could not run (usage, GHCR unreachable, a host's listing
// or index that does not read or parse) · 4 PRIVATE PACKAGE (the state, the
// root or a list does not read with no credential) · 70 an internal error, a
// defect of this script (its stack goes to stderr).
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, checkBand, liveFetch, replayFetch } from '@domains/adapter';
import { readRecordings } from '@domains/adapter/node';
import { GhcrError, LATEST, refTag, repoOf, WORKFLOW_RUN_ID } from '@domains/ghcr';
import { VERIFY_ANNOTATIONS } from '@domains/pack';
import { spansDay } from '@domains/root';
import { cursorOf, encodeProposal, encodeState, HISTORY_DAYS, historyOf, proposalFile } from '@domains/state';
import { dayStart, gapAt, isDay, isoOfMs, nextDay } from '../../adapters/thc-ct/src/cursor.ts';
import { HOSTS, LIMITS, SOURCE } from '../../adapters/thc-ct/src/index.ts';
import { cs2Index, readListing } from '../../adapters/thc-ct/src/locate.ts';
import { deadline, HostFault, isTimeout } from '../../adapters/thc-ct/src/pass.ts';
import { buildTags, checkOutDir, freshDir, writeOut } from '../compact/plan.mjs';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { RateLimitError, readPaused, realSleep } from '../ghcr/rate.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { oneLine } from '../lib/line.mjs';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { Fault, HEAD_CONCURRENCY, readRootJson, runAttempt, UsageError } from '../root/lib.mjs';
import { liveState, PrivateState } from '../state/lib.mjs';
import { DEFAULT_SOURCES, loadRegistry } from '../verify-pack.mjs';
import { adoptProposal, gapProposal } from './adopt.mjs';
import { pslFile } from './pack.mjs';
import { isoSecond, nowIso } from './plan.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, private: 4, internal: 70 });
export const PLAN_FORMAT = 'domains.thc-plan.v1';
// The most days of one window: the plan's history keeps HISTORY_DAYS (90) days
// through `to`, so a window of 62 keeps at least 28 days of baseline before its
// first day; and 62 is MAX_RANGE_DAYS of compact-daily.yml, so the window's days
// compact in one range dispatch (D18). The backfill of 2026-09-01 to 10-31 is 61.
export const MAX_DAYS = 62;
// The deadline of the listing and of cs2's index: each is one page of at most
// tens of KB (15,428 B for the listing, MEASURED 2026-11-01T07:45:37Z, design
// M2), read in about a second; record.mjs gives its requests the same 120 s.
export const HOST_DEADLINE_S = 120;
const ADAPTER = SOURCE;
const USAGE = 'usage: node scripts/ingest/thc-plan.mjs --from YYYY-MM-DD --to YYYY-MM-DD --out DIR [--recordings DIR] [--now ISO] [--run ID]';
const VALUED = ['from', 'to', 'out', 'recordings', 'now', 'run'];
const HEX64 = /^[0-9a-f]{64}$/;
const TAG_FORM = new RegExp(`^${SOURCE}\\.([0-9]{8})\\.([0-9a-f]{12})(-d)?$`);
const A = VERIFY_ANNOTATIONS;
const OBS = repoOf('obs');
const DATASETS = ['names', 'domains'];

function parse(argv, env, clock) {
  const a = parseArgs(argv);
  for (const k of Object.keys(a)) if (k !== '_' && !VALUED.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  for (const k of VALUED) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  for (const k of ['from', 'to', 'out']) if (a[k] === undefined) throw new UsageError(`--${k} is needed`);
  for (const k of ['from', 'to']) if (!isDay(a[k])) throw new UsageError(`--${k} ${JSON.stringify(a[k])} is not a calendar day YYYY-MM-DD from 2026-01-01`);
  if (a.to < a.from) throw new UsageError(`--to ${a.to} is before --from ${a.from}`);
  const days = [];
  for (let d = a.from; d <= a.to; d = nextDay(d)) {
    days.push(d);
    if (days.length > MAX_DAYS) throw new UsageError(`--from ${a.from} to --to ${a.to} holds more than ${MAX_DAYS} days (MAX_DAYS)`);
  }
  checkOutDir(a.out, '--out');
  if (a.recordings !== undefined && (!existsSync(a.recordings) || !statSync(a.recordings).isDirectory())) throw new UsageError(`--recordings ${a.recordings} is not a directory`);
  const now = a.now === undefined ? nowIso(clock()) : isoSecond(a.now, '--now');
  const run = a.run ?? env.GITHUB_RUN_ID;
  if (run === undefined || !WORKFLOW_RUN_ID.test(run)) throw new UsageError(`the run ${JSON.stringify(run ?? null)} is not a workflow run id: give --run or GITHUB_RUN_ID`);
  return { from: a.from, to: a.to, days, out: a.out, recordings: a.recordings, now, run, attempt: runAttempt(env) };
}

// cs2's index page, parsed (cs2Index). Throws HostFault `cs2` or `timeout`.
async function readIndex(fetch) {
  const url = HOSTS.cs2;
  const limits = { readDeadlineS: HOST_DEADLINE_S };
  let text;
  let status;
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' }, signal: deadline(limits) });
    status = res.status;
    text = await res.text();
  } catch (e) {
    if (isTimeout(e)) throw new HostFault('cs2', 'timeout', `GET ${url} did not end within ${HOST_DEADLINE_S} s`);
    throw new HostFault('cs2', 'cs2', `GET ${url} failed: ${e?.message ?? String(e)}`);
  }
  if (status !== 200) throw new HostFault('cs2', 'cs2', `GET ${url} answered ${status}`);
  return cs2Index(text);
}

// The hosts' view of the days: the listing read once, cs2's index read once
// and only when asked for. locate(day) is { host, bytes, path } or null.
function hostsOf(fetch, d) {
  let listing = null;
  let index = null;
  return {
    async listing() {
      if (listing === null) {
        listing = await readListing(fetch, HOSTS.listing, USER_AGENT, { readDeadlineS: HOST_DEADLINE_S, maxListingPages: LIMITS.maxListingPages });
        d.out(`listing ${listing.size} day files`);
      }
      return listing;
    },
    async locate(day) {
      const e = (await this.listing()).get(day);
      if (e !== undefined) return { host: 'hf', bytes: e.size, path: e.path };
      if (index === null) {
        index = await readIndex(fetch);
        d.out(`index ${index.size} day files`);
      }
      const i = index.get(day);
      return i === undefined ? null : { host: 'cs2', bytes: i.bytes, path: null };
    },
  };
}

// The thc-ct tags of each day of the window: Map day -> Map sha12 -> { names, domains }.
function tagsByDay(tags, days) {
  const wanted = new Map(days.map((d) => [d.replaceAll('-', ''), d]));
  const out = new Map(days.map((d) => [d, new Map()]));
  let n = 0;
  for (const tag of tags) {
    const m = TAG_FORM.exec(tag);
    if (m === null || !wanted.has(m[1])) continue;
    const group = out.get(wanted.get(m[1]));
    const g = group.get(m[2]) ?? { names: null, domains: null };
    g[m[3] === undefined ? 'names' : 'domains'] = tag;
    group.set(m[2], g);
    n += 1;
  }
  return { byDay: out, count: n };
}

// The manifests of `tags`, HEAD_CONCURRENCY at a time: Map tag -> { tag, digest, json }.
async function manifestsOf(reader, tags, d) {
  const out = new Map();
  let next = 0;
  const worker = async () => {
    while (next < tags.length) {
      const tag = tags[next++];
      const m = await readPaused(`the manifest ${tag} of ${OBS}`, () => reader.getManifest(OBS, tag), d);
      out.set(tag, { tag, digest: m.digest, json: m.json });
    }
  };
  await Promise.all(Array.from({ length: Math.min(HEAD_CONCURRENCY, tags.length) }, worker));
  return out;
}

const pslOfManifest = (m) => {
  const v = m.json.annotations?.[A.psl];
  if (typeof v !== 'string' || !HEX64.test(v)) throw new Fault(`obs:${m.tag} names no list: ${A.psl} is ${JSON.stringify(v ?? null)}, not 64 lowercase hex digits`);
  return v;
};

// What holds the day's `dataset`, or null: a pack of the root that carries
// thc-ct and spans the whole day (its segment, or a pack that took it), else
// a tag of the day that state owes.
function holderOf(root, state, dataset, day, group) {
  const pack = (Object.hasOwn(root.datasets, dataset) ? root.datasets[dataset] : []).find((p) => p.sources.includes(SOURCE) && spansDay(p, day));
  if (pack !== undefined) return `${dataset} ${pack.repo.split('/').at(-1)}:${pack.tag} (root_seq ${root.root_seq})`;
  for (const g of group.values()) {
    const tag = g[dataset];
    if (tag !== null && state.owed.some((o) => o.ref === `obs:${tag}`)) return `${dataset} obs:${tag} (owed by state)`;
  }
  return null;
}

// D19 steps 2 and 3: the one list of the day's live domains packs, else the root's.
function rootListOf(root, day) {
  const start = dayStart(day);
  const end = dayStart(nextDay(day));
  const lists = new Set((root.datasets.domains ?? []).filter((p) => p.span.start < end && start < p.span.end).map((p) => p.psl));
  return lists.size === 1 ? [...lists][0] : root.psl;
}

// The action of each day (D22), before the band: [{ day, action, ... }], and the refusals.
async function classify(args, { root, state, byDay, hosts }) {
  const nowMs = Date.parse(args.now);
  const entries = [];
  const refused = [];
  for (const day of args.days) {
    const group = byDay.get(day);
    const tags = [...group.values()].flatMap((g) => [g.names, g.domains]).filter((t) => t !== null);
    const held = DATASETS.map((ds) => holderOf(root, state, ds, day, group));
    const e = { day, action: null, bytes: null, host: null, verdict: null, path: null, psl: null, tags, detail: null, pslTag: null, pair: null };
    if (held.every((h) => h !== null)) {
      // The listing's size, for the band; cs2's index is not read for a day held.
      const l = (await hosts.listing()).get(day);
      entries.push({ ...e, action: 'present', detail: held.join(', '), ...(l === undefined ? {} : { host: 'hf', bytes: l.size, path: l.path }) });
      continue;
    }
    if (group.size > 1) {
      refused.push({ day, code: 'two-files', detail: `its tags name ${group.size} files (${tags.join(' ')}), and neither the root nor state holds the day; adopt or re-run one by hand` });
      continue;
    }
    if (group.size === 1) {
      const g = [...group.values()][0];
      if (g.names !== null && g.domains !== null) {
        entries.push({ ...e, action: 'adopt', pair: g });
        continue;
      }
      const located = await hosts.locate(day);
      if (located === null) {
        refused.push({ day, code: 'partial', detail: `obs holds ${tags.join(' ')} alone, and no host lists the file to build the other segment` });
        continue;
      }
      entries.push({ ...e, action: 'run', ...located, pslTag: g.names ?? g.domains });
      continue;
    }
    const located = await hosts.locate(day);
    if (located !== null) {
      entries.push({ ...e, action: 'run', ...located });
      continue;
    }
    if ((root.gaps[SOURCE] ?? []).includes(day)) {
      entries.push({ ...e, action: 'present', detail: `root_seq ${root.root_seq} lists the day in gaps.${SOURCE}, and no host lists a file` });
      continue;
    }
    if ((state.gaps?.[SOURCE] ?? []).includes(day)) {
      entries.push({ ...e, action: 'present', detail: `state holds the day pending in gaps.${SOURCE}, and no host lists a file` });
      continue;
    }
    const at = gapAt(day, LIMITS);
    if (nowMs >= at) entries.push({ ...e, action: 'gap' });
    else refused.push({ day, code: 'unpublished', detail: `no host lists the file, and the day becomes a gap only at ${isoOfMs(at)}: --to names a day not published yet` });
  }
  return { entries, refused };
}

// The band (design section 6.3), in day order: each entry's verdict, and the
// history through `to`.
function replayBand(args, { state, entries, band, adopted }) {
  const live = historyOf(state, SOURCE);
  const liveByDay = new Map(live.map((h) => [h.day, h]));
  const hist = live.filter((h) => h.day < args.from).map((h) => ({ ...h }));
  const holds = [];
  for (const e of entries) {
    // A run day is checked as its leg checks it, and its proposal's day replaces any stored one, as an adopted day's does.
    const own = e.action === 'adopt' ? (adopted.get(e.day)?.history ?? null) : e.action === 'present' ? (liveByDay.get(e.day) ?? null) : null;
    if (own !== null) {
      e.verdict = own.quarantined ? 'quarantine' : 'ok';
      if (e.bytes === null) e.bytes = own.count;
      hist.push({ day: e.day, count: own.count, quarantined: own.quarantined });
      continue;
    }
    if (e.bytes === null) continue;
    const r = checkBand(e.bytes, hist, band, { precision: 'day' });
    if (r.verdict === 'hold') {
      holds.push({
        day: e.day,
        code: 'hold',
        detail: `${e.bytes} B against the median ${r.median} (floor ${r.floor}, ceiling ${r.ceiling}): ${r.reason}; a day source never holds (D26), so this is a defect of the band`,
      });
      continue;
    }
    e.verdict = r.verdict;
    hist.push({ day: e.day, count: e.bytes, quarantined: r.verdict === 'quarantine' });
  }
  return { history: hist.slice(-HISTORY_DAYS), holds };
}

export async function main(argv, deps = {}) {
  try {
    return await plan(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`thc-plan: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function plan(argv, deps) {
  const err = deps.err ?? console.error;
  const d = {
    reader: deps.reader ?? anonymousReader(),
    env: deps.env ?? process.env,
    out: deps.out ?? console.log,
    sleep: deps.sleep ?? realSleep,
    random: deps.random ?? Math.random,
    now: deps.now ?? (() => Date.now()),
    log: (l) => err(`thc-plan: ${l}`),
  };
  try {
    const args = parse(argv, d.env, d.now);
    freshDir(args.out, 'thc-plan');
    const registry = loadRegistry(DEFAULT_SOURCES);
    const rows = registry.filter((r) => r.adapter === ADAPTER);
    const row = rows.find((r) => r.id === SOURCE);
    if (row === undefined) throw new UsageError(`the registry ${DEFAULT_SOURCES} holds no row of ${SOURCE}: run node scripts/sources/build.mjs`);
    const fetch = args.recordings === undefined ? liveFetch : replayFetch(readRecordings(args.recordings)).fetch;

    const live = await liveState(d.reader, async () => null, d);
    const state = live.state;
    const cursor = cursorOf(state, ADAPTER);
    d.out(`state state:${LATEST} ${live.digest} cursor ${cursor === null ? 'none' : canonicalJson(cursor)}`);
    const { digest: rootDigest, root } = await readRootJson(d.reader, LATEST, d);
    d.out(`root root:${LATEST} ${rootDigest} root_seq ${root.root_seq} psl ${root.psl}`);
    const hosts = hostsOf(fetch, d);
    await hosts.listing();
    const { byDay, count } = tagsByDay(await buildTags('obs', 'day', d.reader, d), args.days);
    d.out(`tags ${count} ${SOURCE} tags of the window`);

    const { entries, refused } = await classify(args, { root, state, byDay, hosts });
    // The manifests: both of each day to adopt, and the one tag of a day to re-run.
    const wanted = entries.flatMap((e) => (e.action === 'adopt' ? [e.pair.names, e.pair.domains] : e.pslTag !== null ? [e.pslTag] : []));
    const manifests = await manifestsOf(d.reader, wanted, d);
    const ctx = { run: args.run, attempt: args.attempt, at: args.now };
    const adopted = new Map();
    for (const e of entries) {
      if (e.action === 'adopt') {
        const proposal = adoptProposal({ adapter: ADAPTER, rows, manifests: [manifests.get(e.pair.names), manifests.get(e.pair.domains)], state, ...ctx });
        adopted.set(e.day, { proposal, history: proposal.history[0] ?? null });
      } else if (e.action === 'run') e.psl = e.pslTag !== null ? pslOfManifest(manifests.get(e.pslTag)) : rootListOf(root, e.day);
    }
    const { history, holds } = replayBand(args, { state, entries, band: row.band, adopted });

    const byDayEntry = new Map(entries.map((e) => [e.day, e]));
    const problems = new Map([...refused, ...holds].map((p) => [p.day, p]));
    for (const day of args.days) {
      const p = problems.get(day);
      if (p !== undefined) {
        d.out(oneLine(`day ${day} ${p.code} ${p.detail}`));
        continue;
      }
      const e = byDayEntry.get(day);
      if (e.action === 'run') d.out(`day ${day} run ${e.bytes} ${e.host} ${e.verdict} psl ${e.psl.slice(0, 12)}`);
      else if (e.action === 'present') d.out(oneLine(`day ${day} present ${e.detail}`));
      else if (e.action === 'adopt') d.out(`day ${day} adopt ${e.pair.names} ${e.pair.domains}`);
      else d.out(`day ${day} gap`);
    }
    const legs = entries.filter((e) => e.action === 'run' && !problems.has(e.day));
    const gaps = entries.filter((e) => e.action === 'gap');
    if (problems.size > 0) {
      err(`thc-plan: ${problems.size} day(s) refused (${[...problems.keys()].join(', ')}); nothing is written, and no leg runs`);
      return EXIT.fault;
    }

    // The outputs.
    for (const sha of [...new Set(legs.map((e) => e.psl))].sort()) {
      await pslFile(d.reader, sha, args.out, d);
      d.out(`psl ${sha} ref:${refTag('psl', sha)}`);
    }
    const { history: _all, ...rest } = state;
    const others = Object.fromEntries(Object.entries(state.history).filter(([s]) => s !== SOURCE));
    const planned = { ...rest, history: history.length > 0 ? { ...others, [SOURCE]: history } : others };
    writeOut(join(args.out, 'state.json'), encodeState(planned), 'thc-plan');
    const days = args.days.map((day) => {
      const e = byDayEntry.get(day);
      return { day, action: e.action, bytes: e.bytes, host: e.host, verdict: e.verdict, path: e.path, psl: e.psl, tags: e.tags };
    });
    writeOut(join(args.out, 'plan.json'), `${JSON.stringify({ format: PLAN_FORMAT, from: args.from, to: args.to, now: args.now, state: live.digest, root: rootDigest, days })}\n`, 'thc-plan');
    writeOut(join(args.out, 'matrix.json'), `${JSON.stringify({ include: legs.map((e) => ({ day: e.day, psl: e.psl.slice(0, 12) })) })}\n`, 'thc-plan');
    const proposals = [...[...adopted].map(([day, a]) => [day, a.proposal]), ...gaps.map((e) => [e.day, gapProposal({ adapter: ADAPTER, gaps: [{ source: SOURCE, day: e.day }], state, ...ctx })])];
    if (proposals.length > 0) mkdirSync(join(args.out, 'proposals'), { recursive: true });
    for (const [day, p] of proposals) writeOut(join(args.out, 'proposals', proposalFile(ADAPTER, dayStart(day))), encodeProposal(p), 'thc-plan');
    d.out(`legs ${legs.length} adopted ${adopted.size} gaps ${gaps.length}`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`thc-plan: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof PrivateState || isNotPublic(e)) {
      d.out(PRIVATE_LINE);
      err(`thc-plan: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof HostFault) {
      err(oneLine(`thc-plan: ${e.host} ${e.code}: ${e.message}; nothing is planned`));
      return EXIT.usage;
    }
    if (e instanceof Fault) {
      err(oneLine(`thc-plan: FAIL ${e.message}`));
      return EXIT.fault;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`thc-plan: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
