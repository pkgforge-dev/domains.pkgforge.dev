// scripts/todo/next.mjs — the dependency waves: derived from the `Depends on`
// lines, P0 first inside a wave, a cycle refused, a Waiting line shown.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanFixtures, makeRecord } from '../lib/record-fixture.mjs';
import { buildWaves } from './next.mjs';

after(cleanFixtures);

test('buildWaves places an entry after everything it needs, and P0 first inside a wave', () => {
  const pending = [
    { id: 'DOM-003', priority: 'P2' },
    { id: 'DOM-001', priority: 'P3' },
    { id: 'DOM-002', priority: 'P0' },
    { id: 'DOM-004', priority: 'P1' },
  ];
  const deps = new Map([
    ['DOM-001', []],
    ['DOM-002', []],
    ['DOM-003', ['DOM-001', 'DOM-002']],
    ['DOM-004', ['DOM-003']],
  ]);
  const { waves } = buildWaves(pending, deps);
  assert.deepEqual(
    waves.map((w) => w.map((r) => r.id)),
    [['DOM-002', 'DOM-001'], ['DOM-003'], ['DOM-004']],
  );
});

test('buildWaves reports a cycle by its members', () => {
  const pending = [
    { id: 'DOM-001', priority: 'P1' },
    { id: 'DOM-002', priority: 'P1' },
    { id: 'DOM-003', priority: 'P1' },
  ];
  const deps = new Map([
    ['DOM-001', ['DOM-002']],
    ['DOM-002', ['DOM-001']],
    ['DOM-003', []],
  ]);
  assert.deepEqual(buildWaves(pending, deps), { cycle: ['DOM-001', 'DOM-002'] });
});

test('the script prints the waves of the fixture, leaving out the done entry', () => {
  const r = makeRecord();
  const n = r.next();
  assert.equal(n.status, 0, n.stderr);
  const lines = n.stdout.trim().split('\n');
  assert.match(lines[0], /^wave 1:/);
  assert.match(lines[1], /^ {2}P1 DOM-002 The gate$/);
  assert.match(lines[3], /^ {2}P2 DOM-003 \[partial\] The first feed {2}\(needs DOM-002\)$/);
  assert.match(lines[5], /^ {2}P3 DOM-004 The second feed {2}\(needs DOM-003\)$/);
  assert.ok(!n.stdout.includes('DOM-001'), 'a done entry is not pending');
});

test('--json is machine-readable and carries the needs of each entry', () => {
  const r = makeRecord();
  const n = r.next(['--json']);
  assert.equal(n.status, 0, n.stderr);
  const waves = JSON.parse(n.stdout);
  assert.deepEqual(
    waves.map((w) => w.map((e) => [e.id, e.needs])),
    [[['DOM-002', []]], [['DOM-003', ['DOM-002']]], [['DOM-004', ['DOM-003']]]],
  );
  assert.equal(waves[0][0].item, 'The gate');
});

test('a Waiting line is shown as waiting, and as due once its instant has passed', () => {
  const r = makeRecord();
  r.edit('TODO/ingest.md', (t) => t.replace(/(## DOM-003\b[^\n]*\n)/, '$1\n- **Waiting:** until 2999-01-01T00:00:00Z; read the feed again.\n'));
  assert.match(r.next().stdout, /\(waiting until 2999-01-01T00:00:00Z\)/);
  r.edit('TODO/ingest.md', (t) => t.replace('2999-01-01T00:00:00Z', '2026-01-01T00:00:00Z'));
  assert.match(r.next().stdout, /\(DUE since 2026-01-01T00:00:00Z: read the feed again\.\)/);
});

test('a dependency cycle in the record exits 1 and names the entries', () => {
  const r = makeRecord();
  r.edit('TODO/foundation.md', (t) => t.replace(/(## DOM-002\b[^\n]*\n[\s\S]*?)- \*\*Depends on:\*\* DOM-001/, '$1- **Depends on:** DOM-004'));
  const n = r.next();
  assert.equal(n.status, 1);
  assert.match(n.stderr, /cycle among: DOM-002, DOM-003, DOM-004/);
});
