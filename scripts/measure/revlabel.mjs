// scripts/measure/revlabel.mjs — normalise a THC dump line and reverse its
// labels, after design B's revlabel.mjs
// (docs/research/2026-10-27-design-b/scripts/revlabel.mjs), for the THC day
// measurement (DOM-009).
//
// A record file holds one `KEY\tFLAG` line per input name: KEY is the name with
// its labels reversed (`api.example.com.np` is `np.com.example.api`), FLAG is
// `1` when the line was a wildcard `*.NAME` and `0` otherwise. `LC_ALL=C sort -u`
// of that file puts the keys in the bytewise order of docs/architecture.md
// section 3.2, because a tab sorts below every byte a key can hold. readRecords
// reads the sorted file back and merges the two lines one name can have into
// one record with flags 1 (seen plain), 2 (seen as a wildcard) or 3 (both), as
// design B's blockenc.mjs merged them.
//
// The normalisation is the steps of docs/architecture.md section 3.1 except the
// public-suffix refusal, which needs the list: one trailing carriage return
// dropped, a leading `*.` stripped and flagged, one trailing dot stripped, ASCII
// lowercased, a line with a byte above 0x7f read as UTF-8 and converted with
// domainToASCII, then refused when a byte is outside [a-z0-9_.-], a label is
// empty or over 63 bytes, the name is over 253 bytes or has no dot. The first
// fault in byte order names the refusal, except that a byte above 0x7f anywhere
// sends the line to the conversion first.
//
// normaliseInto works on bytes and writes the record line itself, because the
// stage runs it on every line of a day (38 million on 2026-10-26, and more on a
// September day, by a factor not yet measured on a whole file); normaliseName is
// the same function for one string.
//
// Usage:
//   import { normaliseName, normaliseInto, reverseName, normaliseFile, readRecords } from './revlabel.mjs'
//   node scripts/measure/revlabel.mjs IN OUT [--gzip]   one record line per name of IN; prints the counts as JSON
// Exit codes: 0 written, 2 could not run.
import { domainToASCII, pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { createByteWriter, forEachLineOfFile } from './thc-lines.mjs';
import { createRawStats } from './thcstat.mjs';

export class RecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecordError';
  }
}

export const REFUSALS = ['empty', 'charset', 'idn', 'label-empty', 'label-long', 'name-long', 'no-dot'];
const refuse = (reason) => -1 - REFUSALS.indexOf(reason);
const EMPTY = refuse('empty');
const CHARSET = refuse('charset');
const IDN_REFUSED = refuse('idn');
const LABEL_EMPTY = refuse('label-empty');
const LABEL_LONG = refuse('label-long');
const NAME_LONG = refuse('name-long');
const NO_DOT = refuse('no-dot');
// normaliseInto's answer for a line that holds a byte above 0x7f.
const NEEDS_IDN = -100;
// The longest record line: a 253-byte key, a tab, the flag and '\n'.
export const MAX_RECORD = 256;

// A name of 253 bytes with no empty label has at most 126 dots.
const DOTS = new Int32Array(128);

function hasHighByte(src, start, end) {
  for (let i = start; i < end; i++) if (src[i] > 127) return true;
  return false;
}

// Normalises the line src[start, end) and writes `KEY\tFLAG\n` into out at pos,
// where out has MAX_RECORD bytes free. Returns the position after the record,
// -1 - i for the refusal REFUSALS[i], or NEEDS_IDN.
export function normaliseInto(src, start, end, out, pos) {
  let s = start;
  let e = end;
  if (e > s && src[e - 1] === 13) e -= 1;
  let wild = false;
  if (e - s >= 2 && src[s] === 42 && src[s + 1] === 46) {
    wild = true;
    s += 2;
  }
  if (e > s && src[e - 1] === 46) e -= 1;
  if (e === s) return EMPTY;
  let label = 0;
  let dots = 0;
  let upper = false;
  for (let i = s; i < e; i++) {
    const c = src[i];
    if (c === 46) {
      if (label === 0) return LABEL_EMPTY;
      if (dots < DOTS.length) DOTS[dots] = i;
      dots += 1;
      label = 0;
      continue;
    }
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95) {
      // a byte of the charset
    } else if (c >= 65 && c <= 90) {
      upper = true;
    } else {
      return hasHighByte(src, s, e) ? NEEDS_IDN : CHARSET;
    }
    label += 1;
    if (label > 63) return LABEL_LONG;
  }
  if (label === 0) return LABEL_EMPTY;
  if (e - s > 253) return NAME_LONG;
  if (dots === 0) return NO_DOT;
  let p = pos;
  let labelEnd = e;
  for (let d = dots; d >= 0; d--) {
    const labelStart = d === 0 ? s : DOTS[d - 1] + 1;
    for (let i = labelStart; i < labelEnd; i++) {
      const c = src[i];
      out[p++] = upper && c >= 65 && c <= 90 ? c | 32 : c;
    }
    if (d > 0) out[p++] = 46;
    labelEnd = labelStart - 1;
  }
  out[p++] = 9;
  out[p++] = wild ? 49 : 48;
  out[p++] = 10;
  return p;
}

