// The window by name and the overlap of DOM-011 (scripts/measure/tiles-window.mjs):
// the pick of the window, the Kafka cut, the THC scan and the share matrix,
// over synthetic logs, a synthetic Kafka output and a synthetic THC day built
// here (fixtures/tiles/fake-log.mjs); nothing in them was recorded.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { LOG_LIST_URL, logRows } from './ct-logs.mjs';
import { createClient, CtError } from './ct-tiles.mjs';
import { hashName } from './ct-window.mjs';
import { fakeFetch, fakeList, fakeLog, T0 } from './fixtures/tiles/fake-log.mjs';
import { LISTING_URL } from './thc-list.mjs';
import { awaitThcDay, familyShards, kafkaCommand, main, overlap, pickWindow, readKafka, scanThc, shareMatrix } from './tiles-window.mjs';

const at = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString();
const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tiles-window-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('tiles window: the window starts 22 hours before the pick, on the day before it, away from either end of that day', () => {
  assert.deepEqual(pickWindow(at('2026-10-29T10:00:00Z')), { from: at('2026-10-28T12:00:00Z'), to: at('2026-10-28T12:05:00Z'), day: '2026-10-28' });
  assert.equal(iso(pickWindow(at('2026-10-29T10:01:00Z')).from), '2026-10-28T12:05:00.000Z', 'rounded up to 5 minutes');
  assert.equal(pickWindow(at('2026-10-29T00:10:00Z')).day, '2026-10-28');
  assert.equal(iso(pickWindow(at('2026-10-29T21:25:00Z')).to), '2026-10-28T23:30:00.000Z', 'the last window that keeps 30 minutes');
  assert.match(pickWindow(at('2026-10-29T21:30:00Z')).skipped, /within 30 minutes of an end of its UTC day/);
  assert.match(pickWindow(at('2026-10-29T22:30:00Z')).skipped, /the pick's own UTC day/);
  assert.match(pickWindow(at('2026-10-29T10:00:00Z'), at('2026-10-29T10:00:00Z')).skipped, /until 2026-10-29T10:00:00.000Z has passed/);
});

test('tiles window: the families are the usable shards whose name starts with the family', () => {
  const rows = logRows(
    fakeList({
      logs: [
        ["Let's Encrypt", "Let's Encrypt Sycamore2026h2", 'usable', 'https://s1.test/'],
        ["Let's Encrypt", "Let's Encrypt Sycamore2028h1", 'qualified', 'https://s2.test/'],
        ['IPng Networks', 'IPng Networks Gouda2027h1', 'usable', 'https://g.test/'],
        ['IPng Networks', 'IPng Networks Halloumi2026h2a', 'usable', 'https://h.test/'],
      ],
    }),
  );
  assert.deepEqual(familyShards(rows), { sycamore: ['sycamore2026h2'], willow: [], tuscolo: [], gouda: ['gouda2027h1'] });
});

test('tiles window: a Kafka window whose messages start late, end early or are none is cut', (t) => {
  const dir = tmp(t);
  const from = at('2026-10-28T12:00:00Z');
  const to = from + 300_000;
  const write = (stat) => {
    writeFileSync(join(dir, 'kafka.stat.json'), JSON.stringify(stat));
    writeFileSync(join(dir, 'kafka.names.txt'), 'a.example\nb.example');
  };
  write({ messages: 9, first_seen: '2026-10-28T11:59:59Z', last_seen: '2026-10-28T12:04:59Z' });
  const whole = readKafka(dir, from, to);
  assert.equal(whole.cut, false);
  assert.equal(whole.names.size, 2);
  write({ messages: 9, first_seen: '2026-10-28T12:03:00Z', last_seen: '2026-10-28T12:04:59Z' });
  assert.equal(readKafka(dir, from, to).cut, true, 'the retention took the start');
  write({ messages: 9, first_seen: '2026-10-28T12:00:00Z', last_seen: '2026-10-28T12:01:00Z' });
  assert.equal(readKafka(dir, from, to).cut, true);
  write({ messages: 0, first_seen: null, last_seen: null });
  assert.equal(readKafka(dir, from, to).cut, true);
});

test('tiles window: THC day is scanned for the window hashes only, its lines keyed like the names', async (t) => {
  const dir = tmp(t);
  const file = join(dir, 'day.txt.gz');
  writeFileSync(file, gzipSync('*.A.example\r\nb.example\nother.example\nB.EXAMPLE\n'));
  const wanted = new Set([hashName('a.example'), hashName('b.example'), hashName('absent.example')]);
  const r = await scanThc(file, wanted);
  assert.equal(r.lines, 4);
  assert.deepEqual([...r.hits].sort(), [hashName('a.example'), hashName('b.example')].sort());
});

test('tiles window: a cell is the share of the row in the column; THC is a column only', () => {
  const m = shareMatrix({ a: new Float64Array([1, 2, 3, 4]), b: new Float64Array([3, 4, 5]) }, new Float64Array([1, 4, 5]));
  assert.deepEqual(m.rows, ['a', 'b']);
  assert.deepEqual(m.cols, ['a', 'b', 'thc']);
  assert.deepEqual(m.cells, [
    [100, 50, 50],
    [66.67, 100, 66.67],
  ]);
  assert.deepEqual(shareMatrix({ a: new Float64Array([1]) }).cols, ['a']);
});

test('tiles window: THC day is awaited through its listing, and a day that never comes is an error', async () => {
  let polls = 0;
  const listing = () => new Response(JSON.stringify(++polls < 3 ? [] : [{ type: 'file', path: '2026/10/2026-10-26.txt.gz', size: 100 }]));
  let now = 0;
  const opts = { waitMs: 60 * 60_000, clock: () => now, sleep: async (ms) => (now += ms) };
  const got = await awaitThcDay(createClient({ fetchFn: fakeFetch({ [LISTING_URL]: listing }) }), '2026-10-26', opts);
  assert.equal(got.entry.path, '2026/10/2026-10-26.txt.gz');
  assert.equal(got.waited_min, 10);
  now = 0;
  const never = fakeFetch({ [LISTING_URL]: () => new Response('[]') });
  await assert.rejects(awaitThcDay(createClient({ fetchFn: never }), '2026-10-26', { ...opts, waitMs: 12 * 60_000 }), (e) => e instanceof CtError && /does not hold 2026-10-26/.test(e.message));
});

// The overlap over synthetic hosts: one entry a second from T0 in each log.
function overlapWorld({ kafka = 'ok', goudaMissing = false, unlisted = [] } = {}) {
  const fams = {
    sycamore: (i) => [`n${i}.example.com`],
    willow: (i) => [i % 2 ? `w${i}.example.com` : `n${i}.example.com`],
    tuscolo: (i) => [`n${i}.example.com`, `*.t${i}.example.com`],
    gouda: (i) => [`g${i}.example.com`],
  };
  const routes = {};
  const logs = [];
  for (const [f, dns] of Object.entries(fams)) {
    routes[`https://${f}.test/`] = fakeLog({ size: 256 * 8, dns, missing: goudaMissing && f === 'gouda' ? new Set([4]) : new Set() });
    if (!unlisted.includes(f)) logs.push(['Op', `Op ${f[0].toUpperCase()}${f.slice(1)}2026h2`, 'usable', `https://${f}.test/`]);
  }
  routes[LISTING_URL] = () => new Response(JSON.stringify([{ type: 'file', path: '2026/10/2026-10-26.txt.gz', size: 100 }]));
  const runKafka = (from, to, dir) => {
    if (kafka === 'fail') return { status: 1, stderr: 'kafka-window: the read failed' };
    // A cut window: its first message is three minutes after the window starts.
    writeFileSync(join(dir, 'kafka.stat.json'), JSON.stringify({ messages: 10, first_seen: iso(kafka === 'cut' ? from + 180_000 : from), last_seen: iso(to - 1000) }));
    const names = [];
    for (let i = 1000; i < 1100; i++) names.push(`n${i}.example.com`);
    for (let k = 0; k < 100; k++) names.push(`k${k}.example.com`);
    writeFileSync(join(dir, 'kafka.names.txt'), names.join('\n'));
    return { status: 0 };
  };
  const downloadThc = async ({ dest }) => {
    const lines = [];
    for (let i = 1000; i < 1150; i++) lines.push(`n${i}.example.com`);
    lines.push('unrelated.example.org');
    writeFileSync(dest, gzipSync(`${lines.join('\n')}\n`));
    return { ok: true, source: 'cs2', bytes: 1 };
  };
  return { rows: logRows(fakeList({ logs })), client: createClient({ fetchFn: fakeFetch(routes) }), runKafka, downloadThc };
}

test('tiles window: the overlap of a whole window gives each set, the union and the matrix with THC', async (t) => {
  const data = tmp(t);
  const w = overlapWorld();
  const o = await overlap({ from: T0 + 1000_000, to: T0 + 1200_000, day: '2026-10-26', data, thcWaitMs: 0, ...w });
  assert.deepEqual(o.errors, []);
  assert.deepEqual(o.sets, { sycamore: 200, willow: 200, tuscolo: 400, gouda: 200, union4: 700, kafka: 200 });
  assert.ok(Object.values(o.families).every((f) => f.complete));
  assert.equal(o.kafka.ok, true);
  assert.equal(o.thc.ok, true);
  assert.equal(o.thc.lines, 151);
  assert.equal(o.thc.hits, 150);
  const cell = (r, c) => o.matrix.cells[o.matrix.rows.indexOf(r)][o.matrix.cols.indexOf(c)];
  assert.equal(cell('sycamore', 'thc'), 75);
  assert.equal(cell('sycamore', 'willow'), 50);
  assert.equal(cell('kafka', 'sycamore'), 50);
  assert.equal(cell('union4', 'union4'), 100);
  assert.equal(cell('gouda', 'thc'), 0);
  assert.equal(existsSync(join(data, 'thc', '2026-10-26.txt.gz')), false, "THC's day is not kept");
});

test('tiles window: a failed Kafka read or a missing tile is a field of the overlap, and the rest is still read', async (t) => {
  const w = overlapWorld({ kafka: 'fail', goudaMissing: true });
  const o = await overlap({ from: T0 + 1000_000, to: T0 + 1200_000, day: '2026-10-26', data: tmp(t), thcWaitMs: 0, ...w });
  assert.equal(o.kafka.ok, false);
  assert.match(o.kafka.error, /kafka-window\.mjs exited 1/);
  assert.equal(o.sets.kafka, undefined);
  assert.equal(o.families.gouda.complete, false);
  assert.match(o.logs.gouda2026h2.error, /tile 4 answered 404/);
  assert.equal(o.families.sycamore.complete, true);
  assert.equal(o.thc.ok, true);
  assert.equal(o.errors.length, 2);
});

test('tiles window: a family with no usable shard in the list is not whole, though every shard listed was read', async (t) => {
  const o = await overlap({ from: T0 + 1000_000, to: T0 + 1200_000, day: '2026-10-26', data: tmp(t), thcWaitMs: 0, ...overlapWorld({ unlisted: ['willow'] }) });
  assert.deepEqual(o.families.willow.logs, []);
  assert.equal(o.families.willow.complete, false);
  assert.equal(o.families.sycamore.complete, true);
  assert.ok(o.errors.includes('no usable shard of willow in the list'));
});

test('tiles window: a cut Kafka window is left out of the sets and of the matrix', async (t) => {
  const o = await overlap({ from: T0 + 1000_000, to: T0 + 1200_000, day: '2026-10-26', data: tmp(t), thcWaitMs: 0, ...overlapWorld({ kafka: 'cut' }) });
  assert.equal(o.kafka.cut, true);
  assert.equal(o.sets.kafka, undefined);
  assert.ok(!o.matrix.rows.includes('kafka') && !o.matrix.cols.includes('kafka'), JSON.stringify(o.matrix.rows));
  assert.ok(o.matrix.rows.includes('union4'));
});

test('tiles window: an overlap picked after until writes why it was skipped and passes', async (t) => {
  const out = join(tmp(t), 'overlap.json');
  const code = await main(['--overlap', '--until', '2026-10-29T10:00:00Z', '--out', out], { clock: () => at('2026-10-29T10:00:00Z') });
  assert.equal(code, 0);
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(doc.schema, 'dom-011-overlap/1');
  assert.match(doc.skipped, /has passed/);
  await assert.rejects(main(['--overlap', '--until', 'tomorrow', '--out', out]), /--until needs a UTC instant/);
});

test('tiles window: --log reads a window of the log the list names, and writes its counts', async (t) => {
  const dir = tmp(t);
  mkdirSync(join(dir, 'data'));
  const list = join(dir, 'list.json');
  writeFileSync(list, JSON.stringify(fakeList({ logs: [['Geomys', 'Geomys Tuscolo2027h1', 'usable', 'https://tuscolo.test/']] })));
  const client = createClient({ fetchFn: fakeFetch({ [LOG_LIST_URL]: () => new Response('{}'), 'https://tuscolo.test/': fakeLog({ size: 256 * 4 }) }) });
  const out = join(dir, 'w.json');
  const args = ['--log', 'tuscolo2027h1', '--from', iso(T0 + 100_000), '--to', iso(T0 + 400_000), '--list', list, '--out', out, '--data', join(dir, 'data')];
  assert.equal(await main(args, { client }), 0);
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(doc.schema, 'dom-011-window/1');
  assert.equal(doc.stat.entries, 300);
  assert.equal(doc.stat.complete, true);
  assert.ok(existsSync(join(dir, 'data', 'ct', 'tuscolo2027h1.names.f64')));
  args[1] = 'tuscolo2099h1';
  assert.equal(await main(args, { client }), 1);
  assert.match(JSON.parse(readFileSync(out, 'utf8')).error, /no tiled log is named tuscolo2099h1/);
  // A window read with no error that is not whole (it starts before the
  // served tiles) writes its counts and exits 1.
  const cut = createClient({ fetchFn: fakeFetch({ [LOG_LIST_URL]: () => new Response('{}'), 'https://tuscolo.test/': fakeLog({ size: 256 * 4, firstServed: 2 }) }) });
  args[1] = 'tuscolo2027h1';
  assert.equal(await main(args, { client: cut }), 1);
  const notWhole = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(notWhole.error, undefined);
  assert.equal(notWhole.stat.complete, false);
});

test('tiles window: the Kafka read is kafka-window.mjs of this directory, with the window and the data directory', () => {
  const [cmd, args] = kafkaCommand(at('2026-10-28T12:00:00Z'), at('2026-10-28T12:05:00Z'), '/d');
  assert.equal(cmd, process.execPath);
  assert.ok(existsSync(args[0]) && args[0].endsWith('kafka-window.mjs'));
  assert.deepEqual(args.slice(1), ['2026-10-28T12:00:00.000Z', '2026-10-28T12:05:00.000Z', 'kafka', '--data', '/d']);
});
