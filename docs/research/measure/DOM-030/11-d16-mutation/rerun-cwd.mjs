// DOM-030 instrument (gate part (c) of D16), copied from .tmp/dom030/review-d16/mutation/rerun-cwd.mjs
// as it ran, with this header added. Its paths point at that gitignored directory and at its
// copy of the tree, so it runs from there. The lens wrote setup, lib, canary and mutants; the fix
// pass wrote sync-fix, rerun-fix, rerun-cwd and summary (TODO/serve.md, DOM-030).
// Scratch of the D16 fix pass: the cwd test of packages/testkit alone, in the copy, without and with
// the mutant N2 (no modulesRoot). One JSON line each in results-fix.jsonl.
import { appendFileSync, writeFileSync } from "node:fs";
import { testRun, withMutant } from "./lib.mjs";
const HERE = "D:/_WORK_/domains-serve/.tmp/dom030/review-d16/mutation/";
const NAME = "working directory that does not hold the entry";
const base = testRun("packages/testkit", NAME);
writeFileSync(`${HERE}out-fix/N2cwd-baseline.txt`, base.out);
const b = { id: "N2cwd-baseline", at: new Date().toISOString(), status: base.status, pass: base.passLine, fail: base.failLine, failed: base.failed };
appendFileSync(`${HERE}results-fix.jsonl`, `${JSON.stringify(b)}\n`);
console.log(JSON.stringify(b));
let r;
const res = withMutant("packages/testkit/src/workerd.ts", "    modulesRoot: dirname(resolve(options.scriptPath)),\n", "", () => {
  r = testRun("packages/testkit", NAME);
  return {};
});
writeFileSync(`${HERE}out-fix/N2cwd-TK.txt`, r.out);
const m = { id: "N2cwd", desc: "N2 (no modulesRoot), the cwd test alone", at: new Date().toISOString(), killed: r.status !== 0, status: r.status, pass: r.passLine, fail: r.failLine, failed: r.failed, restored: res.restored, internal: /internal error/.test(r.out) };
appendFileSync(`${HERE}results-fix.jsonl`, `${JSON.stringify(m)}\n`);
console.log(JSON.stringify(m));
