// probes/worker/test/kafka-entry.ts — a test-only entry Worker that serves the
// /kafka route of DOM-005 and nothing else, so test/kafka-workerd.test.ts runs
// the route in workerd on its own, apart from src/index.ts. The route is the
// production one with two changes: the broker's address comes from the
// bindings KAFKA_HOST and KAFKA_PORT (the test's fake broker on 127.0.0.1), and
// the wall and connect caps from WALL_MS and CONNECT_MS when they are set. The
// connect is the production default, cloudflare:sockets. GET /loader answers
// the type of what loadConnect() returns. It dispatches as handleFetch in
// src/index.ts does: the route's ProbeError becomes its status with a JSON body;
// any other error is 500. Never deployed: wrangler.toml's main is src/index.ts.
import { ProbeError } from "../src/gaps.ts";
import { type KafkaLimits, loadConnect, makeKafkaRoute } from "../src/kafka.ts";
import type { Env } from "../src/types.ts";

// The test's plain bindings; the route reads none of Env's.
interface TestEnv {
  readonly KAFKA_HOST: string;
  readonly KAFKA_PORT: number;
  readonly WALL_MS?: number;
  readonly CONNECT_MS?: number;
}

const json = (status: number, body: unknown): Response => new Response(`${JSON.stringify(body)}\n`, { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/loader") return json(200, { connect: typeof (await loadConnect()) });
    const limits: Partial<KafkaLimits> = {};
    if (env.WALL_MS !== undefined) Object.assign(limits, { wall_ms: env.WALL_MS });
    if (env.CONNECT_MS !== undefined) Object.assign(limits, { connect_ms: env.CONNECT_MS });
    const route = makeKafkaRoute({ hostname: env.KAFKA_HOST, port: env.KAFKA_PORT, limits });
    if (url.pathname !== route.path) return json(404, { error: `no route ${url.pathname}` });
    try {
      // The route reads no binding, so the probe's Env is not needed here.
      return await route.handle(request, env as unknown as Env, url, Date.now);
    } catch (err) {
      return json(err instanceof ProbeError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) });
    }
  },
};
