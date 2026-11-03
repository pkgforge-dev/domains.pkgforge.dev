// DOM-030 instrument (gate part (c) of D16), copied from .tmp/dom030/review-d16/mutation/mutants.mjs
// as it ran, with this header added. Its paths point at that gitignored directory and at its
// copy of the tree, so it runs from there. The lens wrote setup, lib, canary and mutants; the fix
// pass wrote sync-fix, rerun-fix, rerun-cwd and summary (TODO/serve.md, DOM-030).
// Scratch: plant the mutants one at a time in the copy, run the sets of tests in order until one fails,
// restore byte for byte, and append one JSON line per mutant to results.jsonl.
//   node mutants.mjs            all
//   node mutants.mjs A1 D3      the named ids
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { testRun, withMutant } from "./lib.mjs";

const HERE = "D:/_WORK_/domains-serve/.tmp/dom030/review-d16/mutation/";
mkdirSync(`${HERE}out`, { recursive: true });

const SETS = {
  TK: ["packages/testkit", null],
  API: ["apps/api", null],
  PW: ["probes/worker", null],
  CFG: ["scripts", "config:"],
  MEAS: ["scripts/measure", "decode cpu|make sample pack|kafka worker"],
  WF: ["scripts", "workflow policy"],
};
const ALL = ["TK", "API", "PW", "CFG", "MEAS"];

const TK_SRC = "packages/testkit/src/workerd.ts";
const TK_TEST = "packages/testkit/test/workerd.test.ts";
const API_TOML = "apps/api/wrangler.toml";
const PW_TOML = "probes/worker/wrangler.toml";
const D = (file, from, to, times = 1) => ({ file, from, to, times });
const DATE = 'export const COMPATIBILITY_DATE = "2026-11-02";';
const dateTo = (v) => `export const COMPATIBILITY_DATE = "${v}";`;
const tomlDate = (v) => D(API_TOML, 'compatibility_date = "2026-11-02"', `compatibility_date = "${v}"`);
const pwDate = (v) => D(PW_TOML, 'compatibility_date = "2026-11-02"', `compatibility_date = "${v}"`);
const lock = (name, to, extra = "") => D("package-lock.json", `"node_modules/${name}": {\n      "version": "${extra}"`, `"node_modules/${name}": {\n      "version": "${to}"`);
const nm = (pkg, from, to, times = 1) => D(`node_modules/${pkg}/package.json`, from, to, times);

