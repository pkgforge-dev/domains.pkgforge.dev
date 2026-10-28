// A Worker that imports a Node module. Without nodejs_compat a deploy refuses it,
// and so does the harness's bundle step (workerd.test.ts).
import { readFileSync } from "node:fs";

export default {
  fetch(): Response {
    return new Response(typeof readFileSync);
  },
};
