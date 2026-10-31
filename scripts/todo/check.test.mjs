// scripts/todo/check.test.mjs — every rule of the record guard, seen to refuse.
//
// Each case builds its own small record in a temporary directory
// (scripts/lib/record-fixture.mjs), plants one defect, runs the guard there and
// reads its exit code from its own process. The clean fixture must pass first.
// No case reads this repository's own TODO files, so the tests pass before they
// exist.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cleanFixtures, makeRecord, progressText } from '../lib/record-fixture.mjs';

after(cleanFixtures);

const section = (id) => new RegExp(`(## ${id}\\b[^\\n]*\\n)`);

test('the clean fixture passes the guard and the counts check', () => {
  const r = makeRecord();
  const g = r.guard();
  assert.equal(g.status, 0, `${g.stdout}${g.stderr}`);
  assert.match(g.stdout, /TODO record agrees: 4 entries/);
  const c = r.counts(['--check']);
  assert.equal(c.status, 0, `${c.stdout}${c.stderr}`);
});

test('an empty index is a failure and a missing record is "could not run", never a pass', () => {
  const empty = makeRecord();
  empty.write('TODO/INDEX.md', '');
  const g = empty.guard();
  assert.equal(g.status, 1, 'an empty index has no rows');
  assert.match(g.stderr, /no entry rows parsed/);
  const none = makeRecord();
  rmSync(join(none.dir, 'TODO'), { recursive: true, force: true });
  const n = none.guard();
  assert.equal(n.status, 2);
  assert.match(n.stderr, /could not run/);
});

test('check 1: a wrong counts line in INDEX fails, and count.mjs repairs it', () => {
  const r = makeRecord();
  r.edit('TODO/INDEX.md', (t) => t.replace(/^\*\*(\d+) items\./m, (_, n) => `**${Number(n) + 1} items.`));
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /TODO\/INDEX\.md:\d+ shows/);
  assert.equal(r.counts(['--check']).status, 1);
  assert.equal(r.counts([]).status, 0);
  assert.equal(r.guard().status, 0);
});

test('check 1: a wrong counts table row fails', () => {
  const r = makeRecord();
  r.edit('TODO/INDEX.md', (t) => t.replace(/^\| P1 \| 1 \| 0 \| 0 \| 1 \| 2 \|$/m, '| P1 | 2 | 0 | 0 | 0 | 2 |'));
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /the counts table row disagrees with the rows/);
});

test('check 1: a second counts line anywhere in INDEX fails', () => {
  const r = makeRecord();
  r.edit('TODO/INDEX.md', (t) => `${t}\n**99 items. 99 open, 0 partial, 0 blocked, 0 done.**\n`);
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /counts lines outside ## Counts/);
});

test('check 2: unsorted rows fail', () => {
  const r = makeRecord();
  r.edit('TODO/INDEX.md', (t) => {
    const lines = t.split('\n');
    const rows = lines.flatMap((l, i) => (/^\| \[DOM-\d{3}\]/.test(l) ? [i] : []));
    [lines[rows[0]], lines[rows[1]]] = [lines[rows[1]], lines[rows[0]]];
    return lines.join('\n');
  });
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /not sorted by id/);
});

test('check 2: a duplicate id and a foreign prefix fail', () => {
  const dup = makeRecord();
  dup.edit('TODO/INDEX.md', (t) => t.replace('| [DOM-004](ingest.md)', '| [DOM-003](ingest.md)'));
  assert.match(dup.guard().stderr, /duplicate row ids DOM-003/);
  const foreign = makeRecord();
  foreign.edit('TODO/INDEX.md', (t) => t.replace('[DOM-004](ingest.md)', '[WEB-004](ingest.md)'));
  const g = foreign.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /WEB-004: ids use the DOM- prefix/);
});

