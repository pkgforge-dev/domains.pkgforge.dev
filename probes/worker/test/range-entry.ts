// probes/worker/test/range-entry.ts — a test-only entry Worker that serves the
// /range route of DOM-007 and nothing else, so test/range-workerd.test.ts runs
// the route in workerd on its own, apart from src/index.ts. It dispatches as
// handleFetch in src/index.ts does: the route's ProbeError becomes its status
// with a JSON body; any other error is 500. Never deployed: wrangler.toml's
// main is src/index.ts.
import { ProbeError } from "../src/gaps.ts";
import { rangeRoute } from "../src/range.ts";
import type { Env } from "../src/types.ts";

const json = (status: number, body: unknown): Response => new Response(`${JSON.stringify(body)}\n`, { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== rangeRoute.path) return json(404, { error: `no route ${url.pathname}` });
    try {
      return await rangeRoute.handle(request, env, url, Date.now);
    } catch (err) {
      return json(err instanceof ProbeError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) });
    }
  },
};
