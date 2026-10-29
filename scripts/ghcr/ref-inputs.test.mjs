// scripts/ghcr/ref-inputs.mjs, offline: a server on 127.0.0.1 serves the pinned
// PSL (packages/names/test/fixtures/psl-2026-10-27.dat, the same bytes as the
// list read 2026-10-29T00:38:49Z, sha256 0232f4df...49e9ca) and the CT log list
// recorded at 2026-10-29T00:38:50Z from
// https://www.gstatic.com/ct/log_list/v3/log_list.json (scripts/ghcr/fixtures/
// log_list-95.15.json, 62,375 B, sha256 29e36174...742d5ba), and planted faults
// of each. Every fault of the log list is planted alone on a copy of the
// recorded list, so the guard the test names is the only one it can meet. The
// registries, the source rows and the `out` that plants a defect are
// synthetic. The local server is not the kind's own origin, so every run that
// reads it gives --allow-other-url.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { FetchError } from '../ref/fetch-psl.mjs';
import { checkLogList, checkSources, EXIT, InputError, KINDS, LOG_LIST_URL, main, MIN_LOGS, MIN_OPERATORS, onOrigin, pslCreated, readBits, wholeSecond } from './ref-inputs.mjs';

const PSL = readFileSync(fileURLToPath(new URL('../../packages/names/test/fixtures/psl-2026-10-27.dat', import.meta.url)));
const LIST = readFileSync(fileURLToPath(new URL('./fixtures/log_list-95.15.json', import.meta.url)));
const hex = (b) => createHash('sha256').update(b).digest('hex');

const seen = [];
let server;
let base;
const dirs = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'ref-inputs-'));
  dirs.push(d);
  return d;
};

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const send = (status, body) => {
      res.writeHead(status, { 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
    };
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/psl', 'content-length': '0' });
      res.end();
    } else if (req.url === '/psl') send(200, PSL);
    else if (req.url === '/psl-no-version') send(200, PSL.toString('utf8').replace(/^\/\/ VERSION: .*$/m, '// no version here'));
    else if (req.url === '/psl-cut') send(200, PSL.subarray(0, 100_000));
    else if (req.url === '/ctlogs') send(200, LIST);
    else if (req.url === '/ctlogs-four') {
      const j = JSON.parse(LIST);
      j.operators = j.operators.slice(0, 4);
      send(200, JSON.stringify(j));
    } else send(404, 'no such file');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function run(argv) {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, json: out.length === 1 ? JSON.parse(out[0]) : null };
}

test('ref-inputs: psl downloads with the contact User-Agent, passes the list checks, and is written with its VERSION time as created', async () => {
  const dir = scratch();
  const r = await run(['psl', '--out', dir, '--url', `${base}/psl`, '--allow-other-url']);
  assert.equal(r.code, 0, r.err.join('\n'));
  const sha = hex(PSL);
  assert.equal(sha, '0232f4df0831911356e8ee1f4d5c3b6b12c0ed3f6bd66b0f81c8ab5d3d49e9ca');
  assert.deepEqual(r.json, {
    kind: 'psl',
    tag: 'psl-0232f4df0831',
    title: 'public_suffix_list.dat',
    file: join(dir, 'public_suffix_list.dat'),
    mediaType: 'text/plain',
    bytes: 338012,
    sha256: sha,
    created: '2026-10-22T08:36:41Z',
    url: `${base}/psl`,
    facts: { rules: { icann: 6949, private: 3448 } },
  });
  assert.deepEqual(readFileSync(join(dir, 'public_suffix_list.dat')), PSL);
  const req = seen.findLast((s) => s.url === '/psl');
  assert.equal(req.headers['user-agent'], USER_AGENT);
  assert.equal(req.headers['accept-encoding'], 'identity');
});

