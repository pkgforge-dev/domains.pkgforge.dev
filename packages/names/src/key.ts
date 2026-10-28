// packages/names/src/key.ts — the sort key of every sorted dataset: the labels
// of a name in reverse order (docs/architecture.md section 3.2).
//
//   key("api.example.com.np")     →  "np.com.example.api"
//   fromKey("np.com.example.api") →  "api.example.com.np"
//   rangeOfDescendants("np.com")  →  ["np.com.", "np.com/"]
//
// Keys compare bytewise. A key is ASCII (the charset of syntax.ts), so the
// JavaScript string order of two keys is their byte order, the order of
// `LC_ALL=C sort`.
//
// Every name strictly below a parent has a key in the half-open range
// [parent + ".", parent + "/"); the parent itself is a point lookup. A range
// that starts at the parent key itself also takes `np.com-x`, because `-`
// (0x2D) sorts before `.` (0x2E). `/` (0x2F) is the byte after `.` and is not
// in the charset, so nothing but a descendant sorts inside the range: `np.com0`
// and `np.comz` sort after its end.
//
// ⚠ Key order is not the order of the label lists compared label by label:
// `np.com-x` sorts before `np.com.a` as a key, and after it label by label
// (`com` is a prefix of `com-x`). That is why a subtree is a range starting at
// `parent + "."` and not at the parent.
import { checkLabels } from "./syntax.ts";

function reverseLabels(text: string): string {
  return text.split(".").reverse().join(".");
}

// The key of a valid lowercase name; a NameError otherwise.
export function key(name: string): string {
  checkLabels(name);
  return reverseLabels(name);
}

// The name of a valid key; a NameError otherwise.
export function fromKey(k: string): string {
  checkLabels(k);
  return reverseLabels(k);
}

// The half-open key range [start, end) of every name strictly below the name
// whose key is k. k may be a single label: `np` gives every name under `.np`.
export function rangeOfDescendants(k: string): readonly [start: string, end: string] {
  checkLabels(k);
  return [`${k}.`, `${k}/`];
}
