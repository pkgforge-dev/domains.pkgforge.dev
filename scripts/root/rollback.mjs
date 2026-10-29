// scripts/root/rollback.mjs — roll root:latest back to the packs of an older
// root (DOM-020, TODO/storage.md; docs/architecture.md section 8: "A rollback
// is a new root that names older packs"). It runs in the job `promote` of
// .github/workflows/root-promote.yml (the input `rollback_to`), in the
// concurrency group root-writer, like every move of latest.
//
// It builds a new root, never an old one again: root_seq the live one plus 1,
// previous the live digest, the datasets and gaps of the target (packages/root
// rollbackRoot), the live pin as psl, and the target's sources.json and
// coverage.json layers, which describe those datasets. The target must have
// been live once: it is on the chain of `previous` from the live root (a dated
// root pushed and never moved to latest is refused), and the roots that walk
// reads between the two are rollbackRoot's `between`. Its withdrawn lists each
// pack the live root or a root between names and the target does not (those
// roots created in the last 31 days), so a re-run of the promotion that added
// one is refused (buildRoot), a pack a compaction replaced since the target
// among them. root_seq never falls; as_of may fall to the target's. Then the
// same steps as a promotion
// (scripts/root/lib.mjs): every pack is held by a HEAD by digest, the guard,
// the dated push, the guard again, `oras tag`, and the read back. Nothing is
// deleted (AGENTS.md absolute 13): the newer packs stay in GHCR, unlisted.
//
// A re-run (GITHUB_RUN_ATTEMPT above 1) writes nothing: `unchanged`, exit 0,
// when the live root already names the target's datasets and gaps, and exit 1
// otherwise, since promotions may have landed after the first attempt. A
// rollback is dispatched again, never re-run.
//
// Usage:
//   node scripts/root/rollback.mjs --to r-YYYYMMDDtHHMMSSz
// Environment: as scripts/root/promote.mjs.
// Exit codes: as scripts/root/promote.mjs; a target that is not older than
// the live root or was never live, no live root, or a refused re-run is exit 1.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GhcrError, LATEST } from '@domains/ghcr';
import { canonical, createdOf, layerBytes, RootError, rollbackRoot } from '@domains/root';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { orasRunner } from '../ghcr/push.mjs';
import { RateLimitError, realSleep } from '../ghcr/rate.mjs';
import { EXIT, Fault, liveRoot, login, missingPacks, PrivateRoot, publish, ROOT_REF, readRoot, runAttempt, UsageError } from './lib.mjs';

const USAGE = 'usage: node scripts/root/rollback.mjs --to r-YYYYMMDDtHHMMSSz';
const DATED = /^r-\d{8}t\d{6}z$/;

function parse(argv) {
  if (argv.length === 1 && argv[0].startsWith('--to=')) argv = ['--to', argv[0].slice(5)];
  if (argv.length !== 2 || argv[0] !== '--to') throw new UsageError('give --to and the dated tag of the root to roll back to');
  if (!DATED.test(argv[1])) throw new UsageError(`--to ${JSON.stringify(argv[1])} is not a dated root tag r-YYYYMMDDtHHMMSSz`);
  return argv[1];
}

// The target was live once: it is on the chain of `previous` from the live
// root. Each root is its previous one's root_seq plus 1 (buildRoot and
// rollbackRoot alike), so the walk reads live minus target roots, each with no
// credential, and ends on the target's own digest or refuses. Returns the
// root.json of each root it read before the target, newest first: the roots
// between the live root and the target.
async function checkWasLive(reader, live, target, to, deps) {
  const walked = [];
  let at = live;
  for (let n = live.root.root_seq - target.root.root_seq; n > 0 && at.root.previous !== null; n--) {
    at = await readRoot(reader, at.root.previous, deps, { strict: false });
    walked.push(at.root);
  }
  if (at.digest !== target.digest) {
    throw new Fault(
      `the target ${to} (${target.digest}, root_seq ${target.root.root_seq}) was never live: the chain of previous from ${ROOT_REF}:${LATEST} holds ${at.digest} at root_seq ${at.root.root_seq}. latest is left as it is`,
    );
  }
  return walked.slice(0, -1);
}

