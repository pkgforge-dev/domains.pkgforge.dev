// DOM-030 instrument (gate part (c) of D16), copied from .tmp/dom030/review-d16/mutation/rerun-fix.mjs
// as it ran, with this header added. Its paths point at that gitignored directory and at its
// copy of the tree, so it runs from there. The lens wrote setup, lib, canary and mutants; the fix
// pass wrote sync-fix, rerun-fix, rerun-cwd and summary (TODO/serve.md, DOM-030).
// Scratch of the D16 fix pass: after sync-fix.mjs, run in the copy (never the real tree) a baseline of
// every set, then the lens's survivors and the fix pass's own mutants, one at a time, each restored
// byte for byte. One JSON line a run in results-fix.jsonl; each run's output in out-fix/<id>-<set>.txt.
//   node rerun-fix.mjs baseline
//   node rerun-fix.mjs            every mutant below
//   node rerun-fix.mjs B8 N1      the named ids
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { testRun, withMutant } from "./lib.mjs";

process.env.MUTANTS_NO_RUN = "1";
const { MUTANTS } = await import("./mutants.mjs");

const HERE = "D:/_WORK_/domains-serve/.tmp/dom030/review-d16/mutation/";
mkdirSync(`${HERE}out-fix`, { recursive: true });
const SETS = {
  TK: ["packages/testkit", null],
  API: ["apps/api", null],
  PW: ["probes/worker", null],
  CFG: ["scripts", "config:"],
  MEAS: ["scripts/measure", "decode cpu|make sample pack|kafka worker"],
  WF: ["scripts", "workflow policy"],
};
const ALL = ["TK", "API", "PW", "CFG", "MEAS", "WF"];
const D = (file, from, to, times = 1) => ({ file, from, to, times });

const SURVIVORS = ["B8", "C3", "C4", "C5", "C6", "D2", "D3", "L1", "L2", "L3", "L4", "L5", "E2", "E3", "F1", "F2", "F3", "F4", "F5", "F6", "F9", "F10", "F11", "F12"];
const FIRST = { B8: "TK", F9: "CFG", E2: "CFG", E3: "CFG", F11: "CFG", F12: "MEAS" };
const lens = MUTANTS.filter((m) => SURVIVORS.includes(m.id)).map((m) => ({ ...m, order: [FIRST[m.id] ?? "CFG", ...ALL.filter((s) => s !== (FIRST[m.id] ?? "CFG"))] }));
const own = [
  {
    id: "N1",
    desc: "finish() of apps/api/src/answer.ts copies statusText again (door-1)",
    edits: [D("apps/api/src/answer.ts", "return new Response(body, { status: res.status, headers });", "return new Response(body, { status: res.status, statusText: res.statusText, headers });")],
    order: ["API", ...ALL.filter((s) => s !== "API")],
  },
  {
    id: "N2",
    desc: "miniflareOptions of packages/testkit sets no modulesRoot (door-2)",
    edits: [D("packages/testkit/src/workerd.ts", "    modulesRoot: dirname(resolve(options.scriptPath)),\n", "")],
    order: ["TK", ...ALL.filter((s) => s !== "TK")],
  },
  {
    id: "N3",
    desc: "miniflareOptions sets modulesRoot to the working directory (door-2, a root that does not hold the entry)",
    edits: [D("packages/testkit/src/workerd.ts", "    modulesRoot: dirname(resolve(options.scriptPath)),\n", "    modulesRoot: process.cwd(),\n")],
    order: ["TK", ...ALL.filter((s) => s !== "TK")],
  },
  {
    id: "N4",
    desc: "docs/resources.md: the delete command of the R2 bucket alone names wrangler@4.150.0",
    edits: [D("docs/resources.md", "then `npx wrangler@4.156.1 r2 bucket delete domains-probe`", "then `npx wrangler@4.150.0 r2 bucket delete domains-probe`")],
    order: ["CFG", "WF"],
  },
  {
    id: "N5",
    desc: "HUMAN.md: the rollback command alone names wrangler@4.150.0",
    edits: [D("HUMAN.md", "npx wrangler@4.156.1 rollback", "npx wrangler@4.150.0 rollback")],
    order: ["CFG", "WF"],
  },
];
const ALL_MUTANTS = [...lens, ...own];

function applyAll(edits, fn) {
  if (edits.length === 0) return fn();
  const [e, ...rest] = edits;
  return withMutant(e.file, e.from, e.to, () => applyAll(rest, fn), e.times);
}

const args = process.argv.slice(2);
if (args[0] === "baseline") {
  for (const key of ALL) {
    const [dir, name] = SETS[key];
    const r = testRun(dir, name);
    writeFileSync(`${HERE}out-fix/baseline-${key}.txt`, r.out);
    const row = { id: "baseline", set: key, at: new Date().toISOString(), status: r.status, pass: r.passLine, fail: r.failLine, ms: r.ms, failed: r.failed.slice(0, 6) };
    appendFileSync(`${HERE}results-fix.jsonl`, `${JSON.stringify(row)}\n`);
    console.log(JSON.stringify(row));
  }
  process.exit(0);
}
let n = 0;
for (const m of ALL_MUTANTS) {
  if (args.length && !args.includes(m.id)) continue;
  const t0 = new Date().toISOString();
  const ranSets = [];
  let killedBy = null;
  const body = () => {
    for (const key of m.order) {
      const [dir, name] = SETS[key];
      const r = testRun(dir, name);
      writeFileSync(`${HERE}out-fix/${m.id}-${key}.txt`, r.out);
      ranSets.push({ set: key, status: r.status, pass: r.passLine, fail: r.failLine, ms: r.ms });
      if (r.status !== 0) {
        killedBy = { set: key, status: r.status, failed: r.failed.slice(0, 6) };
        return { killedBy };
      }
    }
    return { killedBy: null };
  };
  let restored;
  let error = null;
  try {
    restored = applyAll(m.edits, body).restored;
  } catch (e) {
    error = String(e.message ?? e);
  }
  const row = { id: m.id, desc: m.desc, at: t0, killed: killedBy !== null, killedBy, sets: ranSets, restored, error };
  appendFileSync(`${HERE}results-fix.jsonl`, `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify({ id: m.id, killed: row.killed, by: killedBy ? `${killedBy.set} exit ${killedBy.status}: ${killedBy.failed[0] ?? ""}` : null, restored, error, ran: ranSets.map((s) => `${s.set}:${s.status}`).join(",") }));
  n += 1;
}
console.log(`${n} mutants run`);
