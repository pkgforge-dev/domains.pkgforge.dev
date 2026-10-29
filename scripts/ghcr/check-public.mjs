// scripts/ghcr/check-public.mjs — the anonymous-read check of
// docs/architecture.md section 4.7 rule 7: read the manifest of a package's
// newest tag with no credential, as any consumer does.
//
// The read is packages/ghcr's reader: the dummy token `Bearer QQ==` first, then
// the anonymous token flow after a 401 or a 403. It holds no credential and reads
// none from the environment. The newest tag is taken to be the last one GHCR
// lists (every page of the list is read, by Link); --tag names one instead.
// That order is measured on the probe package alone, where the last listed tag
// was the last pushed: `node scripts/ghcr/tags.mjs probe` at
// 2026-10-29T03:10:50Z listed size-1536m, size-4096m, retag, layers-100,
// layers-256, layers-1000, the order .github/workflows/measure-push.yml first
// pushes them. For any other package the order is not measured: what this
// reads is the manifest of whichever tag GHCR lists last.
//
// A workflow that pushes a package runs this as its next step (DOM-019,
// TODO/storage.md). The manifest may be as large as GHCR allows (4 MiB): the
// question is whether it reads, and the probe's newest manifest is over the
// reader's 64 KiB default.
//
// ⚠ An absent package and a private one answer alike to a reader with no
// credential (GHCR: 404 NAME_UNKNOWN to the dummy token, 403 DENIED from the
// token endpoint, MEASURED 2026-10-29T00:38:16Z for the `ref` package before its
// first push), so both are PRIVATE PACKAGE here.
//
// Usage:
//   node scripts/ghcr/check-public.mjs PACKAGE [--tag TAG]
// PACKAGE is a package of ghcr.io/pkgforge-dev/domains.pkgforge.dev/ (`ref`, `root`, ...).
// Prints `public ghcr.io/<repo>:<tag> <digest> via <dummy token|anonymous token>`,
// or the one line `PRIVATE PACKAGE` (the reason goes to stderr).
// Exit codes: 0 the manifest read with no credential · 1 the package lists no
// tag, so there is no manifest to read · 2 could not run (bad arguments, GHCR
// unreachable or answering another error, the 429 pauses past their cap) ·
// 4 PRIVATE PACKAGE: a 401, 403 or 404 after the anonymous flow · 70 an
// internal error, a defect of this script (its stack goes to stderr), never a
// verdict on the package.
import { pathToFileURL } from 'node:url';
import { checkRef, GhcrError, ghcrReader, MANIFEST_LIMIT_BYTES } from '../../packages/ghcr/src/reader.ts';
import { LayoutError, REGISTRY_HOST, repoOf } from '../../packages/ghcr/src/layout.ts';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { RateLimitError, readPaused } from './rate.mjs';

export const PRIVATE_LINE = 'PRIVATE PACKAGE';
export const EXIT = Object.freeze({ ok: 0, empty: 1, usage: 2, private: 4, internal: 70 });
const USAGE = 'usage: node scripts/ghcr/check-public.mjs PACKAGE [--tag TAG]';

// Whether a failed anonymous read means the package does not read publicly.
export const isNotPublic = (err) => err instanceof GhcrError && (err.code === 'refused' || err.code === 'missing');

// The reader every anonymous script uses: the contact User-Agent, the global fetch.
export const anonymousReader = () => ghcrReader({ userAgent: USER_AGENT });

// argv minus the flags this script takes, or a string naming what is wrong.
function parse(argv) {
  const pos = [];
  let tag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag' || a.startsWith('--tag=')) {
      tag = a === '--tag' ? argv[++i] : a.slice(6);
      if (tag === undefined || tag === '') return '--tag needs a tag';
    } else if (a.startsWith('--')) {
      return `unknown flag ${a}`;
    } else {
      pos.push(a);
    }
  }
  if (pos.length !== 1) return 'name one package';
  return { pkg: pos[0], tag };
}

// An error check does not know is a defect, exit 70: never 1 or 4, which are
// verdicts a caller acts on.
export async function main(argv, deps = {}) {
  try {
    return await check(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`check-public: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function check(argv, { reader = anonymousReader(), out = console.log, err = console.error, sleep, random }) {
  const args = parse(argv);
  if (typeof args === 'string') {
    err(`check-public: ${args}\n${USAGE}`);
    return EXIT.usage;
  }
  let repo;
  try {
    repo = repoOf(args.pkg);
    if (args.tag !== null) checkRef(args.tag);
  } catch (e) {
    if (!(e instanceof LayoutError) && !(e instanceof GhcrError)) throw e;
    err(`check-public: ${e.message}\n${USAGE}`);
    return EXIT.usage;
  }
  const deps = { sleep, random, log: (line) => err(`check-public: ${line}`) };
  try {
    let tag = args.tag;
    if (tag === null) {
      const list = await readPaused(`the tag list of ${repo}`, () => reader.listTags(repo), deps);
      if (list.truncated) {
        err(`check-public: the tag list of ${repo} is longer than ${list.pages} pages; name the tag with --tag`);
        return EXIT.usage;
      }
      tag = list.tags.at(-1) ?? null;
      if (tag === null) {
        err(`check-public: ${repo} lists no tag, so there is no manifest to read`);
        return EXIT.empty;
      }
    }
    const m = await readPaused(`the manifest ${tag} of ${repo}`, () => reader.getManifest(repo, tag, { maxBytes: MANIFEST_LIMIT_BYTES }), deps);
    out(`public ${REGISTRY_HOST}/${repo}:${tag} ${m.digest} via ${reader.dial.tokenRequests > 0 ? 'anonymous token' : 'dummy token'}`);
    return EXIT.ok;
  } catch (e) {
    if (isNotPublic(e)) {
      out(PRIVATE_LINE);
      err(`check-public: ${REGISTRY_HOST}/${repo} did not read with no credential: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`check-public: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
