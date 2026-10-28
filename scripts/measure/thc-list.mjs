// scripts/measure/thc-list.mjs — the days of THC's Hugging Face bucket listing,
// for the THC day measurement (DOM-009): the matrix of measure-thc-day.yml and
// the gaps of the span.
//
// The listing is `https://huggingface.co/api/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/tree?recursive=true`
// (54 files on 2026-10-27, TODO/ingest.md DOM-009). A file's path is
// `<year>/<month without a leading zero>/<date>.txt.gz`, and the directory is the
// month of the file's own date. A path is always taken from the listing, never
// built from the date: a day file whose directory does not match its date, or a
// day listed twice, is refused rather than guessed at.
//
// Usage:
//   import { parseListing, planDays, gapsOf, hfUrl, cs2Url } from './thc-list.mjs'
//   node scripts/measure/thc-list.mjs --listing FILE --day DAY [--matrix true|false] [--github-output FILE]
//     --matrix false (the default): DAY alone. --matrix true: every listed day up to and including DAY.
//     Prints {"include":[{"day","path","size"}...]} and the gaps; with --github-output it also
//     appends `matrix=<that JSON>` for a later job's strategy.matrix.
// Exit codes: 0 planned, 1 the listing does not hold DAY or cannot be read as a listing, 2 could not run.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';

export class ListingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ListingError';
  }
}

export const LISTING_URL = 'https://huggingface.co/api/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/tree?recursive=true';
const DAY_FILE = /^(\d{4})\/(\d{1,2})\/((\d{4})-(\d{2})-\d{2})\.txt\.gz$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const hfUrl = (path) => `https://huggingface.co/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/resolve/${path}?download=true`;
export const cs2Url = (day) => `https://cs2.ip.thc.org/${day}.txt.gz`;

export function isDay(text) {
  if (typeof text !== 'string' || !DAY.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

// The listing JSON to [{ day, path, size }] in date order, and the paths that
// are not day files.
export function parseListing(json) {
  if (!Array.isArray(json)) throw new ListingError('the listing is not an array');
  const days = new Map();
  const other = [];
  for (const entry of json) {
    if (entry?.type !== 'file') continue;
    const m = DAY_FILE.exec(entry.path ?? '');
    if (!m) {
      other.push(String(entry.path));
      continue;
    }
    const [, year, month, day, dayYear, dayMonth] = m;
    if (!isDay(day)) throw new ListingError(`${entry.path}: ${day} is not a date`);
    if (year !== dayYear || Number(month) !== Number(dayMonth) || month.startsWith('0')) throw new ListingError(`${entry.path}: the directory is not the month of ${day}`);
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) throw new ListingError(`${entry.path}: size ${entry.size}`);
    if (days.has(day)) throw new ListingError(`${day} is listed twice`);
    days.set(day, { day, path: entry.path, size: entry.size });
  }
  return { days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)), other };
}

// matrix false: the one listed day. matrix true: every listed day up to it.
export function planDays(days, { day, matrix = false }) {
  if (!isDay(day)) throw new ListingError(`${day} is not a date`);
  const picked = matrix ? days.filter((d) => d.day <= day) : days.filter((d) => d.day === day);
  if (!days.some((d) => d.day === day)) throw new ListingError(`the listing does not hold ${day}`);
  return picked;
}

// The calendar days from the first to the last of `days` that are not in it.
export function gapsOf(days) {
  if (days.length === 0) return [];
  const have = new Set(days.map((d) => d.day));
  const gaps = [];
  const end = new Date(`${days[days.length - 1].day}T00:00:00Z`).getTime();
  for (let t = new Date(`${days[0].day}T00:00:00Z`).getTime(); t <= end; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!have.has(d)) gaps.push(d);
  }
  return gaps;
}

export function readListing(path) {
  let json;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ListingError(`${path}: ${err.message}`);
  }
  return parseListing(json);
}

function main(argv) {
  const args = parseArgs(argv);
  if (typeof args.listing !== 'string' || typeof args.day !== 'string') {
    console.error('usage: node scripts/measure/thc-list.mjs --listing FILE --day DAY [--matrix true|false] [--github-output FILE]');
    return 2;
  }
  const matrixArg = args.matrix === undefined ? 'false' : String(args.matrix);
  if (matrixArg !== 'true' && matrixArg !== 'false') {
    console.error(`thc-list: --matrix is true or false, got ${matrixArg}`);
    return 2;
  }
  let plan;
  let listing;
  try {
    listing = readListing(args.listing);
    plan = planDays(listing.days, { day: args.day, matrix: matrixArg === 'true' });
  } catch (err) {
    if (!(err instanceof ListingError)) throw err;
    console.error(`thc-list: ${err.message}`);
    return 1;
  }
  const matrix = JSON.stringify({ include: plan });
  if (typeof args['github-output'] === 'string') appendFileSync(args['github-output'], `matrix=${matrix}\n`);
  console.log(matrix);
  console.log(JSON.stringify({ days: plan.length, bytes: plan.reduce((a, d) => a + d.size, 0), gaps: gapsOf(plan), not_day_files: listing.other }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
