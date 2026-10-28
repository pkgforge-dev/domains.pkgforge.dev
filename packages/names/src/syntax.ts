// packages/names/src/syntax.ts — the one character loop that every name, key
// and Public Suffix List rule goes through, and the one conversion of Unicode
// text to its ASCII form.
//
// Runs in Node and in workerd alike: no `node:` import, no Buffer, no process.
//
// The charset is docs/architecture.md section 3.1's: `[a-z0-9_.-]`, so a valid
// name or key is ASCII and a JavaScript string comparison of two keys is their
// bytewise comparison.

export const MAX_LABEL = 63;
export const MAX_NAME = 253;

const DOT = 46;

// A fault of the loop. `high` is a character above 0x7f, which only the IDN
// conversion can resolve; the others are refusals as they stand.
export type Fault = "high" | "charset" | "label-empty" | "label-long" | "name-long";

export interface Scan {
  // The first fault in character order, or null.
  fault: Fault | null;
  // An ASCII upper-case letter appeared (A to Z): the text is not yet lowercase.
  upper: boolean;
  dots: number;
  // The last label is all digits, as in an address literal such as 192.0.2.1.
  numericTld: boolean;
}

// One pass over text[start, end): the charset, every label from 1 to 63
// characters, at most 253 characters. Upper case passes and is reported.
// No regular expression: this runs once per name of a 38-million-line day.
export function scan(text: string, start = 0, end = text.length): Scan {
  let label = 0;
  let dots = 0;
  let upper = false;
  let digits = true;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === DOT) {
      if (label === 0) return { fault: "label-empty", upper, dots, numericTld: false };
      dots += 1;
      label = 0;
      digits = true;
      continue;
    }
    if (c >= 48 && c <= 57) {
      // a digit keeps the label numeric
    } else if ((c >= 97 && c <= 122) || c === 45 || c === 95) {
      digits = false;
    } else if (c >= 65 && c <= 90) {
      upper = true;
      digits = false;
    } else {
      return { fault: c > 0x7f ? "high" : "charset", upper, dots, numericTld: false };
    }
    label += 1;
    if (label > MAX_LABEL) return { fault: "label-long", upper, dots, numericTld: false };
  }
  if (label === 0) return { fault: "label-empty", upper, dots, numericTld: false };
  if (end - start > MAX_NAME) return { fault: "name-long", upper, dots, numericTld: false };
  return { fault: null, upper, dots, numericTld: digits };
}

// True when text[start, end) holds a character above 0x7f.
export function hasHigh(text: string, start = 0, end = text.length): boolean {
  for (let i = start; i < end; i++) if (text.charCodeAt(i) > 0x7f) return true;
  return false;
}

// True when every ASCII character of text is in [A-Za-z0-9_.-]. Characters
// above 0x7f are left to the conversion.
export function asciiInCharset(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x7f) continue;
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === DOT) continue;
    return false;
  }
  return true;
}

// Unicode text to its ASCII form, or null when the conversion refuses it.
//
// The conversion is the WHATWG URL host parser's (UTS #46 mapping, then
// punycode per label), the one node:url domainToASCII runs, which DOM-009
// measured with. node:url does not exist in workerd under no_nodejs_compat, and
// `new URL("http://" + text).hostname` gives the same answer in both runtimes
// (packages/names/test/workerd.test.ts holds the two equal).
//
// ⛔ Only a text whose ASCII characters are all in [A-Za-z0-9_.-] reaches the
// parser. A `/`, `?`, `#`, `@`, `:` or `\` would end the host early, and the
// parser would answer another host without an error: `ü@evil.example` has the
// host `evil.example`. Full-width forms of those characters are mapped inside
// the host and refused there.
export function toAscii(text: string): string | null {
  if (text.length === 0 || !asciiInCharset(text)) return null;
  try {
    return new URL(`http://${text}`).hostname;
  } catch {
    // The parser throws a TypeError for every host it refuses; that refusal is
    // the answer, and the caller names it.
    return null;
  }
}

// A key, a rule or a name given to a function that needs one already valid.
export class NameError extends Error {
  readonly reason: Fault | "upper";
  constructor(reason: Fault | "upper", text: string) {
    super(`${reason}: ${JSON.stringify(text.length > 300 ? `${text.slice(0, 300)}...` : text)}`);
    this.name = "NameError";
    this.reason = reason;
  }
}

// Throws NameError unless text is lowercase labels of the charset, 1 to 63
// characters each, at most 253 in all. One label is valid: a key such as `np`.
export function checkLabels(text: string): Scan {
  const s = scan(text);
  if (s.fault !== null) throw new NameError(s.fault, text);
  if (s.upper) throw new NameError("upper", text);
  return s;
}
