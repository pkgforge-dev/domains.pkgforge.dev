// scripts/measure/thcstat.mjs — the raw-line statistics of a THC daily dump,
// after design B's thcstat.mjs (docs/research/2026-10-27-design-b/scripts/thcstat.mjs),
// for the THC day measurement (DOM-009).
//
// It counts what design B M2 counted before any normalisation: lines, bytes,
// wildcard lines, lines with upper case, lines with a byte outside 0x21..0x7e,
// lines with a carriage return, the longest line, and adjacent inversions (a
// line below the line before it, bytewise), which show whether the file is
// sorted the way `LC_ALL=C sort` sorts. The registrable-domain count design B's
// script also made is regdoms.mjs's job.
//
// Usage:
//   import { createRawStats } from './thcstat.mjs'
//   node scripts/measure/thcstat.mjs FILE.txt.gz [--json OUT]   prints the counts as JSON
// Exit codes: 0 counted, 2 could not run (no file, or a gzip stream that does not check).
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { forEachLineOfFile } from './thc-lines.mjs';

// addBytes(buf, start, end) takes one line without its '\n'; add(line) takes it
// as a latin1 string. result() returns the counts.
export function createRawStats() {
  let lines = 0;
  let bytes = 0;
  let wildcard = 0;
  let upper = 0;
  let nonPrintable = 0;
  let carriageReturn = 0;
  let inversions = 0;
  let maxLength = 0;
  let prev = Buffer.alloc(0);
  let prevStart = 0;
  let prevEnd = 0;
  const addBytes = (buf, start, end) => {
    const n = end - start;
    lines += 1;
    bytes += n + 1;
    if (n > maxLength) maxLength = n;
    if (buf.compare(prev, prevStart, prevEnd, start, end) < 0) inversions += 1;
    prev = buf;
    prevStart = start;
    prevEnd = end;
    if (n >= 2 && buf[start] === 42 && buf[start + 1] === 46) wildcard += 1;
    let hasUpper = false;
    let hasOther = false;
    for (let i = start; i < end; i++) {
      const c = buf[i];
      if (c >= 65 && c <= 90) hasUpper = true;
      else if (c < 0x21 || c > 0x7e) hasOther = true;
    }
    if (hasUpper) upper += 1;
    if (hasOther) nonPrintable += 1;
    if (n > 0 && buf[end - 1] === 13) carriageReturn += 1;
  };
  return {
    addBytes,
    add(line) {
      const buf = Buffer.from(line, 'latin1');
      addBytes(buf, 0, buf.length);
    },
    result() {
      return {
        lines,
        bytes,
        wildcard_lines: wildcard,
        upper_case_lines: upper,
        non_printable_lines: nonPrintable,
        carriage_return_lines: carriageReturn,
        adjacent_inversions: inversions,
        max_line_length: maxLength,
      };
    },
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const [file] = args._;
  if (!file) {
    console.error('usage: node scripts/measure/thcstat.mjs FILE.txt.gz [--json OUT]');
    return 2;
  }
  const stats = createRawStats();
  const t0 = performance.now();
  try {
    await forEachLineOfFile(file, stats.addBytes, { gzip: file.endsWith('.gz'), bytes: true });
  } catch (err) {
    console.error(`thcstat: ${err.message}`);
    return 2;
  }
  const out = { file, ...stats.result(), seconds: +((performance.now() - t0) / 1000).toFixed(3) };
  if (typeof args.json === 'string') writeFileSync(args.json, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
