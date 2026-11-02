// DOM-030 instrument, copied from .tmp/dom030/mutate.mjs as it ran, with its import and
// output paths moved to docs/research/measure/DOM-030/. Its mutants match
// apps/api/src at 2026-11-02T00:54Z; a later file prints MISSING for a mutant it
// no longer holds. Run from the
// repository root.
// .tmp/dom030/mutate.mjs — scratch guard mutation for DOM-030: plant one defect
// at a time in apps/api/src, run the Worker's tests, and put the file back.
//   node docs/research/measure/DOM-030/04-mutate.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const M = [
  ['cache.ts', 'manifestByTag: 30,', 'manifestByTag: 60,', 'man entry of a tag kept 60 s'],
  ['cache.ts', 'ttl: Math.min(readerTtl - (TTL_S.signedMargin - SIGNED_MARGIN_S), TTL_S.signedMax)', 'ttl: Math.min(readerTtl, TTL_S.signedMax)', 'signed URL kept to se - 60 s'],
  ['cache.ts', "return { kind: \"man\", name, ttl: DIGEST.test(ref) ? TTL_S.manifestByDigest : TTL_S.manifestByTag };", "return { kind: \"man\", name, ttl: TTL_S.manifestByTag };", 'digest manifest kept 30 s'],
  ['root.ts', '  if (m.json.artifactType !== ROOT_TYPE) refuse(', '  if (false) refuse(', 'no artifactType check'],
  ['root.ts', '  if (kept !== null && kept.digest === m.digest) {', '  if (kept !== null) {', 'kept root reused for any digest'],
  ['root.ts', "return { root: kept, reads: [{ tier: kept.tier, pack: kept.digest, sources: [] }], stale: true };", "return { root: kept, reads: [{ tier: kept.tier, pack: kept.digest, sources: [] }], stale: false };", 'stale root not degraded'],
  ['root.ts', "  if (j.format !== ROOT_FORMAT) throw", "  if (false) throw", 'no format check'],
  ['ghcr.ts', '    if (got !== digest) throw new ImmutableError', '    if (false) throw new ImmutableError', 'GHCR bytes not held to digest'],
  ['ghcr.ts', '    else if (isWhole && (await sha256Digest(hit)) !== digest)', '    else if (false)', 'cached body not held to digest'],
  ['pack.ts', '{ partSizes: pack.parts.map((p) => p.size), maxRawBlockBytes: bound }', '{ maxRawBlockBytes: bound }', 'no partSizes'],
  ['pack.ts', 'export const MAX_RAW_BLOCK_BYTES = 1024 * 1024;', 'export const MAX_RAW_BLOCK_BYTES = 16 * 1024 * 1024;', 'bound 16 MiB'],
  ['health.ts', 'const ok = age <= ROOT_AGE_MAX_S;', 'const ok = age < ROOT_AGE_MAX_S;', '6 h exactly fails'],
  ['health.ts', 'const BUILD = /^[0-9a-f]{12}$/;', 'const BUILD = /^[0-9a-fA-F]{12}$/;', 'upper-case BUILD accepted'],
  ['answer.ts', '  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);', '  if (res.status < 400) for (const [name, value] of Object.entries(CORS)) headers.set(name, value);', 'no CORS on errors'],
  ['answer.ts', '  const body = method === "HEAD" || res.status === 204 ? null : res.body;', '  const body = res.status === 204 ? null : res.body;', 'HEAD keeps the body'],
  ['index.ts', '  if (method !== "GET" && method !== "HEAD") return fail(405', '  if (method !== "GET" && method !== "HEAD" && method !== "POST") return fail(405', 'POST passes'],
  ['index.ts', '  if (method === "OPTIONS") return preflight();', '  if (method === "OPTIONS") return fail(404, "not-found", "x");', 'OPTIONS 404'],
  ['guide.ts', '  "internal-error": "The service failed while it made the answer. Retry with backoff.",', '', 'a reason dropped from the stub'],
];

const dir = new URL('../../../../apps/api/src/', import.meta.url);
let killed = 0;
for (const [file, from, to, label] of M) {
  const url = new URL(file, dir);
  const orig = readFileSync(url, 'utf8');
  if (!orig.includes(from)) {
    console.log(`MISSING ${file}: ${label}`);
    continue;
  }
  try {
    writeFileSync(url, orig.replace(from, to));
    const r = spawnSync(process.execPath, ['scripts/test.mjs', 'apps/api'], { cwd: new URL('../../../../', import.meta.url), encoding: 'utf8', timeout: 600_000 });
    const failed = (r.stdout + r.stderr).match(/^✖ (?!failing tests)(.*?) \(\d/gm) ?? [];
    const verdict = r.status === 0 ? 'SURVIVED' : 'killed';
    if (r.status !== 0) killed += 1;
    console.log(`${verdict} (exit ${r.status}) ${file}: ${label}; failing: ${[...new Set(failed)].slice(0, 3).join(' | ')}`);
  } finally {
    writeFileSync(url, orig);
  }
}
console.log(`killed ${killed} of ${M.length}`);
