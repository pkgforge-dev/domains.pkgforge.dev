// scripts/ghcr/tags.mjs — the tags of one package, read anonymously: the one
// way an entry's Prove reads a package's tags (DOM-019, TODO/storage.md).
//
// It reads every page of `/v2/<repo>/tags/list?n=1000`, following the `Link`
// header (packages/ghcr listTags). ⚠ A single `n=1000` request answers the first
// 1,000 tags only, so a `curl` of that URL under-counts a package that holds
// more. A list cut at the page limit is an error here, never a count.
//
// Usage:
//   node scripts/ghcr/tags.mjs PACKAGE [--prefix P] [--count] [--min N]
// PACKAGE is a package of ghcr.io/pkgforge-dev/domains.pkgforge.dev/ (`ref`, `obs`, ...).
// Prints one tag a line in GHCR's order, those that start with P, or with
// --count their number.
// Exit codes: 0 listed (and with --min, at least N tags match) · 1 with --min,
// fewer than N tags match · 2 could not run (bad arguments, GHCR unreachable or
// answering another error, a list longer than the page limit, the 429 pauses
// past their cap) · 4 PRIVATE PACKAGE: the list did not read with no credential
// (a private package and an absent one answer alike) · 70 an internal error, a
// defect of this script (its stack goes to stderr), never a count.
import { pathToFileURL } from 'node:url';
import { GhcrError } from '../../packages/ghcr/src/reader.ts';
import { LayoutError, repoOf } from '../../packages/ghcr/src/layout.ts';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from './check-public.mjs';
import { RateLimitError, readPaused } from './rate.mjs';

export const EXIT = Object.freeze({ ok: 0, fewer: 1, usage: 2, private: 4, internal: 70 });
const USAGE = 'usage: node scripts/ghcr/tags.mjs PACKAGE [--prefix P] [--count] [--min N]';

function parse(argv) {
  const pos = [];
  const o = { prefix: '', count: false, min: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = a.startsWith('--') ? (eq === -1 ? a : a.slice(0, eq)) : null;
    const value = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    if (name === '--count' && eq === -1) o.count = true;
    else if (name === '--prefix') o.prefix = value();
    else if (name === '--min') {
      const v = value();
      if (v === undefined || !/^\d+$/.test(v)) return `--min needs a whole number, not ${JSON.stringify(v ?? null)}`;
      o.min = Number(v);
    } else if (name !== null) return `unknown flag ${a}`;
    else pos.push(a);
  }
  if (typeof o.prefix !== 'string' || !/^[a-z0-9._-]*$/.test(o.prefix)) return `--prefix ${JSON.stringify(o.prefix ?? null)} is not the start of a tag: lowercase letters, digits, _ . and -`;
  if (pos.length !== 1) return 'name one package';
  return { pkg: pos[0], ...o };
}

// An error readTags does not know is a defect, exit 70: never 1 or 4, which are
// verdicts a caller acts on.
export async function main(argv, deps = {}) {
  try {
    return await readTags(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`tags: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function readTags(argv, { reader = anonymousReader(), out = console.log, err = console.error, sleep, random }) {
  const args = parse(argv);
  if (typeof args === 'string') {
    err(`tags: ${args}\n${USAGE}`);
    return EXIT.usage;
  }
  let repo;
  try {
    repo = repoOf(args.pkg);
  } catch (e) {
    if (!(e instanceof LayoutError)) throw e;
    err(`tags: ${e.message}\n${USAGE}`);
    return EXIT.usage;
  }
  let list;
  try {
    list = await readPaused(`the tag list of ${repo}`, () => reader.listTags(repo), { sleep, random, log: (line) => err(`tags: ${line}`) });
  } catch (e) {
    if (isNotPublic(e)) {
      out(PRIVATE_LINE);
      err(`tags: ${repo} did not read with no credential: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`tags: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
  if (list.truncated) {
    err(`tags: the tag list of ${repo} is longer than ${list.pages} pages; nothing is printed rather than a part of it`);
    return EXIT.usage;
  }
  const match = list.tags.filter((t) => t.startsWith(args.prefix));
  if (args.count) out(String(match.length));
  else for (const t of match) out(t);
  if (args.min !== null && match.length < args.min) {
    err(`tags: ${match.length} tag(s) of ${repo} start with ${JSON.stringify(args.prefix)}, fewer than ${args.min} (${list.tags.length} in all, ${list.pages} page(s))`);
    return EXIT.fewer;
  }
  return EXIT.ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
