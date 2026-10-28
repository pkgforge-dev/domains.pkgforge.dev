// packages/names/src/normalise.ts — one raw name to the name every dataset
// stores, or the reason it is refused.
//
//   normalise("*.API.Example.com.", psl)  →  { name: "api.example.com", wild: true }
//   normalise("bücher.example", psl)      →  { name: "xn--bcher-kva.example", wild: false }
//   normalise("co.uk", psl)               →  { refused: "public-suffix" }
//
// Every adapter runs this one function (docs/architecture.md section 3.1), so
// two sources never store one name as two. The steps, in this order:
//   1. Remove one trailing dot, then a leading `*.`, which sets `wild`.
//   2. One loop over the characters: the charset `[a-z0-9_.-]` (upper case is
//      lowercased), no empty label, no label over 63, no name over 253.
//   3. A text holding a character above 0x7f is converted to its ASCII form
//      (toAscii in syntax.ts) and the loop runs again on the result. The first
//      fault in character order names the refusal, except that a character
//      above 0x7f anywhere sends the text to the conversion first.
//   4. Refuse a name with no dot, and a name whose last label is all digits.
//   5. Refuse a name that is itself an ICANN public suffix (`co.uk`, `com.np`).
//      `github.io` is a suffix of the private section only, and passes.
//
// The input is text: a caller decodes UTF-8 before it calls. A line read as
// latin1 would turn `ü` into two characters, which convert to a valid but
// different name. A carriage return, a space or any other ASCII character
// outside the charset is a refusal, so a line splitter that leaves `\r` fails
// loudly on every name.
//
// The all-digit last label (step 4) is DOM-015's decision on DOM-009's finding:
// 1,516 names of THC's 2026-10-26 dump, under 256 distinct all-digit top-level
// labels, are address literals such as `192.0.2.1` that a certificate carried.
// RFC 1123 section 2.1: a host name never has the dotted-decimal form, because
// its highest-level label is alphabetic. Kept, each would make a top-level
// suffix such as `1` and a registrable domain such as `2.1`, which the `domains`
// ledger would report as new.
import { isPublicSuffix, type Psl } from "./psl.ts";
import { asciiInCharset, hasHigh, type Scan, scan, toAscii } from "./syntax.ts";

export const REFUSALS = Object.freeze(["empty", "charset", "idn", "label-empty", "label-long", "name-long", "no-dot", "numeric-tld", "public-suffix"] as const);
export type Refusal = (typeof REFUSALS)[number];

export type Normalised = { name: string; wild: boolean } | { refused: Refusal };

const DOT = 46;
const STAR = 42;

// The refusal of a scan, or null when it passed. `high` cannot reach here.
function refusalOf(s: Scan): Refusal | null {
  if (s.fault !== null) return s.fault === "high" ? "idn" : s.fault;
  if (s.dots === 0) return "no-dot";
  if (s.numericTld) return "numeric-tld";
  return null;
}

export function normalise(input: string, psl: Psl): Normalised {
  let start = 0;
  let end = input.length;
  if (end > start && input.charCodeAt(end - 1) === DOT) end -= 1;
  let wild = false;
  if (end - start >= 2 && input.charCodeAt(start) === STAR && input.charCodeAt(start + 1) === DOT) {
    wild = true;
    start += 2;
  }
  if (end === start) return { refused: "empty" };
  let s = scan(input, start, end);
  let name: string;
  if (s.fault === null) {
    name = s.upper ? input.slice(start, end).toLowerCase() : input.slice(start, end);
  } else if (s.fault !== "high" && !hasHigh(input, start, end)) {
    return { refused: s.fault };
  } else {
    const text = input.slice(start, end);
    if (!asciiInCharset(text)) return { refused: "charset" };
    const ascii = toAscii(text);
    if (ascii === null) return { refused: "idn" };
    s = scan(ascii);
    // The parser answers lowercase ASCII; anything else is not its answer.
    if (s.fault === "high" || s.upper) return { refused: "idn" };
    name = ascii;
  }
  const refused = refusalOf(s);
  if (refused !== null) return { refused };
  if (isPublicSuffix(name, psl)) return { refused: "public-suffix" };
  return { name, wild };
}
