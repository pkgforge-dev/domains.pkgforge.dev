// scripts/root/show.mjs — read a root as a consumer reads it, with no
// credential (DOM-020, docs/architecture.md section 11): the manifest of
// root:latest, or of a dated root or a digest, its three layers held to their
// digests, root.json validated as a reader validates it (unknown fields and
// datasets ignored), and sources.json held to it.
//
// Usage:
//   node scripts/root/show.mjs [--ref latest|r-YYYYMMDDtHHMMSSz|sha256:DIGEST] [--json]
// Prints the root's digest, root_seq, as_of, created, previous, psl and
// psl_live, then each dataset with its live packs (tier, span, PACKAGE:TAG,
// records, sources), the `through` of each source, the gaps, and each
// manifest a rollback withdrew with its time; with --json, root.json as it was read.
// Exit codes: 0 read and valid · 1 the root does not validate, or a layer
// does not hash to its digest · 2 could not run (bad arguments, GHCR
// unreachable or answering another error, the 429 pauses past their cap) ·
// 4 PRIVATE PACKAGE: the root does not read with no credential (a private
// package and an absent one answer alike) · 70 an internal error, a defect of
// this script (its stack goes to stderr).
import { pathToFileURL } from 'node:url';
import { checkRef, GhcrError, LATEST, NAMESPACE } from '@domains/ghcr';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from '../ghcr/check-public.mjs';
import { RateLimitError } from '../ghcr/rate.mjs';
import { EXIT, Fault, readRoot, ROOT_REF } from './lib.mjs';

const USAGE = 'usage: node scripts/root/show.mjs [--ref latest|r-YYYYMMDDtHHMMSSz|sha256:DIGEST] [--json]';

function parse(argv) {
  let ref = LATEST;
  let json = false;
  let given = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--ref' || a.startsWith('--ref=')) {
      if (given) return '--ref is given twice';
      given = true;
      ref = a === '--ref' ? argv[++i] : a.slice(6);
      if (ref === undefined || ref === '') return '--ref needs a tag or a digest';
    } else return a.startsWith('--') ? `unknown flag ${a}` : `${JSON.stringify(a)} is not a flag`;
  }
  try {
    checkRef(ref);
  } catch (e) {
    return e.message;
  }
  return { ref, json };
}

const pkgTag = (p) => `${p.repo.slice(NAMESPACE.length + 1)}:${p.tag}`;

// The lines of a root read by readRoot.
export function describe(read, ref) {
  const r = read.root;
  const out = [
    `root ${ROOT_REF}:${ref} ${read.digest}`,
    `format ${r.format}`,
    `root_seq ${r.root_seq}`,
    `as_of ${r.as_of ?? 'none'}`,
    `created ${r.created}`,
    `previous ${r.previous ?? 'none'}`,
    `psl ${r.psl}`,
    `psl_live ${r.psl_live.length === 0 ? 'none' : r.psl_live.join(' ')}`,
  ];
  const datasets = Object.entries(r.datasets);
  if (datasets.length === 0) out.push('datasets none: no live pack');
  for (const [ds, packs] of datasets) {
    const c = r.counts[ds];
    out.push(`dataset ${ds}: ${packs.length} live pack(s), ${c?.records ?? '?'} record(s), corpus_since ${r.corpus_since[ds] ?? '?'}`);
    for (const p of packs) out.push(`  ${p.tier} ${p.span.start} ${p.span.end} ${pkgTag(p)} ${p.count} ${p.sources.join(',')}`);
  }
  for (const [id, t] of Object.entries(r.through)) out.push(`through ${id} ${t}`);
  for (const [id, days] of Object.entries(r.gaps)) out.push(`gaps ${id} ${days.join(' ')}`);
  if (r.withdrawn.length === 0) out.push('withdrawn none');
  for (const w of r.withdrawn) out.push(`withdrawn ${w.manifest} ${w.at}`);
  return out;
}

// An error show does not know is a defect, exit 70: never 1 or 4.
export async function main(argv, deps = {}) {
  try {
    return await show(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`show: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function show(argv, { reader = anonymousReader(), out = console.log, err = console.error, sleep, random }) {
  const args = parse(argv);
  if (typeof args === 'string') {
    err(`show: ${args}\n${USAGE}`);
    return EXIT.usage;
  }
  try {
    const read = await readRoot(reader, args.ref, { sleep, random, log: (l) => err(`show: ${l}`) }, { strict: false });
    if (args.json) out(new TextDecoder().decode(read.layers['root.json']).trimEnd());
    else for (const line of describe(read, args.ref)) out(line);
    return EXIT.ok;
  } catch (e) {
    if (isNotPublic(e)) {
      out(PRIVATE_LINE);
      err(`show: ${ROOT_REF}:${args.ref} did not read with no credential: ${e.message}`);
      return EXIT.private;
    }
    if (e instanceof Fault) {
      err(`show: ${e.message}`);
      return EXIT.fault;
    }
    if (e instanceof GhcrError || e instanceof RateLimitError) {
      err(`show: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
