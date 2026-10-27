import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCommandLike, proveCriterion, proveLineOf, proveVerdicts } from './prove.mjs';

const prove = (s) => proveCriterion(`- **Prove:** ${s}`);

test('the guard alone is vacuous, whatever prose restates its verdict', () => {
  assert.equal(prove('`node scripts/todo/check.mjs` exits 0.').vacuous, true);
  assert.equal(prove('`node scripts/todo/check.mjs` is green and `TODO/INDEX.md` agrees.').vacuous, true);
  assert.equal(prove('<!-- tests --> `node scripts/todo/check.mjs` exits 0').vacuous, true);
});

test('the guard beside a real command is not vacuous', () => {
  const r = prove('`npm test` exits 0 and `node scripts/todo/check.mjs` exits 0.');
  assert.equal(r.vacuous, false);
  assert.deepEqual(r.commands, ['npm test']);
});

test('the guard beside a named test is not vacuous', () => {
  assert.equal(prove('the planted-defect test fails red-then-green; `node scripts/todo/check.mjs` exits 0.').vacuous, false);
});

test('a command with no guard is a criterion', () => {
  const r = prove('`curl -sS https://domains.pkgforge.dev/v1/status` returns 200.');
  assert.equal(r.vacuous, false);
  assert.equal(r.unverifiable, false);
});

test('a document path alone names nothing runnable', () => {
  const r = prove('`docs/resources.md` lists it.');
  assert.equal(r.unverifiable, true);
});

test('command shapes', () => {
  assert.equal(isCommandLike('npm run gate'), true);
  assert.equal(isCommandLike('oras manifest fetch ghcr.io/pkgforge-dev/domains/ct:latest'), true);
  assert.equal(isCommandLike('scripts/gate.mjs'), true);
  assert.equal(isCommandLike('TODO/INDEX.md'), false);
  assert.equal(isCommandLike('apps/serve/wrangler.toml'), false);
});

test('proveVerdicts reads the Prove line of each entry and skips an entry with none', () => {
  const out = proveVerdicts([
    { id: 'DOM-001', file: 'foundation.md', section: '## DOM-001 — A\n\n- **Prove:** `node scripts/todo/check.mjs` exits 0.\n' },
    { id: 'DOM-002', file: 'foundation.md', section: '## DOM-002 — B\n\n- **Prove:** `npm test` exits 0.\n' },
    { id: 'DOM-003', file: 'foundation.md', section: '## DOM-003 — C\n\nno prove line\n' },
  ]);
  assert.deepEqual(
    out.map((v) => [v.id, v.vacuous]),
    [
      ['DOM-001', true],
      ['DOM-002', false],
    ],
  );
  assert.equal(proveLineOf('x\n- **Prove:** `a b`\n'), '- **Prove:** `a b`');
  assert.equal(proveLineOf('no line'), null);
});