async function rollbackIn(to, deps) {
  const { out, reader } = deps;
  const attempt = runAttempt(deps.env);
  const work = mkdtempSync(join(deps.tmp ?? deps.env.RUNNER_TEMP ?? tmpdir(), 'root-rollback-'));
  try {
    const config = await login(work, deps);
    const ctx = { deps, config, work, reader };
    const live = await liveRoot(reader, ctx);
    if (live === null) throw new Fault('root:latest does not exist: there is nothing to roll back');
    let target;
    try {
      target = await readRoot(reader, to, deps);
    } catch (e) {
      if (isNotPublic(e)) throw new Fault(`the target ${to} does not read with no credential: ${e.message}`);
      throw e;
    }
    out(`live root:latest ${live.digest} root_seq ${live.root.root_seq}; target ${to} ${target.digest} root_seq ${target.root.root_seq}`);
    // A re-run cannot tell whether promotions landed since the first attempt,
    // so it writes only what is already live: nothing.
    if (attempt > 1) {
      if (canonical(live.root.datasets) === canonical(target.root.datasets) && canonical(live.root.gaps) === canonical(target.root.gaps)) {
        out(`unchanged root:latest ${live.digest} root_seq ${live.root.root_seq} already names the datasets and gaps of ${to}: nothing written (re-run, attempt ${attempt})`);
        return EXIT.ok;
      }
      throw new Fault(
        `a re-run (attempt ${attempt}) of a rollback is refused: root:latest is root_seq ${live.root.root_seq}, which does not name the datasets and gaps of ${to}, and promotions may have landed since the first attempt. Dispatch the rollback again. latest is left as it is`,
      );
    }
    const between = await checkWasLive(reader, live, target, to, deps);
    const root = rollbackRoot({ live: { root: live.root, digest: live.digest }, target: target.root, between, psl: live.root.psl, now: createdOf(deps.now()) });
    const layers = { 'root.json': layerBytes(root), 'sources.json': target.layers['sources.json'], 'coverage.json': target.layers['coverage.json'] };
    out(`built root_seq ${root.root_seq} as_of ${root.as_of ?? 'none'} with the datasets of ${to}`);
    const missing = await missingPacks(reader, root, deps);
    if (missing.length > 0) throw new Fault(`the rolled-back root names ${missing.length} pack(s) GHCR does not hold, so latest is left as it is: ${missing.join('; ')}`);
    const result = await publish({ root, layers, expected: live.digest, live: live.root, rollback: true }, ctx);
    for (const line of result.lines) out(line);
    return result.code;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function main(argv, deps = {}) {
  try {
    return await run(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`rollback: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function run(argv, deps) {
  const err = deps.err ?? console.error;
  const out = deps.out ?? console.log;
  const env = deps.env ?? process.env;
  try {
    const to = parse(argv);
    if (!env.GITHUB_ACTOR) throw new UsageError('GITHUB_ACTOR is not set: the login is the workflow actor');
    if (!env.REGISTRY_TOKEN) throw new UsageError("REGISTRY_TOKEN is not set: give the job's own GITHUB_TOKEN through env");
    return await rollbackIn(to, {
      env,
      out,
      err,
      reader: deps.reader ?? anonymousReader(),
      oras: deps.oras ?? orasRunner(),
      sleep: deps.sleep ?? realSleep,
      random: deps.random ?? Math.random,
      now: deps.now ?? Date.now,
      tmp: deps.tmp,
      log: (line) => err(`rollback: ${line}`),
    });
  } catch (e) {
    if (e instanceof UsageError) {
      err(`rollback: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof PrivateRoot) {
      out(PRIVATE_LINE);
      err(`rollback: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof Fault || e instanceof RootError || e instanceof RateLimitError || e instanceof GhcrError) {
      err(`rollback: ${e.message}`);
      return EXIT.fault;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
