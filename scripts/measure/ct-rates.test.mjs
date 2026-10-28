// The rates of every log (scripts/measure/ct-rates.mjs, DOM-011): two reads of
// each tree size, over synthetic hosts whose size moves between the reads and a
// clock the test turns (fixtures/tiles/fake-log.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from './ct-tiles.mjs';
import { measureRates, sizeOf, totals } from './ct-rates.mjs';
import { fakeFetch, fakeLog } from './fixtures/tiles/fake-log.mjs';

// A clock that the fake sleep moves forward.
const clockAt = (t0) => {
  let now = t0;
  return { clock: () => now, sleep: async (ms) => (now += ms) };
};

test('ct rates: a tiled and an RFC 6962 log grow between the two reads; the rate is per second of the span', async () => {
  let pass = 0;
  const tiled = { handle: (p) => fakeLog({ size: pass === 0 ? 1000 : 1600 }).handle(p) };
  const sth = () => new Response(JSON.stringify({ tree_size: pass === 0 ? 5000 : 5600 }));
  const fetchFn = fakeFetch({ 'https://t.test/': tiled, 'https://r.test/ct/v1/get-sth': sth });
  const c = clockAt(Date.parse('2026-10-28T12:00:00Z'));
  const rows = [
    { op: 'A', desc: 'A Tiled', name: 'tiled', kind: 'tiled', state: 'usable', mon: 'https://t.test/' },
    { op: 'B', desc: 'B Rfc', name: 'rfc', kind: 'rfc6962', state: 'usable', url: 'https://r.test/' },
    { op: 'C', desc: 'C Old', name: 'old', kind: 'rfc6962', state: 'retired', url: 'https://old.test/' },
  ];
  const sleep = async (ms) => {
    await c.sleep(ms);
    pass = 1;
  };
  const r = await measureRates(createClient({ fetchFn, clock: c.clock }), rows, { gapMs: 600_000, clock: c.clock, sleep });
  assert.equal(r.gap_s, 600);
  assert.equal(r.res.length, 2, 'a retired log is left out, as design A left it out');
  const t = r.res.find((x) => x.name === 'tiled');
  assert.equal(t.rate_per_s, 1);
  assert.equal(t.per_day_M, 0.09);
  assert.equal(t.names_tile, 200);
  assert.equal(r.res.find((x) => x.name === 'rfc').rate_per_s, 1);
  assert.equal(r.res.find((x) => x.name === 'rfc').names_tile, null);
  assert.deepEqual(totals(r), { logs: 2, measured: 2, total_M_per_day: 0.2, names_tile_logs_M_per_day: 0.1 });
});

test('ct rates: a log that does not answer has an error and no rate', async () => {
  const fetchFn = fakeFetch({ 'https://t.test/': fakeLog({ size: 10, status: (p) => (p === 'checkpoint' ? new Response('', { status: 503 }) : null) }) });
  const row = { kind: 'tiled', state: 'usable', mon: 'https://t.test/' };
  assert.deepEqual(await sizeOf(createClient({ fetchFn }), row, () => 7), { err: 503, at: 7 });
  const notJson = fakeFetch({ 'https://r.test/ct/v1/get-sth': () => new Response('<html>') });
  assert.equal((await sizeOf(createClient({ fetchFn: notJson }), { kind: 'rfc6962', url: 'https://r.test/' })).err, 'get-sth is not JSON');
  const c = clockAt(0);
  const r = await measureRates(createClient({ fetchFn }), [{ op: 'A', desc: 'A', name: 'a', ...row }], { gapMs: 1000, clock: c.clock, sleep: c.sleep });
  assert.equal(r.res[0].rate_per_s, null);
  assert.equal(r.res[0].err, 503);
  assert.equal(totals(r).measured, 0);
});
