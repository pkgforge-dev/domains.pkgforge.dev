// scripts/todo/check.mjs — the READER half of the TODO record guard.
//
// Asserts, independently of the writer, that the record agrees with itself:
//   1. TODO/INDEX.md shows the counts derived from its rows, exactly once.
//   2. Rows exist, are sorted by id, and ids are unique and use the DOM- prefix.
//   3. Every row resolves to a `## <ID>` section in TODO/<category>.md whose
//      Status, Priority and Effort agree with the row and the record's values.
//   4. Every entry carries a `- **Prove:**` line with a backticked command.
//   5. Every `## <ID>` section has a row, and no id is defined twice.
//   6. No unfilled `{{placeholder}}` remains in TODO/.
//   7. Every relative markdown link in the narrative documents resolves to a
//      file inside the repository.
//   8. Every id mentioned in TODO/ and the narrative documents has a row, and
//      `Depends on` lines form no cycle.
//   9. TODO/PROGRESS.md carries its required sections, each once, and shows the
//      derived counts line exactly once, under `## Baseline`.
//  10. Backticked repository paths in the narrative documents exist, and a
//      cited line number is within the file. docs/research/ is exempt: a dated
//      report cites other repositories' paths at their own commits.
//  11. No Prove line rests on this guard alone.
//  12. The work order (PROGRESS.md "Start here next session") lists no entry
//      before an open entry it depends on.
//  13. A `- **Waiting:**` line reads `until <YYYY-MM-DDTHH:MM:SSZ>; <then>`, on
//      a partial entry, so scripts/todo/next.mjs can tell when it is due.
//  14. A done entry carries a `- **Closed …:**` line, the record of its Prove
//      passing.
//  15. No Closed, Measured, Read, Found, Built, Done or Correction label is
//      stamped later than the guard runs, so none is later than its commit.
//
// Category entry files are not narrative documents for checks 7 and 10: their
// Approach and Prove lines name files the entry will create.
//
// A mention of a foreign id, one with another project's prefix (the sibling
// repository's WEB- entries), is no mention of this record and is never checked.
// A foreign id as a row of the index is refused (check 2).
//
// Usage: node scripts/todo/check.mjs
// Exit codes: 0 pass, 1 fail, 2 could not run. Read the exit code unpiped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { COUNTS_LINE, ID_PREFIX, parseRows, PRIORITIES, renderCounts, ROOT, STATUSES, TODO_DIR } from './count.mjs';
import { proveVerdicts } from './prove.mjs';

const INDEX = join(TODO_DIR, 'INDEX.md');
const PROGRESS = join(TODO_DIR, 'PROGRESS.md');
const CONTROL = ['INDEX.md', 'PROGRESS.md', 'RULES.md'];
const EFFORTS = ['S', 'M', 'L', 'XL'];
const ID_RE = new RegExp(`\\b${ID_PREFIX}-\\d{3}\\b`, 'g');
const PROGRESS_SECTIONS = ['## State', '## Baseline', '## What this session did', '## What is in progress', '## Start here next session', '## Open questions', '## Settled'];

const failures = [];
const fail = (msg) => failures.push(msg);
const rel = (p) => relative(ROOT, p).split(sep).join('/');

