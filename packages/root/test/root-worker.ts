// packages/root/test/root-worker.ts — the Worker the root workerd test runs.
// It proves packages/root/src runs in workerd under the pinned compatibility
// date and flags (no nodejs_compat): a reader's validateRoot of root.json, a
// writer's, and the next root built and held forward of a live one.
//
//   POST /root   the body is JSON: { root, live, add, psl, now }: the root to
//                read (strict and not), and a live root, packs to add, the pin
//                and the time to build the next root from. Answers what each gives.
// A RootError answers 422 with its code and message. Any other path or method
// answers 404.
import { buildRoot, type LiveRoot, type NewPack, RootError, validateRoot } from "../src/index.ts";

interface Ask {
  root: unknown;
  live: LiveRoot;
  add: NewPack[];
  psl: string;
  now: string;
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function root(request: Request): Promise<Response> {
  const ask = (await request.json()) as Ask;
  try {
    const reader = validateRoot(ask.root, { strict: false });
    const writer = validateRoot(ask.root);
    const next = buildRoot({ live: ask.live, add: ask.add, psl: ask.psl, now: ask.now });
    return json({ reader: reader.root_seq, writer: writer.as_of, next });
  } catch (error) {
    if (error instanceof RootError) return json({ code: error.code, message: error.message }, 422);
    throw error;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/root") return root(request);
    return new Response("not found", { status: 404 });
  },
};
