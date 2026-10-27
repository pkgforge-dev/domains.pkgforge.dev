// scripts/todo/count.mjs — the WRITER half of the TODO record guard.
//
// Every count in the record is derived from the rows of the `## Entries` table
// in TODO/INDEX.md and written into two places: the `## Counts` section of
// TODO/INDEX.md and the counts line under `## Baseline` in TODO/PROGRESS.md.
// A count is never typed by hand.
//
// Row shape (the only shape the reader accepts):
//   | [DOM-001](foundation.md) | P1 | foundation | open | One-line title |
// A bold status (`**done**`) marks an entry closed with its Prove command run
// and its output recorded; plain `done` marks one closed on an operator ruling.
//
// Usage:
//   node scripts/todo/count.mjs                       rewrite the counts
//   node scripts/todo/count.mjs --check               exit 1 if a count disagrees
//   node scripts/todo/count.mjs --set DOM-007 partial  move a status in the row
//                                                     and the entry, then recount
//   node scripts/todo/count.mjs --set DOM-007 done --proven   same, bold in the row
//
// Exit codes: 0 ok, 1 counts disagree (--check) or a bad --set, 2 could not run.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TODO_DIR = join(ROOT, 'TODO');
const INDEX = join(TODO_DIR, 'INDEX.md');
const PROGRESS = join(TODO_DIR, 'PROGRESS.md');

export const ID_PREFIX = 'DOM';
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const STATUSES = ['open', 'partial', 'blocked', 'done'];

const ROW = /^\|\s*\[([A-Z]+-\d{3})\]\(([^)]+)\)\s*\|\s*(P\d)\s*\|\s*([^|]+?)\s*\|\s*(\*{0,2})(open|partial|blocked|done)\5\s*\|/;

export function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(ROW);
    if (m) {
      rows.push({
        id: m[1],
        file: m[2],
        priority: m[3],
        category: m[4].trim(),
        status: m[6],
        bold: m[5].length > 0,
      });
    }
  }
  return rows;
}

export function deriveCounts(rows) {
  const byPri = {};
  for (const p of PRIORITIES) byPri[p] = { open: 0, partial: 0, blocked: 0, done: 0, total: 0 };
  const all = { open: 0, partial: 0, blocked: 0, done: 0, total: 0 };
  for (const r of rows) {
    if (!byPri[r.priority]) throw new Error(`unknown priority ${r.priority} on ${r.id}`);
    byPri[r.priority][r.status] += 1;
    byPri[r.priority].total += 1;
    all[r.status] += 1;
    all.total += 1;
  }
  return { byPri, all };
}

export function renderCounts(rows) {
  const { byPri, all } = deriveCounts(rows);
  const line = `**${all.total} items. ${all.open} open, ${all.partial} partial, ${all.blocked} blocked, ${all.done} done.**`;
  const table = [
    '| priority | open | partial | blocked | done | total |',
    '| --- | --- | --- | --- | --- | --- |',
    ...PRIORITIES.map((p) => `| ${p} | ${byPri[p].open} | ${byPri[p].partial} | ${byPri[p].blocked} | ${byPri[p].done} | ${byPri[p].total} |`),
    `| **All** | ${all.open} | ${all.partial} | ${all.blocked} | ${all.done} | ${all.total} |`,
  ];
  return { line, table };
}

export const COUNTS_LINE = /^\*\*\d+ items\./;
const TABLE_HEADER = /^\| priority \| open \|/;
const TABLE_ALL = /^\| \*\*All\*\* \|/;

// The lines of the section that starts at `heading` and ends before the next
// `## ` heading. Exactly one such heading is required: a second copy is a
// place a reader could be shown different numbers, so the writer refuses it.
export function sectionBounds(lines, heading) {
  const heads = lines.flatMap((l, i) => (l.trim() === heading ? [i] : []));
  if (heads.length === 0) throw new Error(`no \`${heading}\` section`);
  if (heads.length > 1) {
    throw new Error(`\`${heading}\` appears ${heads.length} times (lines ${heads.map((i) => i + 1).join(', ')})`);
  }
  const start = heads[0];
  const next = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return { start, end: next === -1 ? lines.length : next };
}

export function rewriteIndex(text, rows) {
  const { line, table } = renderCounts(rows);
  const lines = text.split('\n');
  const { start, end } = sectionBounds(lines, '## Counts');
  const inSection = (i) => i > start && i < end;
  const countIdx = lines.findIndex((l, i) => inSection(i) && COUNTS_LINE.test(l));
  if (countIdx === -1) throw new Error('no counts line under `## Counts` in TODO/INDEX.md');
  const headIdx = lines.findIndex((l, i) => inSection(i) && TABLE_HEADER.test(l));
  if (headIdx === -1) throw new Error('no counts table under `## Counts` in TODO/INDEX.md');
  const allRows = lines.flatMap((l, i) => (inSection(i) && TABLE_ALL.test(l) ? [i] : []));
  if (allRows.length !== 1 || allRows[0] < headIdx) {
    throw new Error('the counts table under `## Counts` must hold exactly one `| **All** |` row, after its header');
  }
  lines[countIdx] = line;
  lines.splice(headIdx, allRows[0] - headIdx + 1, ...table);
  return lines.join('\n');
}

