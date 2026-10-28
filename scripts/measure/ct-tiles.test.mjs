// The static CT client of DOM-011 (scripts/measure/ct-tiles.mjs): tile paths,
// the checkpoint and names tile parsers on recorded checkpoints and synthetic
// tiles, and the GET with its User-Agent, its 429 rule and its per-host limit,
// over the synthetic hosts of fixtures/tiles/fake-log.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BODY_MAX_BYTES, CtError, createClient, parseCheckpoint, parseNamesTile, partialPath, pickHeaders, retryAfterSeconds, tilePath, tilesOf, USER_AGENT } from './ct-tiles.mjs';
import { fakeFetch, fakeLog } from './fixtures/tiles/fake-log.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tiles');

test('ct tiles: a tile number is written in groups of three, each but the last prefixed x', () => {
  assert.equal(tilePath(0), '000');
  assert.equal(tilePath(91), '091');
  assert.equal(tilePath(1000), 'x001/000');
  assert.equal(tilePath(4074091), 'x004/x074/091');
  // The Geomys tile of DOM-011's premise.
  assert.equal(tilePath(3988266), 'x003/x988/266');
  assert.equal(tilePath(1234567890), 'x001/x234/x567/890');
  assert.equal(partialPath(4088649, 212), 'x004/x088/649.p/212');
  assert.throws(() => tilePath(-1), CtError);
  assert.throws(() => tilePath(1.5), CtError);
  assert.throws(() => partialPath(1, 0), CtError);
  assert.throws(() => partialPath(1, 256), CtError);
  assert.deepEqual(tilesOf(1000), { last: 2, partial: 232 });
  assert.deepEqual(tilesOf(255), { last: -1, partial: 255 });
  assert.deepEqual(tilesOf(512), { last: 1, partial: 0 });
});

test('ct tiles: the recorded checkpoints of three operators parse to their origin and size', () => {
  const want = {
    'checkpoint-sycamore2026h2.txt': 'log.sycamore.ct.letsencrypt.org/2026h2',
    'checkpoint-tuscolo2027h1.txt': 'tuscolo2027h1.sunlight.geomys.org',
    'checkpoint-gouda2026h2.txt': 'gouda2026h2.log.ct.ipng.ch',
  };
  for (const [file, origin] of Object.entries(want)) {
    const c = parseCheckpoint(readFileSync(join(FIX, file), 'utf8'));
    assert.equal(c.origin, origin, file);
    assert.ok(Number.isSafeInteger(c.size) && c.size > 1e8, file);
  }
});

test('ct tiles: a body that is not a checkpoint is refused, never read as a size', () => {
  assert.throws(() => parseCheckpoint('<html>404 Not Found</html>'), /at least three lines/);
  assert.throws(() => parseCheckpoint('origin\n12a\nq4PMvo9y=\n'), /not a decimal number/);
  assert.throws(() => parseCheckpoint('\n12\nq4PMvo9y=\n'), /no origin/);
  assert.throws(() => parseCheckpoint('origin\n12\n\n'), /no base64 root/);
  assert.throws(() => parseCheckpoint('origin\n99999999999999999\nq4PMvo9y=\n'), /not a decimal number|safe integer/);
});

test('ct tiles: a names tile is checked line by line and against its width', () => {
  const tile = [{ Timestamp: 1, DNS: ['a.example'] }, { Timestamp: 2 }].map((x) => JSON.stringify(x)).join('\n');
  assert.deepEqual(parseNamesTile(`${tile}\n`, 2), [
    { ts: 1, dns: ['a.example'] },
    { ts: 2, dns: [] },
  ]);
  assert.throws(() => parseNamesTile(tile, 256), /holds 2 entries, not 256/);
  assert.throws(() => parseNamesTile('{"Timestamp":1}\nnot json'), /line 2 .* not JSON/);
  assert.throws(() => parseNamesTile('{"DNS":["a"]}'), /no numeric Timestamp/);
  assert.throws(() => parseNamesTile('{"Timestamp":1,"DNS":"a"}'), /not an array of strings/);
});

