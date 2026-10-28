// One look at one tiled log (scripts/measure/tiles-probe.mjs, DOM-011), over
// the synthetic hosts of fixtures/tiles/fake-log.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from './ct-tiles.mjs';
import { fakeFetch, fakeLog } from './fixtures/tiles/fake-log.mjs';
import { pickLogs, probeLog } from './tiles-probe.mjs';

const LOG = { name: 'synthetic2026h2', op: 'Synthetic', state: 'usable', mon: 'https://log.test/' };
const probe = (log, opts) => probeLog(createClient({ fetchFn: fakeFetch({ 'https://log.test/': log }) }), LOG, opts);

test('tiles probe: a log that serves every tile has its checkpoint, tile 0, tail and partial tile recorded', async () => {
  const r = await probe(fakeLog({ size: 256 * 10 + 7 }));
  assert.equal(r.checkpoint.status, 200);
  assert.equal(r.checkpoint.origin, 'log.test/fake');
  assert.equal(r.size, 2567);
  assert.equal(r.checkpoint.text, undefined, 'no body is kept');
  assert.deepEqual([r.tile0.n, r.tile0.status, r.tile0.entries], [0, 200, 256]);
  assert.deepEqual([r.tail.n, r.tail.status, r.tail.entries], [9, 200, 256]);
  assert.deepEqual([r.partial.n, r.partial.w, r.partial.status, r.partial.entries], [10, 7, 200, 7]);
  assert.equal(r.tail.last_ts - r.tail.first_ts, 255_000);
  assert.deepEqual(r.first_served, { tile: 0, probes: 0, how: 'tile 0' });
});

test('tiles probe: tile 0 missing and the tail served starts the search, from the hint when there is one', async () => {
  const log = fakeLog({ size: 256 * 1000, firstServed: 377 });
  const r = await probe(log);
  assert.equal(r.tile0.status, 404);
  assert.equal(r.tile0.body, '404 page not found');
  assert.equal(r.first_served.tile, 377);
  assert.equal(r.first_served.how, 'search');
  const h = await probe(log, { hint: 377 });
  assert.deepEqual(h.first_served, { tile: 377, probes: 3, how: 'hint' });
  const gone = await probe(fakeLog({ size: 256 * 1000, firstServed: 5000 }));
  assert.equal(gone.tail.status, 404);
  assert.deepEqual(gone.first_served, { tile: null, probes: 0, how: 'tail not served' });
});

test('tiles probe: a small tree skips the tiles it does not have, and a body of the wrong width is marked bad', async () => {
  const tiny = await probe(fakeLog({ size: 100 }));
  assert.match(tiny.tile0.skipped, /no full tile/);
  assert.match(tiny.tail.skipped, /no full tile/);
  assert.equal(tiny.partial.entries, 100);
  const one = await probe(fakeLog({ size: 256 }));
  assert.equal(one.tile0.status, 200);
  assert.deepEqual(one.tail, { n: 0, same_as: 'tile0' });
  assert.match(one.partial.skipped, /multiple of 256/);
  const short = fakeLog({ size: 512, status: (p) => (p === 'tile/names/001' ? new Response('{"Timestamp":1}\n') : null) });
  const bad = await probe(short);
  assert.equal(bad.tail.status, 200);
  assert.match(bad.tail.bad, /holds 1 entries, not 256/);
});

test('tiles probe: a checkpoint that is not one, or no answer, stops the probe of that log', async () => {
  const html = await probe(fakeLog({ size: 512, status: (p) => (p === 'checkpoint' ? new Response('<html>maintenance</html>') : null) }));
  assert.match(html.checkpoint.bad, /at least three lines/);
  assert.equal(html.tile0, undefined);
  const down = await probeLog(
    createClient({
      fetchFn: async () => {
        throw new Error('down');
      },
    }),
    LOG,
  );
  assert.equal(down.checkpoint.status, null);
  assert.equal(down.checkpoint.error, 'down');
});

test('tiles probe: the logs picked are the tiled ones in the states asked for', () => {
  const rows = [
    { kind: 'tiled', state: 'usable', name: 'a' },
    { kind: 'tiled', state: 'retired', name: 'b' },
    { kind: 'rfc6962', state: 'usable', name: 'c' },
    { kind: 'tiled', state: 'qualified', name: 'd' },
  ];
  assert.deepEqual(
    pickLogs(rows).map((r) => r.name),
    ['a', 'd'],
  );
  assert.deepEqual(
    pickLogs(rows, { states: ['usable'], nameRe: /^a$/ }).map((r) => r.name),
    ['a'],
  );
});
