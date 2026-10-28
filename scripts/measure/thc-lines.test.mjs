// The line reader and writer of scripts/measure/thc-lines.mjs: lines split
// across chunks, a last line with no newline, bytes above 0x7f kept as latin1,
// back-pressure, and a gzip stream that does not check.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createByteWriter, forEachLine, forEachLineBytes, forEachLineOfFile } from './thc-lines.mjs';

const dir = mkdtempSync(join(tmpdir(), 'thc-lines-'));
after(() => rmSync(dir, { recursive: true, force: true }));

async function* chunks(...parts) {
  for (const p of parts) yield Buffer.from(p, 'latin1');
}

test('thc lines: joins a line split across chunks and keeps a last line with no newline', async () => {
  const got = [];
  const r = await forEachLine(chunks('ab', 'c\nde', 'f\n\ngh'), (l) => {
    got.push(l);
  });
  assert.deepEqual(got, ['abc', 'def', '', 'gh']);
  assert.deepEqual(r, { lines: 4, bytes: 11, finalNewline: false });
});

test('thc lines: keeps a byte above 0x7f as one latin1 code unit', async () => {
  const got = [];
  await forEachLine([Buffer.from([0x61, 0xc3, 0xbc, 0x0a])], (l) => {
    got.push(l);
  });
  assert.equal(got[0].length, 3);
  assert.equal(got[0].charCodeAt(1), 0xc3);
});

test('thc lines: the byte reader gives each line as a range of the chunk', async () => {
  const got = [];
  const r = await forEachLineBytes(chunks('a.com\nb.', 'com\nc.com'), (buf, start, end) => {
    got.push(buf.toString('latin1', start, end));
  });
  assert.deepEqual(got, ['a.com', 'b.com', 'c.com']);
  assert.deepEqual(r, { lines: 3, bytes: 17, finalNewline: false });
});

test('thc lines: the writer waits on back-pressure and writes every byte once', async () => {
  const path = join(dir, 'out.bin');
  const w = createByteWriter(path);
  const block = Buffer.alloc(1 << 20, 0x78);
  let waits = 0;
  for (let i = 0; i < 40; i++) {
    block[0] = i;
    const p = w.write(Buffer.from(block));
    if (p) {
      waits += 1;
      await p;
    }
  }
  const r = await w.close();
  assert.ok(waits > 0);
  assert.equal(r.bytes, 40 << 20);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, 40 << 20);
  assert.equal(bytes[39 << 20], 39);
});

test('thc lines: the writer rejects when the file cannot be written', async () => {
  const w = createByteWriter(join(dir, 'absent-dir', 'out.bin'));
  await assert.rejects(async () => {
    const p = w.write(Buffer.from('x'));
    if (p) await p;
    await w.close();
  });
});

test('thc lines: reads a gzip file, and rejects one that is cut short', async () => {
  const good = join(dir, 'good.gz');
  const body = gzipSync(Buffer.from('a.com\nb.com\n'));
  writeFileSync(good, body);
  const got = [];
  await forEachLineOfFile(
    good,
    (l) => {
      got.push(l);
    },
    { gzip: true },
  );
  assert.deepEqual(got, ['a.com', 'b.com']);
  const cut = join(dir, 'cut.gz');
  writeFileSync(cut, body.subarray(0, body.length - 4));
  await assert.rejects(forEachLineOfFile(cut, () => {}, { gzip: true }));
});
