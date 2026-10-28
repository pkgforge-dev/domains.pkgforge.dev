// A Worker that answers the plain variables of its environment as JSON.
// workerd.test.ts uses it to see that `bindings` reach the Worker.
export default {
  async fetch(_request: Request, env: Record<string, unknown>): Promise<Response> {
    return new Response(JSON.stringify({ greeting: env.GREETING ?? null, limit: env.LIMIT ?? null }), { headers: { "content-type": "application/json" } });
  },
};
