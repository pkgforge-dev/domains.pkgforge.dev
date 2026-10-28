// scripts/measure/psl.mjs — the Public Suffix List matcher of the THC day
// measurement (DOM-009). One helper for what design A and design B each wrote
// as psl.mjs (docs/research/2026-10-27-design-{a,b}/scripts/psl.mjs).
//
// The list becomes two tries keyed by reversed labels, `icann` (the ICANN
// section) and `all` (both sections), so a reversed key such as
// `np.com.example.www` is matched from its first label with no string joins.
// The algorithm is the list's own and the designs': the longest matching rule
// wins, `*.x` matches one label under `x`, an exception `!x` prevails over every
// other rule and makes `x` registrable, and the implicit rule `*` makes any
// top-level label a suffix.
//
// Rules are converted to their ASCII form (`aéroport.ci` becomes
// `xn--aroport-bya.ci`), because the names compared against them are ASCII.
// Neither design converted them, so an IDN suffix fell back to `*` there; the
// registrable counts of this helper can differ from theirs by those names.
//
// Usage:
//   import { parsePsl, loadPsl, suffixLabels, regKey, regKeyCached, split } from './psl.mjs'
//   node scripts/measure/psl.mjs --check FILE   prints "sha256 HEX icann N private N", exits 0
// Exit codes (--check): 0 the file holds both sections, 1 it does not, 2 could not run.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { domainToASCII, pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { reverseName } from './revlabel.mjs';

export class PslError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PslError';
  }
}

const node = () => ({ c: null, rule: false, exc: false, wild: false });

function insert(root, labels, kind) {
  let at = root;
  for (let i = labels.length - 1; i >= 0; i--) {
    if (at.c === null) at.c = new Map();
    let next = at.c.get(labels[i]);
    if (next === undefined) {
      next = node();
      at.c.set(labels[i], next);
    }
    at = next;
  }
  if (kind === 'wild') at.wild = true;
  else if (kind === 'exc') at.exc = true;
  else at.rule = true;
}

// One rule line to { kind, labels } in ASCII, or a PslError.
export function parseRule(text) {
  let kind = 'rule';
  let body = text;
  if (body.startsWith('!')) {
    kind = 'exc';
    body = body.slice(1);
  } else if (body.startsWith('*.')) {
    kind = 'wild';
    body = body.slice(2);
  }
  const ascii = /[^\x00-\x7f]/.test(body) ? domainToASCII(body) : body.toLowerCase();
  if (!ascii || ascii.includes('*') || ascii.startsWith('.') || ascii.endsWith('.') || ascii.includes('..')) {
    throw new PslError(`rule cannot be read: ${JSON.stringify(text)}`);
  }
  return { kind, labels: ascii.split('.') };
}

// The list (a Buffer of its bytes, or its text) to { icann, all, rules:
// { icann, private }, sha256 }. sha256 is of the bytes when a Buffer is given.
// A list without both section markers is refused: a truncated download must
// not pass for a list with no private section.
export function parsePsl(input) {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const marks = ['// ===BEGIN ICANN DOMAINS===', '// ===END ICANN DOMAINS===', '// ===BEGIN PRIVATE DOMAINS===', '// ===END PRIVATE DOMAINS==='];
  for (const mark of marks) {
    if (!text.includes(mark)) throw new PslError(`missing marker ${mark}`);
  }
  const icann = node();
  const all = node();
  const rules = { icann: 0, private: 0 };
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('// ===BEGIN ICANN')) section = 'icann';
    else if (line.startsWith('// ===BEGIN PRIVATE')) section = 'private';
    else if (line.startsWith('// ===END')) section = null;
    if (line === '' || line.startsWith('//')) continue;
    if (section === null) throw new PslError(`rule outside a section: ${JSON.stringify(line)}`);
    const { kind, labels } = parseRule(line.split(/\s/)[0]);
    insert(all, labels, kind);
    if (section === 'icann') insert(icann, labels, kind);
    rules[section] += 1;
  }
  const sha256 = createHash('sha256').update(input).digest('hex');
  return { icann, all, rules, sha256 };
}

export function loadPsl(path) {
  return parsePsl(readFileSync(path));
}

// One walk of the trie along a reversed key. Returns the number of labels of
// the key's public suffix. When path is given, path[d] is the trie node of the
// key's first d labels for every d the walk reached, and path[0] is the deepest
// such d (0 when the first label is in no rule).
function walk(trie, key, path) {
  let at = trie;
  let best = 1;
  let exc = 0;
  let depth = 0;
  let start = 0;
  if (path !== null) path[0] = 0;
  for (;;) {
    let end = key.indexOf('.', start);
    if (end === -1) end = key.length;
    depth += 1;
    if (at.wild && depth > best) best = depth;
    const next = at.c === null ? undefined : at.c.get(key.slice(start, end));
    if (next === undefined) break;
    if (path !== null) {
      path[depth] = next;
      path[0] = depth;
    }
    if (next.exc) exc = depth;
    if (next.rule && depth > best) best = depth;
    at = next;
    if (end === key.length) break;
    start = end + 1;
  }
  return exc > 0 ? exc - 1 : best;
}

// The number of labels of the public suffix of a reversed key.
export function suffixLabels(trie, key) {
  return walk(trie, key, null);
}

// The first `count` labels of a reversed key, or null when it has fewer.
function headLabels(key, count) {
  let end = -1;
  for (let i = 0; i < count; i++) {
    if (end === key.length) return null;
    end = key.indexOf('.', end + 1);
    if (end === -1) end = key.length;
  }
  return key.slice(0, end);
}

// The reversed registrable domain of a reversed key, or null when the name is
// itself a public suffix.
export function regKey(trie, key) {
  return headLabels(key, suffixLabels(trie, key) + 1);
}

// regKey with a one-entry cache for keys in ascending order: a key equal to the
// last registrable domain, or under it, reuses it when that domain is closed.
// A domain is closed when no rule lies under it: no rule or exception below it
// and no wildcard on it. Then every name under it has it as its registrable
// domain. The walk that finds the domain also finds its trie node, if it has
// one: no node means no rule passes through it, so it is closed.
export function regKeyCached(trie) {
  const path = [0];
  let last = null;
  return (key) => {
    if (last !== null && key.startsWith(last) && (key.length === last.length || key.charCodeAt(last.length) === 46)) return last;
    const n = walk(trie, key, path);
    const reg = headLabels(key, n + 1);
    if (reg === null) {
      last = null;
      return null;
    }
    const at = path[0] > n ? path[n + 1] : null;
    last = at === null || (at.c === null && !at.wild) ? reg : null;
    return reg;
  };
}

// { suffix, reg } for a forward name, as design A's split returned it.
export function split(trie, name) {
  const key = reverseName(name);
  const n = suffixLabels(trie, key);
  const reg = headLabels(key, n + 1);
  return { suffix: reverseName(headLabels(key, n) ?? key), reg: reg === null ? null : reverseName(reg) };
}

function main(argv) {
  const args = parseArgs(argv);
  if (typeof args.check !== 'string') {
    console.error('usage: node scripts/measure/psl.mjs --check FILE');
    return 2;
  }
  let bytes;
  try {
    bytes = readFileSync(args.check);
  } catch (err) {
    console.error(`psl: cannot read ${args.check}: ${err.message}`);
    return 2;
  }
  try {
    const psl = parsePsl(bytes);
    console.log(`sha256 ${psl.sha256} icann ${psl.rules.icann} private ${psl.rules.private}`);
    return 0;
  } catch (err) {
    if (!(err instanceof PslError)) throw err;
    console.error(`psl: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
