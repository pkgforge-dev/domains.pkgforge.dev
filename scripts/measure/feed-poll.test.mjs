import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import {
  commentLines,
  dosTime,
  ISC_LAGS,
  iscPresent,
  iscUrl,
  main,
  makeRunner,
  observeCommit,
  observeHead,
  observeRolling,
  observeZip,
  PREFIX_BYTES,
  pollOnce,
  ROLLING,
  runPolls,
  SCHEMA,
  USER_AGENT,
  utcDate,
  WHOISDS_LAGS,
  whoisdsPresent,
  whoisdsUrl,
  zipEntries,
} from './feed-poll.mjs';

const T0 = Date.parse('2026-10-28T10:30:00Z');

// A stored (uncompressed) zip with the given entries, in the layout WhoisDS
// serves: local headers and data, the central directory, the end record.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.time, 10);
    local.writeUInt16LE(f.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(f.time, 12);
    central.writeUInt16LE(f.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// 2026-10-26 16:52:00 and 2026-10-25 19:29:00 as MS-DOS date and time.
const DOS_1026 = { date: (46 << 9) | (10 << 5) | 26, time: (16 << 11) | (52 << 5) };
const DOS_1025 = { date: (46 << 9) | (10 << 5) | 25, time: (19 << 11) | (29 << 5) };

const streamOf = (buf, size) =>
  new ReadableStream({
    start(c) {
      for (let i = 0; i < buf.length; i += size) c.enqueue(new Uint8Array(buf.subarray(i, i + size)));
      c.close();
    },
  });

const HAGEZI_HEAD = '# Title: Newly Registered Domains (NRD)\n# Expires: 8 hours\n# Last modified: 28 Oct 2026 07:04 UTC\n# Number of entries: 2897068\n#\n0-0c.com\n0-10.xyz\n';

test('feed poll: the dated URLs are the ones the sources serve', () => {
  assert.equal(iscUrl(null), 'https://isc.sans.edu/feeds/domaindata.json.gz');
  assert.equal(iscUrl('2026-10-26'), 'https://isc.sans.edu/feeds/domaindata.2026-10-26.json.gz');
  assert.equal(whoisdsUrl('2026-10-27'), 'https://www.whoisds.com/whois-database/newly-registered-domains/MjAyNi0xMC0yNy56aXA=/nrd');
});

test('feed poll: a lag counts whole UTC days back from the instant', () => {
  const justAfterMidnight = Date.parse('2026-10-28T00:05:00Z');
  assert.equal(utcDate(justAfterMidnight), '2026-10-28');
  assert.equal(utcDate(justAfterMidnight, 1), '2026-10-27');
  assert.equal(utcDate(justAfterMidnight, 5), '2026-10-23');
  assert.deepEqual(ISC_LAGS, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(WHOISDS_LAGS, [0, 1, 2]);
});

test('feed poll: every request names the project and its contact address', () => {
  assert.match(USER_AGENT, /^domains\.pkgforge\.dev\/1\.0 /);
  assert.match(USER_AGENT, /contact: domains@pkgforge\.dev/);
});

test('feed poll: an empty ISC array and an empty WhoisDS page are not a publication', () => {
  assert.equal(iscPresent({ status: 200, length: 55 }), false);
  assert.equal(iscPresent({ status: 200, length: 3025169 }), true);
  assert.equal(iscPresent({ status: 404, length: 3025169 }), false);
  assert.equal(iscPresent({ status: 200, length: null }), false);
  assert.equal(whoisdsPresent({ status: 200, length: 0, type: 'text/html; charset=UTF-8' }), false);
  assert.equal(whoisdsPresent({ status: 200, length: 566869, type: 'application/octet-stream' }), true);
  assert.equal(whoisdsPresent({ status: 200, length: null, type: 'application/octet-stream' }), true);
  assert.equal(whoisdsPresent({ status: 200, length: null, type: 'text/html' }), false);
});

test('feed poll: the comment block ends at the first name', () => {
  assert.deepEqual(commentLines(HAGEZI_HEAD), ['# Title: Newly Registered Domains (NRD)', '# Expires: 8 hours', '# Last modified: 28 Oct 2026 07:04 UTC', '# Number of entries: 2897068', '#']);
  assert.deepEqual(commentLines('# Last update: 27 Oct 2026 13:00:21 UTC\r\n# Domains: 699,953\r\n0-0.bio\n'), ['# Last update: 27 Oct 2026 13:00:21 UTC', '# Domains: 699,953']);
  assert.deepEqual(commentLines('example.com\n# not a header\n'), []);
});

test('feed poll: zip entries are read from the central directory, also from a tail', () => {
  const zip = makeZip([
    { name: 'domain-names.txt', data: 'a.com\nb.net\n', ...DOS_1026 },
    { name: 'readme.txt', data: 'x', ...DOS_1025 },
  ]);
  const whole = zipEntries(zip, zip.length);
  assert.equal(whole.count, 2);
  assert.deepEqual(whole.entries[0], { name: 'domain-names.txt', crc32: crc32(Buffer.from('a.com\nb.net\n')).toString(16).padStart(8, '0'), size: 12, csize: 12, mtime: '2026-10-26T16:52:00' });
  assert.equal(whole.entries[1].mtime, '2026-10-25T19:29:00');
  // The directory (two 46 B headers and their names, 118 B) and the end record (22 B).
  const tail = zip.subarray(zip.length - 140);
  assert.deepEqual(zipEntries(tail, zip.length), whole);
  assert.equal(dosTime(DOS_1026.date, DOS_1026.time), '2026-10-26T16:52:00');
});

test('feed poll: a body that is not a zip, or a directory outside the tail, is refused', () => {
  assert.throws(() => zipEntries(Buffer.from('<html></html>'.repeat(4)), 52), /no end of central directory/);
  const zip = makeZip([{ name: 'domain-names.txt', data: 'a.com\n', ...DOS_1026 }]);
  assert.throws(() => zipEntries(zip.subarray(zip.length - 30), zip.length), /outside the bytes read/);
});

test('feed poll: the zip read hashes the whole body and parses its tail', async () => {
  const zip = makeZip([{ name: 'domain-names.txt', data: 'x.com\n'.repeat(20000), ...DOS_1026 }]);
  const fetchFn = async () => new Response(streamOf(zip, 7000), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  const o = await observeZip('https://example.invalid/z', fetchFn, () => T0);
  assert.equal(o.error, undefined);
  assert.equal(o.bytes, zip.length);
  assert.equal(o.sha256, createHash('sha256').update(zip).digest('hex'));
  assert.equal(o.entry_count, 1);
  assert.equal(o.entries[0].size, 120000);
  const html = await observeZip(
    'https://example.invalid/z',
    async () => new Response('<html>no list</html>', { status: 200 }),
    () => T0,
  );
  assert.match(html.error, /^not a zip: /);
});

test('feed poll: the production fetch sends the headers and reads 206 and 304', async (t) => {
  const seen = [];
  const body = Buffer.from(`${HAGEZI_HEAD}${'z.com\n'.repeat(2000)}`);
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url === '/isc') {
      res.writeHead(200, { 'content-length': '3025169', etag: '"2e2911-65ee353c9f8e6"', 'last-modified': 'Wed, 28 Oct 2026 09:38:36 GMT', 'content-type': 'application/x-gzip' });
      res.end();
    } else if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { etag: '"v1"' });
      res.end();
    } else {
      res.writeHead(206, { etag: '"v1"', 'content-range': `bytes 0-${PREFIX_BYTES - 1}/${body.length}`, 'content-length': String(PREFIX_BYTES) });
      res.end(body.subarray(0, PREFIX_BYTES));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const head = await observeHead(`${base}/isc`);
  assert.equal(head.status, 200);
  assert.equal(head.length, 3025169);
  assert.equal(head.etag, '"2e2911-65ee353c9f8e6"');
  assert.equal(head.last_modified, 'Wed, 28 Oct 2026 09:38:36 GMT');

  const first = await observeRolling(`${base}/list`, null);
  assert.equal(first.status, 206);
  assert.equal(first.etag, '"v1"');
  assert.equal(first.total, body.length);
  assert.ok(first.header.includes('# Last modified: 28 Oct 2026 07:04 UTC'));
  const again = await observeRolling(`${base}/list`, first.etag);
  assert.equal(again.status, 304);
  assert.equal(again.etag, '"v1"');
  assert.equal(again.header, undefined);

  assert.equal(seen[0].method, 'HEAD');
  for (const s of seen) {
    assert.equal(s.headers['user-agent'], USER_AGENT);
    assert.equal(s.headers['accept-encoding'], 'identity');
  }
  assert.equal(seen[1].headers.range, `bytes=0-${PREFIX_BYTES - 1}`);
  assert.equal(seen[1].headers['if-none-match'], undefined);
  assert.equal(seen[2].headers['if-none-match'], '"v1"');
});

test('feed poll: a failed request is a field of the poll, never a throw', async () => {
  const reset = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  };
  const timeout = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  assert.match((await observeHead('https://example.invalid/', reset)).error, /^ECONNRESET: fetch failed$/);
  assert.equal((await observeRolling('https://example.invalid/', null, timeout)).error, 'timeout');
  assert.equal((await observeZip('https://example.invalid/', timeout)).error, 'timeout');
});

test('feed poll: the commit query is scoped to the file and checked', async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    return JSON.stringify([{ sha: 'b1b14d0f2370aa', commit: { committer: { date: '2026-10-28T07:33:31Z' }, author: { date: '2026-10-28T07:33:31Z' }, message: 'release\n\nbody' } }]);
  };
  const o = await observeCommit('hagezi/nrd', 'domains/nrd7.txt', runGh, () => T0);
  assert.deepEqual(calls[0], ['api', 'repos/hagezi/nrd/commits?path=domains%2Fnrd7.txt&per_page=1']);
  assert.equal(o.sha, 'b1b14d0f2370aa');
  assert.equal(o.committed, '2026-10-28T07:33:31Z');
  assert.equal(o.message, 'release');
  assert.match(
    (
      await observeCommit(
        'cenk/nrd',
        'x.txt',
        async () => '[]',
        () => T0,
      )
    ).error,
    /no commit touches the path/,
  );
  assert.match(
    (
      await observeCommit(
        'cenk/nrd',
        'x.txt',
        async () => '[{"sha":"a"}]',
        () => T0,
      )
    ).error,
    /without sha or committer date/,
  );
});

