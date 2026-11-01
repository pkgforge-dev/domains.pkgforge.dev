// scripts/todo/rulings.test.mjs: the ruling of TODO/RULES.md section 5 that
// holds the order of the record, ruling 26, which keeps the route documents
// and the consumer contract (DOM-059, DOM-060) after every route family.
// Unlike check.test.mjs, it reads this repository's own record: its ruling,
// the Depends on lines of TODO/serve.md, the work order of TODO/PROGRESS.md
// and the ordering argument of TODO/INDEX.md.
//
//   node scripts/test.mjs scripts/todo --name rulings
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../files.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
// A text with its runs of white space made one space, so a phrase matches
// across the wrap of a line.
const flat = (text) => text.replace(/\s+/g, ' ');
const ID = /\bDOM-\d{3}\b/g;

// The entries of TODO/serve.md that own a family of routes a caller reads.
const ROUTE_FAMILIES = Object.freeze(['DOM-032', 'DOM-033', 'DOM-039', 'DOM-040', 'DOM-044']);
const LAST = Object.freeze(['DOM-059', 'DOM-060']);

// An entry: its `## <ID>` heading and every line up to the next `## `.
function entry(body, id) {
  const at = body.search(new RegExp(`^## ${id}\\b`, 'm'));
  assert.notEqual(at, -1, `no entry ${id}`);
  const rest = body.slice(at + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const dependsOn = (body, id) =>
  entry(body, id)
    .match(/^- \*\*Depends on:\*\* (.*)$/m)?.[1]
    .match(ID) ?? [];

test('rulings: ruling 26 states the operator words and the order, and the agent reading apart', () => {
  const rules = flat(read('TODO/RULES.md'));
  for (const f of [
    '26. **The documents and the contract come last** (operator, 2026-11-01, choosing "Keep the current order" over shipping the generated documents with the first routes: "keep the current order, better to publish routes & contracts only after the project is ready").',
    'and DOM-060 (the consumer contract and the reference reader) stay after every route family, as their `Depends on` lines and the work order have them',
    "The rest is the agent's reading under ruling 20, not the operator's words: each route is still deployed and driven with `curl` as its entry closes",
  ])
    assert.ok(rules.includes(f), `ruling 26 of TODO/RULES.md lacks: ${f}`);
});

test('rulings: DOM-059 depends on every route family and DOM-060 on DOM-059, and the work order ends with the two (ruling 26)', () => {
  const serve = read('TODO/serve.md');
  const headings = [...serve.matchAll(/^## (DOM-\d{3}) — (.*)$/gm)].map(([, id, title]) => ({ id, title }));
  // Each family is an entry of serve.md, and an entry whose heading names a /v1/ route is a family.
  for (const id of ROUTE_FAMILIES)
    assert.ok(
      headings.some((h) => h.id === id),
      `${id} is no entry of TODO/serve.md`,
    );
  for (const h of headings) if (h.title.includes('/v1/')) assert.ok(ROUTE_FAMILIES.includes(h.id), `${h.id} (${h.title}) serves a route and is not in ROUTE_FAMILIES`);
  const on = dependsOn(serve, 'DOM-059');
  for (const id of ROUTE_FAMILIES) assert.ok(on.includes(id), `DOM-059 does not depend on ${id}: ruling 26 keeps it after every route family`);
  assert.ok(dependsOn(serve, 'DOM-060').includes('DOM-059'), 'DOM-060 does not depend on DOM-059');
  // The numbered list of "Start here next session": its last item names the two and no other id, and no earlier item names either.
  const progress = read('TODO/PROGRESS.md');
  const at = progress.search(/^## Start here next session$/m);
  assert.notEqual(at, -1, 'TODO/PROGRESS.md has no work order');
  const list = progress
    .slice(progress.indexOf('\n', at) + 1)
    .trimStart()
    .split(/\n\s*\n/)[0];
  const items = list.split(/\n(?=\d+\. )/);
  assert.ok(items.length > 1, list);
  assert.deepEqual([...new Set(items.at(-1).match(ID))], [...LAST], `the last item of the work order: ${items.at(-1)}`);
  for (const item of items.slice(0, -1)) for (const id of LAST) assert.ok(!item.includes(id), `an earlier item of the work order names ${id}: ${item}`);
  // The ordering argument of TODO/INDEX.md cites ruling 26 for the two.
  assert.match(flat(read('TODO/INDEX.md')), /\*\*Documents and the consumer contract last \(DOM-059, DOM-060\)\.\*\* [^*]*?\(ruling 26\)/);
});
