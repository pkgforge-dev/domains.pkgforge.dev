// packages/state/src/errors.ts — the one error of the state package. Its code
// says which rule a call, a state or a proposal broke:
//   usage     a call this package refuses before it reads anything: a time
//             that is not ISO 8601 UTC to the second, a run id off its
//             grammar, an answer of a caller's callback off its shape
//   format    bytes that are not UTF-8 JSON, or a `format` this reader does
//             not know (a reader refuses a state or a proposal of another
//             version rather than guess at it)
//   schema    a state.json field missing, unknown, of the wrong type, or
//             breaking its rule (an order, a limit, a duplicate)
//   size      a state or a proposal over its limit, measured before parsing
//   proposal  a proposal that breaks its rules (proposal.ts), propose's
//             refusal among them
//   stale     a moving tag of `state` that holds another digest than the one
//             this run read: another writer moved it (guard)
export type StateErrorCode = "usage" | "format" | "schema" | "size" | "proposal" | "stale";

export class StateError extends Error {
  readonly code: StateErrorCode;
  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = "StateError";
    this.code = code;
  }
}
