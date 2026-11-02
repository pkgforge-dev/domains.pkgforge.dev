// DOM-030 instrument, copied from .tmp/dom030/live.mts as it ran, with its import and
// output paths moved to docs/research/measure/DOM-030/. Its stop file and
// URL file stay in the gitignored .tmp/dom030/. Run from the
// repository root.
// .tmp/dom030/live.mts — scratch: run apps/api in workerd through the testkit
// harness, with every outbound fetch sent to the real network (anonymous GHCR
// reads), and print its local URL, so curl can drive it. Ends when the file
// .tmp/dom030/stop exists, or after 15 minutes, and disposes workerd itself.
//   node docs/research/measure/DOM-030/03-live.mts
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { withWorker } from "../../../../packages/testkit/src/index.ts";

const STOP = new URL("../../../../.tmp/dom030/stop", import.meta.url);
const URL_FILE = new URL("../../../../.tmp/dom030/live.url", import.meta.url);
rmSync(STOP, { force: true });
const started = Date.now();
await withWorker(
  {
    scriptPath: new URL("../../../../apps/api/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    bindings: { BUILD: process.env.BUILD ?? "000000000000" },
    outbound: async (request) => {
      const headers = new Headers();
      for (const name of ["authorization", "accept", "range", "user-agent"]) {
        const v = request.headers.get(name);
        if (v !== null) headers.set(name, v);
      }
      const t0 = Date.now();
      const res = await fetch(request.url, { method: request.method, headers, redirect: "manual" });
      const u = new URL(request.url);
      console.log(`outbound ${request.method} ${u.host}${u.pathname} ${res.status} ${Date.now() - t0} ms auth=${headers.has("authorization") ? (headers.get("authorization") === "Bearer QQ==" ? "dummy" : "other") : "none"}`);
      return res;
    },
  },
  async (w) => {
    const url = await w.miniflare.ready;
    writeFileSync(URL_FILE, `${url.href}\n`);
    console.log(`listening ${url.href}`);
    while (!existsSync(STOP) && Date.now() - started < 15 * 60_000) await new Promise((r) => setTimeout(r, 300));
    console.log(`stopping after ${Math.round((Date.now() - started) / 1000)} s; outbound ${w.outbound.length}`);
  },
);
rmSync(STOP, { force: true });
console.log("disposed");
