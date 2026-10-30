// scripts/root/promote.mjs — move root:latest forward (DOM-020,
// TODO/storage.md; docs/architecture.md sections 4.6 and 4.7). The one job
// that runs it is `promote` of .github/workflows/root-promote.yml, in the
// concurrency group root-writer (ruling 18), so two promotions never run at once.
//
// The steps:
//   1. read root:latest with no credential, as a consumer does, and its three
//      layers. When it reads as absent, read latest with the job's token: absent
//      too is the first promotion, and the first root is root_seq 1, previous
//      null, as_of null, with no dataset unless --add names packs; present is a
//      root that does not read publicly, exit 4 and nothing written;
//   2. read each --add and each new pack of --replace: its manifest with no
//      credential and its index head by range, and the head of its time copy's
//      index too when it carries one (scripts/root/lib.mjs packFacts);
//      a re-run (GITHUB_RUN_ATTEMPT above 1) drops every one the live root
//      already names or supersedes (section 4.7 rule 4);
//   3. with --partial, keep the additions the live-set rule allows (keepLiveSet
//      below) and print each other one as `waiting PKG:TAG: <the rule's
//      message>`; the replacements are applied whole, as without it;
//   4. build the next root (packages/root buildRoot): root_seq the live one
//      plus 1, previous the live digest, the live-set rule held, as_of never
//      below the live one; and the sources.json and coverage.json layers;
//   5. check that every pack the next root names has a manifest, by an
//      anonymous HEAD by digest; a missing one is exit 1;
//   6. the guard, the dated push with scripts/ghcr/push.mjs under
//      rootTag(created), the guard again, `oras tag` to latest, and the read
//      back as a consumer reads it (lib.mjs publish).
// A promotion that changes nothing (no pack, the same PSL, gaps and coverage,
// and the same sources.json layer: registry rows and fetched times) prints
// `unchanged` and writes nothing; so does one whose every addition waits.
//
// --partial (DOM-024, the Decision of 2026-10-30): the job `promote` of
// .github/workflows/ingest-live.yml adds every pack that state owes, and one
// owed pack across a hole (a day source's last day, and a stream's first
// window hours later) would refuse the whole promotion, and every later one,
// until a pack covers the hole or the item expires (OWED_DAYS of
// @domains/state). With --partial the promotion adds the --add packs that
// the live-set rule allows (checkLiveSet of packages/root,
// docs/architecture.md section 4.5): every one when the root with all of them
// passes, and otherwise one at a time, each kept when the rule holds with the
// kept ones and it, in passes until a pass keeps none, since one pack can
// close the hole another needs (keepLiveSet). A pack the rule refuses waits:
// it stays owed in state, and a later run adds it again. Only the live-set
// refusal waits: a missing pack, a quarantined manifest, a withdrawn one, a
// refused replacement, the guard and every other fault exit as without
// --partial. Without --partial a root the rule refuses is refused whole, exit
// 1, so an operator's promotion is never cut down. --partial applies to the
// additions alone: each replacement spans what it replaces, so it opens no
// hole, and the replacements are built first, whole, and refused whole.
//
// psl is the sha256 of the list pinned at promotion: the
// dev.pkgforge.domains.sha256 annotation of the ref package's --psl
// psl-<sha12>, checked against its one layer, or the live root's when --psl is
// not given. The first root needs --psl. psl_live is derived from the live
// packs' own dev.pkgforge.domains.psl (ruling 22).
//
// The full verification of a pack (scripts/verify-pack.mjs, section 5.8) is
// the duty of the job that wrote it, before this one runs, and nothing here
// checks that it ran: this script reads a pack's manifest and index heads and
// holds them to each other, not every block; that a time copy holds exactly
// the rows of its key copy is the verifier's `time` check. A manifest that carries
// dev.pkgforge.domains.quarantine is refused (packFromManifest).
//
// --fixture NAME runs one synthetic case against the GHCR double of
// scripts/root/fixture.mjs, in this process, with no network and no token:
// `stale` plants a second writer that moves latest after this run read it, and
// exits 1 with latest as that writer left it and no tag written.
//
// Usage:
//   node scripts/root/promote.mjs [--add PKG:TAG]... [--replace OLD[,OLD...]=NEW]... [--psl psl-SHA12]
//                                 [--gap SOURCE=YYYY-MM-DD]... [--fetched SOURCE=TIME]... [--coverage FILE] [--sources FILE]
//                                 [--partial]
//   node scripts/root/promote.mjs --fixture stale
// PKG:TAG names a pack of ghcr.io/pkgforge-dev/domains.pkgforge.dev/PKG by its
// tag (names:names-d-20261026, obs:thc-ct.20261026.0232f4df0831). --sources is
// the registry, default config/sources.json; --coverage the coverage table,
// default the live root's. --partial takes no value.
// stdout, one line each: `live`; on a re-run, `dropped` for each pack the
// live root names or supersedes; with --partial, `waiting PKG:TAG: MESSAGE`
// for each addition that waits; then `unchanged`, or `built`, push.mjs's own
// lines and `latest`.
// Environment: GITHUB_ACTOR and REGISTRY_TOKEN (the job's GITHUB_TOKEN, to oras
// on stdin only), GITHUB_RUN_ATTEMPT, GITHUB_RUN_ID, ORAS, RUNNER_TEMP.
// Exit codes: 0 promoted and read back, or unchanged · 1 a fault or a refusal
// (the guard: latest moved, or the root is not above the live one; a pack
// GHCR does not hold; a root the live-set rule refuses, without --partial or
// for its replacements; a read-back that differs) · 2 could not run (usage,
// no token, a registry or coverage file that does not read) · 3 the dated tag
// holds another manifest · 4 PRIVATE PACKAGE: the root does not read with no
// credential · 70 an internal error, a defect of this script (its stack goes
// to stderr).
import { readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { artifactType, GhcrError, LayoutError, NAMESPACE, refTag, repoOf } from '@domains/ghcr';
import { buildRoot, canonical, checkLiveSet, comparePacks, createdOf, dropSuperseded, EMPTY_COVERAGE, layerBytes, RootError, sourcesLayer } from '@domains/root';
import { anonymousReader, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { orasRunner } from '../ghcr/push.mjs';
import { RateLimitError, readPaused, realSleep } from '../ghcr/rate.mjs';
import { DEFAULT_SOURCES, loadRegistry } from '../verify-pack.mjs';
import { EXIT, Fault, liveRoot, login, missingPacks, packFacts, parsePackRef, PrivateRoot, publish, runAttempt, tempDir, UsageError } from './lib.mjs';

export { EXIT };
const USAGE =
  'usage: node scripts/root/promote.mjs [--add PKG:TAG]... [--replace OLD[,OLD...]=NEW]... [--psl psl-SHA12] [--gap SOURCE=YYYY-MM-DD]... [--fetched SOURCE=TIME]... [--coverage FILE] [--sources FILE] [--partial] | --fixture NAME';
const REPEATED = new Set(['--add', '--replace', '--gap', '--fetched']);
const SINGLE = new Set(['--psl', '--coverage', '--sources', '--fixture']);
// A flag of no value.
const SWITCH = new Set(['--partial']);
// Packs read at once in step 2.
export const READ_CONCURRENCY = 4;
const PSL_TITLE = 'public_suffix_list.dat';
const SHA_ANNOTATION = 'dev.pkgforge.domains.sha256';

// The plan from argv, or UsageError.
export function parsePromoteArgs(argv) {
  const o = { add: [], replace: [], gap: [], fetched: [], psl: null, coverage: null, sources: null, fixture: null, partial: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq !== -1 ? a.slice(0, eq) : a;
    if (SWITCH.has(name)) {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
      if (o.partial) throw new UsageError(`${name} is given twice`);
      o.partial = true;
      continue;
    }
    if (!REPEATED.has(name) && !SINGLE.has(name)) throw new UsageError(a.startsWith('--') ? `unknown flag ${name}` : `${JSON.stringify(a)} is not a flag; every value follows its flag`);
    const value = a.startsWith('--') && eq !== -1 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') throw new UsageError(`${name} needs a value`);
    const key = name.slice(2);
    if (REPEATED.has(name)) o[key].push(value);
    else if (o[key] !== null) throw new UsageError(`${name} is given twice`);
    else o[key] = value;
  }
  if (o.fixture !== null && argv.length !== 2) throw new UsageError('--fixture NAME takes no other flag');
  for (const ref of o.add) parsePackRef(ref);
  const replace = o.replace.map((r) => {
    const k = r.lastIndexOf('=');
    const old = k > 0 ? r.slice(0, k).split(',') : [];
    const to = k > 0 ? r.slice(k + 1) : '';
    if (old.length === 0 || to === '') throw new UsageError(`--replace ${JSON.stringify(r)} is not OLD[,OLD...]=NEW`);
    for (const ref of [...old, to]) parsePackRef(ref);
    return { old, new: to };
  });
  const gaps = {};
  for (const g of o.gap) {
    const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)=(\d{4}-\d{2}-\d{2})$/.exec(g);
    if (m === null) throw new UsageError(`--gap ${JSON.stringify(g)} is not SOURCE=YYYY-MM-DD`);
    gaps[m[1]] = [...new Set([...(gaps[m[1]] ?? []), m[2]])].sort();
  }
  const fetched = {};
  for (const f of o.fetched) {
    const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(f);
    if (m === null || Object.hasOwn(fetched, m[1])) throw new UsageError(`--fetched ${JSON.stringify(f)} is not SOURCE=YYYY-MM-DDTHH:MM:SSZ, once a source`);
    fetched[m[1]] = m[2];
  }
  if (o.psl !== null && !/^psl-[0-9a-f]{12}$/.test(o.psl)) throw new UsageError(`--psl ${JSON.stringify(o.psl)} is not a tag psl-<12 hex> of the ref package`);
  return { add: o.add, replace, gaps, fetched, psl: o.psl, coverage: o.coverage, sources: o.sources ?? DEFAULT_SOURCES, fixture: o.fixture, partial: o.partial };
}

// PKG:TAG of a pack entry.
const refOf = (p) => `${p.repo.slice(NAMESPACE.length + 1)}:${p.tag}`;
const liveSetRefusal = (e) => e instanceof RootError && e.code === 'live-set';

// The additions of --partial (the header): { add, waiting }. `input` is
// buildRoot's: { live, add, replace, psl, now, gaps }. `add` keeps the order
// it was given in; `waiting` is [{ ref, message }], each addition the
// live-set rule refuses beside the kept ones, with the rule's message, in
// the order given.
//
// The root with every addition is built first: when it passes, or fails
// otherwise than by the live-set rule, that is the answer, as without
// --partial. Then the root with no addition (the replacements alone, which
// throw as without --partial). Each addition is then tried against that
// root's datasets and the additions kept so far, by checkLiveSet of its
// dataset (the rule as validateRoot holds it, one dataset at a time) and by
// the manifests the root names, so a try costs one dataset, not one root.
// The passes go in span order, then against it, and again until a pass keeps
// none: a run of additions after the live packs is kept in one pass, and a
// run before them in the next. The caller builds the root with the kept ones,
// which validateRoot holds whole.
//
// No waiting addition can join the kept ones. The kept set is the largest
// one when no two additions overlap and each dataset has a live pack;
// otherwise the order of the passes picks which of two overlapping
// additions, or of two runs of additions apart in a dataset with no live
// pack, is kept.
export function keepLiveSet(input) {
  try {
    buildRoot(input);
    return { add: input.add, waiting: [] };
  } catch (e) {
    if (!liveSetRefusal(e)) throw e;
  }
  const base = buildRoot({ ...input, add: [] });
  const lists = new Map(Object.entries(base.datasets).map(([ds, packs]) => [ds, [...packs]]));
  const manifests = new Set(Object.values(base.datasets).flatMap((packs) => packs.map((p) => p.manifest)));
  const join = ({ dataset, pack }) => {
    if (manifests.has(pack.manifest)) throw new RootError('live-set', `datasets.${dataset}: ${refOf(pack)} names the manifest ${pack.manifest}, which the root names already`);
    const list = [...(lists.get(dataset) ?? []), pack].sort(comparePacks);
    checkLiveSet(dataset, list);
    lists.set(dataset, list);
    manifests.add(pack.manifest);
  };
  const kept = [];
  const why = new Map();
  // One PKG:TAG given twice is one addition: the second copy is dropped, never
  // reported as waiting on the first. Two refs of one manifest stay two.
  const given = new Set();
  const once = input.add
    .map((np, i) => ({ np, i }))
    .filter(({ np }) => {
      const key = `${refOf(np.pack)} ${np.pack.manifest}`;
      if (given.has(key)) return false;
      given.add(key);
      return true;
    });
  let pending = once.sort((a, b) => comparePacks(a.np.pack, b.np.pack) || a.i - b.i);
  for (let moved = true; moved; ) {
    moved = false;
    const still = [];
    for (const c of pending) {
      try {
        join(c.np);
        kept.push(c);
        moved = true;
      } catch (e) {
        if (!liveSetRefusal(e)) throw e;
        why.set(c.i, e.message);
        still.push(c);
      }
    }
    // The next pass goes the other way.
    pending = still.reverse();
  }
  const byIndex = (a, b) => a.i - b.i;
  return { add: kept.sort(byIndex).map((k) => k.np), waiting: pending.sort(byIndex).map((c) => ({ ref: refOf(c.np.pack), message: why.get(c.i) })) };
}

// The sha256 the ref package's `tag` pins: its dev.pkgforge.domains.sha256
// annotation, which must be the digest of its one layer, the list, and whose
// first 12 digits are the tag's.
export async function pinnedPsl(reader, tag, deps = {}) {
  const repo = repoOf('ref');
  const m = await readPaused(`the manifest ${tag} of ${repo}`, () => reader.getManifest(repo, tag), deps);
  const sha = m.json.annotations?.[SHA_ANNOTATION];
  const layers = m.json.layers ?? [];
  const at = `ghcr.io/${repo}:${tag}`;
  if (m.json.artifactType !== artifactType('ref')) throw new Fault(`${at} is ${JSON.stringify(m.json.artifactType ?? null)}, not a ref`);
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) throw new Fault(`${at} has no ${SHA_ANNOTATION} of 64 hex digits`);
  if (layers.length !== 1 || layers[0].annotations?.['org.opencontainers.image.title'] !== PSL_TITLE || layers[0].digest !== `sha256:${sha}`) {
    throw new Fault(`${at} does not hold one layer ${PSL_TITLE} whose digest is its ${SHA_ANNOTATION}`);
  }
  let named;
  try {
    named = refTag('psl', sha);
  } catch (e) {
    if (e instanceof LayoutError) throw new Fault(e.message);
    throw e;
  }
  if (named !== tag) throw new Fault(`${at} pins ${sha}, whose tag is ${named}`);
  return sha;
}

