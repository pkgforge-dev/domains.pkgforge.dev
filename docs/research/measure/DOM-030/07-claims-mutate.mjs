// DOM-030 instrument of the pass that weighed the claim audit and the guard
// mutation's B2 and D1, copied from the session's scratch as it ran, with its
// root moved from an absolute path to the repository root.
// Plant one defect at a time in the worktree, run the owning suite, write the
// file back byte for byte. Each mutant must fail a test (exit != 0).
// node docs/research/measure/DOM-030/07-claims-mutate.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MUTANTS = [
  ['B2 kept moves back', 'apps/api/src/root.ts', 'if (kept === null || root.head.root_seq >= kept.head.root_seq) kept = root;', 'kept = root;', ['apps/api', '--name', 'lower root_seq']],
  ['F8 no manifest cap passed', 'apps/api/src/root.ts', 'g.getManifest(ROOT_REPO, ROOT_TAG, { maxBytes: LIMITS.manifestBytes })', 'g.getManifest(ROOT_REPO, ROOT_TAG)', ['apps/api', '--name', 'manifestBytes']],
  ['C11g context outside try', 'apps/api/src/index.ts', '  try {\n    ray = request.headers.get("cf-ray") ?? "-";', '  ray = request.headers.get("cf-ray") ?? "-";\n  try {', ['apps/api', '--name', 'context answers 500']],
  ['C13 bulk files back', 'apps/api/src/guide.ts', 'ask for a shorter window.",', 'ask for a shorter window, or read the bulk files.",', ['apps/api', '--name', 'stubs point']],
  ['C13 cursor back', 'apps/api/src/guide.ts', 'Retry with a narrower request.",', 'Retry with a narrower request, or follow the cursor.",', ['apps/api', '--name', 'stubs point']],
  ['F10 old index line', 'apps/api/src/guide.ts', '"This service asks for no key and no account, and sets no rate limit.",', '"No key, no account and no rate limit.",', ['apps/api', '--name', 'reasons are']],
  ['C16 margin 119', 'apps/api/src/cache.ts', 'signedMargin: 120,', 'signedMargin: 119,', ['apps/api', '--name', 'less than 121']],
  ['C16 floor at 2', 'apps/api/src/cache.ts', 'if (!(seconds >= 1) || this.#cache === null) return;', 'if (!(seconds >= 2) || this.#cache === null) return;', ['apps/api', '--name', 'less than 121']],
  ['F5 literal in ghcr.ts', 'apps/api/src/ghcr.ts', 'export { USER_AGENT };', 'export const UA_COPY = "x (contact: domains@pkgforge.dev)";\nexport { USER_AGENT };', ['apps/api', '--name', 'one contact']],
  ['F5 literal in scripts', 'scripts/lib/user-agent.mjs', "export { USER_AGENT } from '../../packages/core/src/contact.ts';", "export const USER_AGENT = 'domains.pkgforge.dev/1.0 (+https://github.com/pkgforge-dev/domains.pkgforge.dev; contact: domains@pkgforge.dev)';", ['packages/core', '--name', 'contact']],
];

let killed = 0;
for (const [name, rel, from, to, args] of MUTANTS) {
  const file = ROOT + rel;
  const original = readFileSync(file);
  const text = original.toString('utf8');
  const count = text.split(from).length - 1;
  if (count !== 1) {
    console.log(`SKIP ${name}: the text occurs ${count} times`);
    continue;
  }
  let code;
  try {
    writeFileSync(file, text.replace(from, to));
    const r = spawnSync(process.execPath, ['scripts/test.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    code = r.status;
  } finally {
    writeFileSync(file, original);
  }
  const restored = readFileSync(file).equals(original);
  if (code !== 0) killed += 1;
  console.log(`${code !== 0 ? 'KILLED' : 'SURVIVED'} ${name}: exit ${code}, restored ${restored}`);
}
console.log(`${killed} of ${MUTANTS.length} killed`);
process.exitCode = killed === MUTANTS.length ? 0 : 1;
