// scripts/todo/count.mjs — the writer: counts derived from rows, `--set` moving a
// status in both places, and every refusal. Each case builds its own record
// (scripts/lib/record-fixture.mjs).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanFixtures, makeRecord } from '../lib/record-fixture.mjs';
import { deriveCounts, parseRows, renderCounts, sectionBounds } from './count.mjs';

after(cleanFixtures);

test('parseRows reads the row shape and nothing else', () => {
  const rows = parseRows(
    [
      '| ID | Priority | Category | Status | Item |',
      '| --- | --- | --- | --- | --- |',
      '| [DOM-001](a.md) | P1 | a | **done** | One |',
      '| [DOM-002](a.md) | P2 | a | blocked | Two |',
      'not a row | [DOM-003](a.md) | P1 | a | open | x |',
    ].join('\n'),
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.priority, r.status, r.bold]),
    [
      ['DOM-001', 'P1', 'done', true],
      ['DOM-002', 'P2', 'blocked', false],
    ],
  );
});

test('a bold status that does not close with its own bold is not a row', () => {
  assert.deepEqual(parseRows('| [DOM-001](a.md) | P1 | a | **done | One |'), []);
});

test('deriveCounts and renderCounts add up by priority and overall', () => {
  const rows = parseRows(
    ['| [DOM-001](a.md) | P0 | a | done | x |', '| [DOM-002](a.md) | P1 | a | open | x |', '| [DOM-003](a.md) | P1 | a | partial | x |', '| [DOM-004](a.md) | P3 | a | blocked | x |'].join('\n'),
  );
  const { byPri, all } = deriveCounts(rows);
  assert.deepEqual(all, { open: 1, partial: 1, blocked: 1, done: 1, total: 4 });
  assert.deepEqual(byPri.P1, { open: 1, partial: 1, blocked: 0, done: 0, total: 2 });
  const { line, table } = renderCounts(rows);
  assert.equal(line, '**4 items. 1 open, 1 partial, 1 blocked, 1 done.**');
  assert.equal(table.at(-1), '| **All** | 1 | 1 | 1 | 1 | 4 |');
});

test('a row with a priority outside P0 to P3 is refused', () => {
  assert.throws(() => deriveCounts(parseRows('| [DOM-001](a.md) | P9 | a | open | x |')), /unknown priority P9/);
});

test('sectionBounds refuses a missing heading and a heading twice', () => {
  assert.throws(() => sectionBounds(['# a'], '## Counts'), /no `## Counts` section/);
  assert.throws(() => sectionBounds(['## Counts', 'x', '## Counts'], '## Counts'), /appears 2 times/);
  assert.deepEqual(sectionBounds(['## A', 'x', '## B', 'y'], '## A'), { start: 0, end: 2 });
});

test('with no flag, count.mjs rewrites a wrong count and writes nothing else', () => {
  const r = makeRecord();
  const before = r.read('TODO/foundation.md');
  r.edit('TODO/INDEX.md', (t) => t.replace(/^\*\*(\d+) items\./m, (_, n) => `**${Number(n) + 5} items.`));
  r.edit('TODO/PROGRESS.md', (t) => t.replace(/^\*\*(\d+) items\./m, (_, n) => `**${Number(n) + 5} items.`));
  assert.equal(r.counts(['--check']).status, 1);
  const w = r.counts([]);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(r.counts(['--check']).status, 0);
  assert.equal(r.read('TODO/foundation.md'), before);
  assert.match(r.read('TODO/PROGRESS.md'), /^\*\*4 items\. 2 open, 1 partial, 0 blocked, 1 done\.\*\*$/m);
});

test('--check says which file disagrees, and exits 1', () => {
  const r = makeRecord();
  r.edit('TODO/PROGRESS.md', (t) => t.replace(/^\*\*(\d+) items\./m, (_, n) => `**${Number(n) + 1} items.`));
  const c = r.counts(['--check']);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /counts disagree with rows in TODO\/PROGRESS\.md/);
  assert.doesNotMatch(c.stderr, /TODO\/INDEX\.md/);
});

test('--set moves a status in the row and the entry and recounts', () => {
  const r = makeRecord();
  const s = r.counts(['--set', 'DOM-002', 'blocked']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(r.read('TODO/INDEX.md'), /^\| \[DOM-002\]\(foundation\.md\) \| P1 \| foundation \| blocked \|/m);
  assert.match(r.read('TODO/foundation.md'), /## DOM-002\b[\s\S]*?- \*\*Status:\*\* blocked/);
  assert.match(r.read('TODO/INDEX.md'), /^\*\*4 items\. 1 open, 1 partial, 1 blocked, 1 done\.\*\*$/m);
  assert.equal(r.guard().status, 0, r.guard().stderr);
});

test('--set done --proven writes a bold row, and moves only the named entry', () => {
  const r = makeRecord();
  const s = r.counts(['--set', 'DOM-004', 'done', '--proven']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(r.read('TODO/INDEX.md'), /^\| \[DOM-004\]\(ingest\.md\) \| P3 \| ingest \| \*\*done\*\* \|/m);
  assert.match(r.read('TODO/ingest.md'), /## DOM-003\b[\s\S]*?- \*\*Status:\*\* partial/);
  assert.match(r.read('TODO/ingest.md'), /## DOM-004\b[\s\S]*?- \*\*Status:\*\* done/);
  const back = r.counts(['--set', 'DOM-004', 'open']);
  assert.equal(back.status, 0, back.stderr);
  assert.match(r.read('TODO/INDEX.md'), /^\| \[DOM-004\]\(ingest\.md\) \| P3 \| ingest \| open \|/m);
});

test('--set refuses an unknown id, an unknown status, --proven on a status but done, and a missing argument', () => {
  const r = makeRecord();
  assert.equal(r.counts(['--set', 'DOM-997', 'done']).status, 1);
  assert.match(r.counts(['--set', 'DOM-997', 'done']).stderr, /DOM-997 has no row/);
  const status = r.counts(['--set', 'DOM-002', 'wontfix']);
  assert.equal(status.status, 1);
  assert.match(status.stderr, /status must be one of open, partial, blocked, done/);
  const proven = r.counts(['--set', 'DOM-002', 'partial', '--proven']);
  assert.equal(proven.status, 1);
  assert.match(proven.stderr, /--proven applies only to done/);
  assert.equal(r.counts(['--set', 'DOM-002']).status, 1);
  assert.match(r.read('TODO/INDEX.md'), /^\| \[DOM-002\]\(foundation\.md\) \| P1 \| foundation \| open \|/m, 'a refused --set changes nothing');
});

test('count.mjs refuses to write counts when the index holds no row', () => {
  const r = makeRecord();
  r.write('TODO/INDEX.md', '# TODO\n\n## Counts\n\n**0 items. 0 open, 0 partial, 0 blocked, 0 done.**\n');
  const c = r.counts([]);
  assert.equal(c.status, 2);
  assert.match(c.stderr, /no entry rows parsed/);
});
