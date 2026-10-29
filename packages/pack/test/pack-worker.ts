// packages/pack/test/pack-worker.ts — the Worker the pack workerd test runs. It
// proves the reader of packages/pack runs in workerd under the pinned
// compatibility date and flags (no nodejs_compat): DecompressionStream for
// deflate-raw and gzip, the CRC-32, the index pages and the record codecs.
//
//   POST /read   the body is JSON: { idx, parts, get?, lo?, hi? }, the index and
//                each part as hex. Answers every record a scan gives, the
//                records of the keys in `get` (null when absent), and the
//                records of the range [lo, hi) when either is given.
// A PackError answers 422 with its code and message. Any other path or method
// answers 404.
import { fromHex, PackError, PackReader, partsSource } from "../src/index.ts";

interface Ask {
  idx: string;
  parts: string[];
  get?: string[];
  lo?: string;
  hi?: string;
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

async function read(request: Request): Promise<Response> {
  const ask = (await request.json()) as Ask;
  try {
    const reader = await PackReader.open(fromHex(ask.idx), partsSource(ask.parts.map(fromHex)));
    const got: Record<string, unknown> = {};
    for (const key of ask.get ?? []) got[key] = await reader.get(key);
    const range = ask.lo !== undefined || ask.hi !== undefined ? await collect(reader.scan(ask.lo, ask.hi)) : null;
    return json({ dataset: reader.index.header.dataset, codec: reader.index.header.codec, blocks: reader.index.header.blocks, records: await collect(reader.scan()), got, range });
  } catch (error) {
    if (error instanceof PackError) return json({ code: error.code, message: error.message }, 422);
    throw error;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/read") return read(request);
    return json({ error: `no route ${request.method} ${url.pathname}` }, 404);
  },
};
