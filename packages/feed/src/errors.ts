// packages/feed/src/errors.ts — the one error of the feed. Its `code` names the
// check that refused, so a job can print `FAIL <code> <detail>`, a route can
// map it to a problem reason, and a test can tell one guard from another.
//
//   usage      a call outside the contract: a bad option, a value out of range
//   order      rows or keys that do not ascend by key
//   window     a window that is not whole seconds with t0 below t1, or a row
//              whose first_seen falls outside the span of the pack it is built for
//   precision  a row whose first_seen does not fit the precision of its sources
//   facts      a fact about an event that the rules cannot take (an RDAP date
//              on or after 2026-01-01 given as a refutation)
//   live       a live set whose spans overlap, or a pack entry that does not parse
//   range      a suffix or a parent that is not a valid name
//   time       a time copy that does not bind to its key copy (docs/format.md
//              section 14.2), a pack of tier d, w, m or y read with no time
//              copy, or a first_seen that a time key cannot hold
//   budget     a page that cannot give one row inside the block budget

export type FeedErrorCode = "usage" | "order" | "window" | "precision" | "facts" | "live" | "range" | "time" | "budget";

export class FeedError extends Error {
  readonly code: FeedErrorCode;
  constructor(code: FeedErrorCode, message: string) {
    super(message);
    this.name = "FeedError";
    this.code = code;
  }
}
