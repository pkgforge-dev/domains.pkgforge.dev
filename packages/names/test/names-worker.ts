// packages/names/test/names-worker.ts — the Worker the names workerd test runs.
// It proves the names package runs in workerd under the pinned compatibility
// date and flags (no nodejs_compat): the IDN conversion through the URL parser,
// the list's hash through crypto.subtle, and the bytes decoded by TextDecoder.
//
//   POST /names?name=N&name=M...   the body is a Public Suffix List. Answers its
//                                  sha256 and rule counts, and for each N what
//                                  normalise, split and key give here.
// Every answer is JSON. Any other path or method answers 404.
import { key, loadPsl, normalise, PslError, split } from "../src/index.ts";

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function names(request: Request, url: URL): Promise<Response> {
  let psl: Awaited<ReturnType<typeof loadPsl>>;
  try {
    psl = await loadPsl(new Uint8Array(await request.arrayBuffer()));
  } catch (error) {
    if (error instanceof PslError) return json({ error: error.message }, 400);
    throw error;
  }
  const rows = url.searchParams.getAll("name").map((input) => {
    const r = normalise(input, psl);
    if ("refused" in r) return { input, refused: r.refused };
    return { input, name: r.name, wild: r.wild, key: key(r.name), ...split(r.name, psl) };
  });
  return json({ sha256: psl.sha256, rules: psl.rules, rows });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/names") return names(request, url);
    return json({ error: `no route ${request.method} ${url.pathname}` }, 404);
  },
};