const todoFiles = () =>
  readdirSync(TODO_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
const categoryFiles = () => todoFiles().filter((f) => !CONTROL.includes(f));

// One definition of an entry: its `## <ID>` heading and every line up to the
// next `## ` heading or the end of the file.
function entrySection(body, id) {
  const at = body.search(new RegExp(`^## ${id}\\b`, 'm'));
  if (at === -1) return null;
  const after = body.slice(at);
  const firstNl = after.indexOf('\n');
  if (firstNl === -1) return after;
  const next = after.slice(firstNl + 1).search(/^## /m);
  return next === -1 ? after : after.slice(0, firstNl + 1 + next);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.wrangler') || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// The documents that describe the tree as it is.
function narrativeDocs() {
  const docs = [];
  for (const f of ['AGENTS.md', 'README.md', 'HUMAN.md', 'SECURITY.md']) if (existsSync(join(ROOT, f))) docs.push(join(ROOT, f));
  for (const d of ['docs', 'apps', 'packages']) {
    for (const f of walk(join(ROOT, d))) if (f.endsWith('.md')) docs.push(f);
  }
  for (const f of CONTROL) if (existsSync(join(TODO_DIR, f))) docs.push(join(TODO_DIR, f));
  return docs;
}

function exactlyOnce(label, body, wanted, what) {
  const hits = [];
  body.split('\n').forEach((l, i) => {
    if (l.trimEnd() === wanted) hits.push(i + 1);
  });
  if (hits.length === 0) fail(`${label}: the ${what} disagrees with the rows (want: ${wanted})`);
  else if (hits.length > 1) fail(`${label}: the ${what} appears ${hits.length} times (lines ${hits.join(', ')})`);
}

function headingOnce(label, body, heading) {
  const at = [];
  body.split('\n').forEach((l, i) => {
    if (l.trim() === heading) at.push(i + 1);
  });
  if (at.length === 0) fail(`${label}: missing section ${heading}`);
  else if (at.length > 1) fail(`${label}: ${heading} appears ${at.length} times (lines ${at.join(', ')})`);
}

function countsLineIn(label, body, heading, wanted) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  const next = start === -1 ? -1 : lines.findIndex((l, i) => i > start && /^## /.test(l));
  const end = next === -1 ? lines.length : next;
  const all = lines.flatMap((l, i) => (COUNTS_LINE.test(l.trim()) ? [i] : []));
  const inside = all.filter((i) => i > start && i < end);
  if (start !== -1 && inside.length === 0) fail(`${label}: no counts line under ${heading} (want: ${wanted})`);
  for (const i of inside) {
    if (lines[i].trim() !== wanted) fail(`${label}:${i + 1} shows \`${lines[i].trim()}\`, the rows derive \`${wanted}\``);
  }
  const outside = all.filter((i) => !inside.includes(i));
  if (outside.length > 0) {
    fail(`${label}: counts lines outside ${heading} at line(s) ${outside.map((i) => i + 1).join(', ')}; a record states its counts once`);
  }
  if (inside.length > 1) fail(`${label}: ${inside.length} counts lines under ${heading}`);
}

// A cite's line locator: `path:12`, `path:12-14`, `path:12,18`.
const CITE_LOC = /^(.+?):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/;
const maxLineOf = (loc) => Math.max(...loc.match(/\d+/g).map(Number));
const lineCount = (text) => (text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length);

// Repository roots a backticked path is checked under, and files at the root.
const ANCHORS = ['apps/', 'packages/', 'scripts/', 'docs/', 'TODO/', '.github/'];
const ROOT_FILES = [
  'AGENTS.md',
  'README.md',
  'HUMAN.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'biome.json',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.node-version',
];
// Paths `.gitignore` makes optional: a cite to one is correct whether or not
// this checkout holds it.
const OPTIONAL = ['RESUME.md', '.dev.vars', '.tmp/', '.env/', 'node_modules/', 'dist/'];
const GLOB = /[*?<>|{}…]/;
// A clause that says a path is absent does not claim it exists.
const ABSENCE =
  /\b(?:has|have|holds?)\s+no\b|\bno\s+longer\b|\bdoes\s+not\s+exist\b|\bnot\s+yet\b|\bwill\s+(?:create|add|hold|carry|land)\b|\bto\s+be\s+(?:created|added|written)\b|\bcreated\s+by\b|\blands?\s+(?:in|with|under)\b/i;

function checkCites(file) {
  const label = rel(file);
  // A dated research report cites other repositories' paths at their own commits.
  if (label.startsWith('docs/research/')) return;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.includes('`')) return;
      for (const clause of line.split(/(?<=[.;])\s+/)) {
        if (ABSENCE.test(clause.replace(/`[^`\n]+`/g, ' '))) continue;
        for (const m of clause.matchAll(/`([^`\n]+)`/g)) {
          const token = m[1].trim();
          const loc = token.match(CITE_LOC);
          let target = loc ? loc[1] : token;
          if (GLOB.test(target) || /\s/.test(target)) continue;
          if (!ANCHORS.some((a) => target.startsWith(a)) && !ROOT_FILES.includes(target)) continue;
          if (OPTIONAL.some((o) => target === o || target.startsWith(o))) continue;
          target = target.replace(/\/$/, '');
          const abs = join(ROOT, target);
          if (!existsSync(abs)) {
            fail(`${label}:${i + 1} cites \`${token}\`, which does not exist`);
            continue;
          }
          if (loc && statSync(abs).isFile()) {
            const total = lineCount(readFileSync(abs, 'utf8'));
            const want = maxLineOf(loc[2]);
            if (want > total) fail(`${label}:${i + 1} cites \`${token}\`, but that file has ${total} lines`);
          }
        }
      }
    });
}

function checkLinks(file) {
  const label = rel(file);
  const body = readFileSync(file, 'utf8');
  for (const m of body.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
    const target = m[1].split('#')[0];
    if (!target) continue;
    const abs = resolve(dirname(file), target);
    if (!(abs === ROOT || abs.startsWith(ROOT + sep))) {
      fail(`${label} links outside the repository: ${m[1]}`);
      continue;
    }
    if (!existsSync(abs)) fail(`${label} links a missing target: ${m[1]}`);
  }
}

function hasCycle(graph) {
  const state = new Map();
  const visit = (n, path) => {
    if (state.get(n) === 1) return [...path, n];
    if (state.get(n) === 2) return null;
    state.set(n, 1);
    for (const m of graph.get(n) ?? []) {
      const found = visit(m, [...path, n]);
      if (found) return found;
    }
    state.set(n, 2);
    return null;
  };
  for (const n of graph.keys()) {
    const found = visit(n, []);
    if (found) return found;
  }
  return null;
}

function run() {
  const index = readFileSync(INDEX, 'utf8');
  const rows = parseRows(index);

  // 1
  const { line, table } = renderCounts(rows);
  headingOnce('TODO/INDEX.md', index, '## Counts');
  countsLineIn('TODO/INDEX.md', index, '## Counts', line);
  for (const t of table) exactlyOnce('TODO/INDEX.md', index, t, 'counts table row');

  // 2
  if (rows.length === 0) fail('TODO/INDEX.md: no entry rows parsed from `## Entries`');
  const ids = rows.map((r) => r.id);
  const num = (id) => Number(id.split('-')[1]);
  if (ids.some((id, i) => i > 0 && num(id) < num(ids[i - 1]))) fail('TODO/INDEX.md: rows are not sorted by id');
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) fail(`TODO/INDEX.md: duplicate row ids ${[...new Set(dupes)].join(', ')}`);
  for (const id of ids) if (!id.startsWith(`${ID_PREFIX}-`)) fail(`${id}: ids use the ${ID_PREFIX}- prefix`);

  // 3, 4
  const entries = [];
  for (const r of rows) {
    if (r.file !== `${r.category}.md`) fail(`${r.id}: row links ${r.file} but names category ${r.category}`);
    const path = join(TODO_DIR, r.file);
    if (!existsSync(path)) {
      fail(`${r.id}: category file TODO/${r.file} is missing`);
      continue;
    }
    const section = entrySection(readFileSync(path, 'utf8'), r.id);
    if (section === null) {
      fail(`${r.id}: no \`## ${r.id}\` section in TODO/${r.file}`);
      continue;
    }
    entries.push({ id: r.id, file: r.file, section });
    const status = section.match(/^- \*\*Status:\*\* (\S+)$/m);
    const priority = section.match(/^- \*\*Priority:\*\* (\S+)$/m);
    const effort = section.match(/^- \*\*Effort:\*\* (\S+)$/m);
    if (!status || !STATUSES.includes(status[1])) fail(`${r.id}: entry has no valid \`- **Status:**\` line`);
    else if (status[1] !== r.status) fail(`${r.id}: row says ${r.status}, entry says ${status[1]}`);
    if (!priority || !PRIORITIES.includes(priority[1])) fail(`${r.id}: entry has no valid \`- **Priority:**\` line`);
    else if (priority[1] !== r.priority) fail(`${r.id}: row says ${r.priority}, entry says ${priority[1]}`);
    if (!effort || !EFFORTS.includes(effort[1])) fail(`${r.id}: entry has no valid \`- **Effort:**\` line (${EFFORTS.join('/')})`);
    if (!/^- \*\*Prove:\*\* .*`[^`]+`/m.test(section)) fail(`${r.id}: entry has no \`- **Prove:**\` line with a backticked command`);
    // 13
    for (const [waiting] of section.matchAll(/^- \*\*Waiting:\*\*.*$/gm)) {
      const at = waiting.match(/^- \*\*Waiting:\*\* until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z); \S/);
      if (!at || Number.isNaN(Date.parse(at[1]))) fail(`${r.id}: its Waiting line is not \`until <YYYY-MM-DDTHH:MM:SSZ>; <then>\`, so scripts/todo/next.mjs cannot tell when it is due`);
      else if (r.status !== 'partial') fail(`${r.id}: a Waiting line on a ${r.status} entry (only a partial entry waits)`);
    }
    // 14
    if (r.status === 'done' && !/^\s*- \*\*Closed\b/m.test(section)) fail(`${r.id}: done, but no \`- **Closed …:**\` line records its Prove passing`);
    // 15
    for (const [, label, stamp] of section.matchAll(/^\s*- \*\*(Closed|Measured|Read|Found|Built|Done|Correction)\b[^*\n]*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)[^*\n]*\*\*/gm)) {
      if (Date.parse(stamp) > Date.now()) fail(`${r.id}: its ${label} line is stamped ${stamp}, later than now: a record says when it was, never later`);
    }
  }

  // 5
  const definedAt = new Map();
  for (const f of categoryFiles()) {
    const body = readFileSync(join(TODO_DIR, f), 'utf8');
    for (const m of body.matchAll(new RegExp(`^## (${ID_PREFIX}-\\d{3})\\b`, 'gm'))) {
      const id = m[1];
      if (definedAt.has(id)) fail(`${id} is defined in TODO/${definedAt.get(id)} and TODO/${f}`);
      definedAt.set(id, f);
      if (!ids.includes(id)) fail(`${id} in TODO/${f} has no row in TODO/INDEX.md`);
    }
  }

  // 6
  for (const f of todoFiles()) {
    if (readFileSync(join(TODO_DIR, f), 'utf8').includes('{{')) fail(`TODO/${f} contains an unfilled {{placeholder}}`);
  }

  // 7, 10
  const docs = narrativeDocs();
  for (const f of docs) checkLinks(f);
  for (const f of todoFiles()) if (!CONTROL.includes(f)) checkLinks(join(TODO_DIR, f));
  for (const f of docs) checkCites(f);

  // 8
  const mentionSources = [...todoFiles().map((f) => join(TODO_DIR, f)), ...docs];
  for (const f of new Set(mentionSources)) {
    const body = readFileSync(f, 'utf8');
    for (const id of new Set(body.match(ID_RE) ?? [])) {
      if (!ids.includes(id)) fail(`${rel(f)} mentions ${id}, which has no row`);
    }
  }
  const graph = new Map();
  for (const e of entries) {
    const dep = e.section.match(/^- \*\*Depends on:\*\* (.*)$/m);
    const on = dep ? [...new Set(dep[1].match(ID_RE) ?? [])] : [];
    if (on.includes(e.id)) fail(`${e.id} depends on itself`);
    graph.set(
      e.id,
      on.filter((d) => d !== e.id),
    );
  }
  const cycle = hasCycle(graph);
  if (cycle) fail(`Depends on lines form a cycle: ${cycle.join(' -> ')}`);

  // 12
  const statusOf = new Map(rows.map((r) => [r.id, r.status]));
  const progress = readFileSync(PROGRESS, 'utf8');
  const orderAt = progress.search(/^## Start here next session$/m);
  if (orderAt !== -1) {
    const rest = progress.slice(orderAt + 1);
    const next = rest.search(/^## /m);
    const order = [...new Set((next === -1 ? rest : rest.slice(0, next)).match(ID_RE) ?? [])];
    order.forEach((id, i) => {
      for (const dep of graph.get(id) ?? []) {
        if (statusOf.get(dep) === 'done') continue;
        const at = order.indexOf(dep);
        if (at === -1 || at > i) fail(`work order: ${id} is listed before ${dep}, an open entry it depends on (node scripts/todo/next.mjs prints a valid order)`);
      }
    });
  }

  // 9
  for (const h of PROGRESS_SECTIONS) headingOnce('TODO/PROGRESS.md', progress, h);
  countsLineIn('TODO/PROGRESS.md', progress, '## Baseline', line);

  // 11
  const notes = [];
  for (const v of proveVerdicts(entries)) {
    if (v.vacuous) fail(`${v.id}: its only acceptance criterion is the record guard, which cannot fail on the entry's claim`);
    else if (v.unverifiable) notes.push(`check 11: ${v.id}'s Prove names neither a command nor a test`);
  }

  return { count: rows.length, notes };
}

let result;
try {
  result = run();
} catch (err) {
  console.error(`could not run: ${err.message}`);
  process.exit(2);
}
for (const n of result.notes) console.log(`NOTE: ${n}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`TODO record agrees: ${result.count} entries`);