test('ct tiles: every request sends the contact User-Agent and asks for gzip', async () => {
  assert.match(USER_AGENT, /contact: domains@pkgforge\.dev/);
  const fetchFn = fakeFetch({ 'https://log.test/': fakeLog({ size: 300 }) });
  const c = createClient({ fetchFn });
  const o = await c.get('https://log.test/checkpoint');
  assert.equal(o.status, 200);
  assert.match(o.text, /^log\.test\/fake\n300\n/);
  assert.equal(fetchFn.calls[0].headers['user-agent'], USER_AGENT);
  assert.equal(fetchFn.calls[0].headers['accept-encoding'], 'gzip');
});

test('ct tiles: an answer other than 200 keeps its headers, without set-cookie, and the start of its body', async () => {
  const fetchFn = fakeFetch({
    'https://h.test/x': () => new Response('<html>\u0001gone</html>', { status: 404, headers: { server: 'nginx', 'set-cookie': 'a=b' } }),
  });
  const o = await createClient({ fetchFn }).get('https://h.test/x');
  assert.equal(o.status, 404);
  assert.equal(o.text, undefined);
  assert.equal(o.headers.server, 'nginx');
  assert.equal(o.headers['set-cookie'], undefined);
  assert.equal(o.body, '<html> gone</html>');
  assert.deepEqual(pickHeaders(new Headers({ a: 'x'.repeat(300) })).a.length, 203);
});

test('ct tiles: a 429 is retried only when asked, after its Retry-After, and a long Retry-After is not waited for', async () => {
  let n = 0;
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  const fetchFn = fakeFetch({ 'https://g.test/t': () => (++n <= 2 ? new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }) : new Response('ok')) });
  const once = await createClient({ fetchFn, sleep }).get('https://g.test/t');
  assert.equal(once.status, 429, 'a round records the 429');
  assert.equal(once.throttled, 1);
  assert.deepEqual(waits, []);
  const retried = await createClient({ fetchFn, sleep }).get('https://g.test/t', { retry429: 4 });
  assert.equal(retried.status, 200);
  assert.equal(retried.tries, 2);
  assert.deepEqual(waits, [3000]);
  const long = fakeFetch({ 'https://g.test/t': () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }) });
  const gaveUp = await createClient({ fetchFn: long, sleep }).get('https://g.test/t', { retry429: 4 });
  assert.equal(gaveUp.status, 429);
  assert.equal(gaveUp.tries, 1, 'an hour is past the cap: no wait, no retry');
  assert.equal(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT'), null);
});

test('ct tiles: no answer is an observation with an error, never a rejection', async () => {
  const fetchFn = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  };
  const c = createClient({ fetchFn });
  const o = await c.get('https://down.test/checkpoint');
  assert.equal(o.status, null);
  assert.match(o.error, /^ECONNRESET/);
  assert.equal(c.counts.failed, 1);
});

test('ct tiles: a body past maxBytes is cancelled and is an error; a redirect names the host it ended at', async () => {
  assert.equal(BODY_MAX_BYTES, 8 * 1024 * 1024);
  const big = fakeFetch({ 'https://big.test/t': () => new Response('x'.repeat(2048)) });
  const c = createClient({ fetchFn: big, maxBytes: 1024 });
  const o = await c.get('https://big.test/t');
  assert.equal(o.status, null);
  assert.match(o.error, /the body passed 1024 B/);
  assert.equal(c.counts.failed, 1);
  assert.equal((await createClient({ fetchFn: big, maxBytes: 2048 }).get('https://big.test/t')).bytes, 2048, 'exactly the cap is read');
  // A synthetic answer in the shape fetch gives after following a redirect.
  const moved = async () => ({ status: 200, redirected: true, url: 'https://cdn.example.test/tile/names/000', headers: new Headers(), body: new Response('ok').body });
  const r = await createClient({ fetchFn: moved }).get('https://log.test/tile/names/000');
  assert.equal(r.status, 200);
  assert.equal(r.redirected_to, 'cdn.example.test');
  assert.equal((await createClient({ fetchFn: fakeFetch({ 'https://log.test/': fakeLog({ size: 300 }) }) }).get('https://log.test/checkpoint')).redirected_to, undefined);
});

test('ct tiles: at most perHost requests to one host are in flight', async () => {
  let active = 0;
  let peak = 0;
  const fetchFn = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return new Response('ok');
  };
  const c = createClient({ fetchFn, perHost: 2 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => c.get(`https://one.test/${i}`)));
  assert.equal(peak, 2);
});
