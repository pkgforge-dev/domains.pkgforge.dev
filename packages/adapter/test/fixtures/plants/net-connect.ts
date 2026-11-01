// packages/adapter/test/fixtures/plants/net-connect.ts — a plant: an adapter
// that opens a node:net socket of its own instead of ctx.connect, which no
// trap of the harness sees. It connects to 127.0.0.1 at the cursor's port and
// waits for the server's first byte, so the server has counted the connection
// before the run returns. test/sandbox.test.ts holds it to reach that server in
// process and to be refused in the sandbox.
import { connect } from "node:net";
import type { AdapterContext, Cursor, RunResult } from "../../../src/types.ts";

export async function run(cursor: Cursor, _ctx: AdapterContext): Promise<RunResult> {
  const { port } = cursor as { port: number };
  await new Promise<void>((ok, fail) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("data", () => {
      s.destroy();
      ok();
    });
    s.once("error", fail);
  });
  return { segments: [], cursor, stats: {}, errors: [] };
}
