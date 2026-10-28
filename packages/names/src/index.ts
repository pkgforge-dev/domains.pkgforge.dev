// @domains/names: one name for every adapter and for the Worker.
//   normalise            a raw name to { name, wild } or { refused }
//   loadPsl, split       the pinned Public Suffix List: suffix, reg and site
//   key, fromKey         reversed labels, the sort key of every dataset
//   rangeOfDescendants   the key range of every name below a parent
// It imports nothing from `node:` and reads no global that only one runtime
// has, so the same code runs in Node and in workerd.
export { fromKey, key, rangeOfDescendants } from "./key.ts";
export type { Normalised, Refusal } from "./normalise.ts";
export { normalise, REFUSALS } from "./normalise.ts";
export type { Psl, RuleKind, Split } from "./psl.ts";
export { isPublicSuffix, loadPsl, MARKERS, PslError, parseRule, split } from "./psl.ts";
export type { Fault, Scan } from "./syntax.ts";
export { checkLabels, MAX_LABEL, MAX_NAME, NameError, scan, toAscii } from "./syntax.ts";