// `fn` over `items`, `n` at a time, in order.
async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const readJsonFile = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`${what} ${path} does not read as JSON: ${e.message}`);
  }
};

function registryRows(path) {
  try {
    return loadRegistry(path);
  } catch (e) {
    throw new UsageError(`the registry ${path} does not validate: ${e.message}`);
  }
}

// The live gaps with --gap's days added.
function mergeGaps(live, extra) {
  const out = {};
  for (const [id, days] of Object.entries({ ...live })) out[id] = [...days];
  for (const [id, days] of Object.entries(extra)) out[id] = [...new Set([...(out[id] ?? []), ...days])].sort();
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// One promotion, past its arguments; throws UsageError, Fault, PrivateRoot,
// RootError, GhcrError or RateLimitError, each mapped to its exit by main.
async function promoteIn(plan, deps) {
  const { out, reader } = deps;
  const registry = registryRows(plan.sources);
  const coverage = plan.coverage === null ? null : readJsonFile(plan.coverage, 'the coverage table');
  if (coverage !== null && (typeof coverage !== 'object' || Array.isArray(coverage))) throw new UsageError(`the coverage table ${plan.coverage} is not a JSON object`);
  const attempt = runAttempt(deps.env);
  const work = tempDir(deps.tmp ?? deps.env.RUNNER_TEMP, 'root-promote-');
  try {
    const config = await login(work, deps);
    const ctx = { deps, config, work, reader };
    const live = await liveRoot(reader, ctx);
    out(live === null ? 'live none: root:latest does not exist; this is the first root' : `live root:latest ${live.digest} root_seq ${live.root.root_seq} as_of ${live.root.as_of ?? 'none'}`);
    const psl = plan.psl !== null ? await pinnedPsl(reader, plan.psl, deps) : (live?.root.psl ?? null);
    if (psl === null) throw new UsageError('the first root needs --psl psl-<sha12>, the list the ref package pins');
    let add = await mapPool(plan.add, READ_CONCURRENCY, (ref) => packFacts(reader, ref, deps));
    const news = await mapPool(plan.replace, READ_CONCURRENCY, (r) => packFacts(reader, r.new, deps));
    // An old pack is named by its repository and tag in the live root; one the
    // live root does not hold stays as its ref, and buildRoot refuses it.
    const liveDigest = (ref) => {
      const { repo, tag } = parsePackRef(ref);
      for (const packs of Object.values(live?.root.datasets ?? {})) for (const p of packs) if (p.repo === repo && p.tag === tag) return p.manifest;
      return ref;
    };
    let replace = plan.replace.map((r, i) => ({ old: r.old.map(liveDigest), new: news[i] }));
    if (attempt > 1) {
      const kept = dropSuperseded(live?.root ?? null, add, replace);
      for (const d of kept.dropped) out(`dropped ${d.tag} ${d.manifest}: ${d.why} (re-run, attempt ${attempt})`);
      add = kept.add;
      replace = kept.replace;
    }
    const gaps = mergeGaps(live?.root.gaps ?? {}, plan.gaps);
    const now = createdOf(deps.now());
    if (plan.partial && add.length > 0) {
      const kept = keepLiveSet({ live: live === null ? null : { root: live.root, digest: live.digest }, add, replace, psl, now, gaps });
      for (const w of kept.waiting) out(`waiting ${w.ref}: ${w.message}`);
      add = kept.add;
    }
    const sameCoverage = coverage === null || (live !== null && canonical(coverage) === canonical(live.coverage));
    // The sources.json layer the live root would carry now: the registry and
    // the fetched times, each compared, so a change of either alone is written.
    const sameSources = () => canonical(sourcesLayer({ registry, root: live.root, previous: live.sources, fetched: plan.fetched })) === canonical(live.sources);
    if (live !== null && add.length === 0 && replace.length === 0 && psl === live.root.psl && canonical(gaps) === canonical(live.root.gaps) && sameCoverage && sameSources()) {
      out(`unchanged root:latest ${live.digest} root_seq ${live.root.root_seq}: nothing to promote, nothing written`);
      return EXIT.ok;
    }
    const root = buildRoot({ live: live === null ? null : { root: live.root, digest: live.digest }, add, replace, psl, now, gaps });
    const layers = {
      'root.json': layerBytes(root),
      'sources.json': layerBytes(sourcesLayer({ registry, root, previous: live?.sources ?? null, fetched: plan.fetched })),
      'coverage.json': layerBytes(coverage ?? live?.coverage ?? EMPTY_COVERAGE),
    };
    const packs = Object.values(root.datasets).reduce((a, l) => a + l.length, 0);
    out(`built root_seq ${root.root_seq} as_of ${root.as_of ?? 'none'} created ${root.created} previous ${root.previous ?? 'none'} psl ${root.psl} psl_live ${root.psl_live.length} packs ${packs}`);
    const missing = await missingPacks(reader, root, deps);
    if (missing.length > 0) throw new Fault(`the next root names ${missing.length} pack(s) GHCR does not hold, so latest is left as it is: ${missing.join('; ')}`);
    const result = await publish({ root, layers, expected: live?.digest ?? null, live: live?.root ?? null }, ctx);
    for (const line of result.lines) out(line);
    return result.code;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// An error promote does not know is a defect, exit 70: never 1, 3 or 4, which
// are verdicts a caller acts on.
export async function main(argv, deps = {}) {
  try {
    return await run(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`promote: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function run(argv, deps) {
  const err = deps.err ?? console.error;
  const out = deps.out ?? console.log;
  let plan;
  try {
    plan = parsePromoteArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`promote: ${e.message}\n${USAGE}`);
    return EXIT.usage;
  }
  if (plan.fixture !== null) {
    const { runFixture } = await import('./fixture.mjs');
    return runFixture(plan.fixture, main, { out, err });
  }
  const env = deps.env ?? process.env;
  const full = {
    env,
    out,
    err,
    reader: deps.reader ?? anonymousReader(),
    oras: deps.oras ?? orasRunner(),
    sleep: deps.sleep ?? realSleep,
    random: deps.random ?? Math.random,
    now: deps.now ?? Date.now,
    tmp: deps.tmp,
    log: (line) => err(`promote: ${line}`),
  };
  try {
    if (!env.GITHUB_ACTOR) throw new UsageError('GITHUB_ACTOR is not set: the login is the workflow actor');
    if (!env.REGISTRY_TOKEN) throw new UsageError("REGISTRY_TOKEN is not set: give the job's own GITHUB_TOKEN through env");
    return await promoteIn(plan, full);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`promote: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof PrivateRoot) {
      out(PRIVATE_LINE);
      err(`promote: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof Fault || e instanceof RootError || e instanceof RateLimitError || e instanceof GhcrError) {
      err(`promote: ${e.message}`);
      return EXIT.fault;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
