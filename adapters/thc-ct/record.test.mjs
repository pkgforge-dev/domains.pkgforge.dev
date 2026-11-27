// adapters/thc-ct/record.mjs against a double of THC's two hosts on
// 127.0.0.1 (node:http), read with the production default, the global fetch.
// The test passes the hosts and a clock, so it reaches no network and reads
// no wall clock. Every byte here is synthetic.
//
//   node scripts/test.mjs adapters/thc-ct --name "thc-ct record"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readRecordings } from '@domains/adapter/node';
import { EXIT, main, RECORDED_DIR, SYNTHETIC_TAIL } from './record.mjs';

const NOW_MS = Date.parse('2026-11-02T04:30:00Z');
const DAY = '2026-10-31';
const ABSENT = '2026-11-02';
const LM = 'Sun, 01 Nov 2026 00:05:02 GMT';

// 3,000 lines: a name a line, with an upper-case line, a `*.` line, an xn--
// line and an address literal in lines 10 to 59.
function fileLines() {
  const out = [];
  for (let i = 1; i <= 3000; i++) out.push(i % 2 === 0 ? `*.host${i}.example.com` : `host${i}.example.com`);
  out[19] = 'Upper20.Example.com';
  out[29] = 'shop.xn--bcher-kva.example';
  out[39] = '192.0.2.40';
  return out;
}

const FILE = gzipSync(Buffer.from(`${fileLines().join('\n')}\n`), { level: 9 });

