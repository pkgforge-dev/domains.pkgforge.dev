// scripts/bench/pack.mjs — DOM-017's bench, run as a process on synthetic
// names, and its parts on planted inputs: the verdict on results one step past
// each limit, the Range fetch against a stand-in server that answers 206, 200,
// a wrong Content-Range or a short body, and the lines of a gzip prefix cut in
// the middle of a member. No test reaches the network; every name is synthetic.
//
//   node scripts/test.mjs scripts/bench --name "pack bench"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadPsl } from '@domains/names';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { BenchError, fetchSample, judge, keysOfLines, linesOfSample, MAX_SAMPLE_TEXT_BYTES, parseFlags, recordOf, SAMPLE_BYTES, syntheticKeys, syntheticTimes, UsageError } from './pack.mjs';

const SCRIPT = fileURLToPath(new URL('./pack.mjs', import.meta.url));
const PSL = join(import.meta.dirname, '..', '..', 'packages', 'names', 'test', 'fixtures', 'psl-2026-10-27.dat');

function run(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('pack bench: 5,000 synthetic names give four packs, two PASS lines and exit 0', async () => {
  const r = await run(['--names', '5000', '--seed', '7']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.schema, 'domains.bench.pack.v1');
  assert.equal(out.names.mode, 'synthetic');
  assert.deepEqual(
    out.variants.map((v) => [v.name, v.sources, v.records]),
    [
      ['keys', 0, 5000],
      ['1-source', 1, 5000],
      ['2-sources', 2, 5000],
      ['3-sources', 3, 5000],
    ],
  );
  assert.equal(out.variants[0].field_bytes_per_name, 0);
  // Each source adds bytes.
  for (let i = 1; i < 4; i += 1) assert.ok(out.variants[i].part_bytes > out.variants[i - 1].part_bytes, out.variants[i].name);
  assert.equal(out.lookups.count, 1000);
  assert.equal(out.lookups.reads_max, 2);
  assert.deepEqual(
    out.criteria.map((c) => [c.name, c.pass]),
    [
      ['one-source-at-most-12-bytes-a-name', true],
      ['lookup-at-most-2-range-reads', true],
    ],
  );
  assert.match(r.stderr, /PASS one-source-at-most-12-bytes-a-name/);
  // The same seed makes the same packs.
  const again = JSON.parse((await run(['--names', '5000', '--seed', '7'])).stdout);
  assert.deepEqual(
    again.variants.map((v) => v.sha256),
    out.variants.map((v) => v.sha256),
  );
});

test('pack bench: the verdict fails one step past each limit and passes at it', () => {
  const v = (b) => [{ sources: 1, bytes_per_name_with_idx: b }];
  const l = (max) => ({ count: 1000, reads_max: max });
  assert.equal(judge(v(12), l(2)).pass, true);
  const over = judge(v(12.001), l(2));
  assert.deepEqual(
    over.criteria.map((c) => c.pass),
    [false, true],
  );
  const reads = judge(v(5), l(3));
  assert.deepEqual(
    reads.criteria.map((c) => c.pass),
    [true, false],
  );
  // No 1-source variant, or no lookup, is a fail and never a pass.
  assert.equal(judge([{ sources: 2, bytes_per_name_with_idx: 1 }], l(2)).pass, false);
  assert.equal(judge(v(5), null).pass, false);
  assert.equal(judge(v(5), { count: 0, reads_max: 0 }).pass, false);
});

test('pack bench: flags are checked', () => {
  assert.throws(() => parseFlags([]), UsageError);
  assert.throws(() => parseFlags(['--names', '0']), UsageError);
  assert.throws(() => parseFlags(['--sample', 'cs3']), UsageError);
  assert.throws(() => parseFlags(['--names', '5', '--bogus', '1']), UsageError);
  assert.throws(() => parseFlags(['--names']), UsageError);
  assert.deepEqual(parseFlags(['--sample', 'cs2']), { names: undefined, sample: 'cs2', seed: 1, recordsPerBlock: 4096, out: null });
  assert.deepEqual(parseFlags(['--names', '10', '--records-per-block', '1024', '--seed', '3']), { names: 10, sample: null, seed: 3, recordsPerBlock: 1024, out: null });
});

// A stand-in for fetch: records what it was asked and answers what the test says.
function standIn({ status = 206, contentRange = `bytes 0-${SAMPLE_BYTES - 1}/319900000`, length = SAMPLE_BYTES } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect });
    return new Response(new Uint8Array(length), { status, headers: { 'content-range': contentRange } });
  };
  return { fetchFn, calls };
}

