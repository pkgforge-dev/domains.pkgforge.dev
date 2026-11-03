// DOM-030 instrument (gate part (c) of D16), copied from .tmp/dom030/review-d16/mutation/sync-fix.mjs
// as it ran, with this header added. Its paths point at that gitignored directory and at its
// copy of the tree, so it runs from there. The lens wrote setup, lib, canary and mutants; the fix
// pass wrote sync-fix, rerun-fix, rerun-cwd and summary (TODO/serve.md, DOM-030).
// Scratch of the D16 fix pass: bring the mutation copy to the worktree's files after the fixes.
// It copies each tracked or new file (git ls-files -co --exclude-standard) that differs from the
// copy's, and never touches node_modules or .tmp. It writes nothing in the real tree.
//   node sync-fix.mjs          copy the files that differ, and list them
//   node sync-fix.mjs --check  list them only; exit 1 when any differs
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const REAL = "D:/_WORK_/domains-serve/";
const COPY = "D:/_WORK_/domains-serve/.tmp/dom030/review-d16/mutation/copy/";
const check = process.argv.includes("--check");
const files = execFileSync("git", ["-C", REAL, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && !f.startsWith("node_modules/") && !f.startsWith(".tmp/") && existsSync(REAL + f));
const differ = [];
for (const f of files) {
  const a = readFileSync(REAL + f);
  const b = existsSync(COPY + f) ? readFileSync(COPY + f) : null;
  if (b !== null && a.equals(b)) continue;
  differ.push(f);
  if (!check) {
    mkdirSync(dirname(COPY + f), { recursive: true });
    copyFileSync(REAL + f, COPY + f);
  }
}
console.log(JSON.stringify({ files: files.length, differ }));
process.exit(check && differ.length > 0 ? 1 : 0);