test('feed poll: makeRunner returns stdout and rejects with the exit code', async () => {
  const node = makeRunner(process.execPath);
  assert.equal(await node(['-e', 'process.stdout.write("[1]")']), '[1]');
  await assert.rejects(node(['-e', 'process.stderr.write("nope"); process.exit(3)']), /exited 3: nope/);
});

// A fake web of the four feeds at one instant. `zipReads` counts zip GETs.
function fakeFeeds(now) {
  const today = utcDate(now());
  const yesterday = utcDate(now(), 1);
  const zip = makeZip([{ name: 'domain-names.txt', data: 'a.com\n', ...DOS_1026 }]);
  const log = { zipReads: 0, rolling: [] };
  const fetchFn = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('https://isc.sans.edu/')) {
      const big = !url.includes(`.${today}.`);
      return new Response(null, { status: 200, headers: { 'content-length': big ? '3025169' : '55', etag: '"e"', 'last-modified': 'Wed, 28 Oct 2026 09:38:36 GMT' } });
    }
    if (url.startsWith('https://www.whoisds.com/')) {
      const present = url === whoisdsUrl(yesterday);
      if (method === 'HEAD')
        return new Response(null, {
          status: 200,
          headers: present ? { 'content-length': String(zip.length), 'content-type': 'application/octet-stream' } : { 'content-length': '0', 'content-type': 'text/html' },
        });
      log.zipReads += 1;
      return new Response(zip, { status: 200 });
    }
    log.rolling.push({ url, inm: init.headers['if-none-match'] });
    if (init.headers['if-none-match'] === '"r1"') return new Response(null, { status: 304, headers: { etag: '"r1"' } });
    return new Response(HAGEZI_HEAD, { status: 206, headers: { etag: '"r1"', 'content-range': 'bytes 0-4095/49737362' } });
  };
  const runGh = async (args) => JSON.stringify([{ sha: `sha-${args[1].split('/')[2]}`, commit: { committer: { date: '2026-10-28T07:33:31Z' }, message: 'release' } }]);
  return { fetchFn, runGh, log, today, yesterday };
}