test('pack bench: the sample is one Range read with the contact User-Agent, and only a whole 206 is kept', async () => {
  const ok = standIn();
  const got = await fetchSample({ fetchFn: ok.fetchFn });
  assert.equal(got.body.length, SAMPLE_BYTES);
  assert.equal(got.total, 319_900_000);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, 'https://cs2.ip.thc.org/2026-10-26.txt.gz');
  assert.equal(ok.calls[0].headers['user-agent'], USER_AGENT);
  assert.equal(ok.calls[0].headers.range, 'bytes=0-19999999');
  assert.equal(ok.calls[0].redirect, 'error');
  // A server that ignores Range answers 200 with the whole file.
  await assert.rejects(
    () => fetchSample({ fetchFn: standIn({ status: 200 }).fetchFn }),
    (e) => e instanceof BenchError && /answered 200/.test(e.message),
  );
  await assert.rejects(
    () => fetchSample({ fetchFn: standIn({ contentRange: 'bytes 0-999/5000' }).fetchFn }),
    (e) => e instanceof BenchError && /Content-Range/.test(e.message),
  );
  await assert.rejects(
    () => fetchSample({ fetchFn: standIn({ length: SAMPLE_BYTES - 1 }).fetchFn }),
    (e) => e instanceof BenchError && /19999999 B arrived/.test(e.message),
  );
});

test('pack bench: a gzip prefix cut inside its member gives its whole lines, normalised to keys', async () => {
  const text = ['www.Example.com', '*.cdn.example.com', 'cdn.example.com', 'co.uk', '192.0.2.1', 'bücher.example', 'api.example.com.np', 'partial.example.org'].join('\n');
  const gz = gzipSync(Buffer.from(text, 'utf8'));
  // The cut keeps the header and most of the deflate stream.
  const { lines } = linesOfSample(gz.subarray(0, gz.length - 12));
  assert.ok(lines.length >= 6 && lines.length < 8, `${lines.length} lines`);
  assert.ok(!lines.includes('partial.example.org'));
  const psl = await loadPsl(readFileSync(PSL));
  const got = keysOfLines(lines.slice(0, 7), psl);
  assert.deepEqual(got.keys, ['com.example.cdn', 'com.example.www', 'example.xn--bcher-kva', 'np.com.example.api']);
  assert.deepEqual(got.flags, [3, 1, 1, 1]);
  assert.deepEqual(got.refused, { 'public-suffix': 1, 'numeric-tld': 1 });
  assert.throws(() => linesOfSample(gzipSync(Buffer.from('no newline'))), BenchError);
});

test('pack bench: a sample that decompresses past its bound is refused, not inflated', () => {
  assert.equal(MAX_SAMPLE_TEXT_BYTES, 512 * 1024 * 1024);
  // 10,000 B of synthetic lines against a bound of 1,000 B; at 10,000 they read.
  const gz = gzipSync(Buffer.alloc(10_000, 'a.example\n'));
  assert.throws(
    () => linesOfSample(gz, 1000),
    (e) => e instanceof BenchError && /decompresses to more than 1000 B/.test(e.message),
  );
  assert.equal(linesOfSample(gz, 10_000).decompressed_bytes, 10_000);
});

test('pack bench: decompressed_bytes counts the bytes of the inflated sample, not the UTF-16 units of its text', () => {
  // Synthetic lines: ü is 2 bytes in UTF-8 and 1 unit in UTF-16, 𝔘 4 bytes and 2 units.
  const text = 'bücher.example\n𝔘.example\nwww.example.com\n';
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.equal(bytes, 45);
  assert.equal(text.length, 42);
  const got = linesOfSample(gzipSync(Buffer.from(text, 'utf8')));
  assert.equal(got.decompressed_bytes, bytes);
  assert.deepEqual(got.lines, ['bücher.example', '𝔘.example', 'www.example.com']);
});

test('pack bench: synthetic keys ascend with none twice, and the times stay within 2026', () => {
  const keys = syntheticKeys(3000, 9);
  assert.equal(new Set(keys).size, 3000);
  assert.deepEqual([...keys].sort(), keys);
  const times = syntheticTimes(3000, 9);
  for (let i = 0; i < 3000; i += 1) {
    const r = recordOf(i, keys[i], 1, 3, times);
    assert.deepEqual(
      r.sources.map((s) => s.bit),
      [0, 1, 2],
    );
    for (const s of r.sources) assert.ok(s.first >= 0 && s.last >= s.first, `${i} bit ${s.bit}`);
    assert.ok(r.sources[1].last < 299 * 86_400, 'the second source stays in day 298');
  }
});
