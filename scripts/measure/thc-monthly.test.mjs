// scripts/measure/thc-monthly.mjs: the head reader, the guards on each answer,
// the meter, the /proc reader, awk's output parser and the verdict, each on
// synthetic inputs; the awk program run by the machine's awk on the recorded
// sample and on planted lines; and the command line run end to end with the
// real curl, gzip and awk against a local HTTP server that redirects like
// Hugging Face does, answers Range requests, and drops, refuses, changes or
// trickles on demand. Every exit code is read from the process itself.
//
// The recorded sample `fixtures/thc-monthly/sept-head-sample.csv` is lines
// 1-40 and 5,476-5,495 of the first 1,048,576 B of
// https://huggingface.co/buckets/IP-THC-ORG/Datasets/resolve/2026/10/rdns-sept.csv.gz?download=true
// (fetched 2026-10-28T10:29:35Z with `curl -r 0-1048575`, then `gzip -dc`):
// 50 IPv4 lines then 10 IPv6 lines, the first IPv6 line at 5,486.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import {
  AWK_PROGRAM,
  checkFinal,
  gzipStatus,
  HeadReader,
  Meter,
  PAGE_RECORDS,
  parseAwk,
  parseHead,
  parseProcStat,
  parseRange,
  protoFor,
  Refused,
  SCHEMA,
  verdictLines,
  verdictOf,
} from './thc-monthly.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'thc-monthly.mjs');
const SAMPLE = readFileSync(join(HERE, 'fixtures', 'thc-monthly', 'sept-head-sample.csv'));

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'thc-monthly-test-'));
  dirs.push(d);
  return d;
};

// The awk under test: THC_MONTHLY_AWK when it is set (the workflow sets it to
// the awk its measurement runs with), else the script's default `awk`, which
// the command line then runs with no --awk at all.
const AWK = process.env.THC_MONTHLY_AWK || 'awk';
const AWK_ARGS = process.env.THC_MONTHLY_AWK ? ['--awk', AWK] : [];
const has = (bin, flags = ['--version']) => spawnSync(bin, flags, { stdio: 'ignore' }).status === 0;
const tools = { curl: has('curl'), gzip: has('gzip'), awk: has(AWK) || has(AWK, ['-W', 'version']) };
const needAwk = { skip: tools.awk ? false : `${AWK} is not on the PATH, so the awk program was not run` };
const missing = Object.keys(tools).filter((t) => !tools[t]);
const needAll = { skip: missing.length ? `${missing.join(', ')} not on the PATH, so the command line was not run` : false };

