// packages/names/src/psl.ts — the Public Suffix List: suffix, registrable
// domain and site of a name.
//
//   const psl = await loadPsl(bytesOfTheList);
//   split("x.github.io", psl)  →  { suffix: "io", reg: "github.io", site: "x.github.io", labels: 3 }
//
// docs/architecture.md section 2: `suffix` and `reg` come from the ICANN
// section alone; `site` is the registrable domain under both sections.
//
// The algorithm is the list's own (https://publicsuffix.org/list/): the longest
// matching rule wins, `*.x` matches one label under `x`, an exception `!x`
// prevails over every other rule and makes `x` registrable, and the implicit
// rule `*` makes any top-level label a suffix. One trie keyed by reversed
// labels holds both sections, each node marked with the section of each rule,
// so one walk gives the ICANN answer and the full-list answer together.
//
// Every rule holding a character above 0x7f is converted to its ASCII form
// with toAscii, because the names compared against it are ASCII. Without the
// conversion a name under `公司.cn` matches only `cn`, and a name under
// `個人.香港` only the implicit `*`: each registrable domain one label short
// (DOM-015, Found of DOM-009).
//
// Runs in Node and in workerd alike: the hash is crypto.subtle's.
import { checkLabels, scan, toAscii } from "./syntax.ts";

export class PslError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PslError";
  }
}

export const MARKERS = Object.freeze(["// ===BEGIN ICANN DOMAINS===", "// ===END ICANN DOMAINS===", "// ===BEGIN PRIVATE DOMAINS===", "// ===END PRIVATE DOMAINS==="] as const);

// The flags of a trie node: a rule ending at the node, a wildcard below it, an
// exception ending at it, once for each section.
const ICANN_RULE = 1;
const ICANN_WILD = 2;
const ICANN_EXC = 4;
const PRIVATE_RULE = 8;
const PRIVATE_WILD = 16;
const PRIVATE_EXC = 32;
const ANY_RULE = ICANN_RULE | PRIVATE_RULE;
const ANY_WILD = ICANN_WILD | PRIVATE_WILD;
const ANY_EXC = ICANN_EXC | PRIVATE_EXC;

interface PslNode {
  children: Map<string, PslNode> | null;
  flags: number;
}

export interface Psl {
  // The sha256 of the list's bytes, lowercase hex: the value sources.json and
  // every root carry.
  readonly sha256: string;
  // The rule lines of each section, as the file holds them.
  readonly rules: { readonly icann: number; readonly private: number };
  readonly trie: PslNode;
}

export interface Split {
  // The ICANN public suffix.
  suffix: string;
  // The ICANN suffix plus one label, or null when the name is itself an ICANN
  // public suffix.
  reg: string | null;
  // The registrable domain under both sections, or null when the name is
  // itself a public suffix of the full list (`github.io`).
  site: string | null;
  // The number of labels of the name.
  labels: number;
}

export type RuleKind = "rule" | "wild" | "exc";

// One rule as the file writes it (`com.np`, `*.np`, `!city.kawasaki.jp`,
// `公司.cn`) to its kind and its labels in ASCII, or a PslError.
export function parseRule(text: string): { kind: RuleKind; labels: string[] } {
  let kind: RuleKind = "rule";
  let body = text;
  if (body.startsWith("!")) {
    kind = "exc";
    body = body.slice(1);
  } else if (body.startsWith("*.")) {
    kind = "wild";
    body = body.slice(2);
  }
  const s = scan(body);
  let ascii: string | null;
  if (s.fault === null) ascii = s.upper ? body.toLowerCase() : body;
  else if (s.fault === "high") ascii = toAscii(body);
  else ascii = null;
  if (ascii === null || scan(ascii).fault !== null) throw new PslError(`rule cannot be read: ${JSON.stringify(text)}`);
  const labels = ascii.split(".");
  // An exception names a registrable domain: one label of it is the suffix.
  if (kind === "exc" && labels.length < 2) throw new PslError(`exception of one label: ${JSON.stringify(text)}`);
  return { kind, labels };
}

function insert(root: PslNode, labels: string[], flag: number): void {
  let at = root;
  for (let i = labels.length - 1; i >= 0; i--) {
    if (at.children === null) at.children = new Map();
    let next = at.children.get(labels[i]!);
    if (next === undefined) {
      next = { children: null, flags: 0 };
      at.children.set(labels[i]!, next);
    }
    at = next;
  }
  at.flags |= flag;
}

