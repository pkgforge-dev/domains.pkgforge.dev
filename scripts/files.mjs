// scripts/files.mjs — the file list the tree checks read.
//
// Git answers when it can: tracked files plus untracked files that
// `--exclude-standard` keeps. Without a git work tree (a tarball, a copy) the
// tree is walked instead, skipping the roots `.gitignore` excludes.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp', '.env', 'dist', 'coverage']);
const skipDir = (n) => SKIP_DIRS.has(n) || n.startsWith('.wrangler');

function walkTree() {
  const out = [];
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!skipDir(e.name)) visit(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(relative(ROOT, join(dir, e.name)).split(sep).join('/'));
      }
    }
  };
  visit(ROOT);
  return out;
}

// mode 'all': every tracked and new file. mode 'staged': files staged for commit.
export function listFiles(mode) {
  const args = mode === 'staged' ? ['-C', ROOT, 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'] : ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  try {
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { files: out.split('\0').filter((p) => p.length > 0), walked: false };
  } catch {
    if (mode === 'staged') return { files: [], walked: false };
    return { files: walkTree(), walked: true };
  }
}