test('ref-inputs: a list with no VERSION line, or one cut short, fails its check with exit 1 and writes nothing', async () => {
  const dir = scratch();
  const nov = await run(['psl', '--out', dir, '--url', `${base}/psl-no-version`, '--allow-other-url']);
  assert.equal(nov.code, 1);
  assert.match(nov.err[0], /no `\/\/ VERSION: YYYY-MM-DD_HH-MM-SS_UTC` line/);
  const cut = await run(['psl', '--out', dir, '--url', `${base}/psl-cut`, '--allow-other-url']);
  assert.equal(cut.code, 1);
  assert.deepEqual(nov.out.concat(cut.out), []);
  assert.throws(() => readFileSync(join(dir, 'public_suffix_list.dat')), /ENOENT/);
});

test('ref-inputs: ctlogs reads the recorded list v3 whole: 11 operators, 26 logs, 59 tiled logs, created its log_list_timestamp', async () => {
  const dir = scratch();
  const r = await run(['ctlogs', '--out', dir, '--url', `${base}/ctlogs`, '--allow-other-url']);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(r.json.tag, 'ctlogs-29e361747007');
  assert.equal(r.json.sha256, '29e361747007c6391c0240a3d4ea915b38a8afd86f3618e684ef62f77742d5ba');
  assert.equal(r.json.bytes, 62375);
  assert.equal(r.json.created, '2026-10-28T13:37:58Z');
  assert.equal(r.json.mediaType, 'application/json');
  assert.equal(r.json.title, 'log_list.json');
  assert.deepEqual(r.json.facts, { version: '95.15', timestamp: '2026-10-28T13:37:58Z', operators: 11, logs: 26, tiled: 59 });
  assert.equal(LOG_LIST_URL, 'https://www.gstatic.com/ct/log_list/v3/log_list.json');
});

// A copy of the recorded list with one fault planted by `plant`.
function planted(plant) {
  const j = JSON.parse(LIST);
  plant(j);
  return new TextEncoder().encode(JSON.stringify(j));
}
const tiled0 = (j) => j.operators.find((o) => (o.tiled_logs ?? []).length > 0).tiled_logs[0];
const log0 = (j) => j.operators.find((o) => (o.logs ?? []).length > 0).logs[0];

test('ref-inputs: each fault of the log list, planted alone, fails the check that names it', () => {
  const cases = [
    ['not JSON', () => new TextEncoder().encode('{"version":'), /not UTF-8 JSON/],
    ['no version', () => planted((j) => delete j.version), /has no version/],
    ['a timestamp that is not a time', () => planted((j) => (j.log_list_timestamp = '2026-10-28 13:37')), /log_list_timestamp .* is not an ISO 8601 UTC time/],
    ['no operators', () => planted((j) => (j.operators = {})), /no operators array/],
    ['an operator with no name', () => planted((j) => (j.operators[3].name = '')), /operator 3 has no name/],
    ['email not a list', () => planted((j) => (j.operators[0].email = 'x@example.org')), /email is not a list/],
    ['a log with no description', () => planted((j) => delete log0(j).description), /has no description/],
    ['a log_id of 31 bytes', () => planted((j) => (log0(j).log_id = Buffer.alloc(31).toString('base64'))), /log_id is not 32 bytes of base64/],
    ['a log_id twice', () => planted((j) => (tiled0(j).log_id = log0(j).log_id)), /appears twice/],
    ['a key that is not base64', () => planted((j) => (log0(j).key = 'not base64!')), /key is not base64/],
    ['an http url', () => planted((j) => (log0(j).url = 'http://ct.example/')), /url is not an https URL/],
    ['a tiled log with no monitoring_url', () => planted((j) => delete tiled0(j).monitoring_url), /monitoring_url is not an https URL/],
    ['no mmd', () => planted((j) => delete log0(j).mmd), /mmd is not a whole number/],
    ['two states', () => planted((j) => (log0(j).state = { usable: {}, retired: {} })), /state holds 2 keys, not one/],
    ['logs not a list', () => planted((j) => (j.operators[0].logs = {})), /logs is not a list/],
    ['four operators', () => planted((j) => (j.operators = j.operators.slice(0, 4))), new RegExp(`4 operators, fewer than ${MIN_OPERATORS}`)],
    [
      'too few logs',
      () =>
        planted((j) => {
          for (const o of j.operators) {
            o.logs = (o.logs ?? []).slice(0, 1);
            o.tiled_logs = (o.tiled_logs ?? []).slice(0, 1);
          }
        }),
      new RegExp(`fewer than ${MIN_LOGS}`),
    ],
  ];
  for (const [what, bytes, re] of cases)
    assert.throws(
      () => checkLogList(bytes()),
      (e) => e instanceof InputError && re.test(e.message),
      what,
    );
  // The recorded list passes the same checks.
  assert.equal(checkLogList(LIST).operators, 11);
});

