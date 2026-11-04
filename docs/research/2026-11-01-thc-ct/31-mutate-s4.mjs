// DOM-029 instrument 31, copied from the session scratchpad (mutate-s4.mjs) as it ran on 2026-11-02T08:21Z to 08:51Z.
// The question: whether each guard of thc-plan.mjs, adopt.mjs and ingest-thc.yml can fail a test (stage 4 mutation pass).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/31-mutate-s4.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Mutation pass of DOM-029 stage 4: each mutant edits one guard of a file, runs
// the tests that should kill it, and restores the file byte for byte. A mutant
// is killed only when a test fails (exit not 0). Run from the repository root.
//   node mutate-s4.mjs            every mutant
//   ONLY=regex node mutate-s4.mjs those whose name matches
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const T_PLAN = ['scripts/test.mjs', 'scripts/ingest', '--name', 'thc-plan'];
const T_ADOPT = ['scripts/test.mjs', 'scripts/ingest', '--name', 'adopt'];
const T_WF = ['scripts/test.mjs', 'scripts/workflows', '--name', 'ingest-thc:'];
const T_SCRIPTS = ['scripts/test.mjs', 'scripts/workflows', '--name', 'ingest-thc scripts'];
const PLAN = 'scripts/ingest/thc-plan.mjs';
const ADOPT = 'scripts/ingest/adopt.mjs';
const WF = '.github/workflows/ingest-thc.yml';

const MUTANTS = [
  ['present when one dataset is held', PLAN, 'if (held.every((h) => h !== null)) {', 'if (held.some((h) => h !== null)) {', T_PLAN],
  ['two files read as one', PLAN, 'if (group.size > 1) {', 'if (group.size > 2) {', T_PLAN],
  ['gap one second late', PLAN, 'if (nowMs >= at) entries.push', 'if (nowMs > at) entries.push', T_PLAN],
  ['two lists read as one', PLAN, 'return lists.size === 1 ? [...lists][0] : root.psl;', 'return lists.size >= 1 ? [...lists][0] : root.psl;', T_PLAN],
  ['a stored item wins for a run day', PLAN, ": e.action === 'present' ? (liveByDay.get(e.day) ?? null) : null;", ': (liveByDay.get(e.day) ?? null);', T_PLAN],
  ['root gaps not read', PLAN, "if ((root.gaps[SOURCE] ?? []).includes(day)) {", 'if (false) {', T_PLAN],
  ['state gaps not read', PLAN, "if ((state.gaps?.[SOURCE] ?? []).includes(day)) {", 'if (false) {', T_PLAN],
  ['MAX_DAYS off by one', PLAN, 'if (days.length > MAX_DAYS)', 'if (days.length >= MAX_DAYS)', T_PLAN],
  ['existing tag list ignored', PLAN, "e.psl = e.pslTag !== null ? pslOfManifest(manifests.get(e.pslTag)) : rootListOf(root, e.day);", 'e.psl = rootListOf(root, e.day);', T_PLAN],
  ['a pack without thc-ct holds', PLAN, '.find((p) => p.sources.includes(SOURCE) && spansDay(p, day));', '.find((p) => spansDay(p, day));', T_PLAN],
  ['owed not read', PLAN, "if (tag !== null && state.owed.some((o) => o.ref === `obs:${tag}`))", 'if (false)', T_PLAN],
  ['gap proposals not written', PLAN, "...gaps.map((e) => [e.day, gapProposal(", '...[].map((e) => [e.day, gapProposal(', T_PLAN],
  ['refusal still writes', PLAN, 'if (problems.size > 0) {', 'if (false) {', T_PLAN],
  ['a hold passes', PLAN, "if (r.verdict === 'hold') {", 'if (false) {', T_PLAN],
  ['index read for a held day', PLAN, 'const l = (await hosts.listing()).get(day);', 'const l = await hosts.locate(day);', T_PLAN],
  ['adopt takes any mark', ADOPT, "if (q !== undefined && q !== '1')", 'if (false)', T_ADOPT],
  ['adopt joins two files', ADOPT, 'if (was !== undefined && was.raw !== p.raw)', 'if (false)', T_ADOPT],
  ['adopt history from domains first', ADOPT, "const DATASET_ORDER = ['names', 'domains'];", "const DATASET_ORDER = ['domains', 'names'];", T_ADOPT],
  ['adopt counts records for bytes', ADOPT, 'measure = raw.size;', 'measure = Number(count);', T_ADOPT],
  ['adopt any precision', ADOPT, 'if (precision !== row.precision)', 'if (false)', T_ADOPT],
  ['plan: matrix not held to plan.json', WF, "'.format == \"domains.thc-plan.v1\" and ([.days[] | select(.action == \"run\") | .day] == [$m[0].include[].day])'", "'.format == \"domains.thc-plan.v1\"'", T_WF],
  ['plan: any from proposals', WF, 'if [ "$legs" -gt 0 ]; then\n            any=true', 'if [ "${#files[@]}" -gt 0 ]; then\n            any=true', T_WF],
  ['leg: bytes bound strict', WF, '+ 0 >= 900000000)', '+ 0 > 900000000)', T_WF],
  ['leg: share bound strict', WF, '+ 0 >= 0.01)', '+ 0 > 0.01)', T_WF],
  ['leg: live under any list', WF, 'if [ "$MODE" = live ] && [ "$DAY" = live ] && [ "$PSL" = root ]; then', 'if [ "$MODE" = live ] && [ "$DAY" = live ]; then', T_WF],
  ['leg: psl of any form', WF, 'if ! [[ "$PSL" =~ ^(root|[0-9a-f]{12})$ ]]; then', 'if ! [[ "$PSL" =~ ^(root|[0-9a-zA-Z./]+)$ ]]; then', T_WF],
  ['leg: no state for a backfill leg', WF, ' --state "$RUNNER_TEMP/thc/state.json"', '', T_SCRIPTS],
];

const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
let killed = 0;
let survived = 0;
for (const [name, file, from, to, cmd] of MUTANTS) {
  if (only && !only.test(name)) continue;
  const before = readFileSync(file);
  const text = before.toString('utf8');
  const n = text.split(from).length - 1;
  if (n !== 1) {
    console.log(`SKIP ${name}: the text occurs ${n} times in ${file}`);
    survived += 1;
    continue;
  }
  writeFileSync(file, text.replace(from, to));
  let r;
  try {
    r = spawnSync(process.execPath, cmd, { encoding: 'utf8', timeout: 600_000 });
  } finally {
    writeFileSync(file, before);
  }
  if (!readFileSync(file).equals(before)) throw new Error(`${file} was not restored byte for byte`);
  if (r.status !== 0) {
    killed += 1;
    console.log(`killed ${name} (exit ${r.status})`);
  } else {
    survived += 1;
    console.log(`SURVIVED ${name}`);
  }
}
console.log(`mutants ${killed + survived} killed ${killed} survived ${survived}`);
process.exitCode = survived === 0 ? 0 : 1;
