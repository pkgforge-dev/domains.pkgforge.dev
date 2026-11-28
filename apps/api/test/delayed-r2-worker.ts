import type { Env, WaitContext } from "../src/context.ts";
import api from "../src/index.ts";

// Wrap only the native GET so the normal request crosses the 250 ms soft
// deadline while every byte and metadata field still comes from Miniflare R2.
export default {
  fetch(request: Request, env: Required<Pick<Env, "CACHE">>, ctx: WaitContext): Promise<Response> {
    const native = env.CACHE;
    return api.fetch(
      request,
      {
        CACHE: {
          async get(key) {
            const object = await native.get(key);
            await new Promise<void>((resolve) => setTimeout(resolve, 450));
            return object;
          },
          put: native.put.bind(native),
        },
      },
      ctx,
    );
  },
};
