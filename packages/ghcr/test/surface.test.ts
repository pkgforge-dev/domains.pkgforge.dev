// packages/ghcr/src/index.ts: the package's public surface. The reader's
// low-level parts stay inside reader.ts, since send sends any Authorization to
// any URL and each of them skips the checks of ghcrReader (the wave 3 door
// sweep, finding 3). A re-export of any of them fails here.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as ghcr from "../src/index.ts";

const CLOSED = ["send", "ghcr", "tokenNew", "tokenKept", "resetTokens", "dialer", "readCapped"];

test("ghcr surface: the reader's low-level parts are not exported, and the reader, its error and the layout are", () => {
  const names = Object.keys(ghcr);
  for (const name of CLOSED) assert.ok(!names.includes(name), `${name} is exported from @domains/ghcr`);
  for (const name of ["ghcrReader", "GhcrError", "rootTag", "segTag", "refTag", "tierTag", "NAMESPACE"]) {
    assert.ok(names.includes(name), `${name} is not exported from @domains/ghcr`);
  }
});