test('ref-inputs: a log list of four operators fails with exit 1 through the CLI, and a 404 is exit 2', async () => {
  const dir = scratch();
  const four = await run(['ctlogs', '--out', dir, '--url', `${base}/ctlogs-four`, '--allow-other-url']);
  assert.equal(four.code, 1);
  assert.match(four.err[0], /4 operators/);
  const gone = await run(['ctlogs', '--out', dir, '--url', `${base}/gone`, '--allow-other-url']);
  assert.equal(gone.code, 2);
  assert.match(gone.err[0], /answered 404/);
});

test('ref-inputs: sources reads the committed registry, created from --created and its URL from --commit', async () => {
  const dir = scratch();
  const file = join(dir, 'in.json');
  const reg = '{\n  "format": "domains.sources.v1",\n  "comment": "synthetic",\n  "sources": []\n}\n';
  writeFileSync(file, reg);
  const commit = 'e'.repeat(40);
  const r = await run(['sources', '--out', join(dir, 'out'), '--file', file, '--created', '2026-10-28T23:41:22Z', '--commit', commit]);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(r.json.tag, `sources-${hex(reg).slice(0, 12)}`);
  assert.equal(r.json.created, '2026-10-28T23:41:22Z');
  assert.equal(r.json.url, `https://github.com/pkgforge-dev/domains.pkgforge.dev/blob/${commit}/config/sources.json`);
  assert.deepEqual(r.json.facts, { sources: 0 });
  assert.equal(readFileSync(join(dir, 'out', 'sources.json'), 'utf8'), reg);
  // The committed file of this tree passes the same check.
  assert.equal(checkSources(readFileSync(fileURLToPath(new URL('../../config/sources.json', import.meta.url)))).sources >= 0, true);
});

