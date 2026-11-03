// DOM-030 instrument (gate part (c) of D16), copied from .tmp/dom030/review-d16/mutation/lib.mjs
// as it ran, with this header added. Its paths point at that gitignored directory and at its
// copy of the tree, so it runs from there. The lens wrote setup, lib, canary and mutants; the fix
// pass wrote sync-fix, rerun-fix, rerun-cwd and summary (TODO/serve.md, DOM-030).
// Scratch helpers of the mutation lens: apply one mutant to the copy, run its tests, restore, and
// read each exit code from the process that produced it (spawnSync status, never a pipe).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const REAL = "D:/_WORK_/domains-serve/";
export const COPY = "D:/_WORK_/domains-serve/.tmp/dom030/review-d16/mutation/copy/";

export const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function testRun(dir, name, { cwd = COPY, timeoutMs = 900_000 } = {}) {
  const args = ["scripts/test.mjs", dir];
  if (name) args.push("--name", name);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, TEST_CONCURRENCY: process.env.TEST_CONCURRENCY ?? "2" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { status: r.status, signal: r.signal, ms: Date.now() - t0, out, failed: failedNames(out), passLine: (out.match(/ℹ pass \d+/) ?? [""])[0], failLine: (out.match(/ℹ fail \d+/) ?? [""])[0] };
}

export function nodeRun(args, { cwd = COPY, timeoutMs = 600_000 } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { status: r.status, ms: Date.now() - t0, out };
}

// The names of tests that failed, from node:test's spec reporter lines "✖ name".
export function failedNames(out) {
  const names = new Set();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*✖ (.+?)(?: \([\d.]+ms\))?$/);
    if (m && !/^failing tests:?$/i.test(m[1])) names.add(m[1]);
  }
  return [...names];
}

// Apply one text mutant to a file of the copy (the text must be there exactly `times` times), run `fn`, restore byte for byte.
export function withMutant(file, from, to, fn, times = 1) {
  const path = COPY + file;
  const original = readFileSync(path);
  const text = original.toString("utf8");
  const n = text.split(from).length - 1;
  if (times === null ? n < 1 : n !== times) throw new Error(`${file}: the planted text is there ${n} times, not ${times}: ${from.slice(0, 60)}`);
  writeFileSync(path, text.split(from).join(to));
  let result;
  try {
    result = fn();
  } finally {
    writeFileSync(path, original);
  }
  const restored = readFileSync(path).equals(original);
  return { ...result, restored: restored && result.restored !== false };
}
