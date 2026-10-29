// scripts/ref/fetch-psl.mjs, offline: a server on 127.0.0.1 serves the pinned
// list (packages/names/test/fixtures/psl-2026-10-27.dat) and planted faults of
// it. Each refusal is planted alone: a list cut short, a list of too few rules,
// a list with an empty private section, a 404, a redirect to the good list, a
// body over the cap, a body that breaks off, a refused connection, and an --out
// path that cannot be written.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { USER_AGENT as FEED_POLL_USER_AGENT } from '../measure/feed-poll.mjs';
import { checkList, DEFAULT_URL, download, MAX_BYTES, MIN_RULES, TIMEOUT_MS, USER_AGENT } from './fetch-psl.mjs';

const SCRIPT = fileURLToPath(new URL('./fetch-psl.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../packages/names/test/fixtures/psl-2026-10-27.dat', import.meta.url));
const LIST = readFileSync(FIXTURE);
const TEXT = LIST.toString('utf8');
const SHA256 = createHash('sha256').update(LIST).digest('hex');
const MARKS = ['// ===BEGIN ICANN DOMAINS===', '// ===END ICANN DOMAINS===', '// ===BEGIN PRIVATE DOMAINS===', '// ===END PRIVATE DOMAINS==='];

// Synthetic, not recorded: every marker, three rules.
const FEW = `${MARKS[0]}\ncom\nnp\n*.np\n${MARKS[1]}\n${MARKS[2]}\ngithub.io\n${MARKS[3]}\n`;
// The pinned list with the rules of its private section removed, markers kept.
const NO_PRIVATE = TEXT.slice(0, TEXT.indexOf(MARKS[2]) + MARKS[2].length) + '\n' + TEXT.slice(TEXT.indexOf(MARKS[3]));
// The same with the rules of its ICANN section removed.
const NO_ICANN = TEXT.slice(0, TEXT.indexOf(MARKS[0]) + MARKS[0].length) + '\n' + TEXT.slice(TEXT.indexOf(MARKS[1]));

const seen = [];
let server;
let base;
const dirs = [];

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const send = (status, body) => {
      res.writeHead(status, { 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
    };
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/list', 'content-length': '0' });
      res.end();
    } else if (req.url === '/list') send(200, LIST);
    else if (req.url === '/cut') send(200, TEXT.slice(0, TEXT.indexOf(MARKS[2])));
    else if (req.url === '/few') send(200, FEW);
    else if (req.url === '/no-private') send(200, NO_PRIVATE);
    else if (req.url === '/no-icann') send(200, NO_ICANN);
    else if (req.url === '/big') send(200, Buffer.alloc(MAX_BYTES + 1, 0x61));
    else if (req.url === '/exact') send(200, Buffer.alloc(MAX_BYTES, 0x61));
    else if (req.url === '/broken') {
      res.writeHead(200, { 'content-length': String(LIST.length) });
      res.write(LIST.subarray(0, 1000));
      setTimeout(() => res.socket.destroy(), 50);
    } else send(404, 'no such file');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// The script as a child process, awaited: the server answers from this process,
// so a synchronous spawn would never get an answer.
function run(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-psl-'));
  dirs.push(dir);
  return dir;
};

test('fetch-psl: the default source, the rule floor and the contact User-Agent of ruling 11', () => {
  assert.equal(DEFAULT_URL, 'https://publicsuffix.org/list/public_suffix_list.dat');
  assert.equal(MIN_RULES, 9000);
  assert.equal(USER_AGENT, FEED_POLL_USER_AGENT);
  assert.match(USER_AGENT, /contact: domains@pkgforge\.dev/);
});

test('fetch-psl: prints the sha256 and rule count of the pinned list, writes it with --out, and sends the User-Agent', async () => {
  const out = join(scratch(), 'psl.dat');
  seen.length = 0;
  const r = await run('--url', `${base}/list`, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `sha256 ${SHA256} rules 10397\n`);
  assert.deepEqual(readFileSync(out), LIST);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers['user-agent'], USER_AGENT);
  assert.equal(seen[0].headers['accept-encoding'], 'identity');
});

test('fetch-psl: a list that fails a check exits 1 and writes nothing', async () => {
  for (const [path, message] of [
    ['/cut', /missing marker \/\/ ===BEGIN PRIVATE DOMAINS===/],
    ['/few', /4 rules, not more than 9000/],
    ['/no-private', /a section holds no rule: icann 6949 private 0/],
    ['/no-icann', /a section holds no rule: icann 0 private 3448/],
  ]) {
    const out = join(scratch(), 'psl.dat');
    const r = await run('--url', `${base}${path}`, '--out', out);
    assert.equal(r.status, 1, `${path}: ${r.stderr}`);
    assert.match(r.stderr, message, path);
    assert.equal(r.stdout, '', path);
    assert.equal(existsSync(out), false, path);
  }
});

test('fetch-psl: a 404, a body over the cap, a body that breaks off and a refused connection exit 2', async () => {
  for (const [url, message] of [
    [`${base}/absent`, /answered 404/],
    [`${base}/big`, new RegExp(`sent more than ${MAX_BYTES} bytes`)],
    [`${base}/broken`, /the body broke off after 1000 bytes/],
  ]) {
    const r = await run('--url', url);
    assert.equal(r.status, 2, `${url}: ${r.stderr}`);
    assert.match(r.stderr, message, url);
    assert.equal(r.stdout, '', url);
  }
  const closed = createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const refused = await run('--url', `http://127.0.0.1:${port}/list`);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /request failed/);
});

test('fetch-psl: a redirect is refused with exit 2 and nothing is written, though its target is the good list', async () => {
  const out = join(scratch(), 'psl.dat');
  seen.length = 0;
  const r = await run('--url', `${base}/moved`, '--out', out);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /request failed: unexpected redirect/);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(out), false);
  // The redirect was not followed: /list was never asked for.
  assert.deepEqual(
    seen.map((s) => s.url),
    ['/moved'],
  );
  await assert.rejects(download(`${base}/moved`), /unexpected redirect/);
});

test('fetch-psl: the cap is 4 MiB, a body of exactly the cap is read and one byte more is not, and the request has 60 s', async () => {
  assert.equal(MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(TIMEOUT_MS, 60_000);
  assert.equal((await download(`${base}/exact`)).length, MAX_BYTES);
  await assert.rejects(download(`${base}/big`), new RegExp(`sent more than ${MAX_BYTES} bytes`));
});

test('fetch-psl: bad arguments, and an --out path that cannot be written, exit 2', async () => {
  assert.equal((await run('extra')).status, 2);
  assert.equal((await run('--url')).status, 2);
  assert.equal((await run('--url', `${base}/list`, '--out')).status, 2);
  const r = await run('--url', `${base}/list`, '--out', join(scratch(), 'no-such-dir', 'psl.dat'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot write/);
  assert.equal(r.stdout, '');
});

test('fetch-psl: checkList is the names loader plus the rule floor', async () => {
  const psl = await checkList(LIST);
  assert.deepEqual(psl.rules, { icann: 6949, private: 3448 });
  await assert.rejects(checkList(Buffer.from(FEW)), /not more than 9000/);
});
