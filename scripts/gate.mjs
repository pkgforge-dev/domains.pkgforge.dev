// scripts/gate.mjs — the mechanical gate: part (a) of the gate in
// docs/methodology/gate.md, as TODO/RULES.md §1 names it.
//
// Runs every mechanical check, one child process per step, with stdout
// inherited and each exit code read from the process that produced it, never
// from the end of a pipe. A failing step does not stop later steps; the run
// fails if any step failed. A step marked `warn` prints WARN on failure and
// fails nothing.
//
// A run whose every step passed is recorded as the pass of the tree it ran on
// (scripts/lib/gated.mjs), the tree read before and after the steps: a file
// changed during the run records nothing. A later deploy script refuses a tree
// with no pass. Recording never fails the gate.
//
// Usage:
//   node scripts/gate.mjs            the steps below
//   node scripts/gate.mjs --install  `npm ci` first, for a fresh checkout
//
// Exit codes: 0 every step passed, 1 a step failed, 2 a step could not start.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { filesTree, recordPass } from './lib/gated.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// `npm` is a `.cmd` shim on Windows and needs a shell there; `node` steps never do.
const win = process.platform === 'win32';
const node = (args) => ({ name: `node ${args.join(' ')}`, cmd: process.execPath, args, shell: false });
const npm = (args) => ({ name: `npm ${args.join(' ')}`, cmd: 'npm', args, shell: win });

// Order: the record first (cheapest, and the one a session most often breaks),
// then the suites, then the formatter and linter, then the type check, then the
// tree-wide text and secret sweeps. TODO/RULES.md §1 lists the same steps, and
// gate.test.mjs holds the two lists equal.
export const STEPS = [
  node(['scripts/todo/check.mjs']),
  node(['scripts/todo/count.mjs', '--check']),
  npm(['test']),
  // One formatter and linter for JavaScript and TypeScript, biome.json its rules.
  npm(['run', 'lint']),
  // tsc twice: tsconfig.json against Node's types, tsconfig.worker.json against
  // the Workers runtime's. Node strips the types and checks none of them.
  npm(['run', 'typecheck']),
  node(['scripts/text-check.mjs']),
  node(['scripts/scan-secrets.mjs', '--all']),
  // A hook tracked without the executable bit is skipped by git in silence.
  node(['scripts/check-hooks.mjs']),
];

function runStep(s) {
  console.log(`\n== ${s.name}`);
  // A shell step is spawned as one command string: an args array together with
  // `shell: true` is deprecated (DEP0190).
  const r = s.shell ? spawnSync(`${s.cmd} ${s.args.join(' ')}`, { cwd: ROOT, stdio: 'inherit', shell: true }) : spawnSync(s.cmd, s.args, { cwd: ROOT, stdio: 'inherit', shell: false });
  return { name: s.name, status: r.status, error: r.error, warn: s.warn === true };
}

// The tree the steps run on; null when git cannot name it.
const treeNow = () => {
  try {
    return filesTree(ROOT);
  } catch {
    return null;
  }
};

function main() {
  const before = treeNow();
  const steps = process.argv.includes('--install') ? [npm(['ci']), ...STEPS] : STEPS;
  const results = steps.map(runStep);

  let failed = false;
  let couldNotStart = false;
  console.log('');
  for (const r of results) {
    if (r.error) {
      console.error(`COULD NOT START ${r.name}: ${r.error.message}`);
      couldNotStart = true;
    } else if (r.status !== 0 && r.warn) {
      console.error(`WARN ${r.name} (exit ${r.status}): a warning, not a failure`);
    } else if (r.status !== 0) {
      console.error(`FAIL ${r.name} (exit ${r.status})`);
      failed = true;
    } else {
      console.log(`ok   ${r.name}`);
    }
  }
  if (couldNotStart) process.exit(2);
  if (failed) process.exit(1);
  console.log('\ngate: all steps passed');
  const after = treeNow();
  if (!before || before !== after) {
    console.log(`gate: no pass recorded: ${before ? 'the files changed during the run' : 'git could not name the tree'}`);
    return;
  }
  try {
    const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || null;
    recordPass(ROOT, { tree: before, head });
    console.log(`gate: pass recorded for tree ${before.slice(0, 12)} (${head ? `HEAD ${head.slice(0, 7)}` : 'no commit yet'} with the working files)`);
  } catch (e) {
    console.log(`gate: no pass recorded: ${e.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
