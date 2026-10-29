// packages/adapter/src/live.ts — the fetch a production run gives an adapter as
// ctx.fetch: the global fetch, called with globalThis as its receiver.
//
// An adapter calls `ctx.fetch(url)`, a method call on ctx. workerd refuses its
// global fetch called with another receiver ("Illegal invocation"), so passing
// the global fetch itself as ctx.fetch fails only in a deploy; Node's fetch
// accepts either receiver, so a Node test would never show it. The workerd test
// (test/workerd.test.ts) holds both facts. The global is read at each call, so
// the harness's trap on the global fetch also sees a call made through this.
import type { Fetch } from "./types.ts";

export const liveFetch: Fetch = (input, init) => globalThis.fetch(input, init);
