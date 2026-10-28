// The normalisation and the record files of scripts/measure/revlabel.mjs: each
// refusal, the wildcard flag, IDN conversion, the flag merge of readRecords and
// its refusal of an unsorted or malformed file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { normaliseFile, normaliseName, RecordError, readRecords, reverseName } from './revlabel.mjs';

const DAY = fileURLToPath(new URL('./fixtures/thc/day.txt', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./revlabel.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'thc-revlabel-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// The latin1 string a reader makes of the UTF-8 bytes of a text.
const latin1 = (text) => Buffer.from(text, 'utf8').toString('latin1');

const ok = (name, wild, idn) => ({ name, key: reverseName(name), wild, idn });

test('thc revlabel: lowercases, strips a wildcard, a trailing dot and a carriage return', () => {
  assert.deepEqual(normaliseName('Example.COM'), ok('example.com', false, false));
  assert.deepEqual(normaliseName('*.example.com'), ok('example.com', true, false));
  assert.deepEqual(normaliseName('example.com.'), ok('example.com', false, false));
  assert.deepEqual(normaliseName('*.Example.com.\r'), ok('example.com', true, false));
  assert.deepEqual(normaliseName('_dmarc.example.com'), ok('_dmarc.example.com', false, false));
  assert.deepEqual(normaliseName('API.Example.COM.NP'), ok('api.example.com.np', false, false));
  assert.equal(normaliseName('API.Example.COM.NP').key, 'np.com.example.api');
});

test('thc revlabel: converts a UTF-8 name to its ASCII form', () => {
  assert.deepEqual(normaliseName(latin1('www.bücher.de')), ok('www.xn--bcher-kva.de', false, true));
  assert.deepEqual(normaliseName(latin1('*.Bücher.de.')), ok('xn--bcher-kva.de', true, true));
  assert.deepEqual(normaliseName(latin1('x.公司.cn')), ok('x.xn--55qx5d.cn', false, true));
  assert.deepEqual(normaliseName('\xff\xfe.com'), { refused: 'idn' });
});

test('thc revlabel: refuses each malformed name with its reason', () => {
  const cases = [
    ['', 'empty'],
    ['*.', 'empty'],
    ['bad name.com', 'charset'],
    ['*.*.example.com', 'charset'],
    ['localhost', 'no-dot'],
    ['a..com', 'label-empty'],
    ['.leading.com', 'label-empty'],
    [`${'a'.repeat(64)}.com`, 'label-long'],
    [`${'a.'.repeat(126)}com`, 'name-long'],
  ];
  for (const [raw, reason] of cases) assert.deepEqual(normaliseName(raw), { refused: reason }, JSON.stringify(raw));
  assert.equal(normaliseName(`${'a'.repeat(63)}.com`).name.length, 67);
  assert.equal(normaliseName(`${'a.'.repeat(125)}com`).name.length, 253);
});

test('thc revlabel: reverses the labels', () => {
  assert.equal(reverseName('api.example.com.np'), 'np.com.example.api');
  assert.equal(reverseName(reverseName('a.b.c')), 'a.b.c');
});

test('thc revlabel: normaliseFile writes one record a name and counts the refusals', async () => {
  const gz = join(dir, 'day.txt.gz');
  writeFileSync(gz, gzipSync(readFileSync(DAY)));
  const out = join(dir, 'day.records');
  const r = await normaliseFile(gz, out, { gzip: true });
  assert.equal(r.raw.lines, 41);
  assert.equal(r.records_written, 35);
  assert.deepEqual(r.refused, { empty: 0, charset: 2, idn: 0, 'label-empty': 2, 'label-long': 1, 'name-long': 0, 'no-dot': 1 });
  assert.equal(r.idn_converted, 3);
  assert.equal(r.wildcard_records, 3);
  const lines = readFileSync(out, 'latin1').split('\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines.length, 35);
  assert.ok(lines.includes('com.example.www\t0'));
  assert.ok(lines.includes('com.example\t1'));
  assert.ok(lines.includes('de.xn--bcher-kva.www\t0'));
});

test('thc revlabel: readRecords merges the two flags of a name and keeps the order', async () => {
  const f = join(dir, 'sorted.records');
  writeFileSync(f, 'com.example\t0\ncom.example\t1\ncom.example-x\t0\ncom.example.www\t1\nnet.example\t0');
  const got = [];
  const r = await readRecords(f, (key, flags) => {
    got.push([key, flags]);
  });
  assert.deepEqual(got, [
    ['com.example', 3],
    ['com.example-x', 1],
    ['com.example.www', 2],
    ['net.example', 1],
  ]);
  assert.deepEqual(r, { lines: 5, bytes: 75, records: 4 });
});

test('thc revlabel: readRecords refuses an unsorted file and a malformed line', async () => {
  const unsorted = join(dir, 'unsorted.records');
  writeFileSync(unsorted, 'com.example.www\t0\ncom.example\t0\n');
  await assert.rejects(
    readRecords(unsorted, () => {}),
    (err) => err instanceof RecordError && /below/.test(err.message),
  );
  for (const bad of ['com.example\n', 'com.example\t2\n', '\t0\n', 'com.example 0\n']) {
    const f = join(dir, 'bad.records');
    writeFileSync(f, bad);
    await assert.rejects(
      readRecords(f, () => {}),
      RecordError,
      JSON.stringify(bad),
    );
  }
});

test('thc revlabel: the command line writes the records of a plain name list', () => {
  const inp = join(dir, 'names.txt');
  writeFileSync(inp, '*.a.example.com\nb.example.com\n');
  const out = join(dir, 'names.records');
  const printed = JSON.parse(execFileSync(process.execPath, [SCRIPT, inp, out], { encoding: 'utf8' }));
  assert.equal(printed.records_written, 2);
  assert.equal(readFileSync(out, 'latin1'), 'com.example.a\t1\ncom.example.b\t0\n');
});
