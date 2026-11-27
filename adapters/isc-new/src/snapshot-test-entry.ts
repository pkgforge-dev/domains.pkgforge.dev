// The sandbox grants a module access to its own directory. Keep the test
// driver beside the production code it exercises, apart from the live entry.
import type { AdapterModule } from "@domains/adapter";
import { fetchSnapshot, parseSnapshot, writeIndexedSnapshot } from "./index.ts";

const DAY = "2026-11-26";

export const run: AdapterModule["run"] = async (cursor, ctx) => {
  if (cursor !== null) return { cursor, segments: [], stats: { rows: 0 }, errors: [] };
  const file = await fetchSnapshot(ctx, { day: DAY });
  if (file.kind !== "file") throw new Error("the fixture must give a dated file");
  const parsed = await parseSnapshot(file, ctx.psl);
  const segment = await writeIndexedSnapshot(parsed, ctx.writer);
  return { cursor: { written: DAY }, segments: [segment], stats: { rows: parsed.rows }, errors: [] };
};
