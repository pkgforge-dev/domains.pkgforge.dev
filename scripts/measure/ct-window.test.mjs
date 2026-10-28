// The window read of one log (scripts/measure/ct-window.mjs, DOM-011), over
// synthetic trees whose entries are one second apart from T0
// (fixtures/tiles/fake-log.mjs): every count is known from the arithmetic.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient, CtError } from './ct-tiles.mjs';
import { byteKey, hashName, hashSet, nameKey, readWindow, SEQUENCED_MS, writeNames } from './ct-window.mjs';
import { h53, readF64 } from './f64cmp.mjs';
import { fakeFetch, fakeLog, T0 } from './fixtures/tiles/fake-log.mjs';

const MON = 'https://log.test/';
const read = (log, from, to, opts = {}) => readWindow(createClient({ fetchFn: fakeFetch({ [MON]: log }), sleep: async () => {} }), { mon: MON, from, to, clock: () => T0 + 10 * 86_400_000, ...opts });

test('ct window: the entries of [from, to) are counted exactly, and each name once', async () => {
  // Entry i at T0 + i s with the names n<i>.example.com and, every tenth, a wildcard of the same.
  const log = fakeLog({ size: 256 * 40 + 9, dns: (i) => (i % 10 === 0 ? [`n${i}.example.com`, `*.n${i}.example.com`] : [`N${i}.Example.com`]) });
  const { names, stat } = await read(log, T0 + 1000 * 1000, T0 + 1300 * 1000);
  assert.equal(stat.entries, 300);
  assert.equal(stat.distinct_names, 300, 'the wildcard and the upper case fold into one name');
  assert.ok(names.has('n1000.example.com') && names.has('n1299.example.com') && !names.has('n1300.example.com'));
  assert.equal(stat.start_tile, 3);
  assert.equal(stat.first, new Date(T0 + 1000 * 1000).toISOString());
  assert.equal(stat.last, new Date(T0 + 1299 * 1000).toISOString());
  assert.equal(stat.complete, true);
  assert.equal(stat.throttled, 0);
  assert.equal(stat.gz_unknown_tiles, 0);
  assert.ok(stat.gz_bytes > 0 && stat.gzip_local_bytes > 0);
});

test('ct window: a log that does not serve tile 0 is searched from its first served tile', async () => {
  const log = fakeLog({ size: 256 * 40, firstServed: 2 });
  const { stat } = await read(log, T0 + 2000 * 1000, T0 + 2100 * 1000);
  assert.equal(stat.first_served_tile, 2);
  assert.equal(stat.entries, 100);
  assert.equal(stat.complete, true);
});

test('ct window: a window that starts before the served range is not whole', async () => {
  const log = fakeLog({ size: 256 * 40, firstServed: 10 });
  const { stat } = await read(log, T0 + 100 * 1000, T0 + 3000 * 1000);
  assert.equal(stat.cut_before, true);
  assert.equal(stat.complete, false);
  // The same read with every tile served is whole: the guard alone made the difference.
  const whole = await read(fakeLog({ size: 256 * 40 }), T0 + 100 * 1000, T0 + 3000 * 1000);
  assert.equal(whole.stat.cut_before, false);
  assert.equal(whole.stat.complete, true);
  assert.equal(whole.stat.entries, 2900);
});

test('ct window: the read goes into the partial tile; a window the tree does not yet hold is not whole', async () => {
  const log = fakeLog({ size: 256 * 4 + 100 });
  const inPartial = await read(log, T0 + 1030 * 1000, T0 + 1060 * 1000);
  assert.equal(inPartial.stat.entries, 30);
  assert.equal(inPartial.stat.complete, true);
  // The tree ends at entry 1123; the window runs past it.
  const open = await read(log, T0 + 1100 * 1000, T0 + 1200 * 1000, { clock: () => T0 + 1150 * 1000 });
  assert.equal(open.stat.entries, 24);
  assert.equal(open.stat.reached_end, true);
  assert.equal(open.stat.closed_before_checkpoint, false);
  assert.equal(open.stat.complete, false);
  // The same window read long after it closed: the tree holds all it will.
  const closed = await read(log, T0 + 1100 * 1000, T0 + 1200 * 1000);
  assert.equal(closed.stat.closed_before_checkpoint, true);
  assert.equal(closed.stat.complete, true);
  // SEQUENCED_MS is 5 minutes: a window that closed 4 minutes before the
  // checkpoint was read is not whole, one that closed 5 minutes before is.
  assert.equal(SEQUENCED_MS, 5 * 60_000);
  const recent = await read(log, T0 + 1100 * 1000, T0 + 1200 * 1000, { clock: () => T0 + 1200 * 1000 + 4 * 60_000 });
  assert.deepEqual([recent.stat.closed_before_checkpoint, recent.stat.complete], [false, false]);
  const atEdge = await read(log, T0 + 1100 * 1000, T0 + 1200 * 1000, { clock: () => T0 + 1200 * 1000 + 5 * 60_000 });
  assert.deepEqual([atEdge.stat.closed_before_checkpoint, atEdge.stat.complete], [true, true]);
});

test('ct window: a 429 is retried after its Retry-After; a tile that stays missing fails the read', async () => {
  let n = 0;
  const throttled = fakeLog({ size: 256 * 8, status: (p) => (p === 'tile/names/003' && ++n <= 2 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : null) });
  const { stat } = await read(throttled, T0, T0 + 2048 * 1000);
  assert.equal(stat.entries, 2048);
  assert.equal(stat.throttled, 2);
  await assert.rejects(read(fakeLog({ size: 256 * 8, missing: new Set([5]) }), T0, T0 + 2048 * 1000), (e) => e instanceof CtError && /tile 5 answered 404/.test(e.message));
});

test('ct window: Content-Length absent is counted as unknown, not as zero bytes', async () => {
  const { stat } = await read(fakeLog({ size: 256 * 4, lengths: false }), T0, T0 + 1024 * 1000);
  assert.equal(stat.gz_bytes, 0);
  assert.equal(stat.gz_unknown_tiles, stat.tiles_read);
  assert.equal(stat.gz_per_entry, null);
  assert.ok(stat.gzip_local_bytes > 0);
});

test('ct window: the key is the UTF-8 bytes, ASCII lowered, without one leading *. and one trailing CR', () => {
  assert.equal(byteKey('*.WWW.Example.COM\r'), 'www.example.com');
  assert.equal(byteKey('*.*.a.b'), '*.a.b');
  assert.equal(nameKey('Bücher.example'), Buffer.from('bücher.example', 'utf8').toString('latin1'));
  assert.equal(hashName('*.A.example'), h53('a.example'));
  // A THC line read as latin1 bytes and a name from JSON hash alike.
  assert.equal(hashName('bücher.example'), h53(byteKey(Buffer.from('bücher.example\r', 'utf8').toString('latin1'))));
});

test('ct window: writeNames writes the names and their sorted hashes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-window-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = new Set(['b.example', 'a.example']);
  const hashes = writeNames(dir, 'x', names);
  assert.deepEqual(readFileSync(join(dir, 'x.names.txt'), 'utf8').split('\n').sort(), ['a.example', 'b.example']);
  assert.deepEqual([...readF64(join(dir, 'x.names.f64'))], [...hashes]);
  assert.deepEqual([...hashSet(names)], [...hashes]);
  assert.ok(hashes[0] < hashes[1]);
});
