// packages/compact/src/errors.ts — the one error of compaction. Its `code`
// names the check that refused, so a CLI can print `FAIL <code> <detail>` and
// a test can tell one guard from another.
//
//   usage      a call outside the contract: a bad option, a tier or a span that is not one
//   straddle   a live pack crosses the edge of the unit, so no pack of the unit can replace it
//   count      the output of a merge does not hold exactly the distinct keys of its inputs,
//              or a record that is not the merge of the inputs' records of its key
//   plan       a plan, a count or a range result that does not belong to the plan given,
//              or a set of them with one missing, one twice or one out of order
//   range      a range window that the counts do not give, or a range output
//              that does not join the ranges beside it
//   span       a range that does not fit in one part
//   time       a time copy that cannot be merged (inputs that share a key), or that
//              does not bind to its key copy (timeBindFault of @domains/pack)
//   sort       a time copy to sort that holds more rows than the sort holds
//   psl        inputs built under more than one Public Suffix List, for a dataset
//              whose keys depend on the list
//   tag        a unit whose tag @domains/ghcr refuses (a start off the tier's boundary,
//              a tier or a dataset with no tag): tagDecision's LayoutError

export type CompactErrorCode = "usage" | "straddle" | "count" | "plan" | "range" | "span" | "time" | "sort" | "psl" | "tag";

export class CompactError extends Error {
  readonly code: CompactErrorCode;
  constructor(code: CompactErrorCode, message: string) {
    super(message);
    this.name = "CompactError";
    this.code = code;
  }
}
