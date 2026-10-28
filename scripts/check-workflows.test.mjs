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
import { ACTION_PINS, checkText, defaultFiles, JOB_GRANTS, ROOT_PROMOTE_GRANTS, RULES } from './check-workflows.mjs';
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
  ['parse.yml', 'parse', 47],
  ['top-permissions.yml', '1', 17],
  ['contents-write.yml', '2', 32],
  ['grant-outside-table.yml', '3', 58],
  ['shell.yml', '4', 23],
  ['timeout.yml', '5', 54],
  ['unpinned.yml', '6', 49],
  ['checkout-credentials.yml', '6', 36],
  ['run-expression.yml', '7', 43],
  ['trigger.yml', '8', 7],
  ['secret.yml', '9', 42],
  ['delete-package.yml', '10', 43],
  ['runner.yml', '11', 55],
  ['schedule-dispatch.yml', '12', 6],
  ['queue.yml', '13', 21],
  ['root-writer.yml', '13', 66],
  ['upload-overwrite.yml', '14', 48],
  ['if-bang.yml', '15', 47],
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
  assert.deepEqual(ROOT_PROMOTE_GRANTS, ['packages', 'issues']);
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

const CALLER = (uses, extra = '') =>
  CLEAN.concat(
    `\n  release:\n    needs: promote\n    permissions:\n      contents: read\n      packages: write\n      issues: write\n${extra}    concurrency:\n      group: root-writer\n      queue: max\n      cancel-in-progress: false\n    uses: ${uses}\n`,
  );

test('workflow policy: rule 3 lets a job that calls root-promote.yml hold its grants, and rules 5 and 11 skip a reusable call', () => {
  accepted(CALLER('./.github/workflows/root-promote.yml'));
  refusedBy(CALLER('./.github/workflows/root-promote.yml', '      actions: write\n'), '3');
  const other = checkText(CALLER('./.github/workflows/other.yml'));
  assert.deepEqual(rulesOf(other), ['3']);
  assert.equal(other.length, 2, 'packages and issues');
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
  refusedBy(plant("    if: github.ref == 'refs/heads/main'\n", "    if: secrets.TOKEN != ''\n"), '9');
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

test('workflow policy: rule 13 refuses an unknown queue, a cancel from an expression, and a state push or a root-promote call outside root-writer', () => {
  refusedBy(plant('  queue: max\n  cancel-in-progress: false\n\ndefaults:', '  queue: all\n  cancel-in-progress: false\n\ndefaults:'), '13');
  refusedBy(plant('  queue: max\n  cancel-in-progress: false\n\ndefaults:', "  queue: max\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n\ndefaults:"), '13');
  const CHAIN = '        run: gh workflow run clean.yml --ref main --repo "$GITHUB_REPOSITORY"\n';
  refusedBy(plant(CHAIN, '        run: |\n          node scripts/ghcr/push.mjs \\\n            "$PKG/state" latest state.json:application/json\n'), '13');
  accepted(plant(CHAIN, '        run: node scripts/ghcr/push.mjs "$PKG/obs" seg-1 seg.bin:application/octet-stream\n'));
  const caller = CALLER('./.github/workflows/root-promote.yml').replace(/(\n {2}release:[\s\S]*?)\n {4}concurrency:\n {6}group: root-writer\n {6}queue: max\n {6}cancel-in-progress: false\n/, '$1\n');
  refusedBy(caller, '13');
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
  refusedBy(plant("    if: github.ref == 'refs/heads/main'\n", '    if: !cancelled()\n'), '15');
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
  assert.match(bad.stderr, /^scripts\/fixtures\/workflows\/delete-package\.yml:43: rule 10: a deletion of GHCR content/m);
  const good = cli('scripts/fixtures/workflows/clean.yml');
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /1 workflow file\(s\) keep the 15 rules/);
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