const head = (status, headers = {}) => ({ status, headers });
// A larger synthetic CSV, about 25 B a line, for the trickle and the head reads.
const bigCsv = (n) => Buffer.from(Array.from({ length: n }, (_, i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255},h${i}.example\n`).join(''));

test('thc-monthly head reader: a redirect head, then the final head split across chunks, then the body', () => {
  const r = new HeadReader();
  const text = 'HTTP/1.1 302 Found\r\nLocation: https://cdn.example/x?sig=1\r\nContent-Length: 0\r\n\r\nHTTP/2 206\r\ncontent-range: bytes 0-3/10\r\n\r\nBODY';
  const bytes = Buffer.from(text, 'latin1');
  assert.equal(r.push(bytes.subarray(0, 50)), null);
  const cut = bytes.indexOf('\r\n\r\nBODY') + 2;
  assert.equal(r.push(bytes.subarray(50, cut)), null, 'half of the blank line is not the end of the head');
  assert.equal(r.push(bytes.subarray(cut)).toString(), 'BODY');
  assert.equal(r.heads.length, 2);
  assert.equal(r.final.status, 206);
  assert.equal(r.final.headers['content-range'], 'bytes 0-3/10');
  assert.equal(r.push(Buffer.from('MORE')).toString(), 'MORE', 'after the head every byte is body');
});

test('thc-monthly head reader: a 1xx head and a 3xx with no Location', () => {
  const r = new HeadReader();
  assert.equal(r.push(Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')).toString(), 'ok');
  assert.equal(r.final.status, 200);
  const s = new HeadReader();
  assert.equal(s.push(Buffer.from('HTTP/1.1 304 Not Modified\r\nETag: "x"\r\n\r\n')).length, 0);
  assert.equal(s.final.status, 304, 'a 3xx curl did not follow is the final head');
});

test('thc-monthly head reader: refuses a line that is not HTTP and a head with no end', () => {
  assert.throws(() => new HeadReader().push(Buffer.from('47.0.0.28,host.example\r\n\r\n')), Refused);
  assert.throws(() => parseHead('HTTP/1.1 200 OK\r\nno colon here'), /not a header line/);
  assert.throws(() => new HeadReader().push(Buffer.alloc(70 * 1024, 0x41)), /no end of a response head/);
  assert.deepEqual(parseHead('HTTP/2 206 \r\nETag: "a"'), { status: 206, headers: { etag: '"a"' } });
});

test('thc-monthly guards: the whole file wants 200 and a Range wants 206 for exactly its bytes', () => {
  const whole = { from: 0, to: null, total: null, etag: null };
  assert.deepEqual(checkFinal(head(200, { 'content-length': '10', etag: '"e"' }), whole), { total: 10, length: 10, etag: '"e"' });
  assert.throws(() => checkFinal(head(206, { 'content-range': 'bytes 0-9/10' }), whole), /HTTP 206 for the whole file; expected 200/);
  const resume = { from: 4, to: null, total: 10, etag: '"e"' };
  assert.deepEqual(checkFinal(head(206, { 'content-range': 'bytes 4-9/10', 'content-length': '6', etag: '"e"' }), resume), { total: 10, length: 6, etag: '"e"' });
  assert.throws(() => checkFinal(head(200, { 'content-length': '10', etag: '"e"' }), resume), /HTTP 200 for a Range from byte 4; expected 206/);
  assert.throws(() => checkFinal(head(206, { 'content-range': 'bytes 0-9/10', etag: '"e"' }), resume), /does not answer the Range 4-/);
  assert.throws(() => checkFinal(head(206, { 'content-range': 'bytes 4-9/10', 'content-length': '5', etag: '"e"' }), resume), /content-length does not match/);
  assert.throws(() => checkFinal(head(206, { 'content-range': 'bytes 4-10/11', etag: '"e"' }), resume), /it changed between requests/);
  assert.throws(() => checkFinal(head(206, { 'content-range': 'bytes 4-9/10', etag: '"f"' }), resume), /ETag is "\\"f\\"" and was/);
  assert.throws(() => checkFinal(head(200, { 'content-length': '10', 'content-encoding': 'gzip' }), whole), /encoded, not the file's own bytes/);
  assert.throws(() => checkFinal(head(200, { 'content-length': 'ten' }), whole), /content-length is not a byte count/);
});

test('thc-monthly guards: a range past the end is clamped by the server, and 429 and 5xx are retried with their delay', () => {
  assert.equal(checkFinal(head(206, { 'content-range': 'bytes 0-9/10' }), { from: 0, to: 99, total: null, etag: null }).length, 10);
  let err;
  try {
    checkFinal(head(503, { 'retry-after': '7' }), { from: 0, to: null, total: null, etag: null });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Refused);
  assert.equal(err.retry, true);
  assert.equal(err.retryAfterMs, 7000);
  assert.equal(new Refused('x', { status: 404 }).retry, false);
  assert.equal(new Refused('x', { status: 429 }).retry, true);
  assert.equal(new Refused('x', { status: 429, retryAfterMs: null }).retryAfterMs, null);
});

test('thc-monthly urls and ranges: https, or http to a loopback address only', () => {
  assert.equal(protoFor('https://huggingface.co/x'), '=https');
  assert.equal(protoFor('http://127.0.0.1:8080/x'), '=http,https');
  assert.throws(() => protoFor('http://example.com/x'), /https, or http to a loopback/);
  assert.throws(() => protoFor('file:///etc/passwd'), /https, or http to a loopback/);
  assert.throws(() => protoFor('not a url'), /not a URL/);
  assert.deepEqual(parseRange('0-1048575'), { from: 0, to: 1048575 });
  assert.throws(() => parseRange('5-4'), /A <= B/);
  assert.throws(() => parseRange('0-'), /A <= B/);
});

test('thc-monthly meter: the first span, the whole span and each minute', () => {
  const m = new Meter(0, 100);
  m.add(60, 1000);
  m.add(60, 2000);
  m.add(30, 61_000);
  const s = m.summary(62_000);
  assert.equal(s.bytes, 150);
  assert.equal(s.seconds_to_first_byte, 1);
  assert.deepEqual(s.first_2gb, { bytes: 120, seconds: 2, mb_per_s: 0 });
  assert.equal(s.per_minute_mb_per_s.length, 2);
  assert.equal(new Meter(0).summary(1000).first_2gb, null);
});

test('thc-monthly /proc reader: fields are counted after the last parenthesis', () => {
  const line = '4242 (a (b) c) S 1 4242 4242 0 -1 4194560 100 0 0 0 1234 567 0 0 20 0 1 0 99 1000 10 18446744073709551615';
  assert.deepEqual(parseProcStat(line), { utime: 1234, stime: 567 });
  assert.throws(() => parseProcStat('garbage'), /unreadable/);
});

test('thc-monthly awk output: keys by name, examples kept whole, an unknown key or no end refused', () => {
  const out = [
    'records\t5',
    'fields\t2\t4',
    'fields\t3\t1',
    'ipv4\t4',
    'ipv6\t0',
    'not_address\t1',
    'family_runs\t3',
    'first_address\t1.2.3.4',
    'last_address\t1.2.3.9',
    'first_other_field_count\t5\t3\ta,b,c\twith a tab',
    'suspect_count\t1',
    'suspect\t5\ta,b,c\twith a tab',
    'name_odd_count\t0',
    'end\tok',
    '',
  ].join('\n');
  const c = parseAwk(out);
  assert.equal(c.records, 5);
  assert.deepEqual(c.fields, { 2: 4, 3: 1 });
  assert.deepEqual(c.first_other_field_count, { line: 5, fields: 3, text: 'a,b,c\twith a tab' });
  assert.deepEqual(c.suspects, [{ line: 5, text: 'a,b,c\twith a tab' }]);
  assert.throws(() => parseAwk(`${out}surprise\t1\n`), /unknown key/);
  assert.throws(() => parseAwk(out.replace('end\tok\n', '')), /no closing end/);
  assert.throws(() => parseAwk(out.replace('ipv6\t0\n', '')), /no ipv6/);
});

test('thc-monthly gzip status: truncated, warning and error are told apart', () => {
  assert.equal(gzipStatus(0, ''), 'ok');
  assert.equal(gzipStatus(1, 'gzip: stdin: unexpected end of file'), 'truncated');
  assert.equal(gzipStatus(2, 'gzip: stdin: decompression OK, trailing garbage ignored'), 'warning');
  assert.equal(gzipStatus(1, 'gzip: stdin: invalid compressed data--crc error'), 'error');
});

// A result as the run writes it, for the verdict tests.
function fakeResult({ stream = {}, network = null, head = null } = {}) {
  const counts = {
    records: 10,
    fields: { 2: 10 },
    ipv4: 10,
    ipv6: 0,
    not_address: 0,
    family_runs: 1,
    first_address: '1.2.3.4',
    last_address: '1.2.3.5',
    first_other_field_count: null,
    suspect_count: 0,
    suspects: [],
    name_odd_count: 0,
    name_odd_examples: [],
  };
  const pass = (extra) => ({
    kind: 'pipeline',
    label: 'stream',
    url: 'https://x/y',
    range: null,
    ended: 'complete',
    reason: null,
    complete: true,
    expected_bytes: 100,
    http: { total: 100, resumes: 0, attempts: [] },
    sha256: 'aa',
    bytes: 100,
    seconds: 1,
    mb_per_s: 0,
    seconds_to_first_byte: 0.1,
    first_2gb: null,
    uncompressed: { bytes: 400, mb_per_s: 0, dropped_partial_line_bytes: 0 },
    records_per_s: 10,
    gzip: { exit_code: 0, status: 'ok', stderr: '' },
    awk: { exit_code: 0, stderr: '' },
    counts,
    counts_error: null,
    cpu: null,
    ...extra,
  });
  return {
    schema: SCHEMA,
    args: { url: 'https://x/y', awk: 'awk' },
    conditions: { awk: 'awk 1' },
    passes: { stream: pass(stream), network: network && { ...pass(network), kind: 'network' }, head: head && pass({ label: 'head', range: '0-99', ...head }) },
  };
}

test('thc-monthly verdict: a complete stream with two fields everywhere is absent and passes', () => {
  const v = verdictOf(fakeResult({ network: {}, head: { gzip: { exit_code: 1, status: 'truncated', stderr: 'unexpected end of file' } } }));
  assert.deepEqual(v, { cnames: 'absent', stream_ok: true, pass: true, reasons: [] });
  const { lines, code } = verdictLines(fakeResult());
  assert.equal(code, 0);
  assert.ok(lines.includes('fields: 2=10'));
  assert.ok(lines.includes(`records against the page's 6.36 billion: ratio ${Math.round((10 / PAGE_RECORDS) * 1000) / 1000}`));
  assert.equal(lines.at(-1), 'cnames: absent');
});

