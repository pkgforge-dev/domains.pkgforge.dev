// scripts/lib/record-fixture.mjs — a small, self-contained TODO record in a
// temporary directory, for the tests of scripts/todo/. Each test builds its own
// fixture, plants one defect and runs a copy of the scripts there, so the tests
// pass before this repository's own record exists and never read it.
//
// The fixture holds four entries:
//   DOM-001 done    P1 foundation   no dependency
//   DOM-002 open    P1 foundation   depends on DOM-001
//   DOM-003 partial P2 ingest       depends on DOM-002
//   DOM-004 open    P3 ingest       depends on DOM-003
// and the files a record needs: TODO/{INDEX,PROGRESS,RULES,foundation,ingest}.md,
// AGENTS.md, README.md and docs/architecture.md.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT } from '../files.mjs';
import { parseRows, renderCounts } from '../todo/count.mjs';

const made = [];

// Removes every fixture built so far; a test file calls it from `after`.
export function cleanFixtures() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const ROWS = [
  '| [DOM-001](foundation.md) | P1 | foundation | **done** | The skeleton |',
  '| [DOM-002](foundation.md) | P1 | foundation | open | The gate |',
  '| [DOM-003](ingest.md) | P2 | ingest | partial | The first feed |',
  '| [DOM-004](ingest.md) | P3 | ingest | open | The second feed |',
];

const entry = (id, title, { status, priority, effort = 'S', depends, closed = false }) =>
  [
    `## ${id} — ${title}`,
    '',
    `- **Status:** ${status}`,
    `- **Priority:** ${priority}`,
    `- **Effort:** ${effort}`,
    ...(depends ? [`- **Depends on:** ${depends}`] : []),
    '- **Source:** the operator, 2026-10-27.',
    '- **Prove:** `node scripts/test.mjs scripts/todo` exits 0.',
    ...(closed ? ['- **Closed 2026-01-02T03:04:05Z (proven):** the command ran and exited 0.'] : []),
    '',
  ].join('\n');

export function indexText(rows = ROWS) {
  const { line, table } = renderCounts(parseRows(rows.join('\n')));
  return [
    '# TODO',
    '',
    '## Priority',
    '',
    'P0 to P3.',
    '',
    '## Counts',
    '',
    line,
    '',
    ...table,
    '',
    '## Entries',
    '',
    '| ID | Priority | Category | Status | Item |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

export function progressText(rows = ROWS, order = ['DOM-002', 'DOM-003', 'DOM-004']) {
  const { line } = renderCounts(parseRows(rows.join('\n')));
  return [
    '# Progress',
    '',
    '## State',
    '',
    '- a fixture',
    '',
    '## Baseline',
    '',
    '| measure | reading |',
    '| --- | --- |',
    '| gate | exit 0 |',
    '',
    line,
    '',
    '## What this session did',
    '',
    '- nothing',
    '',
    '## What is in progress',
    '',
    '- nothing',
    '',
    '## Start here next session',
    '',
    ...order.map((id, i) => `${i + 1}. ${id}.`),
    '',
    '## Open questions',
    '',
    '- none',
    '',
    '## Settled',
    '',
    'See RULES.md.',
    '',
  ].join('\n');
}

const FILES = {
  'TODO/RULES.md': '# Rules\n\nA fixture.\n',
  'TODO/foundation.md': `# Foundation\n\n${entry('DOM-001', 'The skeleton', { status: 'done', priority: 'P1', closed: true })}\n${entry('DOM-002', 'The gate', { status: 'open', priority: 'P1', depends: 'DOM-001' })}`,
  'TODO/ingest.md': `# Ingest\n\n${entry('DOM-003', 'The first feed', { status: 'partial', priority: 'P2', effort: 'M', depends: 'DOM-002' })}\n${entry('DOM-004', 'The second feed', { status: 'open', priority: 'P3', depends: 'DOM-003' })}`,
  'AGENTS.md': '# Agents\n\nRead [the rules](TODO/RULES.md) and `docs/architecture.md`.\n',
  'README.md': '# Fixture\n\nA fixture.\n',
  'docs/architecture.md': '# Architecture\n\nLine two.\nLine three.\n',
};

// Builds a fixture and returns helpers bound to it.
export function makeRecord() {
  const dir = mkdtempSync(join(tmpdir(), 'domains-record-'));
  made.push(dir);
  for (const rel of ['scripts/todo/check.mjs', 'scripts/todo/count.mjs', 'scripts/todo/next.mjs', 'scripts/todo/prove.mjs', 'scripts/lib/args.mjs']) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  write('TODO/INDEX.md', indexText());
  write('TODO/PROGRESS.md', progressText());
  for (const [rel, text] of Object.entries(FILES)) write(rel, text);
  const read = (rel) => readFileSync(join(dir, rel), 'utf8');
  return {
    dir,
    read,
    write,
    edit: (rel, fn) => write(rel, fn(read(rel))),
    // Runs a script of the fixture in its own process and reads its exit code from it.
    run(script, args = []) {
      try {
        const stdout = execFileSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: 0, stdout, stderr: '' };
      } catch (err) {
        return { status: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
      }
    },
    guard() {
      return this.run('scripts/todo/check.mjs');
    },
    counts(args = []) {
      return this.run('scripts/todo/count.mjs', args);
    },
    next(args = []) {
      return this.run('scripts/todo/next.mjs', args);
    },
  };
}
