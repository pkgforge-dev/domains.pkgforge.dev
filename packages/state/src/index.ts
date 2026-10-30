// @domains/state: the state of the ingest (DOM-024), for the lanes that
// propose a cursor and the one job that moves it (scripts/ingest/run.mjs,
// scripts/state/).
//   errors.ts    StateError and its codes
//   state.ts     state.json (domains.state.v1): the cursors, the volume history and
//                the packs owed to the root; validateState, parseState, encodeState,
//                emptyState, sameState, cursorOf, historyOf, owe; isSecond (a time to
//                the second) and RUN_ID (a workflow run id or "local"), which the
//                scripts of scripts/state/ and scripts/ingest/ hold their flags to
//   proposal.ts  the cursor proposal of one adapter run (domains.proposal.v1):
//                propose, validateProposal, parseProposal, encodeProposal,
//                proposalFile, proposedRefs
//   advance.ts   advance: the proposals applied to the live state; settle: the owed
//                packs the live root holds, or that expired, dropped
//   guard.ts     guard: the digest guard of every moving tag of the package state
// The GHCR side, reading the live state and moving its tags, is scripts/state/.
// This package reads and writes no network and imports nothing from `node:`;
// it is type-checked as Worker code (tsconfig.worker.json), and no test runs
// it in workerd.
export type { Cursor } from "@domains/adapter";
export type { Advanced, DropCode, Dropped, Held, SettleCode, Settled } from "./advance.ts";
export { advance, settle } from "./advance.ts";
export type { StateErrorCode } from "./errors.ts";
export { StateError } from "./errors.ts";
export { guard } from "./guard.ts";
export type { Lane, Proposal, ProposedDay, ProposedRaw, ProposedSegment, ProposeInput } from "./proposal.ts";
export { encodeProposal, LANES, PROPOSAL_FORMAT, PROPOSAL_MAX_BYTES, parseProposal, propose, proposalFile, proposedRefs, validateProposal } from "./proposal.ts";
export type { HistoryItem, Moved, OwedItem, State } from "./state.ts";
export {
  cursorOf,
  emptyState,
  encodeState,
  HISTORY_DAYS,
  historyOf,
  isSecond,
  OWED_DAYS,
  owe,
  parseState,
  RUN_ID,
  STATE_FORMAT,
  STATE_MAX_BYTES,
  STATE_MEDIA_TYPE,
  STATE_TITLE,
  sameState,
  validateState,
} from "./state.ts";
