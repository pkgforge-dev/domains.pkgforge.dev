// DOM-030 instrument, copied from .tmp/dom030/fix-mutate.mjs as it ran: its
// paths are from the repository root, so none moved. Its mutants match
// the tree at 2026-11-02T03:54Z; a later file prints INVALID for a mutant it no
// longer holds once. Run from the
// repository root.
// scratch (DOM-030 fix): plants one defect at a time in the worktree's own
// file, runs the owning suite, and writes the file back byte for byte, in a
// finally. Every mutant must fail its suite (exit not 0). Exit 1 when one
// survives or a file is not restored.
//   node docs/research/measure/DOM-030/06-fix-mutate.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const API = "apps/api";
const M = [
  ["imm-length-unchecked", "apps/api/src/ghcr.ts", "    if (hit.byteLength !== end - start) cache.refused(", "    if (false) cache.refused(", API],
  ["pack-idx-not-whole", "apps/api/src/pack.ts", "0, size, { whole: size });", "0, size, {});", API],
  ["pack-part-off-by-one", "apps/api/src/pack.ts", "const blob = pack.parts[part];", "const blob = pack.parts[part + 1] ?? pack.parts[part];", API],
  ["pack-bound-records-off", "apps/api/src/pack.ts", "if (h.recordsPerBlock > MAX_RECORDS_PER_BLOCK)", "if (false)", API],
  ["pack-bound-pages-off", "apps/api/src/pack.ts", "if (h.pageEntries > MAX_PAGE_ENTRIES)", "if (false)", API],
  ["pack-idx-size-off", "apps/api/src/pack.ts", "size < 1 || size > MAX_IDX_BYTES", "size < 1", API],
  ["pack-no-heal", "apps/api/src/pack.ts", 'if (first?.tier !== "cache" || !(err instanceof PackError) || !BYTE_FAULTS.has(err.code)) throw err;', "throw err;", API],
  ["pack-keep-unchecked", "apps/api/src/pack.ts", "keep: false });", "keep: true });", API],
  ["root-catch-everything", "apps/api/src/root.ts", "    if (!sourceFault(err)) throw err;\n", "", API],
  ["root-usage-as-ghcr", "apps/api/src/root.ts", '(err instanceof GhcrError && err.code !== "usage")', "err instanceof GhcrError", API],
  ["root-validate-every-time", "apps/api/src/root.ts", "this.#body.validated ??= validateRoot", "this.#body.validated = validateRoot", API],
  ["root-missing-reads", "apps/api/src/root.ts", 'err.code === "missing" && reads.length === 0', 'err.code === "missing"', API],
  ["root-utf8-not-fatal", "apps/api/src/root.ts", "{ fatal: true, ignoreBOM: true }", "{ fatal: false, ignoreBOM: true }", API],
  ["root-strip-bom", "apps/api/src/root.ts", "{ fatal: true, ignoreBOM: true }", "{ fatal: true, ignoreBOM: false }", API],
  ["root-size-zero", "apps/api/src/root.ts", "layer.size < 1 ||", "layer.size < 0 ||", API],
  ["root-stale-claims-tier", "apps/api/src/root.ts", "return { root: kept, reads: [], stale: true };", 'return { root: kept, reads: [{ tier: "ghcr", pack: kept.digest, sources: [], root: true }], stale: true };', API],
  ["root-no-deadline", "apps/api/src/root.ts", "const root = await Promise.race([work, late]);", "const root = await work;", API],
  ["root-read-counted-as-pack", "apps/api/src/root.ts", "reads.push({ tier: tierOf(m.from), pack: m.digest, sources: [], root: true });", "reads.push({ tier: tierOf(m.from), pack: m.digest, sources: [] });", API],
  ["cache-no-waituntil", "apps/api/src/cache.ts", "this.#waitUntil(cache.put(this.key(kind, name), response)", "void (cache.put(this.key(kind, name), response)", API],
  ["cache-key-host-fixed", "apps/api/src/cache.ts", "`https://${this.#host}${CACHE_PREFIX}", "`https://domains.pkgforge.dev${CACHE_PREFIX}", API],
  ["cache-key-no-encode", "apps/api/src/cache.ts", "${encodeURIComponent(name)}", "${name}", API],
  ["cors-expose-as-of", "apps/api/src/answer.ts", '  "x-domains-as-of",\n', "", API],
  ["cors-preflight-maxage", "apps/api/src/answer.ts", '"access-control-max-age": "86400"', '"access-control-max-age": "600"', API],
  ["route-subpath", "apps/api/src/index.ts", "Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname]", 'Object.hasOwn(ROUTES, url.pathname.replace(/\\/$/, "") || "/") ? ROUTES[url.pathname.replace(/\\/$/, "") || "/"]', API],
  ["route-ray-default", "apps/api/src/index.ts", 'request.headers.get("cf-ray") ?? "-"', 'request.headers.get("cf-ray") ?? "none"', API],
  ["guide-reason-removed", "apps/api/src/guide.ts", '  "bad-window": ', '  // "bad-window": ', API],
  ["guide-retry-flipped", "apps/api/src/guide.ts", '"No route answers the path. Do not retry the same path."', '"No route answers the path. Retry later."', API],
  ["ghcr-send-timer-x100", "packages/ghcr/src/reader.ts", "setTimeout(() => stop.abort(), d.timeoutMs);", "setTimeout(() => stop.abort(), d.timeoutMs * 100);", "packages/ghcr"],
  ["ghcr-body-timer-x100", "packages/ghcr/src/reader.ts", " s`)), timeoutMs);", " s`)), timeoutMs * 100);", "packages/ghcr"],
  ["ghcr-send-timer-never-cleared", "packages/ghcr/src/reader.ts", "  } finally {\n    clearTimeout(timer);\n  }\n}\n\n// A body read whole", "  } finally {\n  }\n}\n\n// A body read whole", "packages/ghcr"],
  ["ghcr-manifest-body-default", "packages/ghcr/src/reader.ts", "const bytes = await readCapped(res, max, d.timeoutMs);", "const bytes = await readCapped(res, max);", "packages/ghcr"],
  ["ghcr-range-body-default", "packages/ghcr/src/reader.ts", "const bytes = await readCapped(res, want, d.timeoutMs);\n    if (bytes === null) throw", "const bytes = await readCapped(res, want);\n    if (bytes === null) throw", "packages/ghcr"],
  ["ghcr-realm-any-scheme", "packages/ghcr/src/reader.ts", 'if (typeof www !== "string" || !/^\\s*bearer\\s/i.test(www)) return null;', 'if (typeof www !== "string") return null;', "packages/ghcr"],
  ["ghcr-refused-token-kept", "packages/ghcr/src/reader.ts", "  if (kept !== null) tokens.delete(repo);\n", "", "packages/ghcr"],
  ["core-title-405", "packages/core/src/problem.ts", '405: "Method Not Allowed",', '405: "Not Allowed",', "packages/core"],
  ["core-root-read-is-pack", "packages/core/src/provenance.ts", "record.reads.filter((r) => r.root !== true).map((r) => r.pack)", "record.reads.map((r) => r.pack)", "packages/core"],
  ["core-empty-reads-always", "packages/core/src/provenance.ts", "if (record.reads.length === 0 && record.stale !== true)", "if (false)", "packages/core"],
  ["core-root-sources-ok", "packages/core/src/provenance.ts", "if (r.root === true && r.sources.length > 0)", "if (false)", "packages/core"],
];

const only = process.argv[2];
let bad = 0;
for (const [id, file, from, to, suite] of M) {
  if (only && id !== only) continue;
  const original = readFileSync(file);
  const text = original.toString("utf8");
  const n = text.split(from).length - 1;
  if (n !== 1) {
    console.log(`INVALID ${id}: the text occurs ${n} times in ${file}`);
    bad += 1;
    continue;
  }
  let exit = null;
  try {
    writeFileSync(file, text.replace(from, to));
    const r = spawnSync(process.execPath, ["scripts/test.mjs", suite], { encoding: "utf8", timeout: 300_000 });
    exit = r.status;
  } finally {
    writeFileSync(file, original);
  }
  const restored = readFileSync(file).equals(original);
  const killed = exit !== 0;
  if (!killed || !restored) bad += 1;
  console.log(`${killed ? "KILLED " : "SURVIVED"} ${id} (${suite}) exit=${exit}${restored ? "" : " NOT RESTORED"}`);
}
console.log(bad === 0 ? "all killed, every file restored" : `${bad} not killed or not restored`);
process.exit(bad === 0 ? 0 : 1);
