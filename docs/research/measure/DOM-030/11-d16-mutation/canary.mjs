// DOM-030 instrument (gate part (c) of D16), copied from .tmp/dom030/review-d16/mutation/canary.mjs
// as it ran, with this header added. Its paths point at that gitignored directory and at its
// copy of the tree, so it runs from there. The lens wrote setup, lib, canary and mutants; the fix
// pass wrote sync-fix, rerun-fix, rerun-cwd and summary (TODO/serve.md, DOM-030).
// Canary and baseline: the copy runs its own sources, and its tests are green before any mutant.
import { writeFileSync } from "node:fs";
import { COPY, REAL, sha, testRun, withMutant } from "./lib.mjs";

const log = [];
const say = (o) => {
  log.push(o);
  console.log(JSON.stringify(o));
};

// Baseline: the five owning runs, unmutated.
const before = sha(REAL + "packages/testkit/src/workerd.ts");
for (const [dir, name] of [
  ["packages/testkit", null],
  ["apps/api", "compatibility"],
  ["probes/worker", "probe config"],
  ["scripts", "config:"],
]) {
  const r = testRun(dir, name);
  say({ step: "baseline", dir, name, status: r.status, ms: r.ms, pass: r.passLine, fail: r.failLine });
}

// Canary 1: a throw at the top of the COPY's testkit; apps/api imports @domains/testkit through node_modules/@domains.
const c1 = withMutant("packages/testkit/src/workerd.ts", "export const COMPATIBILITY_DATE", 'throw new Error("CANARY-COPY-TESTKIT");\nexport const COMPATIBILITY_DATE', () => {
  const r = testRun("apps/api", "compatibility");
  return { status: r.status, sawCanary: r.out.includes("CANARY-COPY-TESTKIT"), failed: r.failed.slice(0, 3) };
});
say({ step: "canary-testkit-from-apps-api", ...c1 });

// Canary 2: the same through a package that reaches testkit by the @domains link only (probe-worker's tests import ../../packages? check by name).
const c2 = withMutant("packages/testkit/src/workerd.ts", "export const COMPATIBILITY_DATE", 'throw new Error("CANARY-COPY-TESTKIT-2");\nexport const COMPATIBILITY_DATE', () => {
  const r = testRun("probes/worker", "probe config");
  return { status: r.status, sawCanary: r.out.includes("CANARY-COPY-TESTKIT-2"), failed: r.failed.slice(0, 3) };
});
say({ step: "canary-testkit-from-probe", ...c2 });

const after = sha(REAL + "packages/testkit/src/workerd.ts");
say({ step: "real-tree-unchanged", before, after, same: before === after });
writeFileSync(COPY + "../canary.json", JSON.stringify(log, null, 2));
