// A Worker that fetches the URL in its `url` parameter and answers the body, or
// 502 with the error when the fetch fails. workerd.test.ts uses it to see where
// a Worker's outbound fetch goes.
export default {
  async fetch(request: Request): Promise<Response> {
    const target = new URL(request.url).searchParams.get("url") ?? "";
    try {
      const res = await fetch(target);
      return new Response(await res.text(), { status: res.status });
    } catch (err) {
      return new Response(`fetch failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
    }
  },
};
