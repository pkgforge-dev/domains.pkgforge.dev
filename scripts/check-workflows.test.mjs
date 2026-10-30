// scripts/check-workflows.mjs (DOM-014): the workflow policy. clean.yml keeps
// every rule; each other fixture of scripts/fixtures/workflows/ is clean.yml
// with one planted fault, and the check refuses it under that rule alone, at
// the planted line. The variants below plant the other halves of a rule into
// clean.yml in memory. The command line is run on the fixtures, with each exit
// code read from its own process. Every fixture is synthetic: none was
// recorded from a run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ACTION_PINS, checkScript, checkText, defaultFiles, isShell, JOB_GRANTS, MAIN_ONLY_GRANTS, onMainOnly, ROOT_PROMOTE_GRANTS, RULES, scriptFiles } from './check-workflows.mjs';
import { ROOT } from './files.mjs';

const SCRIPT = join(ROOT, 'scripts', 'check-workflows.mjs');
const FIXTURES = join(ROOT, 'scripts', 'fixtures', 'workflows');
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const CLEAN = read('clean.yml');
const rulesOf = (findings) => [...new Set(findings.map((f) => String(f.rule)))];
const PIN = 'cf430e030ddbb5b0abf93d22962f4752f3646cd9';

// clean.yml with `from`, found exactly once, replaced by `to`.
function plant(from, to) {
  const n = CLEAN.split(from).length - 1;
  assert.equal(n, 1, `the text to replace occurs ${n} times in clean.yml: ${from}`);
  return CLEAN.replace(from, to);
}
const refusedBy = (text, rule) => assert.deepEqual(rulesOf(checkText(text)), [rule], JSON.stringify(checkText(text), null, 1));
const accepted = (text) => assert.deepEqual(checkText(text), []);
// For a plant that also runs an action ACTION_PINS does not list (rule 6).
const refusedByAll = (text, rules) => assert.deepEqual(rulesOf(checkText(text)).sort(), [...rules].sort(), JSON.stringify(checkText(text), null, 1));

// Each planted fixture: its rule and the line of its first finding.
const PLANTED = [
  ['parse.yml', 'parse', 48],
  ['top-permissions.yml', '1', 17],
  ['contents-write.yml', '2', 33],
  ['grant-outside-table.yml', '3', 59],
  ['grant-off-main.yml', '3', 34],
  ['shell.yml', '4', 23],
  ['timeout.yml', '5', 55],
  ['unpinned.yml', '6', 50],
  ['checkout-credentials.yml', '6', 37],
  ['run-expression.yml', '7', 44],
  ['trigger.yml', '8', 7],
  ['secret.yml', '9', 43],
  ['delete-package.yml', '10', 44],
  ['runner.yml', '11', 56],
  ['schedule-dispatch.yml', '12', 6],
  ['queue.yml', '13', 21],
  ['root-writer.yml', '13', 67],
  ['upload-overwrite.yml', '14', 49],
  ['if-bang.yml', '15', 48],
];

test('workflow policy: clean.yml keeps every rule', () => {
  accepted(CLEAN);
});

for (const [file, rule, line] of PLANTED) {
  test(`workflow policy: rule ${rule} refuses ${file} at line ${line}, and no other rule fires`, () => {
    const text = read(file);
    assert.match(text.split('\n').slice(0, 6).join('\n'), new RegExp(`^# Synthetic fixture[\\s\\S]*# Rule ${rule}: `, 'm'), 'the header names the planted rule');
    const findings = checkText(text);
    assert.deepEqual(rulesOf(findings), [rule], JSON.stringify(findings, null, 1));
    assert.equal(findings[0].line, line);
  });
}

test('workflow policy: every rule has a planted fixture, and every fixture has its test', () => {
  const planted = new Set(PLANTED.map(([, rule]) => rule));
  for (const rule of Object.keys(RULES)) assert.ok(planted.has(rule), `rule ${rule} has no planted fixture`);
  assert.equal(Object.keys(RULES).length, 16, 'parse and the 15 rules');
  const files = readdirSync(FIXTURES).filter((f) => f !== 'clean.yml');
  assert.deepEqual(files.sort(), PLANTED.map(([f]) => f).sort());
});