export const MUTANTS = [
  // The date, held by the harness, two wrangler.toml, and the tests that read them.
  { id: "A1", desc: "testkit COMPATIBILITY_DATE -> 2026-10-13 (the old date)", edits: [D(TK_SRC, DATE, dateTo("2026-10-13"))] },
  { id: "A2", desc: "testkit COMPATIBILITY_DATE -> 2026-11-01 (workerd's exported date)", edits: [D(TK_SRC, DATE, dateTo("2026-11-01"))] },
  { id: "A3", desc: "testkit COMPATIBILITY_DATE -> 2026-11-03 (a day after today)", edits: [D(TK_SRC, DATE, dateTo("2026-11-03"))] },
  { id: "A4", desc: "apps/api wrangler.toml date -> 2026-10-13", edits: [tomlDate("2026-10-13")], order: ["API", "TK", "PW", "CFG", "MEAS", "WF"] },
  { id: "A5", desc: "apps/api wrangler.toml date -> 2026-11-01", edits: [tomlDate("2026-11-01")], order: ["API", "TK", "PW", "CFG", "MEAS", "WF"] },
  { id: "A6", desc: "apps/api wrangler.toml date -> 2026-11-03", edits: [tomlDate("2026-11-03")], order: ["API", "TK", "PW", "CFG", "MEAS", "WF"] },
  { id: "A7", desc: "probe wrangler.toml date -> 2026-10-13", edits: [pwDate("2026-10-13")], order: ["PW", "TK", "API", "CFG", "MEAS", "WF"] },
  { id: "A8", desc: "probe wrangler.toml date -> 2026-11-01", edits: [pwDate("2026-11-01")], order: ["PW", "TK", "API", "CFG", "MEAS", "WF"] },
  { id: "A9", desc: "probe wrangler.toml date -> 2026-11-03", edits: [pwDate("2026-11-03")], order: ["PW", "TK", "API", "CFG", "MEAS", "WF"] },
  { id: "A10", desc: "all three held dates together -> 2026-11-01 (a consistent drift to an older runnable date)", edits: [D(TK_SRC, DATE, dateTo("2026-11-01")), tomlDate("2026-11-01"), pwDate("2026-11-01")] },
  { id: "A11", desc: "all three held dates together -> 2026-10-13 (the old date, consistently)", edits: [D(TK_SRC, DATE, dateTo("2026-10-13")), tomlDate("2026-10-13"), pwDate("2026-10-13")] },
  { id: "A12", desc: "apps/api wrangler.toml flags: no_nodejs_compat_v2 dropped", edits: [D(API_TOML, 'compatibility_flags = ["no_nodejs_compat", "no_nodejs_compat_v2"]', 'compatibility_flags = ["no_nodejs_compat"]')], order: ["API", "TK", "PW", "CFG", "MEAS", "WF"] },
  { id: "A13", desc: "probe wrangler.toml flags: no_nodejs_compat_v2 dropped", edits: [D(PW_TOML, 'compatibility_flags = ["no_nodejs_compat", "no_nodejs_compat_v2"]', 'compatibility_flags = ["no_nodejs_compat"]')], order: ["PW", "TK", "API", "CFG", "MEAS", "WF"] },

  // The literals of the tests themselves (a test whose literal can be moved with the subject holds nothing).
  { id: "B1", desc: "testkit test: the date literal 2026-11-02 -> 2026-11-01", edits: [D(TK_TEST, 'assert.equal(COMPATIBILITY_DATE, "2026-11-02");', 'assert.equal(COMPATIBILITY_DATE, "2026-11-01");')], order: ["TK"] },
  { id: "B2", desc: "pinned runtime refuses: the refused date 2026-11-09 -> 2026-11-08 (refused only as a future date)", edits: [D(TK_TEST, 'await workerdTest(bin, "2026-11-09");', 'await workerdTest(bin, "2026-11-08");')], order: ["TK"] },
  { id: "B3", desc: "pinned runtime refuses: the named bound 2026-11-08 -> 2026-11-07 in the message pattern", edits: [D(TK_TEST, 'but the newest date supported by this server binary is "2026-11-08"/', 'but the newest date supported by this server binary is "2026-11-07"/')], order: ["TK"] },
  { id: "B4", desc: "pinned runtime refuses: the passing run at the refused date instead of COMPATIBILITY_DATE", edits: [D(TK_TEST, "const ran = await workerdTest(bin, COMPATIBILITY_DATE);", 'const ran = await workerdTest(bin, "2026-11-09");')], order: ["TK"] },
  { id: "B5", desc: "pinned runtime refuses: the passing run at 2026-11-08 (a future date today, in range of the binary)", edits: [D(TK_TEST, "const ran = await workerdTest(bin, COMPATIBILITY_DATE);", 'const ran = await workerdTest(bin, "2026-11-08");')], order: ["TK"] },
  { id: "B6", desc: "harness test: the wrangler literal 4.156.1 -> 4.156.0", edits: [D(TK_TEST, 'assert.equal(wrangler.version, "4.156.1");', 'assert.equal(wrangler.version, "4.156.0");')], order: ["TK"] },
  { id: "B7", desc: "harness test: the workerd literal 1.20261101.1 -> 1.20261101.0", edits: [D(TK_TEST, 'assert.equal(version, "1.20261101.1");', 'assert.equal(version, "1.20261101.0");')], order: ["TK"] },
  { id: "B8", desc: "pinned runtime refuses: the refused run's config flags emptied (the binary then reads a Worker with the node flags default)", edits: [D(TK_TEST, "const flags = COMPATIBILITY_FLAGS.map((f) => JSON.stringify(f)).join(\", \");", 'const flags = "";')], order: ["TK"] },

  // The installed packages (real copies in the scratch node_modules): a stale or moved install against the pins.
  { id: "C1", desc: "installed wrangler version -> 4.150.0", edits: [nm("wrangler", '"version": "4.156.1",', '"version": "4.150.0",')] },
  { id: "C2", desc: "installed wrangler's own dependency workerd -> 1.20261006.1", edits: [nm("wrangler", '"workerd": "1.20261101.1"', '"workerd": "1.20261006.1"')] },
  { id: "C3", desc: "installed wrangler's own dependency miniflare -> 5.20261006.2-beta", edits: [nm("wrangler", '"miniflare": "5.20261101.0-beta"', '"miniflare": "5.20261006.2-beta"')] },
  { id: "C4", desc: "installed workerd version -> 1.20261006.1 (miniflare loads another workerd than wrangler depends on)", edits: [nm("workerd", '"version": "1.20261101.1",', '"version": "1.20261006.1",')] },
  { id: "C4b", desc: "installed workerd/lib/main.js exports version 1.20261006.1 (the version constant of a workerd that is not the one wrangler depends on)", edits: [D("node_modules/workerd/lib/main.js", 'var version = "1.20261101.1";', 'var version = "1.20261006.1";')] },
  { id: "C5", desc: "installed miniflare version -> 5.20261006.2-beta", edits: [nm("miniflare", '"version": "5.20261101.0-beta",', '"version": "5.20261006.2-beta",')] },
  { id: "C6", desc: "installed @cloudflare/workers-types version -> 5.20261013.1", edits: [nm("@cloudflare/workers-types", '"version": "5.20261102.1"', '"version": "5.20261013.1"')] },

  // package.json and the lock.
  { id: "D1", desc: "package.json wrangler -> 4.150.0", edits: [D("package.json", '"wrangler": "4.156.1"', '"wrangler": "4.150.0"')] },
  { id: "D2", desc: "package.json miniflare -> 5.20261006.2-beta", edits: [D("package.json", '"miniflare": "5.20261101.0-beta"', '"miniflare": "5.20261006.2-beta"')] },
  { id: "D3", desc: "package.json @cloudflare/workers-types -> 5.20261013.1", edits: [D("package.json", '"@cloudflare/workers-types": "5.20261102.1"', '"@cloudflare/workers-types": "5.20261013.1"')] },
  { id: "D4", desc: "package.json wrangler -> 4.156.0 (a drift of one patch)", edits: [D("package.json", '"wrangler": "4.156.1"', '"wrangler": "4.156.0"')] },
  { id: "L1", desc: "package-lock node_modules/wrangler version -> 4.150.0", edits: [lock("wrangler", "4.150.0", "4.156.1")] },
  { id: "L2", desc: "package-lock node_modules/miniflare version -> 5.20261006.2-beta", edits: [lock("miniflare", "5.20261006.2-beta", "5.20261101.0-beta")] },
  { id: "L3", desc: "package-lock node_modules/@cloudflare/workers-types version -> 5.20261013.1", edits: [lock("@cloudflare/workers-types", "5.20261013.1", "5.20261102.1")] },
  { id: "L4", desc: "package-lock node_modules/workerd version -> 1.20261006.1", edits: [lock("workerd", "1.20261006.1", "1.20261101.1")] },
  { id: "L5", desc: "package-lock root devDependencies wrangler -> 4.150.0", edits: [D("package-lock.json", '"wrangler": "4.156.1",\n        "yaml"', '"wrangler": "4.150.0",\n        "yaml"')] },

  // tsconfig.worker.json.
  { id: "E1", desc: "tsconfig.worker.json types -> a dated subpath of workers-types", edits: [D("tsconfig.worker.json", '"types": ["@cloudflare/workers-types"]', '"types": ["@cloudflare/workers-types/2023-07-01"]')], order: ["CFG"] },
  { id: "E2", desc: "tsconfig.worker.json comment: types 5.20261102.1 -> 5.20261013.1", edits: [D("tsconfig.worker.json", "workers-types 5.20261102.1, which", "workers-types 5.20261013.1, which")], order: ["CFG"] },
  { id: "E3", desc: "tsconfig.worker.json comment: harness date 2026-11-02 -> 2026-10-13", edits: [D("tsconfig.worker.json", "harness date 2026-11-02 (", "harness date 2026-10-13 (")], order: ["CFG"] },

  // The forward-looking wrangler version, held by prose and commands.
  { id: "F1", desc: "apps/api/wrangler.toml: every wrangler@4.156.1 -> 4.150.0", edits: [D(API_TOML, "wrangler@4.156.1", "wrangler@4.150.0", null)], order: ["API", "CFG"] },
  { id: "F2", desc: "probes/worker/wrangler.toml: every wrangler@4.156.1 -> 4.150.0", edits: [D(PW_TOML, "wrangler@4.156.1", "wrangler@4.150.0", null)], order: ["PW", "CFG"] },
  { id: "F3", desc: ".github/workflows/worker.yml: wrangler@4.156.1 -> 4.150.0", edits: [D(".github/workflows/worker.yml", "wrangler@4.156.1", "wrangler@4.150.0")], order: ["WF", "CFG", "TK", "API", "PW", "MEAS"] },
  { id: "F4", desc: "HUMAN.md: every wrangler@4.156.1 -> 4.150.0", edits: [D("HUMAN.md", "wrangler@4.156.1", "wrangler@4.150.0", null)], order: ["CFG", "WF"] },
  { id: "F5", desc: "docs/worker.md: every 4.156.1 -> 4.150.0", edits: [D("docs/worker.md", "4.156.1", "4.150.0", null)], order: ["CFG", "WF"] },
  { id: "F6", desc: "docs/resources.md: every wrangler@4.156.1 -> 4.150.0 (the delete columns)", edits: [D("docs/resources.md", "wrangler@4.156.1", "wrangler@4.150.0", null)], order: ["CFG", "WF"] },
  { id: "F7", desc: "scripts/measure/make-sample-pack.mjs uploadCommand wrangler@4.156.1 -> 4.150.0", edits: [D("scripts/measure/make-sample-pack.mjs", "npx wrangler@4.156.1 r2", "npx wrangler@4.150.0 r2")], order: ["MEAS"] },
  { id: "F8", desc: "scripts/measure/decode-cpu.mjs WRANGLER_VERSION -> 4.150.0", edits: [D("scripts/measure/decode-cpu.mjs", "WRANGLER_VERSION = '4.156.1'", "WRANGLER_VERSION = '4.150.0'")], order: ["MEAS"] },
  { id: "F9", desc: "TODO/serve.md DOM-054 tail command wrangler@4.156.1 -> 4.150.0 (an open entry)", edits: [D("TODO/serve.md", "npx wrangler@4.156.1 tail domains-pkgforge-dev", "npx wrangler@4.150.0 tail domains-pkgforge-dev")], order: ["CFG", "WF"] },
  { id: "F10", desc: "docs/worker.md: the date `2026-11-02` of the compatibility_date row -> 2026-10-13", edits: [D("docs/worker.md", "| `compatibility_date` | `2026-11-02`,", "| `compatibility_date` | `2026-10-13`,")], order: ["CFG", "WF"] },
  { id: "F11", desc: "docs/format.md: the date 2026-11-02 in the workerd paragraph -> 2026-10-13", edits: [D("docs/format.md", "2026-11-02 in workerd 1.20261101.1 since.", "2026-10-13 in workerd 1.20261101.1 since.")], order: ["CFG", "WF"] },
  { id: "F12", desc: "decode-cpu.mjs comment: workers-types 5.20261102.1 -> 5.20261013.1", edits: [D("scripts/measure/decode-cpu.mjs", "@cloudflare/workers-types 5.20261102.1 declares", "@cloudflare/workers-types 5.20261013.1 declares")], order: ["MEAS"] },
];

