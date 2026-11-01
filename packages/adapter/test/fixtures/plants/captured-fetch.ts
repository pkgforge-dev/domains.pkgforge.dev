// packages/adapter/test/fixtures/plants/captured-fetch.ts — a plant (DOM-016's
// Found of 2026-10-29T04:54Z, TODO/ingest.md DOM-026): an adapter that took the
// global fetch at import, before any harness ran, so the harness's trap on the
// global fetch never sees its call. The URL comes in the cursor, so a test
// points it at a local server and the sandbox child needs no environment.
// test/sandbox.test.ts holds it to reach that server in process and to be
// refused in the sandbox.
import type { AdapterContext, Cursor, RunResult } from "../../../src/types.ts";

const captured = globalThis.fetch;

export async function run(cursor: Cursor, _ctx: AdapterContext): Promise<RunResult> {
  const { url } = cursor as { url: string };
  await (await captured(url)).text();
  return { segments: [], cursor, stats: {}, errors: [] };
}
