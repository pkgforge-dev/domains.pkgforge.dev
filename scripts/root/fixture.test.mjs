// The GHCR double of scripts/root/fixture.mjs answers a package's tag list,
// and tagAs and fetchTag of scripts/root/lib.mjs move and read a tag of a
// package other than root (DOM-024): the reads every script of scripts/state/
// makes. Every manifest, digest and token is synthetic.
//
//   node scripts/test.mjs scripts/root --name "tag list|tagAs"
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactType, repoOf } from '@domains/ghcr';
import { buildTags } from '../compact/plan.mjs';
import { anonymousReader } from '../ghcr/check-public.mjs';
import { depsFor, registry, sha } from './fixture.mjs';
import { Fault, fetchTag, login, tagAs } from './lib.mjs';

const STATE_REF = 'ghcr.io/pkgforge-dev/domains.pkgforge.dev/state';
const TYPE = artifactType('state');

async function inRegistry(fn) {
  const reg = registry();
  const tmp = mkdtempSync(join(tmpdir(), 'root-fixture-test-'));
  try {
    await fn(reg, tmp);
    assert.deepEqual(reg.w.unusedBodies(), [], 'every GHCR answer body is read or cancelled');
  } finally {
    reg.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const layer = (text) => [{ title: 'state.json', bytes: new TextEncoder().encode(text) }];

test('tag list: the double lists a package tags in the order first written, never its digests, and a package with no manifest is absent', () =>
  inRegistry(async (reg) => {
    reg.seed('state', 'ledger-filter-20261028', TYPE, {}, layer('a'));
    reg.seed('state', 'latest', TYPE, {}, layer('b'));
    reg.seed('state', 'ledger-filter-20261029', TYPE, {}, layer('c'));
    reg.seed('state', 'latest', TYPE, {}, layer('d'));
    const reader = anonymousReader();
    const list = await reader.listTags(repoOf('state'));
    assert.deepEqual(list, { tags: ['ledger-filter-20261028', 'latest', 'ledger-filter-20261029'], pages: 1, truncated: false });
    const logged = [];
    assert.deepEqual(await buildTags('state', 'ledger', reader, { log: (l) => logged.push(l) }), list.tags);
    // feed holds no manifest: GHCR answers 404, which buildTags takes as no build.
    assert.deepEqual(await buildTags('feed', 'hour', reader, { log: (l) => logged.push(l) }), []);
    assert.match(logged.join('\n'), /lists no tag with no credential .+: no build of the hour is there/);
  }));

test('tagAs: moves a tag of state by digest with the token; fetchTag reads it back by the state ref; another writer after a failed call is a Fault', () =>
  inRegistry(async (reg, tmp) => {
    const deps = { ...depsFor(reg, { now: '2026-10-30T08:00:00Z' }), log: () => undefined };
    const ctx = { deps, work: tmp, config: await login(tmp, deps) };
    const one = reg.seed('state', 'state-20261030t080000z', TYPE, {}, layer('one'));
    assert.equal(await fetchTag(ctx, 'latest', STATE_REF), null);
    await tagAs(ctx, { ref: STATE_REF, from: 'state-20261030t080000z', digest: one, tag: 'latest', expected: null });
    const read = await fetchTag(ctx, 'latest', STATE_REF);
    assert.equal(read.digest, one);
    assert.equal(sha(read.bytes), one);
    assert.equal(reg.calls.at(-1).args.at(-1), `${STATE_REF}:latest`);
    // The source of the tag call is the manifest by digest, never the run tag by name.
    const tagCall = reg.calls.find((c) => c.verb === 'tag');
    assert.ok(tagCall.args.includes(`${STATE_REF}@${one}`), tagCall.args.join(' '));
    assert.ok(!tagCall.args.includes(`${STATE_REF}:state-20261030t080000z`));
    // The double refuses a source named by a tag, as a move must not name one.
    const byName = await reg.oras(['tag', '--registry-config', ctx.config, `${STATE_REF}:state-20261030t080000z`, 'x'], {});
    assert.equal(byName.code, 2, byName.stderr);
    // A tag call that fails after another writer moved latest: refused, latest left theirs.
    const two = reg.seed('state', 'state-20261030t081000z', TYPE, {}, layer('two'));
    const theirs = reg.seed('state', null, TYPE, {}, layer('theirs'));
    const oras = deps.oras;
    const failing = async (args, opts) => {
      if (args[0] === 'tag') {
        reg.w.manifests.set('state:latest', reg.w.manifests.get(`state:${theirs}`));
        return { code: 1, stdout: '', stderr: 'Error: 500 Internal Server Error\n' };
      }
      return oras(args, opts);
    };
    await assert.rejects(
      tagAs({ ...ctx, deps: { ...deps, oras: failing } }, { ref: STATE_REF, from: 'state-20261030t081000z', digest: two, tag: 'latest', expected: one }),
      (e) => e instanceof Fault && e.message === `oras tag failed (Error: 500 Internal Server Error), and ${STATE_REF}:latest now holds ${theirs}: another writer moved it`,
    );
    assert.equal(sha(reg.w.manifests.get('state:latest')), theirs);
  }));