// The same for a line that holds a byte above 0x7f: its UTF-8 text converted
// with domainToASCII, then normalised as an ASCII line.
function normaliseIdnInto(src, start, end, out, pos) {
  let s = start;
  let e = end;
  if (e > s && src[e - 1] === 13) e -= 1;
  let wild = false;
  if (e - s >= 2 && src[s] === 42 && src[s + 1] === 46) {
    wild = true;
    s += 2;
  }
  const ascii = domainToASCII(src.toString('utf8', s, e));
  if (ascii === '') return IDN_REFUSED;
  const line = Buffer.from((wild ? '*.' : '') + ascii, 'latin1');
  const r = normaliseInto(line, 0, line.length, out, pos);
  return r === NEEDS_IDN ? IDN_REFUSED : r;
}

// Normalises the line and returns { position, idn }: the position as
// normaliseInto returns it.
function normaliseAny(src, start, end, out, pos) {
  const r = normaliseInto(src, start, end, out, pos);
  if (r !== NEEDS_IDN) return { position: r, idn: false };
  return { position: normaliseIdnInto(src, start, end, out, pos), idn: true };
}

// One raw line (a latin1 string of its bytes) to { name, key, wild, idn } or
// { refused: REASON }.
export function normaliseName(raw) {
  const src = Buffer.from(raw, 'latin1');
  const out = Buffer.allocUnsafe(MAX_RECORD);
  const { position, idn } = normaliseAny(src, 0, src.length, out, 0);
  if (position < 0) return { refused: REFUSALS[-1 - position] };
  const key = out.toString('latin1', 0, position - 3);
  return { name: reverseName(key), key, wild: out[position - 2] === 49, idn };
}

export function reverseName(name) {
  return name.split('.').reverse().join('.');
}

const OUT_BYTES = 4 << 20;

// Reads a dump (gzipped when gzip is true) and writes one record line per name
// that passes. Returns the counts: the raw-line statistics of thcstat.mjs, the
// records written, and each refusal with up to three examples.
export async function normaliseFile(inPath, outPath, { gzip = false } = {}) {
  const raw = createRawStats();
  const writer = createByteWriter(outPath);
  const refused = Object.fromEntries(REFUSALS.map((r) => [r, 0]));
  const examples = {};
  let wild = 0;
  let idn = 0;
  let records = 0;
  let out = Buffer.allocUnsafe(OUT_BYTES);
  let pos = 0;
  const flush = () => {
    if (pos === 0) return null;
    const full = out.subarray(0, pos);
    out = Buffer.allocUnsafe(OUT_BYTES);
    pos = 0;
    return writer.write(full);
  };
  const read = await forEachLineOfFile(
    inPath,
    (buf, start, end) => {
      raw.addBytes(buf, start, end);
      const wait = pos + MAX_RECORD > out.length ? flush() : null;
      const r = normaliseAny(buf, start, end, out, pos);
      if (r.position < 0) {
        const reason = REFUSALS[-1 - r.position];
        refused[reason] += 1;
        const list = (examples[reason] ??= []);
        if (list.length < 3) list.push(buf.toString('latin1', start, Math.min(end, start + 120)));
        return wait;
      }
      if (out[r.position - 2] === 49) wild += 1;
      if (r.idn) idn += 1;
      records += 1;
      pos = r.position;
      return wait;
    },
    { gzip, bytes: true },
  );
  const last = flush();
  if (last) await last;
  const written = await writer.close();
  return {
    text_bytes: read.bytes,
    final_newline: read.finalNewline,
    raw: raw.result(),
    records_written: records,
    records_bytes: written.bytes,
    wildcard_records: wild,
    idn_converted: idn,
    refused,
    refused_examples: examples,
  };
}

// Reads a sorted record file and calls fn(key, flags) once per distinct key, in
// order; when fn returns a promise, the next record waits for it. A line that is
// not `KEY\t0` or `KEY\t1`, or a key below the one before it, is a RecordError:
// an unsorted file must not pass for a sorted one.
export async function readRecords(path, fn) {
  let last = null;
  let flags = 0;
  let records = 0;
  let lineNo = 0;
  const read = await forEachLineOfFile(
    path,
    (buf, start, end) => {
      lineNo += 1;
      const tab = end - 2;
      if (tab <= start || buf[tab] !== 9) throw new RecordError(`${path}:${lineNo}: not KEY<tab>FLAG`);
      const f = buf[tab + 1];
      if (f !== 48 && f !== 49) throw new RecordError(`${path}:${lineNo}: flag is not 0 or 1`);
      const key = buf.toString('latin1', start, tab);
      const bit = f === 49 ? 2 : 1;
      if (key === last) {
        flags |= bit;
        return null;
      }
      if (last !== null && key < last) throw new RecordError(`${path}:${lineNo}: key below the key before it`);
      const prev = last;
      const prevFlags = flags;
      last = key;
      flags = bit;
      if (prev === null) return null;
      records += 1;
      return fn(prev, prevFlags);
    },
    { bytes: true },
  );
  if (last !== null) {
    records += 1;
    await fn(last, flags);
  }
  return { lines: read.lines, bytes: read.bytes, records };
}

async function main(argv) {
  const args = parseArgs(argv);
  const [inPath, outPath] = args._;
  if (!inPath || !outPath) {
    console.error('usage: node scripts/measure/revlabel.mjs IN OUT [--gzip]');
    return 2;
  }
  try {
    console.log(JSON.stringify(await normaliseFile(inPath, outPath, { gzip: args.gzip === true })));
    return 0;
  } catch (err) {
    console.error(`revlabel: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
