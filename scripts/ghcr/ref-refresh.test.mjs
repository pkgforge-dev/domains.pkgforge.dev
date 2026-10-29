// .github/workflows/ref-refresh.yml, read as YAML: the contract DOM-019 gives
// it (TODO/storage.md). It runs daily at 05:13 UTC and on dispatch, in the
// group ref-refresh; its one job `ref` holds contents: read and packages:
// write and nothing else; only the push step holds the token; it pushes the
// three files to `ref` with push.mjs, write-once, under their sha12 tags; the
// anonymous read follows the push; and the visibility-ref step is a no-op
// that fails the job until DOM-034. scripts/check-workflows.mjs holds the 15
// rules of every workflow; this test holds what is particular to this one.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { JOB_GRANTS } from '../check-workflows.mjs';

const FILE = fileURLToPath(new URL('../../.github/workflows/ref-refresh.yml', import.meta.url));
const wf = parse(readFileSync(FILE, 'utf8'));
const job = wf.jobs.ref;
const steps = job.steps;
const step = (name) => steps.find((s) => s.name === name);
const joined = (s) => s.run.replace(/\s*\\\n\s*/g, ' ');

test('ref-refresh: daily at 05:13 UTC and on dispatch, one run at a time, main only', () => {
  assert.deepEqual(wf.on.schedule, [{ cron: '13 5 * * *' }]);
  assert.ok(Object.hasOwn(wf.on, 'workflow_dispatch'));
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(wf.concurrency, { group: 'ref-refresh', 'cancel-in-progress': false });
  assert.deepEqual(Object.keys(wf.jobs), ['ref']);
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
});

test('ref-refresh: the job ref holds contents: read and packages: write only, a grant JOB_GRANTS gives it', () => {
  assert.deepEqual(job.permissions, { contents: 'read', packages: 'write' });
  assert.ok(JOB_GRANTS.packages.includes('ref'));
});

test('ref-refresh: only the push step holds the token, and it pushes each file to ref with push.mjs under its own tag and time', () => {
  const holders = steps.filter((s) => JSON.stringify(s.env ?? {}).includes('github.token'));
  assert.deepEqual(
    holders.map((s) => s.name),
    ['Push to the ref package'],
  );
  const push = step('Push to the ref package');
  assert.deepEqual(push.env, { REGISTRY_TOKEN: '${{ github.token }}' });
  const run = joined(push);
  assert.match(run, /for k in psl ctlogs sources; do/);
  assert.match(run, /node scripts\/ghcr\/push\.mjs ref "\$tag" --artifact-type "\$TYPE" --created "\$created" --annotation "dev\.pkgforge\.domains\.sha256=\$sha"/);
  assert.match(run, /TYPE=application\/vnd\.pkgforge\.domains\.ref\.v1/);
  assert.match(run, /"\$file:\$media"/);
  assert.match(run, /exit "\$failed"/);
  assert.doesNotMatch(run, /REGISTRY_TOKEN/);
});

test('ref-refresh: the files are read and checked before the token step, the anonymous read after it, then the visibility no-op', () => {
  const names = steps.map((s) => s.name ?? s.uses);
  const at = (n) => names.indexOf(n);
  assert.ok(at('Read and check the three files') < at('Push to the ref package'));
  assert.ok(at('Push to the ref package') < at('Read the ref package anonymously'));
  assert.ok(at('Read the ref package anonymously') < at('Raise visibility-ref (a no-op until DOM-034)'));
  const read = joined(step('Read and check the three files'));
  for (const k of ['psl', 'ctlogs']) assert.match(read, new RegExp(`node scripts/ghcr/ref-inputs\\.mjs ${k} --out "\\$WORK/${k}" > "\\$WORK/${k}\\.json"`));
  assert.match(read, /ref-inputs\.mjs sources --out "\$WORK\/sources" --created "\$created" --commit "\$GITHUB_SHA"/);
  const pub = step('Read the ref package anonymously');
  assert.equal(pub.id, 'public');
  // check-public's own exit code goes to the output rc and is the step's exit.
  assert.equal(pub.run, 'rc=0\nnode scripts/ghcr/check-public.mjs ref || rc=$?\necho "rc=$rc" >> "$GITHUB_OUTPUT"\nexit "$rc"\n');
  assert.equal(pub.env, undefined);
  const vis = step('Raise visibility-ref (a no-op until DOM-034)');
  // Only exit 4 (PRIVATE PACKAGE) raises visibility-ref; 1, 2 and 70 do not.
  assert.equal(vis.if, "${{ failure() && steps.public.outputs.rc == '4' }}");
  assert.match(vis.run, /exit 1\s*$/);
  // DOM-034 adds scripts/track-issue and the grant together; neither is here yet.
  assert.doesNotMatch(readFileSync(FILE, 'utf8'), /^\s*issues: write/m);
});

test('ref-refresh: every script the workflow runs is in the tree', () => {
  const text = readFileSync(FILE, 'utf8');
  const scripts = [...new Set([...text.matchAll(/scripts\/[a-z/-]+(?:\.mjs)?/g)].map((m) => m[0]))].filter((s) => !s.endsWith('/') && s !== 'scripts/track-issue');
  assert.deepEqual(scripts.sort(), ['scripts/ghcr/check-public.mjs', 'scripts/ghcr/push.mjs', 'scripts/ghcr/ref-inputs.mjs', 'scripts/ghcr/tags.mjs', 'scripts/install-oras']);
  for (const s of scripts) assert.ok(existsSync(fileURLToPath(new URL(`../../${s}`, import.meta.url))), s);
});