test('workflow policy: JOB_GRANTS holds every job name of the DOM-014 table in TODO/foundation.md', () => {
  const entry = readFileSync(join(ROOT, 'TODO', 'foundation.md'), 'utf8');
  const section = entry.slice(entry.indexOf('## DOM-014'), entry.indexOf('\n## ', entry.indexOf('## DOM-014') + 1));
  const rows = section.split('\n').filter((l) => /^\s*\| `[a-z-]+: write` \|/.test(l));
  assert.equal(rows.length, 3, 'the table has the packages, issues and actions rows');
  const table = {};
  for (const row of rows) {
    const [, perm, names] = row.match(/^\s*\| `([a-z-]+): write` \|(.*)\|\s*$/);
    // A job name is a bare lower-case token; a file, a script or an issue key is not.
    table[perm] = [...names.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((n) => /^[a-z][a-z0-9-]*$/.test(n));
  }
  assert.deepEqual(Object.keys(JOB_GRANTS).sort(), Object.keys(table).sort());
  for (const [perm, names] of Object.entries(table)) {
    assert.ok(names.length > 0, perm);
    for (const n of names) assert.ok(JOB_GRANTS[perm].includes(n), `${perm}: ${n} is in the entry's table and not in JOB_GRANTS`);
  }
  // issues joins with the issue script of DOM-034; until then a caller holds packages alone.
  assert.deepEqual(ROOT_PROMOTE_GRANTS, ['packages']);
});

test('workflow policy: rule 1 refuses write-all and read-all, and a missing top-level permissions', () => {
  refusedBy(plant('    permissions:\n      actions: write\n      contents: read\n', '    permissions: write-all\n'), '1');
  refusedBy(plant('permissions: {}\n', 'permissions: read-all\n'), '1');
  const missing = checkText(plant('permissions: {}\n\n', ''));
  assert.deepEqual(rulesOf(missing), ['1']);
  assert.equal(missing[0].line, 1);
});

test('workflow policy: rule 2 refuses pages: write and id-token: write', () => {
  for (const scope of ['pages', 'id-token']) {
    refusedBy(plant('      contents: read\n      packages: write\n    concurrency:', `      contents: read\n      packages: write\n      ${scope}: write\n    concurrency:`), '2');
  }
});

test('workflow policy: rule 3 refuses a grant outside its row, a grant with no row, and a grant reached through an alias', () => {
  // measure-chain is in the actions row, not in the issues row.
  refusedBy(plant('      actions: write\n      contents: read\n', '      actions: write\n      contents: read\n      issues: write\n'), '3');
  refusedBy(plant('      packages: write\n      issues: write\n    steps:', '      packages: write\n      issues: write\n      pull-requests: write\n    steps:'), '3');
  const aliased = plant('    permissions:\n      actions: write\n      contents: read\n', '    permissions: &grants\n      actions: write\n      contents: read\n').concat(
    '\n  dispatch:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions: *grants\n    steps:\n      - run: echo dispatch\n',
  );
  const findings = checkText(aliased);
  assert.deepEqual(rulesOf(findings), ['3'], JSON.stringify(findings));
  assert.match(findings[0].what, /job dispatch holds actions: write/);
  const merged = plant('    permissions:\n      actions: write\n      contents: read\n', '    permissions: &grants\n      actions: write\n      contents: read\n').concat(
    '\n  dispatch:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions:\n      <<: *grants\n    steps:\n      - run: echo dispatch\n',
  );
  refusedBy(merged, '3');
});

// clean.yml with a job `release` that calls `uses`, holding the grants of
// root-promote.yml's job (contents: read, packages: write) and `extra` lines,
// and no group of its own unless `group` names one (ruling 18:
// root-promote.yml holds root-writer itself).
const CALLER = (uses, extra = '', group = null) =>
  CLEAN.concat(
    `\n  release:\n    needs: promote\n    permissions:\n      contents: read\n      packages: write\n${extra}${group === null ? '' : `    concurrency:\n      group: ${group}\n      queue: max\n      cancel-in-progress: false\n`}    uses: ${uses}\n`,
  );
const ROOT_PROMOTE_FILE = join(ROOT, '.github', 'workflows', 'root-promote.yml');
const ROOT_PROMOTE_NAME = '.github/workflows/root-promote.yml';

test('workflow policy: rule 3 lets a job that calls root-promote.yml hold its grants, and rules 5 and 11 skip a reusable call', () => {
  accepted(CALLER('./.github/workflows/root-promote.yml'));
  // The job `promote` of root-promote.yml may hold packages and issues by JOB_GRANTS; today it holds packages alone.
  for (const perm of ['packages', 'issues']) assert.ok(JOB_GRANTS[perm].includes('promote'), perm);
  refusedBy(CALLER('./.github/workflows/root-promote.yml', '      actions: write\n'), '3');
  const other = checkText(CALLER('./.github/workflows/other.yml'));
  assert.deepEqual(rulesOf(other), ['3']);
  assert.equal(other.length, 1, 'packages');
});

test('workflow policy: rule 3 keeps a job that holds packages: write on main, by an if: whose top-level && holds the main test and no || joins', () => {
  assert.deepEqual(MAIN_ONLY_GRANTS, ['packages']);
  for (const cond of [
    "github.ref == 'refs/heads/main'",
    "${{ github.ref == 'refs/heads/main' }}",
    "'refs/heads/main' == github.ref",
    "(github.ref == 'refs/heads/main')",
    "GITHUB.REF == 'refs/heads/main'",
    "${{ !cancelled() && github.ref == 'refs/heads/main' && needs.plan.result == 'success' && (needs.a.result != 'skipped' || needs.b.result != 'skipped') }}",
    "needs.plan.outputs.tag == 'a && b' && github.ref == 'refs/heads/main'",
    // An || inside a string literal joins nothing.
    "github.ref == 'refs/heads/main' && needs.plan.outputs.note != 'a || b'",
  ])
    assert.equal(onMainOnly(cond), true, cond);
  for (const cond of [
    undefined,
    true,
    'true',
    "github.ref != 'refs/heads/main'",
    "github.ref == 'refs/heads/mainline'",
    "github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'",
    "github.event_name == 'schedule' || github.ref == 'refs/heads/main'",
    // && binds tighter than ||: (main && x) || y runs off main when y holds.
    "github.ref == 'refs/heads/main' && needs.plan.result == 'success' || github.event_name == 'workflow_dispatch'",
    "(github.ref == 'refs/heads/main' || true)",
    "contains(github.ref, 'main')",
    "needs.plan.outputs.ref == 'x && github.ref == ''refs/heads/main'''",
  ])
    assert.equal(onMainOnly(cond), false, String(cond));
  // measure-push of clean.yml holds packages: write; promote holds it too, with the bare form.
  refusedBy(plant("    if: ${{ github.ref == 'refs/heads/main' }}\n", ''), '3');
  refusedBy(plant("    if: ${{ github.ref == 'refs/heads/main' }}\n", "    if: ${{ github.ref == 'refs/heads/main' || inputs.day != '' }}\n"), '3');
  refusedBy(plant("    if: github.ref == 'refs/heads/main'\n", "    if: needs.measure-push.result == 'success'\n"), '3');
  accepted(plant("    if: github.ref == 'refs/heads/main'\n", "    if: ${{ !cancelled() && 'refs/heads/main' == github.ref }}\n"));
  // A job with no write grant needs no if:, and a job that calls root-promote.yml is held by the called file's job.
  accepted(plant('    timeout-minutes: 5\n', "    if: github.event_name == 'schedule'\n    timeout-minutes: 5\n"));
  accepted(CALLER('./.github/workflows/root-promote.yml'));
});

test('workflow policy: rule 3 refuses issues: write on a job that calls root-promote.yml until DOM-034 adds the issue script', () => {
  const f = checkText(CALLER('./.github/workflows/root-promote.yml', '      issues: write\n'));
  assert.deepEqual(rulesOf(f), ['3'], JSON.stringify(f));
  assert.match(f[0].what, /^job release holds issues: write, and JOB_GRANTS names only /);
});

test('workflow policy: rule 4 refuses a job whose default shell is not bash', () => {
  refusedBy(plant('    timeout-minutes: 5\n', '    timeout-minutes: 5\n    defaults:\n      run:\n        shell: pwsh\n'), '4');
});

test('workflow policy: rule 6 refuses a pin with no version comment, a short pin and a docker image; it accepts the string false', () => {
  refusedBy(plant(`actions/upload-artifact@${PIN} # v7.0.2`, `actions/upload-artifact@${PIN}`), '6');
  refusedBy(plant(`actions/upload-artifact@${PIN} # v7.0.2`, `actions/upload-artifact@${PIN} # main`), '6');
  refusedBy(plant(`actions/upload-artifact@${PIN} # v7.0.2`, 'actions/upload-artifact@cf430e0 # v7.0.2'), '6');
  refusedBy(plant(`uses: actions/upload-artifact@${PIN} # v7.0.2`, 'uses: docker://alpine:3.22'), '6');
  refusedBy(plant('          persist-credentials: false\n', '          persist-credentials: true\n'), '6');
  accepted(plant('          persist-credentials: false\n', "          persist-credentials: 'false'\n"));
});

test('workflow policy: rule 6 refuses an action ACTION_PINS does not list, another commit of a listed one, and a comment that is not its row', () => {
  assert.deepEqual(ACTION_PINS['actions/upload-artifact'], { sha: PIN, tag: 'v7.0.2' });
  const OTHER = '0123456789abcdef0123456789abcdef01234567';
  const unlisted = checkText(plant(`actions/upload-artifact@${PIN} # v7.0.2`, `attacker/evil@${OTHER} # v1.0.0`));
  assert.deepEqual(rulesOf(unlisted), ['6']);
  assert.match(unlisted[0].what, /attacker\/evil is not in ACTION_PINS/);
  refusedBy(plant(`actions/upload-artifact@${PIN} # v7.0.2`, `actions/upload-artifact@${OTHER} # v7.0.2`), '6');
  const wrongTag = checkText(plant(`actions/upload-artifact@${PIN} # v7.0.2`, `actions/upload-artifact@${PIN} # v7.0.1`));
  assert.deepEqual(rulesOf(wrongTag), ['6']);
  assert.match(wrongTag[0].what, /says v7\.0\.1; ACTION_PINS holds v7\.0\.2/);
});

test('workflow policy: rule 6 refuses a local action, a local call outside .github/workflows/ and an unpinned reusable call', () => {
  const STEP = `uses: actions/upload-artifact@${PIN} # v7.0.2\n        with:\n          name: result\n          path: result.json\n          overwrite: true\n`;
  for (const local of ['./.github/actions/anything', './../../outside/action', './.github/workflows/clean.yml']) refusedBy(plant(STEP, `uses: ${local}\n`), '6');
  const call = (uses) => CLEAN.concat(`\n  call:\n    permissions:\n      contents: read\n    uses: ${uses}\n`);
  accepted(call('./.github/workflows/other.yml'));
  refusedBy(call('./tools/other.yml'), '6');
  refusedBy(call('./.github/workflows/../../tools/other.yml'), '6');
  refusedBy(call('octo/repo/.github/workflows/x.yml@main'), '6');
});

test('workflow policy: rule 7 refuses each untrusted context in run, in any case, and passes github.event_name, run_id and the actor', () => {
  const RUN = '          printf \'day=%s\\n\' "$DAY"\n';
  for (const e of [
    'matrix.day',
    'needs.plan.outputs.matrix',
    'steps.plan.outputs.matrix',
    'github.event.schedule',
    'github.head_ref',
    'github.base_ref',
    'github.ref',
    'github.ref_name',
    "github['event'].inputs.day",
    "github['ref_name']",
    'toJSON(inputs)',
    'INPUTS.day',
    'GITHUB.EVENT.schedule',
  ]) {
    refusedBy(plant(RUN, `          printf 'day=%s\\n' "\${{ ${e} }}"\n`), '7');
  }
  for (const e of ['github.event_name', 'github.run_id', 'github.ref_type', 'github.repository', 'github.actor', 'runner.temp']) {
    accepted(plant(RUN, `          printf 'day=%s\\n' "\${{ ${e} }}"\n`));
  }
});

test('workflow policy: rule 7 reads a step shell and the script of actions/github-script', () => {
  refusedBy(plant('        run: |\n          printf', '        shell: bash --noprofile --norc -e ${{ inputs.day }} {0}\n        run: |\n          printf'), '7');
  const script = checkText(
    plant(
      `uses: actions/upload-artifact@${PIN} # v7.0.2\n        with:\n          name: result\n          path: result.json\n          overwrite: true\n`,
      `uses: actions/github-script@${PIN} # v8.0.0\n        with:\n          script: console.log('\${{ github.event.inputs.day }}')\n`,
    ),
  );
  assert.deepEqual(rulesOf(script).sort(), ['6', '7'], JSON.stringify(script));
  assert.match(script.find((f) => f.rule === 7).what, /inside with\.script/);
});

test('workflow policy: rule 8 refuses a workflow_run trigger, and pull_request_target in the string and the list forms', () => {
  refusedBy(plant('on:\n  schedule:\n', 'on:\n  workflow_run:\n    workflows: [CI]\n  schedule:\n'), '8');
  const ON = "on:\n  schedule:\n    - cron: '17 3 * * *'\n  workflow_dispatch:\n    inputs:\n      day:\n        description: The day to read\n        type: string\n        default: '2026-10-26'\n";
  refusedBy(plant(ON, 'on: pull_request_target\n'), '8');
  refusedBy(plant(ON, 'on: [workflow_dispatch, pull_request_target]\n'), '8');
  accepted(plant(ON, 'on: [workflow_dispatch]\n'));
});

test('workflow policy: rule 9 refuses a Cloudflare name, a deploy, the wrangler action, secrets: inherit, a secret in an if and a workflow_call that takes secrets', () => {
  refusedBy(plant('  workflow_dispatch:\n', '  workflow_call:\n    secrets:\n      token:\n        required: true\n  workflow_dispatch:\n'), '9');
  accepted(plant('  workflow_dispatch:\n', '  workflow_call:\n  workflow_dispatch:\n'));
  refusedBy(
    plant('          GH_TOKEN: ${{ github.token }}\n        run: gh workflow', '          GH_TOKEN: ${{ github.token }}\n          CLOUDFLARE_API_TOKEN: ${{ vars.TOKEN }}\n        run: gh workflow'),
    '9',
  );
  refusedBy(
    plant('          GH_TOKEN: ${{ github.token }}\n        run: gh workflow', '          GH_TOKEN: ${{ github.token }}\n          CF_API_TOKEN: ${{ vars.TOKEN }}\n        run: gh workflow'),
    '9',
  );
  refusedBy(plant('        run: gh workflow run clean.yml', '        run: echo "$CF_API_TOKEN" && gh workflow run clean.yml'), '9');
  refusedBy(plant('          GH_TOKEN: ${{ github.token }}\n        run: gh workflow', '          GH_TOKEN: ${{ SECRETS.X }}\n        run: gh workflow'), '9');
  for (const cmd of ['deploy', 'publish', 'rollback', 'versions upload', 'versions deploy']) {
    refusedBy(plant('        run: gh workflow run clean.yml', `        run: npx wrangler@4.150.0 ${cmd} && gh workflow run clean.yml`), '9');
  }
  const API = 'gh api "orgs/pkgforge-dev/packages/container/domains.pkgforge.dev%2Fprobe" --jq .visibility';
  refusedBy(plant(API, 'npx wrangler@4.150.0 \\\n            deploy'), '9');
  refusedBy(plant(API, 'npx wrangler@4.150.0 \\\n            --config x.toml \\\n            deploy'), '9');
  refusedByAll(plant(`uses: actions/upload-artifact@${PIN} # v7.0.2`, `uses: cloudflare/wrangler-action@${PIN} # v3.14.1`), ['6', '9']);
  refusedBy(CLEAN.concat('\n  call:\n    permissions:\n      contents: read\n    secrets: inherit\n    uses: ./.github/workflows/other.yml\n'), '9');
  // On measure-chain, which holds no packages: write, so rule 3 stays quiet.
  refusedBy(plant('    timeout-minutes: 5\n', "    if: secrets.TOKEN != ''\n    timeout-minutes: 5\n"), '9');
});

test('workflow policy: rule 10 refuses each way of deleting from GHCR, and passes a DELETE away from the registry', () => {
  const API = 'gh api "orgs/pkgforge-dev/packages/container/domains.pkgforge.dev%2Fprobe" --jq .visibility';
  for (const cmd of [
    'oras manifest delete --force ghcr.io/pkgforge-dev/x:tag',
    'oras manifest \\\n            delete ghcr.io/pkgforge-dev/x:tag',
    'crane delete ghcr.io/pkgforge-dev/x:tag',
    'crane --insecure delete ghcr.io/pkgforge-dev/x:tag',
    'skopeo delete docker://ghcr.io/pkgforge-dev/x:tag',
    'regctl manifest rm ghcr.io/pkgforge-dev/x:tag',
    'regctl tag delete ghcr.io/pkgforge-dev/x:tag',
    'docker rmi ghcr.io/pkgforge-dev/x:tag',
    'curl -X DELETE "https://ghcr.io/v2/pkgforge-dev/x/manifests/sha256:00"',
    'curl -sSX DELETE https://ghcr.io/v2/pkgforge-dev/x/manifests/sha256:00',
    'curl -fsSLX DELETE https://ghcr.io/v2/pkgforge-dev/x/manifests/sha256:00',
    'curl --request DELETE https://ghcr.io/v2/pkgforge-dev/x/manifests/sha256:00',
    'curl -X \\\n            DELETE https://ghcr.io/v2/pkgforge-dev/x/manifests/sha256:00',
    'url="orgs/pkgforge-dev/packages/container/x/versions/1"; gh api --method DELETE "$url"',
    `node -e "fetch('https://ghcr.io/v2/x/manifests/sha256:00', { method: 'DELETE' })"`,
    `python3 -c "import requests; requests.delete('https://ghcr.io/v2/x/manifests/sha256:00')"`,
  ]) {
    refusedBy(plant(API, cmd), '10');
  }
  // The URL in an env value, the DELETE in the run string of the same job.
  refusedBy(
    plant(
      '          GH_TOKEN: ${{ github.token }}\n        run: gh workflow run clean.yml',
      '          GH_TOKEN: ${{ github.token }}\n          TARGET: https://ghcr.io/v2/pkgforge-dev/x/manifests/sha256:00\n        run: curl -X DELETE "$TARGET" && gh workflow run clean.yml',
    ),
    '10',
  );
  refusedByAll(plant(`uses: actions/upload-artifact@${PIN} # v7.0.2`, `uses: actions/delete-package-versions@${PIN} # v5.0.0`).replace('          overwrite: true\n', ''), ['6', '10']);
  const STEP = `uses: actions/upload-artifact@${PIN} # v7.0.2\n        with:\n          name: result\n          path: result.json\n          overwrite: true\n`;
  for (const script of ['await github.rest.packages.deletePackageVersionForOrg({})', "await github.request('DELETE /orgs/pkgforge-dev/packages/container/x/versions/1')"]) {
    refusedByAll(plant(STEP, `uses: actions/github-script@${PIN} # v8.0.0\n        with:\n          script: ${JSON.stringify(script)}\n`), ['6', '10']);
  }
  accepted(plant('        run: gh workflow run clean.yml', '        run: gh api -X DELETE "repos/$GITHUB_REPOSITORY/actions/caches/1" && gh workflow run clean.yml'));
});

// A synthetic script: a header comment, then `body` from line 4.
const SCRIPT_HEAD = "// synthetic script\nimport { spawnSync } from 'node:child_process';\nconst ref = 'ghcr.io/pkgforge-dev/x:tag';\n";
const lineOf10 = (text, shell = false) => checkScript(text, shell).map((f) => `${f.rule}:${f.line}`);

test('workflow policy: rule 10 refuses a deletion in a script or a package file, in a string, a command or an argument array, at its line', () => {
  for (const body of [
    "spawnSync('oras', ['manifest', 'delete', ref]);",
    "await deps.oras(['manifest', '--registry-config', config, 'delete', '--force', ref]);",
    'await deps.oras(["blob", "delete", ref]);',
    "spawnSync('regctl', ['tag', 'rm', ref]);",
    'spawnSync("sh", ["-c", `oras manifest delete --force ${ref}`]);',
    "spawnSync('sh', ['-c', 'crane delete ' + ref]);",
    "await fetch(`https://${ref}/v2/x/manifests/sha256:00`, { method: 'DELETE' });",
    "await fetch(url, { method:\n    'DELETE' });",
    "await github.request('DELETE /orgs/pkgforge-dev/packages/container/x/versions/1');",
    'await octokit.rest.packages.deletePackageVersionForOrg({});',
  ]) {
    assert.deepEqual(lineOf10(SCRIPT_HEAD + body), ['10:4'], body);
  }
  // manifest fetch reads; a later 'delete' of another array is not its verb.
  assert.deepEqual(lineOf10(`${SCRIPT_HEAD}await deps.oras(['manifest', 'fetch', ref]);\nconst verbs = ['delete'];`), []);
  // A DELETE in a file that names no registry, and a comment that names a deleter, run nothing against GHCR.
  assert.deepEqual(lineOf10("// synthetic\nawait fetch('https://api.example/caches/1', { method: 'DELETE' });\n"), []);
  assert.deepEqual(lineOf10(`${SCRIPT_HEAD}// never \`oras manifest delete\`, \`crane delete\` or ['manifest', 'delete']\n  // nor curl -X DELETE on ghcr.io\n`), []);
  // A shell script: its # lines are comments, and its commands are read.
  assert.deepEqual(lineOf10('#!/usr/bin/env bash\n# never oras manifest delete\noras manifest delete "$REF"\n', true), ['10:3']);
  assert.deepEqual(lineOf10('#!/usr/bin/env bash\n# never oras manifest delete\noras manifest fetch "$REF"\n', true), []);
  // A flag at the start of a continuation line is reported at its own line, not the line before.
  assert.deepEqual(lineOf10('#!/usr/bin/env bash\ncurl -fsS \\\n-X DELETE "https://ghcr.io/v2/x/manifests/sha256:00"\n', true), ['10:3']);
  // Read as JavaScript, a # line is code: a shell script is never under-read.
  assert.deepEqual(lineOf10('# oras manifest delete "$REF"\n'), ['10:1']);
});

test('workflow policy: rule 10 reads every script and package file, a shell script by its #! line, and leaves out only its own test', () => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  const root = mkdtempSync(join(ROOT, '.tmp', 'check-workflows-'));
  dirs.push(root);
  const files = {
    'scripts/a.mjs': '',
    'scripts/ghcr/b.mjs': '',
    'scripts/c.sh': '',
    'scripts/install-x': '#!/usr/bin/env bash\n',
    'scripts/run-node': '#!/usr/bin/env node\n',
    'scripts/README': 'no shebang\n',
    'scripts/data.json': '{}',
    'scripts/check-workflows.test.mjs': '',
    'scripts/check-workflows.mjs': '',
    'packages/p/src/x.ts': '',
    'packages/p/bench/y.mjs': '',
    'packages/p/test/fixtures/f.bin': '',
    'packages/p/node_modules/dep/index.js': '',
    'packages/p/.cache/z.ts': '',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  assert.deepEqual(
    scriptFiles(root).map((f) => f.shown),
    ['packages/p/bench/y.mjs', 'packages/p/src/x.ts', 'scripts/a.mjs', 'scripts/c.sh', 'scripts/check-workflows.mjs', 'scripts/ghcr/b.mjs', 'scripts/install-x', 'scripts/run-node'],
  );
  assert.equal(isShell('scripts/install-x', files['scripts/install-x']), true);
  assert.equal(isShell('scripts/run-node', files['scripts/run-node']), false);
  assert.equal(isShell('scripts/c.sh', ''), true);
  assert.equal(isShell('scripts/a.mjs', '#!/usr/bin/env bash\n'), false);
  // The real tree: the GHCR writer, the shell installer and the package code are all read.
  const real = scriptFiles(ROOT).map((f) => f.shown);
  for (const f of ['scripts/ghcr/push.mjs', 'scripts/install-oras', 'scripts/check-workflows.mjs', 'packages/ghcr/src/index.ts', 'packages/ledger/bench/ledger-filter.mjs'])
    assert.ok(real.includes(f), f);
  assert.ok(!real.includes('scripts/check-workflows.test.mjs'));
});

// The oras verbs of scripts/ghcr/push.mjs, the one GHCR writer, read from its
// code (comment lines dropped): every `orasCall(label, [...])`, every
// `deps.oras(name, ...)` resolved to the array its name is built from, and
// every process it can start. `unresolved` names a call whose verbs it could not read.
function orasVerbs(text) {
  const code = text
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  const count = (re) => [...code.matchAll(re)].length;
  const verb = (a, b) => (a === 'manifest' || a === 'blob' || a === 'repo' ? `${a} ${b}` : a);
  const verbs = [];
  const unresolved = [];
  const calls = [...code.matchAll(/\borasCall\(\s*(?:'[^'\n]*'|`[^`\n]*`)\s*,\s*\[\s*'([a-z-]+)'(?:\s*,\s*'([a-z-]+)')?/g)];
  for (const m of calls) verbs.push(verb(m[1], m[2]));
  // orasCall's own definition is the one occurrence that is not a call.
  if (count(/\borasCall\(/g) - 1 !== calls.length) unresolved.push('an orasCall whose arguments are not a literal array');
  for (const [, name] of code.matchAll(/\bdeps\.oras\(\s*([A-Za-z_$][\w$]*)/g)) {
    if (name === 'args' && /async function orasCall\(label, args,/.test(code)) continue;
    const built = new RegExp(String.raw`\bconst ${name} = \[\s*'([a-z-]+)'(?:\s*,\s*'([a-z-]+)')?`).exec(code);
    if (built === null) unresolved.push(`deps.oras(${name})`);
    else verbs.push(built[1] === 'push' && built[2] !== '--oci-layout' ? 'push to a registry' : verb(built[1], built[2]));
  }
  // A call of oras that is not deps.oras( with a name: an inline array, an alias.
  if (count(/\boras\(/g) !== count(/\bdeps\.oras\(\s*[A-Za-z_$]/g)) unresolved.push('an oras call not through deps.oras(name)');
  // One import of node:child_process, its spawn called once, in spawnProcess,
  // which only orasRunner names, and orasRunner named only where deps.oras defaults to it.
  const oneSpawn = count(/child_process/g) === 1 && /^import \{ spawn \} from 'node:child_process';$/m.test(code) && count(/\bspawn\(/g) === 1;
  if (!oneSpawn || count(/\bspawnProcess\b/g) !== 2 || count(/\borasRunner\b/g) !== 2) unresolved.push('a process started outside orasRunner');
  return { verbs: [...new Set(verbs)].sort(), unresolved };
}

test('workflow policy: rule 10: the oras calls of scripts/ghcr/push.mjs log in, push to a local layout, fetch a manifest and copy, and nothing else', () => {
  const text = readFileSync(join(ROOT, 'scripts', 'ghcr', 'push.mjs'), 'utf8');
  const allowed = ['copy', 'login', 'manifest fetch', 'push'];
  assert.deepEqual(orasVerbs(text), { verbs: allowed, unresolved: [] });
  // Each plant is refused by this reading alone.
  const swap = (from, to) => {
    assert.equal(text.split(from).length - 1, 1, from);
    return orasVerbs(text.replace(from, to));
  };
  assert.deepEqual(swap("['manifest', 'fetch',", "['manifest', 'delete',").verbs, ['copy', 'login', 'manifest delete', 'push']);
  assert.deepEqual(swap("['copy', '--from-oci-layout',", "['tag', '--from-oci-layout',").verbs, ['login', 'manifest fetch', 'push', 'tag']);
  assert.ok(swap("const pushArgs = ['push', '--oci-layout',", "const pushArgs = ['push', '--disable-path-validation',").verbs.includes('push to a registry'));
  assert.deepEqual(swap('  // 5. The anonymous read-back.', '  await deps.oras(deleteArgs, {});\n  // 5. The anonymous read-back.').unresolved, ['deps.oras(deleteArgs)']);
  assert.deepEqual(swap('  // 5. The anonymous read-back.', "  await deps.oras(['manifest', 'delete', plan.ref], {});\n  // 5. The anonymous read-back.").unresolved, [
    'an oras call not through deps.oras(name)',
  ]);
  assert.deepEqual(swap('  // 5. The anonymous read-back.', "  const { oras } = deps;\n  await oras(['tag', plan.ref]);\n  // 5. The anonymous read-back.").unresolved, [
    'an oras call not through deps.oras(name)',
  ]);
  assert.deepEqual(swap('  // 5. The anonymous read-back.', "  await orasCall('x', rest, {}, 1, deps);\n  // 5. The anonymous read-back.").unresolved, [
    'an orasCall whose arguments are not a literal array',
  ]);
  assert.deepEqual(swap('  // 5. The anonymous read-back.', "  spawnProcess(process.env.ORAS, ['manifest', 'delete', plan.ref]);\n  // 5. The anonymous read-back.").unresolved, [
    'a process started outside orasRunner',
  ]);
});

test('workflow policy: rule 11 refuses a self-hosted runner and a runner from an expression, and accepts the one-label list', () => {
  const RUNS = '    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n';
  refusedBy(plant(RUNS, '    runs-on: [self-hosted]\n    timeout-minutes: 5\n'), '11');
  refusedBy(plant(RUNS, '    runs-on: ${{ inputs.day }}\n    timeout-minutes: 5\n'), '11');
  accepted(plant(RUNS, '    runs-on: [ubuntu-24.04]\n    timeout-minutes: 5\n'));
  refusedBy(plant(RUNS, `${RUNS}    container: evil.example/img:latest\n`), '11');
  refusedBy(plant(RUNS, `${RUNS}    services:\n      db:\n        image: evil.example/db:latest\n`), '11');
});

test('workflow policy: rule 5 refuses a timeout-minutes with no value', () => {
  refusedBy(plant('    timeout-minutes: 5\n', '    timeout-minutes:\n'), '5');
});

test('workflow policy: rule 13 refuses an unknown queue, a cancel from an expression, and a state push outside root-writer', () => {
  refusedBy(plant('  queue: max\n  cancel-in-progress: false\n\ndefaults:', '  queue: all\n  cancel-in-progress: false\n\ndefaults:'), '13');
  refusedBy(plant('  queue: max\n  cancel-in-progress: false\n\ndefaults:', "  queue: max\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n\ndefaults:"), '13');
  const CHAIN = '        run: gh workflow run clean.yml --ref main --repo "$GITHUB_REPOSITORY"\n';
  refusedBy(plant(CHAIN, '        run: |\n          node scripts/ghcr/push.mjs \\\n            "$PKG/state" latest state.json:application/json\n'), '13');
  accepted(plant(CHAIN, '        run: node scripts/ghcr/push.mjs "$PKG/obs" seg-1 seg.bin:application/octet-stream\n'));
});

test('workflow policy: rule 13 lets a job that only calls root-promote.yml hold no group, and refuses one inside root-writer (ruling 18)', () => {
  // The caller with no group of its own: root-promote.yml holds it.
  accepted(CALLER('./.github/workflows/root-promote.yml'));
  // The caller in root-writer, its own: it would wait on the workflow it calls (assumed, not measured).
  const own = checkText(CALLER('./.github/workflows/root-promote.yml', '', 'root-writer'));
  assert.deepEqual(rulesOf(own), ['13'], JSON.stringify(own));
  assert.match(own[0].what, /job release calls root-promote\.yml from inside the group root-writer; root-promote\.yml holds the group itself \(ruling 18\)/);
  // The caller in root-writer through its workflow's group.
  const viaWorkflow = plant('  group: clean\n', '  group: root-writer\n').concat(
    '\n  release:\n    needs: promote\n    permissions:\n      contents: read\n      packages: write\n    uses: ./.github/workflows/root-promote.yml\n',
  );
  const wf = checkText(viaWorkflow);
  assert.deepEqual(rulesOf(wf), ['13'], JSON.stringify(wf));
  assert.match(wf[0].what, /job release calls root-promote\.yml from inside the group root-writer/);
  // Another group on the caller is its own business; a call of another workflow is not this rule's.
  accepted(CALLER('./.github/workflows/root-promote.yml', '', 'release'));
  // A file whose name only ends in root-promote.yml is another workflow: inside
  // root-writer it gets no clause of this rule, and no grant of rule 3.
  const nearMiss = checkText(CALLER('./.github/workflows/not-root-promote.yml', '', 'root-writer'));
  assert.deepEqual(rulesOf(nearMiss), ['3'], JSON.stringify(nearMiss));
  assert.equal(nearMiss.length, 1, 'packages, and no rule 13');
});

test('workflow policy: rule 13 holds root-promote.yml itself in root-writer with queue: max and no cancel (ruling 18), by its name', () => {
  const text = readFileSync(ROOT_PROMOTE_FILE, 'utf8');
  assert.deepEqual(checkText(text, ROOT_PROMOTE_NAME), []);
  const swap = (from, to) => {
    assert.equal(text.split(from).length - 1, 1, from);
    return text.replace(from, to);
  };
  const GROUP = 'concurrency:\n  group: root-writer\n  queue: max\n  cancel-in-progress: false\n';
  // Planted: the group gone, and the step that runs promote.mjs renamed, so
  // that the clause of the file's name is the only guard left to fire.
  const RUN = 'node scripts/root/promote.mjs "${args[@]}"';
  const bare = swap(GROUP, 'concurrency:\n  group: promote\n  queue: max\n  cancel-in-progress: false\n')
    .replace(RUN, 'node scripts/root/other.mjs "${args[@]}"')
    .replace('node scripts/root/rollback.mjs', 'node scripts/root/other.mjs');
  const byName = checkText(bare, ROOT_PROMOTE_NAME);
  assert.deepEqual(rulesOf(byName), ['13'], JSON.stringify(byName));
  assert.match(byName[0].what, /job promote of root-promote\.yml is outside the group root-writer .* \(ruling 18\)/);
  assert.deepEqual(checkText(bare, '.github/workflows/other.yml'), [], 'the same text under another name is no mover');
  assert.deepEqual(checkText(bare, '.github/workflows/other-root-promote.yml'), [], 'a name that only ends in root-promote.yml is another workflow');
  assert.deepEqual(rulesOf(checkText(bare, 'drafts/root-promote.yaml')), ['13'], 'the clause reads the file name in any directory, .yaml too');
  // The group on the job instead of the workflow: its own, which the clause accepts.
  const onJob = swap(GROUP, '').replace('  promote:\n', `  promote:\n${GROUP.replace(/^/gm, '    ').trimEnd()}\n`);
  assert.match(onJob, /^ {2}promote:\n {4}concurrency:\n {6}group: root-writer\n {6}queue: max\n {6}cancel-in-progress: false\n/m);
  assert.doesNotMatch(onJob, /^concurrency:/m);
  assert.deepEqual(checkText(onJob.replace(RUN, 'node scripts/root/other.mjs "${args[@]}"').replace('node scripts/root/rollback.mjs', 'node scripts/root/other.mjs'), ROOT_PROMOTE_NAME), []);
  // The group without queue: max, or with a cancel: refused by the same clause.
  for (const g of ['concurrency:\n  group: root-writer\n  cancel-in-progress: false\n', 'concurrency:\n  group: root-writer\n  queue: single\n  cancel-in-progress: false\n']) {
    const f = checkText(swap(GROUP, g).replace(RUN, 'node scripts/root/other.mjs "${args[@]}"').replace('node scripts/root/rollback.mjs', 'node scripts/root/other.mjs'), ROOT_PROMOTE_NAME);
    assert.deepEqual(rulesOf(f), ['13'], JSON.stringify(f));
  }
});

test('workflow policy: rule 13 reads a run of scripts/root/promote.mjs or rollback.mjs as a move of the root, under any name', () => {
  const CHAIN = '        run: gh workflow run clean.yml --ref main --repo "$GITHUB_REPOSITORY"\n';
  for (const cmd of ['node scripts/root/promote.mjs --add names:names-d-20261026', 'node scripts/root/rollback.mjs --to r-20261029t080000z']) {
    const f = checkText(plant(CHAIN, `        run: ${cmd}\n`));
    assert.deepEqual(rulesOf(f), ['13'], JSON.stringify(f));
    assert.match(f[0].what, /job measure-chain moves a root or state tag outside the group root-writer/);
  }
  // show.mjs only reads.
  accepted(plant(CHAIN, '        run: node scripts/root/show.mjs --ref latest\n'));
});

test('workflow policy: rule 13 accepts queue: single, and refuses a root push, and a root-writer group with no queue or no cancel-in-progress: false', () => {
  accepted(plant('  queue: max\n  cancel-in-progress: false\n\ndefaults:', '  queue: single\n  cancel-in-progress: false\n\ndefaults:'));
  const CHAIN = '        run: gh workflow run clean.yml --ref main --repo "$GITHUB_REPOSITORY"\n';
  refusedBy(plant(CHAIN, '        run: node scripts/ghcr/push.mjs "$PKG/root" latest root.json:application/json\n'), '13');
  const GROUP = '      group: root-writer\n      queue: max\n      cancel-in-progress: false\n    steps:';
  refusedBy(plant(GROUP, '      group: root-writer\n      cancel-in-progress: false\n    steps:'), '13');
  refusedBy(plant(GROUP, '      group: root-writer\n      queue: max\n    steps:'), '13');
});

test("workflow policy: rule 13 accepts the workflow's own root-writer group for a job that moves a tag", () => {
  const text = plant('  group: clean\n', '  group: root-writer\n').replace('    concurrency:\n      group: root-writer\n      queue: max\n      cancel-in-progress: false\n', '');
  accepted(text);
});

test('workflow policy: rule 14 refuses overwrite: false and accepts the string true', () => {
  refusedBy(plant('          overwrite: true\n', '          overwrite: false\n'), '14');
  accepted(plant('          overwrite: true\n', "          overwrite: 'true'\n"));
});

test('workflow policy: rule 15 refuses a job-level unquoted if: ! and accepts the quoted form', () => {
  refusedBy(plant('    timeout-minutes: 5\n', '    if: !cancelled()\n    timeout-minutes: 5\n'), '15');
  accepted(plant('        if: ${{ !cancelled() }}\n', "        if: '!cancelled()'\n"));
});

test('workflow policy: a duplicate key, a second document, a list and a jobs that is not a mapping do not parse as a workflow', () => {
  const dup = checkText(plant('    permissions:\n      actions: write\n      contents: read\n', '    permissions:\n      contents: read\n    permissions:\n      actions: write\n'));
  assert.deepEqual(rulesOf(dup), ['parse']);
  refusedBy(CLEAN.concat('---\npermissions: write-all\n'), 'parse');
  refusedBy('- a\n- b\n', 'parse');
  assert.ok(rulesOf(checkText('permissions: {}\njobs: [a]\n')).includes('parse'));
});

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

test('workflow policy: the command line exits 1 and prints FILE:LINE: rule on delete-package.yml, and 0 on clean.yml', () => {
  const bad = cli('scripts/fixtures/workflows/delete-package.yml');
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /^scripts\/fixtures\/workflows\/delete-package\.yml:44: rule 10: a deletion of GHCR content/m);
  const good = cli('scripts/fixtures/workflows/clean.yml');
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /1 workflow file\(s\) keep the 15 rules/);
});

test('workflow policy: the command line holds a file named root-promote.yml to its clause of rule 13, and passes the real one', () => {
  const good = cli('.github/workflows/root-promote.yml');
  assert.equal(good.status, 0, good.stdout + good.stderr);
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  const dir = mkdtempSync(join(ROOT, '.tmp', 'check-workflows-'));
  dirs.push(dir);
  const text = readFileSync(ROOT_PROMOTE_FILE, 'utf8')
    .replace('  group: root-writer\n', '  group: promote\n')
    .replaceAll('scripts/root/promote.mjs', 'scripts/root/other.mjs')
    .replaceAll('scripts/root/rollback.mjs', 'scripts/root/other.mjs');
  writeFileSync(join(dir, 'root-promote.yml'), text);
  writeFileSync(join(dir, 'renamed.yml'), text);
  const rel = (f) =>
    join(dir, f)
      .slice(ROOT.length + 1)
      .replaceAll('\\', '/');
  const bad = cli(rel('root-promote.yml'));
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /root-promote\.yml:\d+: rule 13: job promote of root-promote\.yml is outside the group root-writer/);
  const renamed = cli(rel('renamed.yml'));
  assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
});

test('workflow policy: the command line exits 2 on a file it cannot read, even beside a finding', () => {
  const r = cli('scripts/fixtures/workflows/no-such-file.yml', 'scripts/fixtures/workflows/delete-package.yml');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no-such-file\.yml: could not read: ENOENT/);
});

test('workflow policy: the default files are the *.yml and *.yaml directly under .github/workflows/', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-workflows-'));
  dirs.push(root);
  const wf = join(root, '.github', 'workflows');
  mkdirSync(join(wf, 'sub'), { recursive: true });
  // A directory named like a workflow is not one.
  mkdirSync(join(wf, 'x.yml'));
  for (const name of ['b.yaml', 'a.yml', 'README.md', 'sub/c.yml']) writeFileSync(join(wf, name), CLEAN);
  assert.deepEqual(
    defaultFiles(root).map((f) => f.shown),
    ['.github/workflows/a.yml', '.github/workflows/b.yaml'],
  );
  const empty = mkdtempSync(join(tmpdir(), 'check-workflows-'));
  dirs.push(empty);
  mkdirSync(join(empty, '.github', 'workflows'), { recursive: true });
  assert.deepEqual(defaultFiles(empty), []);
});

test('workflow policy: the command line exits 2 on a .github/workflows/ that holds no workflow file', () => {
  // A copy of the script under the repository's .tmp/ (gitignored), so that it
  // resolves the yaml package from the repository and reads its own empty tree.
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  const root = mkdtempSync(join(ROOT, '.tmp', 'check-workflows-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'check-workflows.mjs'), readFileSync(SCRIPT));
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-workflows.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /holds no \*\.yml or \*\.yaml file; nothing was examined/);
});

test('workflow policy: the command line reads the scripts and packages beside the workflows, and a named script, for rule 10', () => {
  // A copy of the script under .tmp/, as above, with clean.yml and one synthetic
  // script that deletes a manifest through an oras argument array.
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  const root = mkdtempSync(join(ROOT, '.tmp', 'check-workflows-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts', 'ghcr'), { recursive: true });
  mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  const copy = join(root, 'scripts', 'check-workflows.mjs');
  writeFileSync(copy, readFileSync(SCRIPT));
  writeFileSync(join(root, '.github', 'workflows', 'clean.yml'), CLEAN);
  writeFileSync(join(root, 'packages', 'p', 'src', 'x.ts'), '// synthetic\nexport const x = 1;\n');
  const run = (...args) => spawnSync(process.execPath, [copy, ...args], { cwd: root, encoding: 'utf8' });
  const good = run();
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /1 workflow file\(s\) keep the 15 rules; 2 script and package file\(s\) delete nothing from GHCR \(rule 10\)/);
  writeFileSync(join(root, 'scripts', 'ghcr', 'drop.mjs'), `${SCRIPT_HEAD}await deps.oras(['manifest', 'delete', ref]);\n`);
  const bad = run();
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /^scripts\/ghcr\/drop\.mjs:4: rule 10: a deletion of GHCR content in a script/m);
  const named = run('scripts/ghcr/drop.mjs');
  assert.equal(named.status, 1, named.stdout + named.stderr);
  assert.match(named.stderr, /^scripts\/ghcr\/drop\.mjs:4: rule 10: /m);
});
