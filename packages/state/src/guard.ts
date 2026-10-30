// packages/state/src/guard.ts — the digest guard of every moving tag of the
// package `state` (`latest`, `ledger-delta`), the mirror's writer guard
// applied to state (DOM-024): a run moves a tag only while it holds the
// digest the run read.
//
//   guard("state:latest", "sha256:<read>", "sha256:<found>")   nothing, or StateError stale
//
// `expected` is the digest the run read before it planned the move (null: the
// tag was absent), `found` the digest the tag holds now (null: absent). A
// mover calls it twice, with a read made with the job's token each time:
// before it pushes its run object, and again immediately before `oras tag`
// (`moveTag` of scripts/state/lib.mjs). A refusal keeps the live tag: the next
// run reads it and plans again.
import { StateError } from "./errors.ts";
import { DIGEST } from "./state.ts";

function digestOrNull(v: unknown, name: string): void {
  if (v !== null && (typeof v !== "string" || !DIGEST.test(v)))
    throw new StateError("usage", `the guard's ${name} ${v === undefined ? "is missing; it" : JSON.stringify(v)} is neither a sha256: digest nor null`);
}

export function guard(what: string, expected: string | null, found: string | null): void {
  if (typeof what !== "string" || what === "") throw new StateError("usage", "the guard names no tag");
  digestOrNull(expected, "expected digest");
  digestOrNull(found, "found digest");
  if (found === expected) return;
  throw new StateError("stale", `${what} holds ${found ?? "nothing"}, and this run read ${expected ?? "nothing"}: another writer moved it. The live one is kept`);
}
