// DOM-030 instrument of D16, the move of wrangler, the date and the types,
// copied from the session scratch as it ran, with its root moved from an
// absolute path to the repository root (Windows: the binary of
// @cloudflare/workerd-windows-64).
// The newest compatibility date the pinned workerd binary runs, read by running
// the binary itself (workerd test, which exits on its own) once a date.
// node docs/research/measure/DOM-030/08-workerd-dates.mjs 2026-10-13 2026-11-01 2026-11-02 2026-11-08 2026-11-09 2099-01-01
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const dir = join(root, ".tmp/dom030/d16-wd");
mkdirSync(dir, { recursive: true });
const bin = join(root, "node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe");
writeFileSync(join(dir, "w.mjs"), "export default { async test() {} };\n");

const dates = process.argv.slice(2);
for (const date of dates) {
  const cfg = join(dir, `c-${date}.capnp`);
  writeFileSync(
    cfg,
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .w) ],
);
const w :Workerd.Worker = (
  modules = [ (name = "w", esModule = embed "w.mjs") ],
  compatibilityDate = "${date}",
  compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"],
);
`,
  );
  const r = spawnSync(bin, ["test", cfg], { encoding: "utf8", timeout: 60_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\s+/g, " ").trim();
  console.log(JSON.stringify({ date, status: r.status, signal: r.signal, error: r.error?.message ?? null, out: out.slice(0, 400) }));
}