test('thc-monthly verdict: a third field or a first field that is not an address makes it present', () => {
  const r = fakeResult();
  r.passes.stream.counts = { ...r.passes.stream.counts, suspect_count: 1, suspects: [{ line: 3, text: '1.2.3.4,a.example,b.example' }] };
  assert.equal(verdictOf(r).cnames, 'present');
  assert.equal(verdictOf(r).pass, true, 'the stream itself is still complete');
  const lines = verdictLines(r).lines;
  assert.ok(lines.includes('suspect line 3: "1.2.3.4,a.example,b.example"'));
  const h = fakeResult({ head: { counts: { ...r.passes.stream.counts } } });
  assert.equal(verdictOf(h).cnames, 'present', 'a suspect in the other month counts too');
});

test('thc-monthly verdict: a gzip error, a cut stream, a range read or differing bytes is not a pass', () => {
  const gz = verdictOf(fakeResult({ stream: { gzip: { exit_code: 1, status: 'error', stderr: 'crc error' } } }));
  assert.equal(gz.pass, false);
  assert.equal(gz.cnames, 'unknown', 'absent is never claimed over a stream that failed');
  assert.match(gz.reasons.join('\n'), /gzip: error, exit 1/);
  const cut = verdictOf(fakeResult({ stream: { ended: 'deadline', complete: false, reason: 'stopped by the deadline at byte 50' } }));
  assert.equal(cut.pass, false);
  assert.match(cut.reasons.join('\n'), /the stream is deadline: stopped by the deadline/);
  const range = verdictOf(fakeResult({ stream: { range: '0-99', gzip: { exit_code: 1, status: 'truncated', stderr: '' } } }));
  assert.equal(range.pass, false);
  assert.equal(range.cnames, 'unknown');
  assert.match(range.reasons.join('\n'), /smoke test, not a pass/);
  assert.match(range.reasons.join('\n'), /truncated at the cut of the range read/);
  const differ = verdictOf(fakeResult({ network: { sha256: 'bb' } }));
  assert.equal(differ.pass, false);
  assert.match(differ.reasons.join('\n'), /read different bytes/);
  const notRun = fakeResult();
  notRun.passes.stream = { kind: 'pipeline', label: 'stream', ended: 'not-run', reason: 'stopped by the deadline', complete: false };
  assert.equal(verdictOf(notRun).pass, false);
  assert.equal(verdictLines(notRun).code, 1);
  const awkBad = verdictOf(fakeResult({ stream: { counts: null, counts_error: 'awk printed no records' } }));
  assert.equal(awkBad.pass, false);
});

