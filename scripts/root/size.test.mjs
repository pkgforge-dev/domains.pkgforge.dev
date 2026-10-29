// scripts/root/size.mjs: the root.json sizes of docs/architecture.md section
// 4.6. The entries are synthetic and the bytes deterministic, so the figures
// the section quotes are held here: a change to the entries or to layerBytes
// that moves them fails this test until the section is measured again.
//
//   node scripts/test.mjs scripts/root --name size
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, sizes } from './size.mjs';

test('size: the figures of section 4.6, in bytes, from synthetic entries', () => {
  assert.deepEqual(sizes(), { entry: 723, part: 97, withdrawn: 115, one: 36_742, five: 181_552, time: 218, datasets: 5 });
});

test('size: main prints one JSON object and exits 0; an internal error exits 70', () => {
  const lines = [];
  assert.equal(main([], { out: (l) => lines.push(l) }), 0);
  assert.deepEqual(JSON.parse(lines.join('\n')), sizes());
  const errs = [];
  const code = main([], {
    out: () => {
      throw new Error('planted');
    },
    err: (l) => errs.push(l),
  });
  assert.equal(code, 70);
  assert.match(errs.join('\n'), /^size: internal error: Error: planted/);
});
