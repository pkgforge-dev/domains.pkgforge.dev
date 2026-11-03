// DOM-030 instrument (gate part (c) of D16), copied from .tmp/dom030/review-d16/mutation/setup.mjs
// as it ran, with this header added. Its paths point at that gitignored directory and at its
// copy of the tree, so it runs from there. The lens wrote setup, lib, canary and mutants; the fix
// pass wrote sync-fix, rerun-fix, rerun-cwd and summary (TODO/serve.md, DOM-030).
// Scratch: build the mutation copy of the worktree.
//   node setup.mjs
// copy/            the worktree's files (working tree, not HEAD), without .git, node_modules, .tmp, .wrangler*
// copy/node_modules   a real directory: a junction to each top-level entry of the worktree's node_modules,
//                     except @domains (each link points at the copy's package) and wrangler, miniflare,
//                     workerd, @cloudflare/workers-types, which are real copies so an installed pin can be mutated.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = "D:/_WORK_/domains-serve";
const HERE = `${ROOT}/.tmp/dom030/review-d16/mutation`;
const COPY = `${HERE}/copy`;

if (existsSync(COPY)) {
  // Never recurse through a junction: unlink the junctions of node_modules first.
  const nm = join(COPY, "node_modules");
  if (existsSync(nm)) {
    for (const e of readdirSync(nm, { withFileTypes: true })) {
      const p = join(nm, e.name);
      if (e.name === "@domains" || e.name === "@cloudflare") {
        for (const s of readdirSync(p, { withFileTypes: true })) if (lstatSync(join(p, s.name)).isSymbolicLink()) rmSync(join(p, s.name), { recursive: false, force: true });
      }
      if (lstatSync(p).isSymbolicLink()) rmSync(p, { recursive: false, force: true });
    }
  }
  rmSync(COPY, { recursive: true, force: true });
}
mkdirSync(COPY, { recursive: true });

const SKIP = new Set([".git", "node_modules", ".tmp"]);
for (const e of readdirSync(ROOT, { withFileTypes: true })) {
  if (SKIP.has(e.name) || e.name.startsWith(".wrangler")) continue;
  cpSync(join(ROOT, e.name), join(COPY, e.name), {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop();
      return !SKIP.has(name) && !name.startsWith(".wrangler");
    },
  });
}

const real = `${ROOT}/node_modules`;
const nm = `${COPY}/node_modules`;
mkdirSync(nm, { recursive: true });
const COPIED = new Set(["wrangler", "miniflare", "workerd"]);
for (const e of readdirSync(real, { withFileTypes: true })) {
  const target = join(real, e.name);
  const link = join(nm, e.name);
  if (e.name === "@domains") continue;
  if (e.name === "@cloudflare") {
    mkdirSync(link);
    for (const s of readdirSync(target, { withFileTypes: true })) {
      if (s.name === "workers-types") cpSync(join(target, s.name), join(link, s.name), { recursive: true });
      else symlinkSync(resolve(target, s.name), join(link, s.name), "junction");
    }
    continue;
  }
  if (COPIED.has(e.name)) {
    cpSync(target, link, { recursive: true });
    continue;
  }
  if (e.isDirectory()) symlinkSync(resolve(target), link, "junction");
  else cpSync(target, link);
}

// @domains: each link points at the copy's package.
mkdirSync(`${nm}/@domains`);
for (const e of readdirSync(`${real}/@domains`, { withFileTypes: true })) {
  const was = readlinkSync(join(real, "@domains", e.name)).replaceAll("\\", "/").replace(/\/$/, "");
  const rel = relative(ROOT, was).split("\\").join("/");
  if (rel.startsWith("..")) throw new Error(`link ${e.name} -> ${was} is outside the worktree`);
  const to = resolve(COPY, rel);
  if (!existsSync(to)) throw new Error(`${to} is missing from the copy`);
  symlinkSync(to, join(nm, "@domains", e.name), "junction");
  console.log(`@domains/${e.name} -> ${to}`);
}
console.log("copy ready");