export function rewriteProgress(text, rows) {
  const { line } = renderCounts(rows);
  const lines = text.split('\n');
  const { start, end } = sectionBounds(lines, '## Baseline');
  const all = lines.flatMap((l, i) => (COUNTS_LINE.test(l.trim()) ? [i] : []));
  const inBaseline = all.filter((i) => i > start && i < end);
  if (inBaseline.length !== 1 || all.length !== 1) {
    throw new Error('TODO/PROGRESS.md must carry exactly one counts line, under `## Baseline`');
  }
  lines[inBaseline[0]] = line;
  return lines.join('\n');
}

class UsageError extends Error {}

// Move one entry's status in both places it is written: its INDEX row and the
// `- **Status:**` line of its `## <ID>` section.
function setStatus(indexText, id, status, proven) {
  if (!STATUSES.includes(status)) throw new UsageError(`status must be one of ${STATUSES.join(', ')}`);
  if (proven && status !== 'done') throw new UsageError('--proven applies only to done');
  const lines = indexText.split('\n');
  const at = lines.findIndex((l) => {
    const m = l.match(ROW);
    return m && m[1] === id;
  });
  if (at === -1) throw new UsageError(`${id} has no row in TODO/INDEX.md`);
  const row = parseRows(lines[at])[0];
  const shown = proven ? `**${status}**` : status;
  lines[at] = lines[at].replace(/\|\s*\*{0,2}(open|partial|blocked|done)\*{0,2}\s*\|/, `| ${shown} |`);

  const entryPath = join(TODO_DIR, row.file);
  const body = readFileSync(entryPath, 'utf8');
  const headAt = body.search(new RegExp(`^## ${id}\\b`, 'm'));
  if (headAt === -1) throw new UsageError(`${id} has no \`## ${id}\` section in TODO/${row.file}`);
  const rest = body.slice(headAt);
  const nextAt = rest.slice(rest.indexOf('\n') + 1).search(/^## /m);
  const sectionEnd = nextAt === -1 ? body.length : headAt + rest.indexOf('\n') + 1 + nextAt;
  const section = body.slice(headAt, sectionEnd);
  const statusLine = /^- \*\*Status:\*\* (open|partial|blocked|done)$/m;
  if (!statusLine.test(section)) throw new UsageError(`${id} has no \`- **Status:**\` line`);
  const updated = body.slice(0, headAt) + section.replace(statusLine, `- **Status:** ${status}`) + body.slice(sectionEnd);
  return { index: lines.join('\n'), entryPath, entry: updated };
}

function main(argv) {
  const index = readFileSync(INDEX, 'utf8');
  const progress = readFileSync(PROGRESS, 'utf8');

  if (argv.includes('--set')) {
    const i = argv.indexOf('--set');
    const id = argv[i + 1];
    const status = argv[i + 2];
    if (!id || !status) throw new UsageError('usage: --set <ID> <status> [--proven]');
    const moved = setStatus(index, id, status, argv.includes('--proven'));
    const rows = parseRows(moved.index);
    writeFileSync(moved.entryPath, moved.entry);
    writeFileSync(INDEX, rewriteIndex(moved.index, rows));
    writeFileSync(PROGRESS, rewriteProgress(progress, rows));
    console.log(`${id} is ${status}; counts rewritten from rows`);
    return 0;
  }

  const rows = parseRows(index);
  if (rows.length === 0) {
    throw new Error('no entry rows parsed from TODO/INDEX.md; every count would be zero, so nothing is written');
  }
  const nextIndex = rewriteIndex(index, rows);
  const nextProgress = rewriteProgress(progress, rows);
  if (argv.includes('--check')) {
    const stale = [];
    if (nextIndex !== index) stale.push('TODO/INDEX.md');
    if (nextProgress !== progress) stale.push('TODO/PROGRESS.md');
    if (stale.length > 0) {
      console.error(`counts disagree with rows in ${stale.join(' and ')}; run without --check to rewrite`);
      return 1;
    }
    console.log('counts agree with rows');
    return 0;
  }
  writeFileSync(INDEX, nextIndex);
  writeFileSync(PROGRESS, nextProgress);
  console.log('counts rewritten from rows');
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      console.error(`could not run: ${err.message}`);
      process.exitCode = 2;
    }
  }
}