test('feed poll: one poll sends every request and the next one is conditional', async () => {
  let now = T0;
  const clock = () => now;
  const { fetchFn, runGh, log, today, yesterday } = fakeFeeds(clock);
  const state = { etags: {}, whoisds: {} };

  const p1 = await pollOnce(state, { fetchFn, runGh, clock });
  assert.deepEqual(Object.keys(p1.isc).sort(), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', 'latest']);
  assert.equal(p1.isc[today].length, 55);
  assert.deepEqual(Object.keys(p1.whoisds).sort(), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.equal(p1.whoisds[today].zip, undefined);
  assert.equal(p1.whoisds[yesterday].zip.entries[0].mtime, '2026-10-26T16:52:00');
  assert.equal(p1.hagezi.file.status, 206);
  assert.equal(p1.hagezi.commit.sha, 'sha-nrd');
  assert.equal(p1.requests, 8 + 3 + 1 + 4);
  assert.equal(p1.failed, 0);

  now += 10 * 60_000;
  const p2 = await pollOnce(state, { fetchFn, runGh, clock });
  assert.equal(p2.cenk.file.status, 304);
  assert.equal(p2.cenk.file.etag, '"r1"');
  assert.equal(p2.whoisds[yesterday].zip, undefined, 'the same answer within the hour reads no zip');
  assert.deepEqual(
    log.rolling.map((r) => r.inm),
    [undefined, undefined, '"r1"', '"r1"'],
  );

  now += 61 * 60_000;
  const p3 = await pollOnce(state, { fetchFn, runGh, clock });
  assert.ok(p3.whoisds[yesterday].zip, 'an hour after the last read the zip is read again');
  assert.equal(log.zipReads, 2);
  assert.deepEqual(Object.keys(ROLLING), ['cenk', 'hagezi']);
});

test('feed poll: the loop runs each slot from the start and appends a line per poll', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-poll-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'sub', 'polls.jsonl');
  let now = T0;
  const clock = () => now;
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
    now += ms;
  };
  const { fetchFn, runGh } = fakeFeeds(clock);
  const r = await runPolls({ out, polls: 3, intervalMs: 600_000, start: T0, fetchFn, runGh, clock, sleep, env: { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' }, log: () => {} });
  assert.deepEqual(r, { ran: 3, skipped: 0, silent: 0 });
  assert.deepEqual(sleeps, [600_000, 600_000]);
  const lines = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['start', 'poll', 'poll', 'poll', 'end'],
  );
  assert.ok(lines.every((l) => l.schema === SCHEMA && l.run_id === '42'));
  assert.deepEqual(
    lines.filter((l) => l.kind === 'poll').map((l) => [l.poll, l.slot, l.late_ms]),
    [
      [0, '2026-10-28T10:30:00.000Z', 0],
      [1, '2026-10-28T10:40:00.000Z', 0],
      [2, '2026-10-28T10:50:00.000Z', 0],
    ],
  );
  assert.equal(lines[0].user_agent, USER_AGENT);
});

test('feed poll: a slot that the next slot has passed is skipped, never sent back to back', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-poll-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = T0;
  const clock = () => now;
  const sleep = async (ms) => {
    now += ms;
  };
  const { fetchFn, runGh } = fakeFeeds(clock);
  const out = join(dir, 'polls.jsonl');
  const r = await runPolls({ out, polls: 4, intervalMs: 600_000, start: T0 - 25 * 60_000, fetchFn, runGh, clock, sleep, env: {}, log: () => {} });
  assert.deepEqual(r, { ran: 2, skipped: 2, silent: 0 });
  const polls = readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((l) => l.kind === 'poll');
  assert.deepEqual(
    polls.map((l) => [l.poll, l.late_ms]),
    [
      [2, 5 * 60_000],
      [3, 0],
    ],
  );
});

