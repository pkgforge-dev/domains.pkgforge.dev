// The first served names tile of DOM-011 (scripts/measure/first-names-tile.mjs):
// the binary search over a synthetic log that serves one contiguous range, as
// IPng's Gouda logs do (fixtures/tiles/fake-log.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, CtError } from './ct-tiles.mjs';
import { firstServedTile, servedProbe } from './first-names-tile.mjs';
import { fakeFetch, fakeLog } from './fixtures/tiles/fake-log.mjs';

// A probe over tiles [first, tail]: true inside, false below.
const range = (first) => {
  const asked = [];
  const probe = async (i) => {
    asked.push(i);
    return i >= first;
  };
  return { probe, asked };
};

test('first names tile: the search finds the lowest served tile of a contiguous range', async () => {
  for (const first of [1, 2, 25, 366929, 4810098, 4810099]) {
    const { probe } = range(first);
    const r = await firstServedTile(probe, { hi: 4810099 });
    assert.equal(r.first, first, String(first));
    assert.equal(r.how, 'search');
  }
});

test('first names tile: tile 0 served, or the tail not served, ends the search at once', async () => {
  const all = range(0);
  assert.deepEqual(await firstServedTile(all.probe, { hi: 100 }), { first: 0, probes: 1, how: 'tile 0' });
  const none = range(1000);
  assert.deepEqual(await firstServedTile(none.probe, { hi: 100 }), { first: null, probes: 2, how: 'tail not served' });
});

test('first names tile: a hint that still holds settles in two probes after the known ends; one that moved still finds the edge', async () => {
  const same = range(366929);
  const r = await firstServedTile(same.probe, { lo: 0, hi: 4810099, hint: 366929 });
  assert.deepEqual(r, { first: 366929, probes: 3, how: 'hint' });
  assert.deepEqual(same.asked, [4810099, 366929, 366928]);
  for (const moved of [366930, 400000, 300000]) {
    const m = range(moved);
    const x = await firstServedTile(m.probe, { lo: 0, hi: 4810099, hint: 366929 });
    assert.equal(x.first, moved, String(moved));
  }
});

test('first names tile: a status other than 200 or 404 ends the search with an error, never as not served', async () => {
  const fetchFn = fakeFetch({ 'https://g.test/': fakeLog({ size: 256 * 50, firstServed: 10, status: (p) => (p === 'tile/names/024' ? new Response('', { status: 429 }) : null) }) });
  const probe = servedProbe(createClient({ fetchFn }), 'https://g.test/');
  await assert.rejects(firstServedTile(probe, { hi: 49 }), (e) => e instanceof CtError && /tile 24 answered 429/.test(e.message));
  const clean = servedProbe(createClient({ fetchFn: fakeFetch({ 'https://g.test/': fakeLog({ size: 256 * 50, firstServed: 10 }) }) }), 'https://g.test');
  assert.equal((await firstServedTile(clean, { hi: 49 })).first, 10);
});
