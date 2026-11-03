// DOM-030 instrument of D16, copied from the session scratch as it ran, with
// its root moved from an absolute path to the repository root.
// Plant one mutant at a time in the worktree, run the owning test filter, and
// write the file back byte for byte. Each mutant must fail it.
// node docs/research/measure/DOM-030/09-move-mutate.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const mutants = [
  {
    id: "M1 the pinned date one day in the future",
    file: "packages/testkit/src/workerd.ts",
    from: 'export const COMPATIBILITY_DATE = "2026-11-02";',
    to: 'export const COMPATIBILITY_DATE = "2026-11-03";',
    name: "pinned runtime refuses",
  },
  {
    id: "M2 the refused date at the binary's bound, refused only as a future date",
    file: "packages/testkit/test/workerd.test.ts",
    from: 'await workerdTest(bin, "2026-11-09");',
    to: 'await workerdTest(bin, "2026-11-08");',
    name: "pinned runtime refuses",
  },
  {
    id: "M3 the config at the refused date for both runs",
    file: "packages/testkit/test/workerd.test.ts",
    from: "const ran = await workerdTest(bin, COMPATIBILITY_DATE);",
    to: 'const ran = await workerdTest(bin, "2026-11-09");',
    name: "pinned runtime refuses",
  },
  {
    id: "M4 apps/api deploys a date the harness does not run",
    file: "apps/api/wrangler.toml",
    from: 'compatibility_date = "2026-11-02"',
    to: 'compatibility_date = "2026-10-13"',
    name: "compatibility",
    dir: "apps/api",
  },
  {
    id: "M5 the probe deploys a date the harness does not run",
    file: "probes/worker/wrangler.toml",
    from: 'compatibility_date = "2026-11-02"',
    to: 'compatibility_date = "2026-10-13"',
    name: "probe config: wrangler.toml holds",
    dir: "probes/worker",
  },
];

let failed = 0;
for (const m of mutants) {
  const path = root + m.file;
  const original = readFileSync(path);
  const text = original.toString("utf8");
  if (text.split(m.from).length !== 2) throw new Error(`${m.id}: the planted text is not there once`);
  writeFileSync(path, text.replace(m.from, () => m.to));
  let r;
  try {
    r = spawnSync(process.execPath, ["scripts/test.mjs", m.dir ?? "packages/testkit", "--name", m.name], { cwd: root, encoding: "utf8", timeout: 300_000 });
  } finally {
    writeFileSync(path, original);
  }
  const back = readFileSync(path).equals(original);
  const killed = r.status !== 0;
  if (!killed || !back) failed += 1;
  console.log(JSON.stringify({ id: m.id, status: r.status, killed, restored: back, tail: `${r.stdout}${r.stderr}`.trim().split("\n").slice(-1)[0] }));
}
process.exit(failed === 0 ? 0 : 1);