test('feed poll: a poll with no answer at all makes the exit 1, a bad argument 2', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-poll-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const down = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ENETUNREACH' } });
  };
  const ghDown = async () => {
    throw new Error('gh exited 1');
  };
  const quiet = { log: () => {}, sleep: async () => {} };
  const code = await main(['--out', join(dir, 'p.jsonl'), '--polls', '1'], { fetchFn: down, runGh: ghDown, ...quiet });
  assert.equal(code, 1);
  const line = readFileSync(join(dir, 'p.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)[1];
  assert.equal(line.failed, line.requests);
  assert.equal(await main(['--polls', '3']), 2);
  assert.equal(await main(['--out', join(dir, 'q.jsonl'), '--start', 'not a date']), 2);
});

test('feed poll: a WhoisDS answer other than 200 is no publication, whatever its body', () => {
  for (const status of [404, 429, 500, 503]) {
    assert.equal(whoisdsPresent({ status, length: 1234, type: 'text/html' }), false, String(status));
    assert.equal(whoisdsPresent({ status, length: 566869, type: 'application/octet-stream' }), false, String(status));
  }
});

test('feed poll: a WhoisDS path whose answer changes inside the hour has its zip read again', async () => {
  let now = T0;
  const clock = () => now;
  const base = fakeFeeds(clock);
  let bump = 0;
  const fetchFn = async (url, init) => {
    const r = await base.fetchFn(url, init);
    if ((init?.method ?? 'GET') === 'HEAD' && url === whoisdsUrl(base.yesterday) && bump > 0)
      return new Response(null, { status: 200, headers: { 'content-length': String(Number(r.headers.get('content-length')) + bump), 'content-type': 'application/octet-stream' } });
    return r;
  };
  const state = { etags: {}, whoisds: {} };
  await pollOnce(state, { fetchFn, runGh: base.runGh, clock });
  assert.equal(base.log.zipReads, 1);
  now += 10 * 60_000;
  await pollOnce(state, { fetchFn, runGh: base.runGh, clock });
  assert.equal(base.log.zipReads, 1, 'the same answer inside the hour reads no zip');
  bump = 7;
  now += 10 * 60_000;
  const p = await pollOnce(state, { fetchFn, runGh: base.runGh, clock });
  assert.equal(base.log.zipReads, 2, 'a changed answer is read at once');
  assert.ok(p.whoisds[base.yesterday].zip);
});