const FLAGS: Record<"icann" | "private", Record<RuleKind, number>> = {
  icann: { rule: ICANN_RULE, wild: ICANN_WILD, exc: ICANN_EXC },
  private: { rule: PRIVATE_RULE, wild: PRIVATE_WILD, exc: PRIVATE_EXC },
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// The list, as its bytes or as text, to a Psl. Bytes are hashed as given; text
// is hashed as its UTF-8 bytes. Refused with a PslError: bytes that are not
// UTF-8, a list without each of the four section markers exactly once and in
// order (a truncated download must not pass for a list with no private
// section), a rule outside a section, and a rule that cannot be read.
export async function loadPsl(input: Uint8Array | string): Promise<Psl> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      throw new PslError("the list is not UTF-8");
    }
  }
  const trie: PslNode = { children: null, flags: 0 };
  const rules = { icann: 0, private: 0 };
  let section: "icann" | "private" | null = null;
  let marker = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("// ===")) {
      if (marker >= MARKERS.length || line !== MARKERS[marker]) throw new PslError(`marker out of order: ${JSON.stringify(line)}`);
      marker += 1;
      section = marker === 1 ? "icann" : marker === 3 ? "private" : null;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (section === null) throw new PslError(`rule outside a section: ${JSON.stringify(line)}`);
    // The list's format: a rule is read up to the first whitespace.
    const { kind, labels } = parseRule(line.split(/\s/)[0]!);
    insert(trie, labels, FLAGS[section][kind]);
    rules[section] += 1;
  }
  if (marker < MARKERS.length) throw new PslError(`missing marker ${MARKERS[marker]}`);
  return { sha256: await sha256Hex(bytes), rules, trie };
}

// One walk of the trie from the last label of a valid name. Returns the number
// of labels of its ICANN suffix and of its suffix under the full list.
function walk(psl: Psl, name: string): { icann: number; all: number } {
  let at = psl.trie;
  let icann = 1;
  let all = 1;
  let icannExc = 0;
  let allExc = 0;
  let depth = 0;
  let end = name.length;
  for (;;) {
    const dot = name.lastIndexOf(".", end - 1);
    depth += 1;
    // A wildcard on the node above matches this label, whatever it is.
    if (at.flags & ICANN_WILD && depth > icann) icann = depth;
    if (at.flags & ANY_WILD && depth > all) all = depth;
    const next = at.children === null ? undefined : at.children.get(name.slice(dot + 1, end));
    if (next === undefined) break;
    if (next.flags & ICANN_EXC) icannExc = depth;
    if (next.flags & ANY_EXC) allExc = depth;
    if (next.flags & ICANN_RULE && depth > icann) icann = depth;
    if (next.flags & ANY_RULE && depth > all) all = depth;
    if (dot === -1) break;
    at = next;
    end = dot;
  }
  return { icann: icannExc > 0 ? icannExc - 1 : icann, all: allExc > 0 ? allExc - 1 : all };
}

// The last `count` labels of a name of `labels` labels, or null when it has fewer.
function tail(name: string, labels: number, count: number): string | null {
  if (count > labels) return null;
  if (count === labels) return name;
  let at = name.length;
  for (let i = 0; i < count; i++) at = name.lastIndexOf(".", at - 1);
  return name.slice(at + 1);
}

// The suffix, registrable domain and site of a name. The name must already be
// valid lowercase labels (normalise gives one); anything else is a NameError,
// because a walk over an upper-case or Unicode label matches no rule and would
// answer the implicit `*` without an error.
export function split(name: string, psl: Psl): Split {
  const labels = checkLabels(name).dots + 1;
  const n = walk(psl, name);
  return { suffix: tail(name, labels, n.icann)!, reg: tail(name, labels, n.icann + 1), site: tail(name, labels, n.all + 1), labels };
}

// True when the name is itself an ICANN public suffix: `co.uk`, `com.np` under
// the rule `*.np`, and any single label under the implicit rule `*`. `github.io`
// is a suffix of the private section only, so it is not one here.
export function isPublicSuffix(name: string, psl: Psl): boolean {
  const labels = checkLabels(name).dots + 1;
  return walk(psl, name).icann >= labels;
}
