// scripts/text-check.mjs — refuse NUL, stray control bytes and invalid UTF-8 in
// tracked and new text files, and narrative history in the technical documents.
//
// A control byte makes `grep` answer "Binary file matches" and hides the line a
// reader needs. A finding names the file and the byte offset, never content.
//
// A technical document states what the system is and does, in the present
// tense (docs/conventions/docs.md, "Present tense, no story"). The narrative
// check reads exactly those documents, the generated root documents of a Worker
// and the string literals of its docs registry, and refuses a short list of
// markers that only a story uses. Markdown code spans and fenced blocks are
// skipped, so a page can name a marker it refuses.
//
// Usage: node scripts/text-check.mjs
// Exit codes: 0 clean, 1 findings, 2 could not run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listFiles, ROOT } from './files.mjs';

const TEXT = /\.(md|mjs|cjs|js|mts|cts|ts|tsx|jsx|json|jsonc|yaml|yml|toml|sql|html|css|svg|sh|txt)$|(^|\/)\.(gitignore|gitattributes|editorconfig|node-version)$/i;

// The technical documents. The story lives elsewhere by design: CHANGELOG.md,
// the git log, docs/research/ (dated measurements) and TODO/ (the record).
const NARRATIVE_FILES = new Set(['AGENTS.md', 'README.md', 'HUMAN.md', 'SECURITY.md', 'docs/architecture.md', 'docs/sources.md', 'docs/clock.md', 'docs/resources.md']);
const NARRATIVE_DIRS = /^docs\/(methodology|conventions|security)\/[^/]+\.md$/;
// A Worker's generated root documents and the registry they are generated from.
const GENERATED = /^apps\/[^/]+\/public\/[^/]+\.(md|txt|json)$/;
const REGISTRY = /^apps\/[^/]+\/src\/docs\.ts$/;

// Each marker is a phrase only a story uses. Kept short and precise: a marker
// that refuses correct present-tense writing gets the check switched off.
export const NARRATIVE_MARKERS = [
  { name: 'no longer', re: /\bno longer\b/i },
  // "used to" as a past habit; "is used to sign" is a present passive.
  { name: 'used to', re: /(?<!\b(?:is|are|be|been|being|was|were|get|gets|got)\s+)\bused to\b/i },
  { name: 'previously', re: /\bpreviously\b/i },
  { name: 'originally', re: /\boriginally\b/i },
  { name: 'formerly', re: /\bformerly\b/i },
  { name: 'until recently', re: /\buntil recently\b/i },
  { name: 'back then', re: /\bback then\b/i },
  { name: 'had been', re: /\bhad been\b/i },
  { name: 'turned out', re: /\bturned out\b/i },
  { name: 'we decided', re: /\bwe (?:decided|found|chose|learned|learnt|discovered|realised|realized)\b/i },
  { name: 'the first review', re: /\bthe first (?:deep )?review\b/i },
  { name: 'after the merge', re: /\bafter the merge\b/i },
  { name: 'has happened', re: /\b(?:this|it) has happened\b/i },
  { name: 'once, a story', re: /\b(?:a|one) (?:session|sweep|project|agent) once\b/i },
  { name: 'is now', re: /\b(?:is|are) now\b/i },
  { name: 'now does', re: /\b(?:it|this|the rule|the check) now [a-z]+s\b/i },
  { name: 'since an entry', re: /\bsince (?:DOM-\d+|commit|[0-9a-f]{7,12}\b)/i },
];

export function narrativeScope(rel) {
  if (NARRATIVE_FILES.has(rel) || NARRATIVE_DIRS.test(rel) || GENERATED.test(rel)) return 'text';
  if (REGISTRY.test(rel)) return 'registry';
  return null;
}

// Blank out markdown fenced blocks and code spans, keeping line numbers.
export function withoutCode(text) {
  const lines = text.split('\n');
  let fence = null;
  return lines
    .map((line) => {
      const open = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
        return '';
      }
      if (open) {
        fence = open[1];
        return '';
      }
      return line.replace(/(`+)[^`]*?\1/g, ' ');
    })
    .join('\n');
}

// The string literals of a TypeScript source, with the line each starts on.
// Comments are skipped; a template literal's ${...} is read as code.
export function stringLiterals(src) {
  const out = [];
  let line = 1;
  let i = 0;
  const stack = []; // template nesting: brace depth at each ${
  let depth = 0;
  const readString = (q) => {
    const start = line;
    let s = '';
    i += 1;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        s += src.slice(i, i + 2);
        if (src[i + 1] === '\n') line += 1;
        i += 2;
        continue;
      }
      if (c === '\n') line += 1;
      if (c === q) {
        i += 1;
        out.push({ line: start, text: s });
        return;
      }
      if (q === '`' && c === '$' && src[i + 1] === '{') {
        out.push({ line: start, text: s });
        stack.push(depth);
        depth = 0;
        i += 2;
        return 'expr';
      }
      s += c;
      i += 1;
    }
    out.push({ line: start, text: s });
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n') {
      line += 1;
      i += 1;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      readString(c);
    } else if (c === '{') {
      depth += 1;
      i += 1;
    } else if (c === '}') {
      if (depth === 0 && stack.length > 0) {
        // The } that closes a ${...}: back inside the template literal. The
        // reader skips this one character, as it skips an opening quote.
        depth = stack.pop();
        readString('`');
      } else {
        depth = Math.max(0, depth - 1);
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return out;
}

// Findings for one file: "<path>:<line>: narrative marker '<name>'".
export function findNarrative(rel, text) {
  const scope = narrativeScope(rel);
  if (!scope) return [];
  const pieces =
    scope === 'registry'
      ? stringLiterals(text).flatMap(({ line, text: s }) => s.split('\n').map((l, k) => ({ line: line + k, text: l })))
      : (rel.endsWith('.json') ? text : withoutCode(text)).split('\n').map((l, k) => ({ line: k + 1, text: l }));
  const found = [];
  for (const { line, text: l } of pieces) {
    const hay = scope === 'registry' ? l.replace(/(`+)[^`]*?\1/g, ' ') : l;
    for (const m of NARRATIVE_MARKERS) {
      if (m.re.test(hay)) found.push(`${rel}:${line}: narrative marker '${m.name}'`);
    }
  }
  return found;
}

// Findings for one file's bytes: invalid UTF-8, or a control byte other than
// tab, line feed and carriage return. Never the content, only the offset.
export function findBytes(rel, buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return [`${rel}: invalid UTF-8`];
  }
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) return [`${rel}: control byte 0x${b.toString(16).padStart(2, '0')} at offset ${i}`];
  }
  return [];
}

function main() {
  let listing;
  try {
    listing = listFiles('all');
  } catch (err) {
    console.error(`could not run: ${err.message}`);
    process.exit(2);
  }
  if (listing.walked) console.log('note: no git work tree here; walked the tree instead');

  const findings = [];
  let checked = 0;
  let narrative = 0;
  for (const rel of listing.files) {
    if (!TEXT.test(rel)) continue;
    let buf;
    try {
      buf = readFileSync(join(ROOT, rel));
    } catch {
      continue; // tracked but deleted in this working tree
    }
    checked += 1;
    const bytes = findBytes(rel, buf);
    if (bytes.length > 0) {
      findings.push(...bytes);
      continue;
    }
    if (narrativeScope(rel)) {
      narrative += 1;
      findings.push(...findNarrative(rel, new TextDecoder().decode(buf).replace(/\r\n/g, '\n')));
    }
  }

  if (findings.length > 0) {
    for (const f of findings) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`text check: ${checked} files clean; ${narrative} technical documents carry no narrative marker`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
