// packages/adapter/test/fixture-psl.ts — the list the package's tests pass as
// ctx.psl: the names package's fixture list (packages/names/test/fixtures),
// loaded once a test file. Node-only: adapter-worker.ts, which runs in workerd,
// gets the list's text in its request and loads it there.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPsl } from "@domains/names";

export const PSL_FILE = join(import.meta.dirname, "..", "..", "names", "test", "fixtures", "psl-2026-10-27.dat");
export const PSL_TEXT = readFileSync(PSL_FILE, "utf8");
export const PSL = await loadPsl(readFileSync(PSL_FILE));