function applyAll(edits, fn) {
  if (edits.length === 0) return fn();
  const [e, ...rest] = edits;
  const r = withMutant(e.file, e.from, e.to, () => applyAll(rest, fn), e.times);
  return r;
}

if (process.env.MUTANTS_NO_RUN !== "1") {
  const only = process.argv.slice(2);
  let n = 0;
  for (const m of MUTANTS) {
    if (only.length && !only.includes(m.id)) continue;
    const order = m.order ?? ALL;
    const t0 = new Date().toISOString();
    const ranSets = [];
    let killedBy = null;
    const body = () => {
      for (const key of order) {
        const [dir, name] = SETS[key];
        const r = testRun(dir, name);
        writeFileSync(`${HERE}out/${m.id}-${key}.txt`, r.out);
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
      // applyAll returns the last withMutant's { ...result, restored }; nested restores are each checked by their own withMutant call.
      const r = applyAll(m.edits, body);
      restored = r.restored;
    } catch (e) {
      error = String(e.message ?? e);
    }
    const row = { id: m.id, desc: m.desc, at: t0, killed: killedBy !== null, killedBy, sets: ranSets, restored, error };
    appendFileSync(`${HERE}results.jsonl`, `${JSON.stringify(row)}\n`);
    console.log(JSON.stringify({ id: m.id, killed: row.killed, by: killedBy ? `${killedBy.set} exit ${killedBy.status}` : null, restored, error, ran: ranSets.map((s) => `${s.set}:${s.status}`).join(",") }));
    n += 1;
  }
  console.log(`${n} mutants run`);

}
