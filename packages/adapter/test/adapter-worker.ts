// packages/adapter/test/adapter-worker.ts — the Worker the adapter workerd test
// runs (test/workerd.test.ts). It proves src/ runs in workerd under the pinned
// compatibility date and flags (no nodejs_compat): the harness with its fake
// fetch and its trap on the global fetch, the writer's Web Crypto digest, the
// band check, and the production fetch seam.
//
//   POST /harness?plant=P   body { recordings, cursor, now }: runAdapter on the
//                           synthetic day adapter with plant P. Answers
//                           { ok: true, first, next } or { ok: false, check, message }.
//   POST /band              body { days: [{ day, count }] }: the verdict of each
//                           day against the ones before it, in date order.
//   GET /live?url=U         ctx.fetch(U) with ctx.fetch = liveFetch.
//   GET /method?url=U       ctx.fetch(U) with ctx.fetch = the global fetch itself.
// Every answer is JSON. Any other path or method answers 404.
import { type BandDay, ContractError, checkBand, liveFetch, parseRecording, runAdapter } from "../src/index.ts";
import { type DayPlant, dayAdapter } from "./synthetic.ts";

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function harness(request: Request, url: URL): Promise<Response> {
  const body = (await request.json()) as { recordings: { name: string; json: unknown }[]; cursor: { last_day: string }; now: string };
  const recordings = body.recordings.map((r) => parseRecording(r.json, r.name));
  try {
    const { first, next } = await runAdapter(dayAdapter((url.searchParams.get("plant") ?? "none") as DayPlant), { recordings, cursor: body.cursor, now: body.now });
    return json({ ok: true, first: { segments: first.result.segments, cursor: first.result.cursor, requests: first.requests }, next: { segments: next.result.segments } });
  } catch (error) {
    if (error instanceof ContractError) return json({ ok: false, check: error.check, message: error.message });
    throw error;
  }
}

async function band(request: Request): Promise<Response> {
  const { days } = (await request.json()) as { days: { day: string; count: number }[] };
  const history: BandDay[] = [];
  const out = days.map((d) => {
    const r = checkBand(d.count, history, { metric: "bytes", min: 0.4, max: 2.5, relative: true }, { precision: "day" });
    history.push({ day: d.day, count: d.count, quarantined: r.verdict === "quarantine" });
    return { day: d.day, ...r };
  });
  return json(out);
}

async function call(fetch: (input: string, init?: RequestInit) => Promise<Response>, target: string): Promise<Response> {
  const ctx = { fetch };
  try {
    const res = await ctx.fetch(target, { headers: { "user-agent": "adapter-workerd-test" } });
    return json({ ok: true, status: res.status, text: await res.text() });
  } catch (error) {
    return json({ ok: false, error: String((error as Error).message) });
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = url.searchParams.get("url") ?? "";
    if (request.method === "POST" && url.pathname === "/harness") return harness(request, url);
    if (request.method === "POST" && url.pathname === "/band") return band(request);
    if (request.method === "GET" && url.pathname === "/live") return call(liveFetch, target);
    if (request.method === "GET" && url.pathname === "/method") return call(globalThis.fetch, target);
    return json({ error: `no route ${request.method} ${url.pathname}` }, 404);
  },
};