// The double: cs2's index, its HEADs and Range GET, and the bucket's listing.
async function withHosts(options, fn) {
  const o = { listingAbsent: false, indexBytes: FILE.length, link: null, absentHead: 404, ranges: true, ...options };
  const seen = [];
  const server = createServer((req, res) => {
    seen.push([req.method, req.url, req.headers['user-agent'], req.headers.range ?? null]);
    if (req.method === 'HEAD' && req.url === `/${ABSENT}.txt.gz` && o.absentHead !== 404) {
      res.writeHead(o.absentHead, { 'content-length': '5' });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === `/${DAY}.txt.gz` && !o.ranges) {
      // A host that ignores Range sends the whole file.
      res.writeHead(200, { 'content-length': String(FILE.length) });
      res.end(FILE);
      return;
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        [
          '<html><body><pre><a href="../">../</a>',
          `<a href="2026-10-30.txt.gz">2026-10-30.txt.gz</a>                                  31-Oct-2026 00:05           123`,
          `<a href="${DAY}.txt.gz">${DAY}.txt.gz</a>                                  01-Nov-2026 00:05           ${o.indexBytes}`,
          '</pre></body></html>',
        ].join('\n'),
      );
      return;
    }
    if (req.url === `/${DAY}.txt.gz`) {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(FILE.length), 'last-modified': LM, etag: '"double"', 'accept-ranges': 'bytes', 'set-cookie': 'id=1' });
        res.end();
        return;
      }
      const m = /^bytes=0-(\d+)$/.exec(req.headers.range ?? '');
      if (m === null) {
        res.writeHead(400);
        res.end();
        return;
      }
      const end = Math.min(Number(m[1]), FILE.length - 1);
      res.writeHead(206, { 'content-range': `bytes 0-${end}/${FILE.length}`, 'content-length': String(end + 1) });
      res.end(FILE.subarray(0, end + 1));
      return;
    }
    if (req.url === '/api/buckets/x/tree?recursive=true') {
      const entries = [
        {
          type: 'file',
          path: '2026/10/2026-10-30.txt.gz',
          size: 123,
          xetHash: 'a'.repeat(64),
          mtime: '2026-10-31T00:05:10.000Z',
          mtimeNanos: 0,
          uploadedAt: '2026-10-31T00:05:30.000Z',
          contentType: 'text/plain',
        },
        {
          type: 'file',
          path: `2026/11/${DAY}.txt.gz`,
          size: FILE.length,
          xetHash: 'b'.repeat(64),
          mtime: '2026-11-01T00:05:02.000Z',
          mtimeNanos: 0,
          uploadedAt: '2026-11-01T00:05:19.498Z',
          contentType: 'text/plain',
        },
      ];
      if (o.listingAbsent) entries.push({ ...entries[0], path: `2026/11/${ABSENT}.txt.gz` });
      res.writeHead(200, { 'content-type': 'application/json', ...(o.link === null ? {} : { link: o.link }) });
      res.end(JSON.stringify(entries));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html>404</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const hosts = ['--cs2', `${base}/`, '--listing', `${base}/api/buckets/x/tree?recursive=true`, '--resolve', `${base}/buckets/x/resolve/`];
  try {
    return await fn(hosts, seen, base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function record(argv) {
  const out = [];
  const err = [];
  const code = await main(argv, { now: () => NOW_MS, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

const tmp = () => join(mkdtempSync(join(tmpdir(), 'thc-ct-record-')), 'fixtures');
const ARGS = ['--day', DAY, '--from-line', '10', '--lines', '50', '--head-bytes', '4096'];

test('thc-ct record: the recorder writes the recorded answers as given, the slice with its synthetic tail, and synthetic answers that replay', () =>
  withHosts({}, async (hosts, seen, base) => {
    const dir = tmp();
    try {
      const r = await record(['--out', dir, ...ARGS, ...hosts]);
      assert.equal(r.code, EXIT.ok, r.text);
      assert.match(r.text, /^slice 2026-10-31 lines 10-59 bytes \d+-\d+$/m);
      // Every request sent the contact User-Agent; the head is the one Range read.
      assert.ok(seen.every((s) => /contact: domains@pkgforge\.dev/.test(s[2])));
      assert.deepEqual(
        seen.filter((s) => s[3] !== null).map((s) => [s[0], s[1], s[3]]),
        [['GET', `/${DAY}.txt.gz`, 'bytes=0-4095']],
      );
      // The recorded answers: origin recorded, the absent day a 404, no cookie kept.
      const recorded = readRecordings(join(dir, RECORDED_DIR));
      assert.deepEqual(recorded.map((x) => [x.name, x.origin, x.response.status]).sort(), [
        ['cs2-head-20261031.http.json', 'recorded', 200],
        ['cs2-head-20261102.http.json', 'recorded', 404],
        ['cs2-index.http.json', 'recorded', 200],
        ['hf-listing.http.json', 'recorded', 200],
      ]);
      const head = recorded.find((x) => x.name === 'cs2-head-20261031.http.json');
      assert.equal(head.response.headers['content-length'], String(FILE.length));
      assert.equal(head.response.headers['set-cookie'], undefined);
      assert.equal(head.recordedAt, '2026-11-02T04:30:00Z');
      // The slice: the real lines 10 to 59, then the twin, co.uk, bücher.example and a blank line.
      const slice = readFileSync(join(dir, `slice-${DAY}.txt`), 'utf8');
      const lines = slice.split('\n');
      assert.deepEqual(lines.slice(0, 50), fileLines().slice(9, 59));
      assert.deepEqual(lines.slice(50), ['upper20.example.com', ...SYNTHETIC_TAIL, '', '']);
      // The synthetic answers: every size the slice's gzip, which gunzips to the slice.
      const synth = readRecordings(dir);
      assert.deepEqual(synth.map((x) => [x.name, x.origin]).sort(), [
        ['cs2-get-20261031.http.json', 'synthetic'],
        ['cs2-head-20261031.http.json', 'synthetic'],
        ['hf-cdn-20261031.http.json', 'synthetic'],
        ['hf-listing.http.json', 'synthetic'],
        ['hf-resolve-20261031.http.json', 'synthetic'],
      ]);
      const get = synth.find((x) => x.name === 'cs2-get-20261031.http.json');
      assert.equal(gunzipSync(get.response.body).toString('utf8'), slice);
      assert.equal(get.response.headers['content-length'], String(get.response.body.length));
      assert.equal(synth.find((x) => x.name === 'cs2-head-20261031.http.json').response.headers['content-length'], String(get.response.body.length));
      const listing = JSON.parse(new TextDecoder().decode(synth.find((x) => x.name === 'hf-listing.http.json').response.body));
      assert.deepEqual(
        listing.map((e) => [e.path, e.size, e.xetHash]),
        [[`2026/11/${DAY}.txt.gz`, get.response.body.length, createHash('sha256').update(get.response.body).digest('hex')]],
      );
      assert.equal(synth.find((x) => x.name === 'hf-resolve-20261031.http.json').request.url, `${base}/buckets/x/resolve/2026/11/${DAY}.txt.gz?download=true`);
      const meta = JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf8'));
      assert.deepEqual([meta.day, meta.absent, meta.file.bytes, meta.file.listing_path, meta.slice.from_line, meta.slice.lines], [DAY, ABSENT, FILE.length, `2026/11/${DAY}.txt.gz`, 10, 50]);
      assert.deepEqual([meta.listing.days, meta.index.days], [2, 2]);
      assert.equal(meta.slice.gzip_sha256, createHash('sha256').update(get.response.body).digest('hex'));
      for (const [name, sha] of Object.entries(meta.files))
        assert.equal(
          createHash('sha256')
            .update(readFileSync(join(dir, name)))
            .digest('hex'),
          sha,
          name,
        );
      // A recording is written once: the second run refuses before it reads a host.
      const before = seen.length;
      const again = await record(['--out', dir, ...ARGS, ...hosts]);
      assert.equal(again.code, EXIT.usage, again.text);
      assert.match(again.text, /exists: delete it first to record again/);
      assert.equal(seen.length, before);
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  }));

test('thc-ct record: hosts that disagree on the size, an absent day already listed, a listing of two pages, an absent day cs2 answers, a host that ignores Range, or a slice without an address literal write nothing', async () => {
  // Lines 45 to 54 hold the `*.` lines and none of the other three kinds.
  const late = ['--day', DAY, '--from-line', '45', '--lines', '10', '--head-bytes', '4096'];
  for (const [options, args, why] of [
    [{ indexBytes: 7 }, ARGS, /cs2's HEAD says \d+ B, its index 7, the listing \d+: the hosts do not agree on one file/],
    [{ listingAbsent: true }, ARGS, /2026-11-02 is listed already/],
    [{ link: '<http://127.0.0.1/next>; rel="next"' }, ARGS, /has a next page/],
    [{ absentHead: 200 }, ARGS, /HEAD http:\/\/127\.0\.0\.1:\d+\/2026-11-02\.txt\.gz answered 200, not 404/],
    [{ ranges: false }, ARGS, /with Range bytes=0-4095 answered 200, Content-Range null, \d+ B: not the head of the \d+ B file/],
    [{}, late, /hold no line of: upper, xn, literal/],
  ]) {
    await withHosts(options, async (hosts) => {
      const dir = tmp();
      try {
        const r = await record(['--out', dir, ...args, ...hosts]);
        assert.equal(r.code, EXIT.fault, `${JSON.stringify(options)}: ${r.text}`);
        assert.match(r.text, why);
        assert.equal(existsSync(dir), false, 'nothing is written');
      } finally {
        rmSync(join(dir, '..'), { recursive: true, force: true });
      }
    });
  }
});

test('thc-ct record: bad arguments are exit 2 before any host is read', async () => {
  for (const [argv, why] of [
    [[], /--out is needed/],
    [['--out', 'x', '--day', '2026-02-30'], /--day "2026-02-30" is not a calendar day/],
    [['--out', 'x', '--day', '2026-10-31', '--absent', '2026-10-31'], /--absent 2026-10-31 is not after --day 2026-10-31/],
    [['--out', 'x', '--lines', '0'], /--lines "0" is not a whole number from 1/],
    [['--out', 'x', '--head-bytes', '10'], /--head-bytes "10" is not a whole number from 1024/],
    [['--out', 'x', '--cs2', 'http://127.0.0.1/'], /--cs2, --listing and --resolve come together/],
    [['--out', 'x', '--nope', '1'], /unknown flag --nope/],
    [['--out', 'x', '--day', '2026-10-31', '--day', '2026-10-30'], /--day is given twice/],
    [['--out', 'x', 'extra'], /"extra" is not a flag/],
  ]) {
    const r = await record(argv);
    assert.equal(r.code, EXIT.usage, `${argv.join(' ')}: ${r.text}`);
    assert.match(r.text, why, argv.join(' '));
  }
});
