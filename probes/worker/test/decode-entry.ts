// probes/worker/test/decode-entry.ts — a test-only Worker that serves DOM-008's
// /decode route and nothing else, so that test/decode-workerd.test.ts runs the
// route in workerd whatever rows src/index.ts's ROUTES holds. It answers a
// thrown error as src/index.ts's handleFetch does: a ProbeError's status, else
// 500, with the message in a JSON body. It is never deployed.
import { decodeRoute } from "../src/decode.ts";
import { ProbeError } from "../src/gaps.ts";
import type { Env } from "../src/types.ts";

const json = (status: number, body: unknown): Response => new Response(`${JSON.stringify(body)}\n`, { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== decodeRoute.path) return json(404, { error: `no route ${url.pathname}` });
    if (request.method !== decodeRoute.method) return json(405, { error: `${url.pathname} answers ${decodeRoute.method} only` });
    try {
      return await decodeRoute.handle(request, env, url, Date.now);
    } catch (err) {
      return json(err instanceof ProbeError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) });
    }
  },
};
