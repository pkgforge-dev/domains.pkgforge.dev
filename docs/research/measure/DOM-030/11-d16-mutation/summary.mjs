// DOM-030 instrument (gate part (c) of D16), copied from .tmp/dom030/review-d16/mutation/summary.mjs
// as it ran, with this header added. Its paths point at that gitignored directory and at its
// copy of the tree, so it runs from there. The lens wrote setup, lib, canary and mutants; the fix
// pass wrote sync-fix, rerun-fix, rerun-cwd and summary (TODO/serve.md, DOM-030).
// Scratch of the D16 fix pass: write ../mutation.json, the guard mutation lens's summary for the record.
// It reads the lens's own runs (results.jsonl, the last line of each id) and the fix pass's re-runs in the
// copy (results-fix.jsonl, the last line of each id), and the verdict of each survivor below.
import { readFileSync, writeFileSync } from "node:fs";

const HERE = "D:/_WORK_/domains-serve/.tmp/dom030/review-d16/mutation/";
const lastOf = (file) => {
  const m = new Map();
  for (const l of readFileSync(HERE + file, "utf8").trim().split("\n")) {
    const r = JSON.parse(l);
    m.set(r.id === "baseline" ? `baseline-${r.set}` : r.id, r);
  }
  return m;
};
const lens = lastOf("results.jsonl");
const fix = lastOf("results-fix.jsonl");
const canary = JSON.parse(readFileSync(`${HERE}canary.json`, "utf8"));

const SET_TEST = "scripts/check-config.test.mjs: config: wrangler, miniflare, workerd and the Workers types are one set in package.json, the lock and node_modules, and the types are of the harness date";
const CMD_TEST = "scripts/check-config.test.mjs: config: every wrangler command of a procedure names the pinned wrangler, and docs/worker.md names the harness date";
const VERDICT = {
  B8: ["test", "the Worker of the pinned runtime test fails when process or Buffer exists, which the date turns on without the two flags (packages/testkit/test/workerd.test.ts)"],
  C3: ["test", SET_TEST],
  C4: ["test", `${SET_TEST} (the installed workerd's own version against wrangler's dependency)`],
  C5: ["test", SET_TEST],
  C6: ["test", SET_TEST],
  D2: ["test", SET_TEST],
  D3: ["test", `${SET_TEST} (and the types' date against COMPATIBILITY_DATE)`],
  L1: ["test", SET_TEST],
  L2: ["test", SET_TEST],
  L3: ["test", SET_TEST],
  L4: ["test", SET_TEST],
  L5: ["test", SET_TEST],
  E2: ["no target", "the comment of tsconfig.worker.json names the types of package.json and COMPATIBILITY_DATE in place of a copy of their values; the set test holds the types' date"],
  E3: ["no target", "as E2"],
  F1: ["test", CMD_TEST],
  F2: ["test", CMD_TEST],
  F3: ["test", CMD_TEST],
  F4: ["test", CMD_TEST],
  F5: ["test", CMD_TEST],
  F6: ["test", `${CMD_TEST} (the delete column of docs/resources.md; its created columns keep the version that ran)`],
  F9: ["accepted", "an entry is the record: its dated lines and the done entries keep the version that ran, so no check can tell an open entry's command from a record without reading each field and status. The session that works DOM-054 reads its Approach against docs/worker.md"],
  F10: ["test", CMD_TEST],
  F11: ["no target", "section 10 of docs/format.md names COMPATIBILITY_DATE of packages/testkit in place of the dates; the story of the dates went to CHANGELOG.md"],
  F12: ["no target", "the comment of scripts/measure/decode-cpu.mjs names the @cloudflare/workers-types of package.json in place of a copy of its version"],
};

const ids = [...lens.keys()];
const before = { mutants: ids.length, killed: ids.filter((id) => lens.get(id).killed).length };
before.survived = before.mutants - before.killed;
const survivors = ids.filter((id) => !lens.get(id).killed);
const weighed = survivors.map((id) => {
  const r = fix.get(id);
  const [verdict, change] = VERDICT[id] ?? ["unweighed", ""];
  return {
    id,
    desc: lens.get(id).desc,
    verdict,
    change,
    rerun: r ? { at: r.at, killed: r.killed, by: r.killedBy ? `${r.killedBy.set} exit ${r.killedBy.status}: ${r.killedBy.failed[0] ?? ""}` : null, error: r.error, ran: r.sets.map((s) => `${s.set}:${s.status}`).join(","), restored: r.restored ?? null } : null,
  };
});
const own = ["N1", "N2", "N2cwd", "N3", "N4", "N5"].map((id) => {
  const r = fix.get(id);
  const by = r?.killedBy ? `${r.killedBy.set} exit ${r.killedBy.status}: ${r.killedBy.failed[0] ?? ""}` : r?.failed?.length ? `TK exit ${r.status}: ${r.failed[0]}${r.internal ? ", workerd printed internal error" : ""}` : null;
  return r ? { id, desc: r.desc, at: r.at, killed: r.killed, by, error: r.error ?? null, restored: r.restored ?? null } : { id, missing: true };
});
const noTarget = weighed.filter((w) => w.verdict === "no target").map((w) => w.id);
const killedAfter = weighed.filter((w) => w.rerun?.killed).map((w) => w.id);
const after = {
  applying: before.mutants - noTarget.length,
  killed: before.killed + killedAfter.length,
  survived: weighed.filter((w) => w.rerun && !w.rerun.killed && !w.rerun.error).map((w) => w.id),
  noTarget,
  ownKilled: own.filter((o) => o.killed).length,
  ownRun: own.length,
};
const baseline = ["TK", "API", "PW", "CFG", "MEAS", "WF"].map((s) => {
  const r = fix.get(`baseline-${s}`);
  return r ? `${s}:${r.status} ${r.pass}` : `${s}:missing`;
});
const out = {
  lens: "the guard mutation (gate part (c) of DOM-030's D16)",
  swept: "52 mutants of the move: the dates held by packages/testkit and the two wrangler.toml files, the literals of the move's tests, the installed packages, package.json, the lock, tsconfig.worker.json, and the forward-looking wrangler@ commands and dates in the documents",
  copy: ".tmp/dom030/review-d16/mutation/copy (its own node_modules: junctions to the worktree's packages, @domains to the copy's packages, real copies of wrangler, miniflare, workerd and @cloudflare/workers-types)",
  canary: canary.map((c) => ({ step: c.step, status: c.status, sawCanary: c.sawCanary ?? null, same: c.same ?? null })),
  lensRuns: "results.jsonl, the last line of each id; the lens ended at a session limit after every run and before its report",
  before,
  survivors,
  fixPass: {
    synced: "sync-fix.mjs copied into the copy the 17 files that the fix pass had changed at 14:58Z, and no other file differed; at 15:08Z it copied the cwd test of packages/testkit, moved to a directory on the entry's drive, and rerun-cwd.mjs ran it without and with N2",
    baseline,
    reruns: "rerun-fix.mjs, results-fix.jsonl and out-fix/",
    weighed,
    own,
    after,
  },
};
writeFileSync(`${HERE}../mutation.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ before, after, baseline }));