test('thc-monthly verdict: each pass must be complete, and absent is claimed only over a stream whole in every part', () => {
  // [result, the reason it names]: every case fails, and none may say absent.
  const cases = [
    [fakeResult({ network: { ended: 'refused', complete: false, reason: 'HTTP 403' } }), /the network pass is refused: HTTP 403/],
    [fakeResult({ head: { ended: 'cut', complete: false, reason: 'connection reset' } }), /the head pass is cut: connection reset/],
    [fakeResult({ head: { awk: { exit_code: 1, stderr: 'boom' } } }), /the head pass's awk failed: exit 1/],
    [fakeResult({ head: { counts: null, counts_error: 'no records line' } }), /the head pass's awk failed: exit 0, no records line/],
    [fakeResult({ stream: { awk: { exit_code: 2, stderr: '' } } }), /awk: exit 2/],
    [fakeResult({ stream: { counts: null, counts_error: 'awk printed no records' } }), /awk's counts are unreadable: awk printed no records/],
    [fakeResult({ stream: { complete: false, ended: 'cut', reason: 'curl exit 18' } }), /the stream is cut: curl exit 18/],
    [fakeResult({ stream: { range: '0-99' } }), /smoke test, not a pass/],
  ];
  for (const [r, re] of cases) {
    const v = verdictOf(r);
    assert.equal(v.pass, false, String(re));
    assert.ok(
      v.reasons.some((x) => re.test(x)),
      `${re}: ${v.reasons.join(' | ')}`,
    );
    // The two stream faults with gzip 0 and the head and network faults: only
    // the stream decides absent, and a failed stream never says it.
    const streamWhole = r.passes.stream.complete && r.passes.stream.range === null && r.passes.stream.awk.exit_code === 0 && r.passes.stream.counts;
    assert.equal(v.cnames, streamWhole ? 'absent' : 'unknown', String(re));
    assert.equal(verdictLines(r).code, 1);
    assert.equal(verdictLines(r).lines.at(-1), `cnames: ${v.cnames}`);
  }
});

test('thc-monthly guards: a 206 whose range ends elsewhere than asked is refused', () => {
  const asked = { from: 0, to: 99, total: null, etag: null };
  assert.equal(checkFinal(head(206, { 'content-range': 'bytes 0-99/1000' }), asked).length, 100);
  assert.throws(() => checkFinal(head(206, { 'content-range': 'bytes 0-49/1000' }), asked), /does not answer the Range 0-99/);
  assert.throws(() => checkFinal(head(206, { 'content-range': 'bytes 0-149/1000' }), asked), /does not answer the Range 0-99/);
});

// The oracle for the fast path: the same counts, field by field on every line.
const AWK_REFERENCE = String.raw`BEGIN { FS = ","; prev = -1 }
{
  nf[NF]++
  a = $1
  if (a ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) fam = 4
  else if (index(a, ":") > 0 && a ~ /^[0-9A-Fa-f:.]+$/) fam = 6
  else fam = 0
  if (fam == 4) v4++
  else if (fam == 6) v6++
  else if (NF > 0) bad++
  if (fam != prev) { runs++; prev = fam }
  if (fam != 0) { if (fa == "") fa = a; la = a }
  if (NF != 2 && fo == "") fo = sprintf("%.0f", NR) "\t" NF "\t" substr($0, 1, 300)
  if (NF > 2 || (NF > 0 && fam == 0)) { sc++; if (sc <= 20) s[sc] = sprintf("%.0f", NR) "\t" substr($0, 1, 300) }
  if (NF > 1 && $2 ~ /[^A-Za-z0-9._*-]/) { oc++; if (oc <= 20) o[oc] = sprintf("%.0f", NR) "\t" substr($0, 1, 300) }
}
END {
  printf "records\t%.0f\n", NR
  for (k in nf) printf "fields\t%s\t%.0f\n", k, nf[k]
  printf "ipv4\t%.0f\nipv6\t%.0f\nnot_address\t%.0f\nfamily_runs\t%.0f\n", v4, v6, bad, runs
  printf "first_address\t%s\nlast_address\t%s\n", fa, la
  if (fo != "") printf "first_other_field_count\t%s\n", fo
  printf "suspect_count\t%.0f\n", sc
  for (i = 1; i <= sc && i <= 20; i++) printf "suspect\t%s\n", s[i]
  printf "name_odd_count\t%.0f\n", oc
  for (i = 1; i <= oc && i <= 20; i++) printf "name_odd\t%s\n", o[i]
  printf "end\tok\n"
}
`;

// Runs an awk program (the script's by default) on `text` with the machine's
// awk, as the script does.
function runAwk(text, program = AWK_PROGRAM) {
  const d = scratch();
  const prog = join(d, 'shape.awk');
  writeFileSync(prog, program);
  const r = spawnSync(AWK, ['-f', prog], { input: text, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, String(r.stderr));
  return parseAwk(r.stdout.toString('utf8'));
}

test('thc-monthly awk program: the fast path counts exactly what the field-by-field program counts', needAwk, () => {
  const planted = [
    '1.2.3.4,a.example',
    '2001:db8::1,b.example',
    '1.2.3.5,c.example,target.example',
    'host.example,1.2.3.6',
    '',
    '1.2.3.7',
    '1.2.3.8,',
    '::ffff:1.2.3.8,d.example',
    '1.2.3.9,has space.example',
    '2001:db8::2,UPPER_and-dash.*.example',
    ':,x.example',
    '1.2.3,short.example',
    '1.2.3.4.5,long.example',
    'fe80::1%eth0,zone.example',
    '1.2.3.10,semi;colon.example',
  ];
  const mixed = Array.from({ length: 3000 }, (_, i) => planted[i % planted.length]).join('\n');
  for (const input of [SAMPLE, Buffer.from(`${planted.join('\n')}\n`), Buffer.from(`${mixed}\n`), bigCsv(5000), Buffer.from('1.2.3.4,no-final-newline.example')]) {
    assert.deepEqual(runAwk(input), runAwk(input, AWK_REFERENCE));
  }
});

test('thc-monthly awk program: the recorded sample is two fields everywhere, 50 IPv4 then 10 IPv6 lines', needAwk, () => {
  const c = runAwk(SAMPLE);
  assert.equal(c.records, 60);
  assert.deepEqual(c.fields, { 2: 60 });
  assert.equal(c.ipv4, 50);
  assert.equal(c.ipv6, 10);
  assert.equal(c.not_address, 0);
  assert.equal(c.family_runs, 2);
  assert.equal(c.first_address, '47.0.0.28');
  assert.equal(c.last_address, '2a00:c38:102::194');
  assert.equal(c.first_other_field_count, null);
  assert.equal(c.suspect_count, 0);
  assert.equal(c.name_odd_count, 0);
});

test('thc-monthly awk program: planted lines are suspects, odd names or neither, by the rule', needAwk, () => {
  const lines = [
    '1.2.3.4,a.example',
    '2001:db8::1,b.example',
    '1.2.3.5,c.example,target.example', // three fields: a suspect
    'host.example,1.2.3.6', // the first field is not an address: a suspect
    '', // an empty line: no field, not a suspect
    '1.2.3.7', // one field, an address: counted, not a suspect
    '::ffff:1.2.3.8,d.example',
    '1.2.3.9,has space.example', // an odd name, not a suspect
    '1.2.3.10,semi;colon.example', // an odd name, not a suspect
    '1.2.3.11,_dmarc.*.Example-1.com',
  ];
  const c = runAwk(`${lines.join('\n')}\n`);
  assert.equal(c.records, 10);
  assert.deepEqual(c.fields, { 0: 1, 1: 1, 2: 7, 3: 1 });
  assert.equal(c.ipv4, 6);
  assert.equal(c.ipv6, 2);
  assert.equal(c.family_runs, 7, '4 6 4 x x 4 6 4 4 4: seven runs, the empty line one with the bad one');
  assert.equal(c.not_address, 1);
  assert.deepEqual(c.first_other_field_count, { line: 3, fields: 3, text: '1.2.3.5,c.example,target.example' });
  assert.equal(c.suspect_count, 2);
  assert.deepEqual(
    c.suspects.map((s) => s.line),
    [3, 4],
  );
  assert.equal(c.name_odd_count, 2);
  assert.deepEqual(
    c.name_odd_examples.map((s) => s.line),
    [8, 9],
  );
  assert.equal(c.first_address, '1.2.3.4');
  assert.equal(c.last_address, '1.2.3.11');
});

// Git for Windows' awk drops a CR before LF on input (MEASURED 2026-10-28 on
// this repository's Windows machine: `printf 'a\r\n' | awk '{print length($0)}'`
// prints 1); the runner's awk keeps it. The probe decides, never the platform.
const keepsCr = tools.awk && spawnSync(AWK, ['{ print length($0) }'], { input: 'a\r\n' }).stdout?.toString().trim() === '2';

test('thc-monthly awk program: a CR before the newline is an odd byte in a name', { skip: keepsCr ? false : 'this awk drops a CR before LF on input, so the case cannot be seen here' }, () => {
  const c = runAwk('1.2.3.4,crlf.example\r\n1.2.3.5,lf.example\n');
  assert.equal(c.name_odd_count, 1);
  assert.equal(c.name_odd_examples[0].line, 1);
});

test('thc-monthly awk program: only the first 20 suspects are kept, and every one is counted', needAwk, () => {
  const text = Array.from({ length: 25 }, (_, i) => `1.2.3.${i},a.example,b.example\n`).join('');
  const c = runAwk(text);
  assert.equal(c.suspect_count, 25);
  assert.equal(c.suspects.length, 20);
  assert.equal(c.suspects[19].line, 20);
});

// A local server shaped like the Hugging Face resolve URL: /f/NAME answers 302
// to /blob/NAME?sig=..., and /blob/NAME serves the bytes with an ETag and
// Range. Faults, per file: dropFirstAt (the first response is cut after N body
// bytes), ignoreRangeAfterFirst (a later Range gets the whole file with 200),
// etagAfterFirst (a later response has another ETag), trickle (N bytes every
// 100 ms), overlong (a body that runs past its declared range).
async function serve(files) {
  const seen = new Map();
  const server = createServer((req, res) => {
    const [, kind, name] = new URL(req.url, 'http://local').pathname.split('/');
    const f = files[name];
    if (!f) {
      res.writeHead(404, { 'content-length': '9' });
      res.end('not found');
      return;
    }
    if (kind === 'f') {
      res.writeHead(302, { location: `/blob/${name}?sig=abc`, 'content-length': '0' });
      res.end();
      return;
    }
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const data = f.data;
    let start = 0;
    let end = data.length - 1;
    let status = 200;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && !(f.ignoreRangeAfterFirst && n > 1)) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
      status = 206;
    }
    const headers = { 'content-type': 'application/gzip', 'accept-ranges': 'bytes', etag: f.etagAfterFirst && n > 1 ? '"changed"' : '"e1"', 'content-length': String(end - start + 1) };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${data.length}`;
    if (f.overlong) {
      // Chunked, with no content-length, so curl hands over every byte sent:
      // the whole file, under a content-range that declares fewer.
      delete headers['content-length'];
      res.writeHead(status, headers);
      res.end(data.subarray(start));
      return;
    }
    res.writeHead(status, headers);
    const body = data.subarray(start, end + 1);
    if (f.dropFirstAt && n === 1) {
      res.write(body.subarray(0, f.dropFirstAt), () => res.socket.destroy());
      return;
    }
    if (f.trickle) {
      let at = 0;
      const timer = setInterval(() => {
        if (at >= body.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(body.subarray(at, at + f.trickle));
        at += f.trickle;
      }, 100);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: (name) => `${base}/f/${name}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// The command line, run as its own process (the server answers from this one).
function cli(args) {
  return new Promise((resolve) => {
    // AWK_ARGS come first, so a test's own --awk overrides them.
    const child = spawn(process.execPath, [SCRIPT, ...AWK_ARGS, ...args], { env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const readResult = (file) => JSON.parse(readFileSync(file, 'utf8'));

test("thc-monthly command line: the whole file, the network pass and another month's head", needAll, async () => {
  const gz = gzipSync(SAMPLE);
  const other = gzipSync(bigCsv(4000));
  const srv = await serve({ 'sept.csv.gz': { data: gz }, 'aug.csv.gz': { data: other } });
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--network-pass', '--head-url', srv.url('aug.csv.gz'), '--head-bytes', '600', '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim().split('\n').at(-2), 'cnames: absent');
    assert.match(r.stdout, /^fields: 2=60$/m);
    assert.match(r.stdout, /^head: .* gzip truncated at the cut \(expected\)$/m);
    const res = readResult(out);
    assert.equal(res.schema, SCHEMA);
    const s = res.passes.stream;
    assert.equal(s.complete, true);
    assert.equal(s.bytes, gz.length);
    assert.equal(s.sha256, sha(gz));
    assert.equal(s.http.total, gz.length);
    assert.equal(s.http.etag, '"e1"');
    assert.equal(s.http.final_host, new URL(srv.url('x')).host);
    assert.equal(s.http.resumes, 0);
    assert.equal(s.http.attempts[0].status, 200);
    assert.equal(s.gzip.exit_code, 0);
    assert.equal(s.awk.exit_code, 0);
    assert.equal(s.uncompressed.bytes, SAMPLE.length);
    assert.equal(s.counts.records, 60);
    assert.equal(s.counts.ipv6, 10);
    assert.equal(res.passes.network.sha256, sha(gz));
    assert.equal(res.passes.network.complete, true);
    if (process.platform === 'linux') {
      // The runner's path: each child's CPU is read from /proc.
      assert.deepEqual(Object.keys(s.cpu.children).sort(), ['awk', 'curl', 'gzip']);
      for (const v of Object.values(s.cpu.children)) assert.ok(Number.isFinite(v.user_s) && Number.isFinite(v.sys_s));
      assert.deepEqual(Object.keys(res.passes.network.cpu.children), ['curl']);
    } else assert.equal(s.cpu.children, null);
    const h = res.passes.head;
    assert.equal(h.complete, true);
    assert.equal(h.bytes, 600);
    assert.equal(h.http.attempts[0].status, 206);
    assert.equal(h.gzip.status, 'truncated');
    // The oracle: zlib's own inflate of the same 600 B, flushed at the cut.
    const partial = gunzipSync(other.subarray(0, 600), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    const lastNl = partial.lastIndexOf(10);
    assert.equal(h.uncompressed.bytes, partial.length);
    assert.equal(
      h.counts.records,
      partial
        .subarray(0, lastNl + 1)
        .toString()
        .split('\n').length - 1,
      'the partial last line at the cut is dropped, not counted',
    );
    assert.equal(h.uncompressed.dropped_partial_line_bytes, partial.length - lastNl - 1);
    assert.ok(h.uncompressed.dropped_partial_line_bytes > 0);
    assert.deepEqual(res.verdict, { cnames: 'absent', stream_ok: true, pass: true, reasons: [] });

    const v = await cli(['--verdict', out]);
    assert.equal(v.code, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /^records: 60$/m);
    assert.match(v.stdout, /^network \(no decompression\): /m);
    assert.equal(v.stdout.trim().split('\n').at(-1), 'cnames: absent');
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: a range read reports gzip truncated at the cut, and is not a pass', needAll, async () => {
  const gz = gzipSync(bigCsv(4000));
  const srv = await serve({ 'sept.csv.gz': { data: gz } });
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--range', '0-799', '--out', out]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^not a pass: gzip: truncated at the cut of the range read \(expected for a partial read\)$/m);
    assert.match(r.stdout, /^not a pass: a --range read \(0-799\) is a smoke test, not a pass$/m);
    assert.equal(r.stdout.trim().split('\n').at(-2), 'cnames: unknown');
    const s = readResult(out).passes.stream;
    assert.equal(s.bytes, 800);
    assert.equal(s.expected_bytes, 800);
    assert.equal(s.gzip.status, 'truncated');
    assert.equal(s.sha256, sha(gz.subarray(0, 800)));
    const v = await cli(['--verdict', out]);
    assert.equal(v.code, 1);
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: a dropped connection resumes from the next byte with a Range', needAll, async () => {
  const gz = gzipSync(bigCsv(4000));
  const srv = await serve({ 'sept.csv.gz': { data: gz, dropFirstAt: 3000 } });
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const s = readResult(out).passes.stream;
    assert.equal(s.http.resumes, 1);
    assert.equal(s.http.attempts[0].bytes, 3000);
    assert.notEqual(s.http.attempts[0].exit_code, 0, 'curl saw the short body');
    assert.equal(s.http.attempts[1].range, '3000-');
    assert.equal(s.http.attempts[1].status, 206);
    assert.equal(s.sha256, sha(gz));
    assert.equal(s.counts.records, 4000);
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: a resume answered with the whole file is refused, never spliced', needAll, async () => {
  const gz = gzipSync(bigCsv(4000));
  const srv = await serve({ 'sept.csv.gz': { data: gz, dropFirstAt: 3000, ignoreRangeAfterFirst: true } });
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--out', out]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const s = readResult(out).passes.stream;
    assert.equal(s.ended, 'refused');
    assert.match(s.reason, /HTTP 200 for a Range from byte 3000; expected 206/);
    assert.equal(s.bytes, 3000, 'no byte of the wrong answer reached gzip');
    assert.equal(s.gzip.status, 'truncated');
    assert.equal(readResult(out).verdict.cnames, 'unknown');
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: a file that changes between requests is refused', needAll, async () => {
  const gz = gzipSync(bigCsv(4000));
  const srv = await serve({ 'sept.csv.gz': { data: gz, dropFirstAt: 3000, etagAfterFirst: true } });
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--out', out]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const s = readResult(out).passes.stream;
    assert.equal(s.ended, 'refused');
    assert.match(s.reason, /the file changed between requests/);
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: a corrupt gzip stream is an error, not a truncation', needAll, async () => {
  const gz = Buffer.from(gzipSync(SAMPLE));
  gz[gz.length - 6] ^= 0xff; // a byte of the CRC-32 trailer
  const srv = await serve({ 'sept.csv.gz': { data: gz } });
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--out', out]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const s = readResult(out).passes.stream;
    assert.equal(s.complete, true, 'every byte arrived');
    assert.equal(s.gzip.status, 'error');
    assert.notEqual(s.gzip.exit_code, 0);
    assert.match(r.stdout, /^not a pass: gzip: error, exit \d+$/m);
    assert.equal(r.stdout.trim().split('\n').at(-2), 'cnames: unknown');
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: a third column makes the verdict present', needAll, async () => {
  const csv = Buffer.concat([SAMPLE, Buffer.from('1.2.3.4,www.example.com,target.example.net\n')]);
  const srv = await serve({ 'sept.csv.gz': { data: gzipSync(csv) } });
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^fields: 2=60 3=1$/m);
    assert.match(r.stdout, /^suspect line 61: "1\.2\.3\.4,www\.example\.com,target\.example\.net"$/m);
    assert.equal(r.stdout.trim().split('\n').at(-2), 'cnames: present');
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: the deadline stops curl and awk still counts what arrived', needAll, async () => {
  const gz = gzipSync(bigCsv(60000));
  const srv = await serve({ 'sept.csv.gz': { data: gz, trickle: 1024 } });
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--deadline-min', '0.03', '--out', out]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const s = readResult(out).passes.stream;
    assert.equal(s.ended, 'deadline');
    assert.ok(s.bytes < gz.length);
    assert.equal(s.gzip.status, 'truncated');
    assert.equal(s.awk.exit_code, 0);
    assert.ok(s.counts !== null && s.counts.records >= 0);
    assert.match(r.stdout, /^not a pass: the stream is deadline: stopped by the deadline at byte \d+$/m);
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: a body longer than its declared range is refused, and no extra byte is passed on', needAll, async () => {
  const gz = gzipSync(bigCsv(4000));
  const srv = await serve({ 'sept.csv.gz': { data: gz, overlong: true } });
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--range', '0-999', '--out', out]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const s = readResult(out).passes.stream;
    assert.equal(s.ended, 'refused');
    assert.match(s.reason, /more bytes than the 1000 B the response declared/);
    assert.ok(s.bytes <= 1000, `${s.bytes} B were passed on`);
    assert.equal(s.http.resumes, 0);
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: an awk that dies stops gzip and curl instead of reading on', needAll, async () => {
  const gz = gzipSync(bigCsv(60000));
  const srv = await serve({ 'sept.csv.gz': { data: gz, trickle: 4096 } });
  try {
    const out = join(scratch(), 'result.json');
    // node prints a version, so it passes the tool check, and then refuses
    // `-f FILE` and exits before reading its input: an awk that died.
    const r = await cli(['--url', srv.url('sept.csv.gz'), '--awk', process.execPath, '--out', out]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const s = readResult(out).passes.stream;
    assert.notEqual(s.awk.exit_code, 0);
    assert.equal(s.counts, null);
    assert.equal(s.ended, 'sink-closed');
    assert.ok(s.bytes < gz.length / 4, `the read stopped near its start, not at ${s.bytes} of ${gz.length} B`);
    assert.equal(readResult(out).verdict.cnames, 'unknown');
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: a 404 is refused at once, with no resume', needAll, async () => {
  const srv = await serve({});
  try {
    const out = join(scratch(), 'result.json');
    const r = await cli(['--url', srv.url('absent.csv.gz'), '--out', out]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const s = readResult(out).passes.stream;
    assert.equal(s.ended, 'refused');
    assert.equal(s.http.resumes, 0);
    assert.match(s.reason, /HTTP 404 for the whole file; expected 200/);
  } finally {
    await srv.close();
  }
});

test('thc-monthly command line: usage errors and an unreadable verdict file exit 2', async () => {
  const d = scratch();
  assert.equal((await cli(['--out', join(d, 'r.json')])).code, 2);
  assert.equal((await cli(['--url', 'file:///etc/hosts', '--out', join(d, 'r.json')])).code, 2);
  assert.equal((await cli(['--url', 'http://example.com/x', '--out', join(d, 'r.json')])).code, 2);
  assert.equal((await cli(['--url', 'https://example.com/x', '--out', join(d, 'r.json'), '--range', '9-1'])).code, 2);
  assert.equal((await cli(['--url', 'https://example.com/x', '--out', join(d, 'r.json'), '--network-pass', 'maybe'])).code, 2);
  assert.equal((await cli(['--url', 'https://example.com/x', '--out', join(d, 'r.json'), '--awk', 'no-such-awk-here'])).code, 2);
  assert.equal((await cli(['--verdict', join(d, 'absent.json')])).code, 2);
  writeFileSync(join(d, 'other.json'), '{"schema":"something-else"}');
  assert.equal((await cli(['--verdict', join(d, 'other.json')])).code, 2);
});
