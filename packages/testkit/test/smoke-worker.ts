// packages/testkit/test/smoke-worker.ts — the Worker the harness test runs in
// workerd. It proves two runtime APIs exist under the pinned compatibility date
// and flags; DOM-008 measured the CPU of DecompressionStream("deflate-raw") on
// Cloudflare itself.
//
//   GET  /decode?text=T   compresses T with CompressionStream("deflate-raw") and
//                         decompresses it with DecompressionStream("deflate-raw")
//   POST /decode          decompresses the body, raw deflate made elsewhere
//   GET  /cache?key=K     puts a body under K in caches.default, then matches it
// Every answer is JSON. Any other path answers 404.
//
// Like every Worker source, it typechecks twice: against the Workers runtime
// types (tsconfig.worker.json) and against Node's (tsconfig.json). So it names
// the one runtime-only member it uses, caches.default, in its own interface.

interface DefaultCache {
  put(key: Request, response: Response): Promise<void>;
  match(key: Request): Promise<Response | undefined>;
}

// caches.default exists only in workerd, so Node's types do not declare it: the
// cast names the one member this Worker uses.
const defaultCache = (): DefaultCache => (globalThis as unknown as { caches: { default: DefaultCache } }).caches.default;

// The one shape both type sets give CompressionStream and DecompressionStream.
interface ByteTransform {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<ArrayBuffer | ArrayBufferView>;
}

// The copy gives a Uint8Array over a plain ArrayBuffer, which both type sets
// accept as a Blob part.
const streamOf = (bytes: Uint8Array): ReadableStream<ArrayBuffer | ArrayBufferView> => new Blob([new Uint8Array(bytes)]).stream();

async function pipeBytes(body: ReadableStream<ArrayBuffer | ArrayBufferView>, transform: ByteTransform): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(body.pipeThrough(transform)).arrayBuffer());
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function decode(request: Request, url: URL): Promise<Response> {
  if (request.method === "POST") {
    if (request.body === null) return json({ error: "no body" }, 400);
    const plain = await pipeBytes(request.body, new DecompressionStream("deflate-raw"));
    return json({ text: new TextDecoder().decode(plain), bytes: plain.byteLength });
  }
  const text = url.searchParams.get("text") ?? "";
  const packed = await pipeBytes(streamOf(new TextEncoder().encode(text)), new CompressionStream("deflate-raw"));
  const back = await pipeBytes(streamOf(packed), new DecompressionStream("deflate-raw"));
  return json({ text: new TextDecoder().decode(back), compressedBytes: packed.byteLength });
}

async function cache(url: URL): Promise<Response> {
  const name = url.searchParams.get("key") ?? "smoke";
  const key = new Request(`https://cache.worker.test/${encodeURIComponent(name)}`);
  const body = `stored at ${name}`;
  await defaultCache().put(key, new Response(body, { headers: { "cache-control": "public, max-age=60" } }));
  const hit = await defaultCache().match(key);
  return json({ stored: body, matched: hit === undefined ? null : await hit.text() });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/decode") return decode(request, url);
    if (url.pathname === "/cache") return cache(url);
    return json({ error: `no route ${url.pathname}` }, 404);
  },
};