test('feed poll: a 304 with no ETag keeps the one it asked with, and a server that ignores Range is read no further than the prefix', async () => {
  const notModified = async () => new Response(null, { status: 304 });
  const kept = await observeRolling(ROLLING.cenk.url, '"r9"', notModified, () => T0);
  assert.equal(kept.status, 304);
  assert.equal(kept.etag, '"r9"');
  // A 200 with the whole 1 MiB file, in 1 KiB chunks: only the prefix is pulled.
  let pulled = 0;
  const chunk = Buffer.alloc(1024, 0x61);
  const head = Buffer.from('# Last modified: 28 Oct 2026 07:04 UTC\n# Number of entries: 2897068\n');
  const whole = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (pulled >= 1024 * 1024) return controller.close();
          const c = pulled === 0 ? Buffer.concat([head, chunk.subarray(head.length)]) : chunk;
          pulled += c.length;
          controller.enqueue(new Uint8Array(c));
        },
      }),
      { status: 200, headers: { etag: '"w"', 'content-length': String(1024 * 1024) } },
    );
  const r = await observeRolling(ROLLING.hagezi.url, null, whole, () => T0);
  assert.equal(r.status, 200);
  assert.equal(r.total, 1024 * 1024);
  assert.deepEqual(r.header, ['# Last modified: 28 Oct 2026 07:04 UTC', '# Number of entries: 2897068']);
  assert.ok(pulled <= PREFIX_BYTES + 2 * 1024, `pulled ${pulled} bytes of a 1 MiB body`);
});

test('feed poll: one failed request of a poll is recorded and the exit is still 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-poll-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = () => Date.now();
  const base = fakeFeeds(clock);
  const fetchFn = async (url, init) => {
    if (url === iscUrl(null)) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return base.fetchFn(url, init);
  };
  const out = join(dir, 'p.jsonl');
  const code = await main(['--out', out, '--polls', '1'], { fetchFn, runGh: base.runGh, log: () => {}, sleep: async () => {} });
  assert.equal(code, 0);
  const poll = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse)[1];
  assert.equal(poll.failed, 1);
  assert.ok(poll.requests > 1);
  assert.match(poll.isc.latest.error, /ECONNRESET/);
});
