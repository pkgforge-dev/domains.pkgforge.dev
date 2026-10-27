// scripts/lib/gated.mjs — the gate's record of what it passed. What the gate ran
// on is named by the git tree of the working files as `git add -A` would stage
// them (tracked and untracked, ignored ones left out), written through a copy of
// the index so the real one is untouched. That is the tree a commit of those
// files holds, so a commit made from them has that tree, and `HEAD^{tree}` names
// it again later.
//
// The record is `.tmp/gate-passes.jsonl`: gitignored, appended to, a line a pass:
// `{tree, head, at, node}`. It is what a gate run says of itself, not a ledger.
// A later deploy script reads it to refuse a tree no gate passed.
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function git(args, cwd, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(r.stderr ?? '').trim() || `exit ${r.status}`}`);
  return r.stdout.trim();
}

export const passesFile = (root) => join(root, '.tmp', 'gate-passes.jsonl');

// The tree of the working files under `root`, as a commit of all of them holds it.
export function filesTree(root) {
  const index = resolve(root, git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], root));
  const dir = mkdtempSync(join(tmpdir(), 'domains-gate-index-'));
  try {
    const copy = join(dir, 'index');
    if (existsSync(index)) copyFileSync(index, copy);
    git(['add', '-A'], root, { GIT_INDEX_FILE: copy });
    return git(['write-tree'], root, { GIT_INDEX_FILE: copy });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function recordPass(root, { tree, head, node = process.version, at = new Date().toISOString() }) {
  const file = passesFile(root);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ tree, head, at, node })}\n`);
  return file;
}

// Every pass the record of `root` holds, oldest first; none when it is absent.
export function passesOf(root) {
  let text = '';
  try {
    text = readFileSync(passesFile(root), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      if (typeof p?.tree === 'string') out.push(p);
    } catch {
      /* a torn line is no pass */
    }
  }
  return out;
}

// The newest pass of `tree`, or null.
export function passOf(root, tree) {
  return passesOf(root).findLast((p) => p.tree === tree) ?? null;
}
