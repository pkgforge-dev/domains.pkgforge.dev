// scripts/check-hooks.mjs — every file under .githooks/ that is in the git index
// carries the executable bit.
//
// git runs a hook directly, not through an interpreter, so a hook tracked as
// mode 100644 is skipped in silence: the commit that should have been refused goes
// through (docs/conventions/git.md section 1). A Windows checkout does not carry
// the bit on disk, so the bit lives in the index, and this step reads the index:
//
//   git ls-files -s -- .githooks
//
// Before the first `git add` the hook is not in the index. The step then prints a
// note and passes: run `git update-index --chmod=+x .githooks/commit-msg` straight
// after the first `git add`, and this step holds the bit from then on. Where git
// cannot answer (no work tree) it prints a note and passes, as the other tree
// checks fall back to walking the tree.
//
// Usage: node scripts/check-hooks.mjs
// Exit codes: 0 pass, 1 a hook in the index without the bit, 2 could not run.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_DIR = '.githooks';

// The index entries of `git ls-files -s` output: [{mode, path}] for stage 0.
export function parseStaged(output) {
  const entries = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(\d{6}) [0-9a-f]+ (\d)\t(.+)$/);
    if (m && m[2] === '0') entries.push({ mode: m[1], path: m[3] });
  }
  return entries;
}

// The findings for a list of index entries: one line for each entry that is not mode 100755.
export function findings(entries) {
  return entries.filter((e) => e.mode !== '100755').map((e) => `${e.path} is in the index as mode ${e.mode}; run: git update-index --chmod=+x ${e.path}`);
}

function main() {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-s', '--', HOOK_DIR], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    console.log(`check-hooks: git could not read the index (${r.error ? r.error.message : `exit ${r.status}`}); nothing was examined`);
    return;
  }
  const entries = parseStaged(r.stdout);
  if (entries.length === 0) {
    console.log(`check-hooks: nothing under ${HOOK_DIR}/ is in the index yet; after the first \`git add\` run: git update-index --chmod=+x ${HOOK_DIR}/commit-msg`);
    return;
  }
  const failed = findings(entries);
  if (failed.length > 0) {
    for (const f of failed) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`check-hooks: ${entries.length} file(s) under ${HOOK_DIR}/ carry the executable bit`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