test('ref-inputs: a registry of another format fails with exit 1; a missing file, a missing --created and stray flags are exit 2', async () => {
  const dir = scratch();
  const file = join(dir, 'bad.json');
  writeFileSync(file, '{"format":"domains.sources.v0","sources":[]}');
  const bad = await run(['sources', '--out', dir, '--file', file, '--created', '2026-10-28T23:41:22Z']);
  assert.equal(bad.code, 1);
  assert.match(bad.err[0], /no format domains\.sources\.v1/);
  assert.throws(() => checkSources(new TextEncoder().encode('{"format":"domains.sources.v1","sources":[{"bit":1}]}')), /each with an id/);
  for (const argv of [
    ['sources', '--out', dir, '--file', join(dir, 'missing.json'), '--created', '2026-10-28T23:41:22Z'],
    ['sources', '--out', dir, '--file', file],
    ['psl', '--out', dir, '--created', '2026-10-28T23:41:22Z'],
    ['sources', '--out', dir, '--file', file, '--created', '2026-10-28T23:41:22Z', '--url', 'https://x.example/'],
    ['sources', '--out', dir, '--file', file, '--created', '2026-10-28T23:41:22Z', '--commit', 'abc'],
    ['psl'],
    ['nope', '--out', dir],
    ['psl', '--out', dir, '--bogus', 'x'],
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.deepEqual(r.out, []);
  }
});

test('ref-inputs: created is the source time cut to its second, and a time that is not one is refused', () => {
  assert.equal(wholeSecond('2026-10-28T13:37:58Z', 't'), '2026-10-28T13:37:58Z');
  assert.equal(wholeSecond('2026-10-28T13:37:58.123456Z', 't'), '2026-10-28T13:37:58Z');
  assert.throws(() => wholeSecond('2026-10-28T13:37:58+05:45', 't'), InputError);
  assert.throws(() => wholeSecond('2026-02-30T00:00:00Z', 't'), InputError);
  assert.throws(() => wholeSecond(undefined, 't'), InputError);
  assert.equal(pslCreated('// x\n// VERSION: 2026-10-22_08-36-41_UTC\n// COMMIT: abc\n'), '2026-10-22T08:36:41Z');
  assert.throws(() => pslCreated('// VERSION: 2026-10-22 08:36:41\n'), InputError);
});

test('ref-inputs: --url is an https URL on the kind’s own origin unless --allow-other-url, refused before any request', async () => {
  const dir = scratch();
  const asked = seen.length;
  for (const [argv, re] of [
    [['psl', '--out', dir, '--url', `${base}/psl`], /is not an https URL on https:\/\/publicsuffix\.org; give --allow-other-url/],
    [['psl', '--out', dir, '--url', 'http://publicsuffix.org/list/public_suffix_list.dat'], /is not an https URL on https:\/\/publicsuffix\.org/],
    [['psl', '--out', dir, '--url', 'https://publicsuffix.org.example/list/public_suffix_list.dat'], /is not an https URL on https:\/\/publicsuffix\.org/],
    [['psl', '--out', dir, '--url', LOG_LIST_URL], /is not an https URL on https:\/\/publicsuffix\.org/],
    [['ctlogs', '--out', dir, '--url', 'https://publicsuffix.org/list/public_suffix_list.dat'], /is not an https URL on https:\/\/www\.gstatic\.com/],
    [['psl', '--out', dir, '--url', `${base}/psl`, '--allow-other-url=yes'], /--allow-other-url takes no value/],
    [['sources', '--out', dir, '--created', '2026-10-28T23:41:22Z', '--allow-other-url'], /--url and --allow-other-url go with psl and ctlogs/],
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err[0], re, argv.join(' '));
    assert.deepEqual(r.out, []);
  }
  assert.equal(seen.length, asked);
  // The kinds' own lists are on their origins, and so is another path there.
  assert.equal(onOrigin(KINDS.psl.url, KINDS.psl.url), true);
  assert.equal(onOrigin(KINDS.ctlogs.url, KINDS.ctlogs.url), true);
  assert.equal(onOrigin('https://publicsuffix.org/list/effective_tld_names.dat', KINDS.psl.url), true);
  assert.equal(onOrigin('not a url', KINDS.psl.url), false);
});

test('ref-inputs: a redirect is refused with exit 2, so the url printed is the one the bytes came from', async () => {
  const dir = scratch();
  const r = await run(['psl', '--out', dir, '--url', `${base}/moved`, '--allow-other-url']);
  assert.equal(r.code, 2);
  assert.match(r.err[0], /request failed: unexpected redirect/);
  assert.deepEqual(r.out, []);
  assert.equal(existsSync(join(dir, 'public_suffix_list.dat')), false);
  // The same list straight from /psl is written: the redirect alone refused it.
  assert.equal((await run(['psl', '--out', dir, '--url', `${base}/psl`, '--allow-other-url'])).code, 0);
});

// Synthetic: the shape of a THC row under the id and bit config/source-bits.json gives it.
const ROW = {
  id: 'thc-ct',
  bit: 0,
  family: 'ct',
  datasets: ['names', 'domains'],
  precision: 'day',
  kind: 'ct_name',
  basis: ['ct-first'],
  cadence: 'P1D',
  band: { metric: 'bytes', min: 0.4, max: 2.5, relative: true },
  urls: ['https://feed.example.test/{date}.txt.gz'],
  retention: 'unknown',
  parser: 'thc-lines/1',
  failure_modes: ['A file is late or missing.'],
  adapter: 'thc-ct',
};
const registry = (o = {}) => `${JSON.stringify({ format: 'domains.sources.v1', comment: 'synthetic', sources: [ROW], ...o }, null, 2)}\n`;

test('ref-inputs: sources passes packages/adapter’s validateRegistry before it is written, so a URL credential or a broken row is exit 1', async () => {
  const dir = scratch();
  const file = join(dir, 'in.json');
  const sources = (text) => {
    writeFileSync(file, text);
    return run(['sources', '--out', join(dir, 'out'), '--file', file, '--created', '2026-10-28T23:41:22Z']);
  };
  const good = await sources(registry());
  assert.equal(good.code, 0, good.err.join('\n'));
  assert.deepEqual(good.json.facts, { sources: 1 });
  // Each fault planted alone passes checkSources (a format and ids) and fails validateRegistry.
  for (const [what, text, re] of [
    ['a query credential', registry({ sources: [{ ...ROW, urls: ['https://feed.example.test/{date}.txt.gz?apikey=synthetic'] }] }), /credential: the query parameter apikey names a credential/],
    ['a user name', registry({ sources: [{ ...ROW, urls: ['https://synthetic-user@feed.example.test/'] }] }), /credential: a URL holds a user name or a password/],
    ['a bit config/source-bits.json does not give', registry({ sources: [{ ...ROW, bit: 1 }] }), /bit-taken|bit-mismatch/],
    ['no comment', `${JSON.stringify({ format: 'domains.sources.v1', sources: [ROW] })}\n`, /comment: missing/],
  ]) {
    rmSync(join(dir, 'out'), { recursive: true, force: true });
    assert.doesNotThrow(() => checkSources(new TextEncoder().encode(text)), what);
    const r = await sources(text);
    assert.equal(r.code, 1, `${what}: ${r.err.join('\n')}`);
    assert.match(r.err[0], /fails packages\/adapter's validateRegistry/, what);
    assert.match(r.err[0], re, what);
    assert.deepEqual(r.out, [], what);
    assert.equal(existsSync(join(dir, 'out', 'sources.json')), false, what);
  }
});

test('ref-inputs: a bit map that cannot be read or is not valid is a FetchError (exit 2), never a verdict on the registry', () => {
  const dir = scratch();
  assert.throws(
    () => readBits(join(dir, 'missing.json')),
    (e) => e instanceof FetchError && /cannot read .*missing\.json: ENOENT/.test(e.message),
  );
  writeFileSync(join(dir, 'bad.json'), '{"format":"domains.source-bits.v1","bits":{"a":0,"b":0}}');
  assert.throws(
    () => readBits(join(dir, 'bad.json')),
    (e) => e instanceof FetchError && /bit-taken/.test(e.message),
  );
  writeFileSync(join(dir, 'broken.json'), '{"format":');
  assert.throws(() => readBits(join(dir, 'broken.json')), FetchError);
});

test('ref-inputs: an error ref-inputs does not know is exit 70, an internal error with its stack, never 1', async () => {
  const dir = scratch();
  const err = [];
  // The list reads and passes its checks; the defect is planted in the one call main does not guard.
  const code = await main(['ctlogs', '--out', dir, '--url', `${base}/ctlogs`, '--allow-other-url'], {
    out: () => {
      throw new TypeError('synthetic defect');
    },
    err: (l) => err.push(l),
  });
  assert.equal(code, 70);
  assert.equal(err.length, 1);
  assert.match(err[0], /^ref-inputs: internal error: TypeError: synthetic defect\n\s+at /);
});

test('ref-inputs: the exit codes are the numbers the header names', () => {
  assert.deepEqual({ ...EXIT }, { ok: 0, failed: 1, usage: 2, internal: 70 });
});

test('ref-inputs: as a process, bad arguments are exit 2 with no request', () => {
  const script = fileURLToPath(new URL('./ref-inputs.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, 'psl'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--out DIR is required/);
  assert.equal(r.stdout, '');
});
