// Dry historical reconstruction of exact daily feeds and the live spans
// that cover them. The plan reads historic roots anonymously. The build
// verifies a caller's local archive, emits local artifacts, and never pushes.
//
//   node scripts/compact/history.mjs plan --ref DIGEST --inventory FILE --edges FILE --from DAY --to DAY --out DIR
//   node scripts/compact/history.mjs collect --plan FILE --out ARCHIVE_DIR [--preflight]
//   node scripts/compact/history.mjs build --plan FILE --inputs DIR --out DIR [--sources FILE] [--run ID]
//
// Dates are UTC, inclusive, and must cover every complete live target span.
// The inventory lists manifest digests, annotations, repository and tag.
// The edge file gives digest pairs `before` and `after`, and `planAnchor`
// when the original compaction planned before the immediate predecessor.
// Read each archive entry from the plan's earlier/replay fields as
// DIR/<tag>/manifest.json and its key and required facts files by layer title.
// Every file used is checked by SHA-256. Unused raw, time and summary blobs
// can remain in the archive. To prove an original target can be retained,
// also save its OCI manifest bytes by the repository and digest in
// plan.targets into the same directory layout. A build's NDJSON gives the
// feed records that moved, disappeared or changed. The report gives the
// candidate replacement pack and every old live manifest it would replace.
// Later and provisional feed packs stay unresolved in `downstream`.
// Collect reads the immutable manifests anonymously. Preflight also checks
// existing archive files and counts the missing bytes and ranges without
// fetching blobs or writing files. Collect itself can reuse verified files.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompactError, WORKFLOW_RUN_ID } from '@domains/compact';
import { GhcrError } from '@domains/ghcr';
import { PackError } from '@domains/pack';
import { RootError } from '@domains/root';
import { anonymousReader } from '../ghcr/check-public.mjs';
import { RateLimitError } from '../ghcr/rate.mjs';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { Fault, UsageError } from '../root/lib.mjs';
import { DEFAULT_SOURCES, ghcrFormReader } from '../verify-pack.mjs';
import { buildHistory } from './history-build.mjs';
import { collectHistory } from './history-collect.mjs';
import { planHistory } from './history-plan.mjs';
import { registryOf } from './hour.mjs';
import { checkOutDir, freshDir } from './plan.mjs';

const FIELDS = Object.freeze({ plan: ['ref', 'inventory', 'edges', 'from', 'to', 'out'], collect: ['plan', 'out'], build: ['plan', 'inputs', 'out'] });
const digestOf = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function argumentsOf(argv) {
  const [op, ...flags] = argv;
  if (!Object.hasOwn(FIELDS, op)) throw new UsageError('give a plan, collect or build operation');
  const args = parseArgs(flags);
  const repeated = repeatedFlag(args);
  if (repeated !== null) throw new UsageError(`--${repeated} is given twice`);
  const required = FIELDS[op];
  const optional = op === 'build' ? ['sources', 'run'] : [];
  for (const k of required) if (typeof args[k] !== 'string' || args[k].length === 0) throw new UsageError(`--${k} needs a value`);
  for (const k of Object.keys(args)) {
    if (k === '_') continue;
    if (op === 'collect' && k === 'preflight') {
      if (args[k] !== true) throw new UsageError('--preflight takes no value');
      continue;
    }
    if (!required.includes(k) && !optional.includes(k)) throw new UsageError(`unknown flag --${k}`);
    if (typeof args[k] !== 'string' || args[k].length === 0) throw new UsageError(`--${k} needs a value`);
  }
  if (args._.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(args._[0])}`);
  checkOutDir(args.out, '--out');
  return { op, args };
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`${what} ${path} cannot be read as JSON: ${e.message}`);
  }
}

function writeJson(out, name, value) {
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function readPlan(path) {
  const saved = readJson(path, 'history plan');
  if (saved === null || typeof saved !== 'object' || saved.plan === null || typeof saved.plan !== 'object') throw new UsageError('the history plan has no plan object');
  if (saved.id !== digestOf(saved.plan)) throw new Fault('the history plan digest does not match its contents');
  return saved;
}

export async function main(argv, { reader, out = console.log, err = console.error, env = process.env } = {}) {
  try {
    const { op, args } = argumentsOf(argv);
    if (op === 'plan') {
      const inventory = readJson(args.inventory, 'archive inventory');
      const hints = readJson(args.edges, 'root edges');
      const plan = await planHistory({ ref: args.ref, from: args.from, to: args.to, hints, inventory }, reader ?? anonymousReader(), { log: err });
      freshDir(args.out, 'history plan');
      const id = digestOf(plan);
      writeJson(args.out, 'history-plan.json', { id, plan });
      out(`planned ${plan.replay.length} days and ${plan.targets.length} original spans from root_seq ${plan.root.seq}; ${plan.downstream.length} later feed packs need reconciliation`);
    } else if (op === 'collect') {
      const saved = readPlan(args.plan);
      const report = await collectHistory(saved.plan, args.out, reader ?? ghcrFormReader(), { preflight: args.preflight === true, log: err });
      out(JSON.stringify({ plan: saved.id, ...report }));
    } else {
      const saved = readPlan(args.plan);
      const run = args.run ?? env.GITHUB_RUN_ID;
      if (typeof run !== 'string' || !WORKFLOW_RUN_ID.test(run)) throw new UsageError('give the numeric pack run with --run or GITHUB_RUN_ID');
      const registry = registryOf(args.sources ?? DEFAULT_SOURCES);
      freshDir(args.out, 'history build');
      const result = await buildHistory(saved.plan, args.inputs, args.out, registry, { run, log: out });
      writeJson(args.out, 'history-build.json', { plan: saved.id, ...result });
      out(`built ${result.replacements.length} unpublished replacements; ${result.downstream.length} later feed packs remain unverified`);
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError || (e instanceof CompactError && e.code === 'usage') || ['ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR'].includes(e?.code)) {
      err(`history: ${e.message}`);
      return 2;
    }
    if (e instanceof Fault || e instanceof PackError || e instanceof CompactError || e instanceof RootError || e instanceof GhcrError || e instanceof RateLimitError) {
      err(`history: FAIL ${e.message}`);
      return 1;
    }
    err(`history: internal error: ${e?.stack ?? e}`);
    return 70;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