test('check 3: a status that disagrees between row and entry fails', () => {
  const r = makeRecord();
  r.edit('TODO/foundation.md', (t) => t.replace(/(## DOM-002\b[\s\S]*?- \*\*Status:\*\* )(\w+)/, (_, a) => `${a}blocked`));
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /DOM-002: row says open, entry says blocked/);
});

test('check 3: a priority and an effort that the entry cannot state fail', () => {
  const r = makeRecord();
  r.edit('TODO/foundation.md', (t) => t.replace(/(## DOM-002\b[\s\S]*?- \*\*Priority:\*\* )P1/, '$1P0'));
  assert.match(r.guard().stderr, /DOM-002: row says P1, entry says P0/);
  const e = makeRecord();
  e.edit('TODO/foundation.md', (t) => t.replace(/(## DOM-002\b[\s\S]*?- \*\*Effort:\*\* )S/, '$1huge'));
  assert.match(e.guard().stderr, /DOM-002: entry has no valid `- \*\*Effort:\*\*` line/);
});

test('check 3: a row naming a category its link does not match fails', () => {
  const r = makeRecord();
  r.edit('TODO/INDEX.md', (t) => t.replace('| [DOM-004](ingest.md) | P3 | ingest |', '| [DOM-004](ingest.md) | P3 | storage |'));
  assert.match(r.guard().stderr, /DOM-004: row links ingest\.md but names category storage/);
});

test('check 4: an entry without a Prove command fails', () => {
  const r = makeRecord();
  r.edit('TODO/foundation.md', (t) => t.replace(/(## DOM-002\b[\s\S]*?)- \*\*Prove:\*\* [^\n]*/, '$1- **Prove:** done when done.'));
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /DOM-002: entry has no .*Prove/);
});

test('check 5: an entry with no row fails, and a row with no entry fails', () => {
  const r = makeRecord();
  r.edit('TODO/foundation.md', (t) => `${t}\n## DOM-999 — Planted\n\n- **Status:** open\n`);
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /DOM-999 in TODO\/.* has no row/);
  const orphan = makeRecord();
  orphan.edit('TODO/ingest.md', (t) => t.replace(/## DOM-004\b/, '## DOM-044'));
  assert.match(orphan.guard().stderr, /DOM-004: no `## DOM-004` section/);
});

test('check 5: an id defined in two category files fails', () => {
  const r = makeRecord();
  r.edit('TODO/ingest.md', (t) => `${t}\n## DOM-001 — Again\n\n- **Status:** done\n`);
  assert.match(r.guard().stderr, /DOM-001 is defined in TODO\/foundation\.md and TODO\/ingest\.md/);
});

test('check 6: a placeholder fails', () => {
  const r = makeRecord();
  r.edit('TODO/RULES.md', (t) => `${t}\n{{title}}\n`);
  assert.match(r.guard().stderr, /unfilled \{\{placeholder\}\}/);
});

test('check 7: a dead relative link fails, and a link out of the repository fails', () => {
  const r = makeRecord();
  r.edit('AGENTS.md', (t) => `${t}\n[gone](docs/absent.md)\n`);
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /links a missing target: docs\/absent\.md/);
  const out = makeRecord();
  out.edit('README.md', (t) => `${t}\n[away](../elsewhere/README.md)\n`);
  assert.match(out.guard().stderr, /links outside the repository: \.\.\/elsewhere\/README\.md/);
});

test('check 7: a dead link in an entry file fails too', () => {
  const r = makeRecord();
  r.edit('TODO/ingest.md', (t) => `${t}\nSee [a page](../docs/absent.md).\n`);
  assert.match(r.guard().stderr, /TODO\/ingest\.md links a missing target/);
});

test('check 8: a mention of an id with no row fails, and a foreign id is no mention', () => {
  const r = makeRecord();
  r.edit('TODO/PROGRESS.md', (t) => t.replace('## Open questions', '## Open questions\n\n- DOM-998 planted.'));
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /TODO\/PROGRESS\.md mentions DOM-998, which has no row/);
  const foreign = makeRecord();
  foreign.edit('TODO/PROGRESS.md', (t) => t.replace('## Open questions', '## Open questions\n\n- The sibling repository tracks WEB-156 itself.'));
  assert.equal(foreign.guard().status, 0);
});

test('check 8: a dependency on itself and a dependency cycle fail', () => {
  const self = makeRecord();
  self.edit('TODO/foundation.md', (t) => t.replace(section('DOM-001'), '$1\n- **Depends on:** DOM-001\n'));
  assert.match(self.guard().stderr, /DOM-001 depends on itself/);
  const cycle = makeRecord();
  cycle.edit('TODO/foundation.md', (t) => t.replace(section('DOM-001'), '$1\n- **Depends on:** DOM-004\n'));
  assert.match(cycle.guard().stderr, /Depends on lines form a cycle/);
});

test('check 9: PROGRESS without a required section fails, and a section twice fails', () => {
  const r = makeRecord();
  r.edit('TODO/PROGRESS.md', (t) => t.replace('## Open questions', '## Questions'));
  assert.match(r.guard().stderr, /missing section ## Open questions/);
  const twice = makeRecord();
  twice.edit('TODO/PROGRESS.md', (t) => `${t}\n## Settled\n\nAgain.\n`);
  assert.match(twice.guard().stderr, /## Settled appears 2 times/);
});

test('check 9: a wrong counts line under Baseline fails, and a second one outside it fails', () => {
  const wrong = makeRecord();
  wrong.edit('TODO/PROGRESS.md', (t) => t.replace(/^\*\*(\d+) items\./m, (_, n) => `**${Number(n) + 1} items.`));
  assert.match(wrong.guard().stderr, /TODO\/PROGRESS\.md:\d+ shows/);
  const outside = makeRecord();
  outside.edit('TODO/PROGRESS.md', (t) => t.replace('- nothing\n\n## What is in progress', '- nothing\n\n**4 items. 2 open, 1 partial, 0 blocked, 1 done.**\n\n## What is in progress'));
  assert.match(outside.guard().stderr, /counts lines outside ## Baseline/);
});

test('check 10: a backticked path that does not exist fails; a line past the end fails', () => {
  const r = makeRecord();
  r.edit('TODO/PROGRESS.md', (t) => `${t}\n- probe: \`scripts/absent.mjs\` runs.\n`);
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /cites `scripts\/absent\.mjs`, which does not exist/);
  const past = makeRecord();
  past.edit('TODO/PROGRESS.md', (t) => `${t}\n- probe: \`scripts/todo/check.mjs:9999\` runs.\n`);
  assert.match(past.guard().stderr, /cites `scripts\/todo\/check\.mjs:9999`, but that file has \d+ lines/);
  const ok = makeRecord();
  ok.edit('TODO/PROGRESS.md', (t) => `${t}\n- probe: \`docs/architecture.md:3\` and \`scripts/todo/check.mjs\` exist.\n`);
  assert.equal(ok.guard().status, 0);
});

test('check 10: a clause stating absence, a glob and a placeholder path are not claims', () => {
  const r = makeRecord();
  r.edit('TODO/PROGRESS.md', (t) => `${t}\n- The tree has no \`scripts/absent.mjs\` yet.\n- Every \`docs/research/*.md\` and \`apps/<worker>/src/index.ts\` is named by pattern.\n`);
  assert.equal(r.guard().status, 0);
});

test('check 10: a dated research report may cite another repository path, and its links still resolve', () => {
  const r = makeRecord();
  r.write('docs/research/2026-10-27-a.md', '# A report\n\nThe sibling holds `apps/forge/src/ghcr.ts:40`.\n');
  assert.equal(r.guard().status, 0);
  r.write('docs/research/2026-10-27-b.md', '# B report\n\nSee [the other](2026-10-27-missing.md).\n');
  assert.match(r.guard().stderr, /docs\/research\/2026-10-27-b\.md links a missing target/);
});

test('check 11: a Prove line resting on the guard alone fails', () => {
  const r = makeRecord();
  r.edit('TODO/foundation.md', (t) => t.replace(/(## DOM-002\b[\s\S]*?)- \*\*Prove:\*\* [^\n]*/, '$1- **Prove:** `node scripts/todo/check.mjs` exits 0.'));
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /DOM-002: its only acceptance criterion is the record guard/);
});

test('check 12: a work order that lists an entry before an open dependency fails', () => {
  const r = makeRecord();
  r.edit('TODO/PROGRESS.md', () => progressText(undefined, ['DOM-003', 'DOM-002', 'DOM-004']));
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /work order: DOM-003 is listed before DOM-002/);
  const missing = makeRecord();
  missing.edit('TODO/PROGRESS.md', () => progressText(undefined, ['DOM-003', 'DOM-004']));
  assert.match(missing.guard().stderr, /work order: DOM-003 is listed before DOM-002/);
  const done = makeRecord();
  done.edit('TODO/PROGRESS.md', () => progressText(undefined, ['DOM-002', 'DOM-003']));
  assert.equal(done.guard().status, 0, 'DOM-001 is done, so DOM-002 needs nothing before it');
});

test('check 13: a Waiting line next.mjs cannot read fails, and so does one on an entry that is not partial', () => {
  const bad = makeRecord();
  bad.edit('TODO/ingest.md', (t) => t.replace(section('DOM-003'), '$1\n- **Waiting:** until 2026-10-12T00:00:00Z, read it again.\n'));
  assert.match(bad.guard().stderr, /DOM-003: its Waiting line is not/);
  const impossible = makeRecord();
  impossible.edit('TODO/ingest.md', (t) => t.replace(section('DOM-003'), '$1\n- **Waiting:** until 2026-13-45T99:99:99Z; read it again.\n'));
  assert.match(impossible.guard().stderr, /DOM-003: its Waiting line is not/, 'a date that does not exist');
  const open = makeRecord();
  open.edit('TODO/ingest.md', (t) => t.replace(section('DOM-004'), '$1\n- **Waiting:** until 2026-10-12T00:00:00Z; read it again.\n'));
  assert.match(open.guard().stderr, /DOM-004: a Waiting line on a open entry/);
  const fine = makeRecord();
  fine.edit('TODO/ingest.md', (t) => t.replace(section('DOM-003'), '$1\n- **Waiting:** until 2026-10-12T00:00:00Z; read it again.\n'));
  assert.equal(fine.guard().status, 0);
});

test('check 14: a done entry with no Closed line fails', () => {
  const r = makeRecord();
  r.edit('TODO/foundation.md', (t) => t.replace(/^(\s*)- \*\*Closed\b/gm, '$1- **Finished'));
  const g = r.guard();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /DOM-001: done, but no/);
  // The word in prose is not the label.
  const prose = makeRecord();
  prose.edit('TODO/foundation.md', (t) => t.replace(/^(\s*)- \*\*Closed\b/gm, '$1- **Finished').replace(section('DOM-001'), '$1\n- **Note:** Closed in prose is no Closed line.\n'));
  assert.match(prose.guard().stderr, /DOM-001: done, but no/);
});

test('check 15: a record line stamped later than now fails, whatever its label and its case', () => {
  const later = `${new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16)}Z`;
  for (const label of ['Closed', 'Measured', 'MEASURED', 'Read', 'READ', 'Found', 'Built', 'Done', 'Correction']) {
    const r = makeRecord();
    r.edit('TODO/foundation.md', (t) => t.replace(section('DOM-002'), `$1\n- **${label} ${later}:** a reading not taken yet.\n`));
    const g = r.guard();
    assert.equal(g.status, 1, label);
    assert.match(g.stderr, new RegExp(`DOM-002: its ${label} line is stamped ${later}, later than now`));
  }
});
