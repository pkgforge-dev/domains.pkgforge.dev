// BASES of packages/adapter/src/types.ts against BASIS of packages/pack/src/codec.ts:
// a basis a source.json names is one the DPK1 writer stores (docs/architecture.md
// sections 3.3 and 3.5, docs/format.md section 5.3). Only this test imports
// @domains/pack; the adapter package itself does not depend on it. A file of its
// own, so a fault in the pack package fails this test alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASIS } from "@domains/pack";
import { BASES } from "../src/types.ts";

test("adapter basis: the registry's bases are the keys of the DPK1 basis table, in the order of their ids", () => {
  assert.deepEqual([...BASES], Object.keys(BASIS));
  assert.deepEqual(
    BASES.map((b) => BASIS[b]),
    [0, 1, 2, 3, 4],
  );
});
