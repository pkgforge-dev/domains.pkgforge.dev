// scripts/ghcr/push.mjs, offline. The registry is the mock of packages/testkit
// (world): the fake oras below writes what it pushes into the world's
// manifests, and the push's anonymous read-back goes through packages/ghcr's
// reader and the global fetch the world replaces, as in production. The fake
// oras answers the four calls push.mjs makes as oras 1.3.4 does, in the parts
// push.mjs reads: `login` writes the registry config, `push --oci-layout`
// writes a real OCI layout (index.json, blobs) and prints the JSON of
// `--format json`, `manifest fetch` writes the manifest or says `not found`,
// and `copy --from-oci-layout` puts the layout's manifest under the tag and
// its digest. Faults are planted per call. The production runner,
// spawnProcess, is tested on its own against a real child process, and
// push.mjs runs as a process twice: once with no token, once with
// fixtures/fake-oras.mjs as its oras. Every file, token, tag and digest here
// is synthetic.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inWorld } from '@domains/testkit';
import { resetTokens } from '../../packages/ghcr/src/reader.ts';
import { decide, EXIT, excerpt, MAX_LAYERS, main, orasRunner, parsePushArgs, spawnProcess, UsageError } from './push.mjs';
import { attemptSeconds, pauseSeconds, RATE_CAPS_S } from './rate.mjs';

const TOKEN = 'synthetic-test-token';
const ACTOR = 'test-actor';
const PREFIX = 'ghcr.io/pkgforge-dev/domains.pkgforge.dev/';
const TYPE = 'application/vnd.pkgforge.domains.ref.v1';
const CREATED = '2026-10-22T08:36:41Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
// The synthetic file every ref push here carries, and its sha256.
const LIST_TEXT = '// synthetic list\ncom\n';
const SHA_LIST = createHash('sha256').update(LIST_TEXT).digest('hex');
const SCRIPT = fileURLToPath(new URL('./push.mjs', import.meta.url));
const FAKE_ORAS = fileURLToPath(new URL('./fixtures/fake-oras.mjs', import.meta.url));
const EMPTY = { mediaType: 'application/vnd.oci.empty.v1+json', digest: `sha256:${createHash('sha256').update('{}').digest('hex')}`, size: 2, data: 'e30=' };
const NOOP = { fetch: () => new Response(null, { status: 204 }) };
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

const VALUE_FLAGS = new Set(['--format', '--artifact-type', '--annotation', '--registry-config', '--to-registry-config', '--output', '--username']);
function parseOras(args) {
  const pos = [];
  const flags = {};
  const annotations = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (a === '--annotation') annotations.push(v);
      else flags[a] = v;
    } else if (a.startsWith('--')) flags[a] = true;
    else pos.push(a);
  }
  return { pos, flags, annotations };
}
const splitRef = (r) => [r.slice(0, r.lastIndexOf(':')), r.slice(r.lastIndexOf(':') + 1)];

// The fake oras. `plan[verb]` is a list of planted answers, one per call, each
// a result or a function of (args, world) giving one; an empty list answers as
// oras does.
function fakeOras(w, plan = {}) {
  const calls = [];
  const loggedIn = new Set();
  const fn = async (args, opts = {}) => {
    calls.push({ args, input: opts.input ?? '', cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    const verb = args[0] === 'manifest' ? 'fetch' : args[0];
    const planted = plan[verb]?.shift();
    if (planted) return typeof planted === 'function' ? planted(args, w, real) : { stdout: '', stderr: '', ...planted };
    return real(args, opts);
  };
  const real = async (args, opts = {}) => {
    const verb = args[0] === 'manifest' ? 'fetch' : args[0];
    const { pos, flags, annotations } = parseOras(args);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (verb === 'login') {
      mkdirSync(join(flags['--registry-config'], '..'), { recursive: true });
      writeFileSync(flags['--registry-config'], JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from(`${flags['--username']}:${opts.input}`).toString('base64') } } }));
      loggedIn.add(flags['--registry-config']);
      return ok('Login Succeeded\n');
    }
    if (verb === 'push') {
      assert.equal(flags['--oci-layout'], true, 'the build is local');
      const [layout, tag] = splitRef(pos[0]);
      const layers = pos.slice(1).map((f) => {
        const [path, mediaType] = splitRef(f);
        const bytes = readFileSync(join(opts.cwd, path));
        mkdirSync(join(layout, 'blobs', 'sha256'), { recursive: true });
        writeFileSync(join(layout, 'blobs', 'sha256', sha(bytes).slice(7)), bytes);
        return { mediaType, digest: sha(bytes), size: bytes.length, annotations: { 'org.opencontainers.image.title': path.replace(/^\.\//, '') } };
      });
      const ann = Object.fromEntries(annotations.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]).sort(([a], [b]) => (a < b ? -1 : 1)));
      const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', artifactType: flags['--artifact-type'], config: EMPTY, layers, annotations: ann });
      const d = sha(manifest);
      mkdirSync(join(layout, 'blobs', 'sha256'), { recursive: true });
      writeFileSync(join(layout, 'blobs', 'sha256', d.slice(7)), manifest);
      writeFileSync(
        join(layout, 'index.json'),
        JSON.stringify({
          schemaVersion: 2,
          manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: d, size: Buffer.byteLength(manifest), annotations: { 'org.opencontainers.image.ref.name': tag } }],
        }),
      );
      return ok(
        JSON.stringify({
          reference: `${layout}@${d}`,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: d,
          size: Buffer.byteLength(manifest),
          annotations: ann,
          artifactType: flags['--artifact-type'],
        }),
      );
    }
    if (verb === 'fetch' || verb === 'copy') {
      const config = flags['--registry-config'] ?? flags['--to-registry-config'];
      if (!loggedIn.has(config) || !existsSync(config)) return { code: 1, stdout: '', stderr: 'Error: unauthorized: authentication required\n' };
      const ref = pos.at(-1);
      assert.ok(ref.startsWith(PREFIX), ref);
      const key = ref.slice(PREFIX.length);
      if (verb === 'fetch') {
        const body = w.manifests.get(key);
        if (body === undefined) return { code: 1, stdout: '', stderr: `Error: failed to fetch the content of "${ref}": ${ref}: not found\n` };
        writeFileSync(flags['--output'], body);
        return ok();
      }
      assert.equal(flags['--from-oci-layout'], true);
      const [layout, tag] = splitRef(pos[0]);
      const index = JSON.parse(readFileSync(join(layout, 'index.json'), 'utf8'));
      const m = index.manifests.find((x) => x.annotations['org.opencontainers.image.ref.name'] === tag);
      const body = readFileSync(join(layout, 'blobs', 'sha256', m.digest.slice(7)), 'utf8');
      const pkg = key.slice(0, key.indexOf(':'));
      w.manifests.set(key, body);
      w.manifests.set(`${pkg}:${m.digest}`, body);
      return ok(`Copied [oci-layout] ${pos[0]} => [registry] ${ref}\nDigest: ${m.digest}\n`);
    }
    return { code: 2, stdout: '', stderr: `Error: the fake oras does not know ${args[0]}\n` };
  };
  return { fn, calls, real };
}

// A temporary directory with one synthetic file to push.
function scratch(t, files = { 'public_suffix_list.dat': LIST_TEXT }) {
  const dir = mkdtempSync(join(tmpdir(), 'ghcr-push-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'in'));
  mkdirSync(join(dir, 'tmp'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'in', name), text);
  return { dir, file: (name = 'public_suffix_list.dat') => join(dir, 'in', name), tmp: join(dir, 'tmp') };
}

const argsFor = (s, { tag = 'psl-aaaaaaaaaaaa', sha256 = SHA_LIST, created = CREATED, extra = [] } = {}) => [
  'ref',
  tag,
  '--artifact-type',
  TYPE,
  '--created',
  created,
  '--annotation',
  `dev.pkgforge.domains.sha256=${sha256}`,
  '--annotation',
  'dev.pkgforge.domains.run=1',
  ...extra,
  `${s.file()}:text/plain`,
];

// Runs push.mjs's main in a world, with the fake oras, a sleep that records,
// and random() 0 (every 429 pause is 20 s).
async function runPush(s, argv, { oras, env } = {}) {
  const out = [];
  const err = [];
  const sleeps = [];
  const code = await main(argv, {
    env: env ?? { GITHUB_ACTOR: ACTOR, REGISTRY_TOKEN: TOKEN },
    oras: oras.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    tmp: s.tmp,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err, sleeps, verbs: oras.calls.map((c) => (c.args[0] === 'manifest' ? 'fetch' : c.args[0])) };
}
const world = (fn) => inWorld(NOOP, () => undefined, fn, { resetIsolate: resetTokens });

test('push: an absent tag is built locally, copied up, and read back anonymously by digest and by tag', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const oras = fakeOras(w);
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.ok, r.err.join('\n'));
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch', 'copy']);
    const body = w.manifests.get('ref:psl-aaaaaaaaaaaa');
    const digest = sha(body);
    assert.deepEqual(r.out, [`pushed ${PREFIX}ref:psl-aaaaaaaaaaaa ${digest}`]);
    const m = JSON.parse(body);
    assert.equal(m.artifactType, TYPE);
    assert.equal(m.annotations['org.opencontainers.image.created'], CREATED);
    assert.equal(m.annotations['org.opencontainers.image.source'], 'https://github.com/pkgforge-dev/domains.pkgforge.dev');
    assert.equal(m.annotations['dev.pkgforge.domains.sha256'], SHA_LIST);
    assert.equal(m.layers[0].digest, `sha256:${SHA_LIST}`);
    assert.equal(m.layers[0].annotations['org.opencontainers.image.title'], 'public_suffix_list.dat');
    // The read-back holds no credential: the dummy token, by digest, then by tag.
    assert.deepEqual(
      w.requests.map((q) => [q.url.slice(q.url.indexOf('/manifests/') + 11), q.init.headers.authorization]),
      [
        [digest, 'Bearer QQ=='],
        ['psl-aaaaaaaaaaaa', 'Bearer QQ=='],
      ],
    );
    // The build ran in the files' directory, with their names.
    const build = oras.calls[1];
    assert.equal(build.cwd, join(s.dir, 'in'));
    assert.equal(build.args.at(-1), './public_suffix_list.dat:text/plain');
  });
});

test('push: the token reaches oras on the login stdin only, never an argument or the output, and the registry config is gone after the run', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const oras = fakeOras(w);
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.ok);
    assert.equal(oras.calls[0].input, TOKEN);
    assert.deepEqual(oras.calls[0].args.slice(-4), ['--username', ACTOR, '--password-stdin', 'ghcr.io']);
    for (const c of oras.calls) assert.ok(!c.args.some((a) => a.includes(TOKEN)), c.args.join(' '));
    for (const c of oras.calls.slice(1)) assert.equal(c.input, '');
    assert.ok(![...r.out, ...r.err].some((l) => l.includes(TOKEN)));
    const config = oras.calls[0].args[2];
    assert.ok(config.startsWith(s.tmp));
    assert.equal(existsSync(config), false);
    assert.deepEqual(readdirSync(s.tmp), []);
  });
});

test('push: a tag that holds the same manifest is present, and nothing is copied', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    assert.equal((await runPush(s, argsFor(s), { oras: fakeOras(w) })).code, EXIT.ok);
    const before = new Map(w.manifests);
    const oras = fakeOras(w);
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.ok);
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch']);
    assert.match(r.out[0], /^present ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/ref:psl-aaaaaaaaaaaa sha256:[0-9a-f]{64} \(the same manifest\)$/);
    assert.deepEqual(w.manifests, before);
  });
});

test('push: a tag whose manifest differs but carries the same dev.pkgforge.domains.sha256 and file is present', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    assert.equal((await runPush(s, argsFor(s), { oras: fakeOras(w) })).code, EXIT.ok);
    const before = w.manifests.get('ref:psl-aaaaaaaaaaaa');
    const oras = fakeOras(w);
    const r = await runPush(s, argsFor(s, { created: '2026-10-23T00:00:00Z' }), { oras });
    assert.equal(r.code, EXIT.ok);
    assert.match(r.out[0], /\(the same dev\.pkgforge\.domains\.sha256 and layers\)$/);
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch']);
    assert.equal(w.manifests.get('ref:psl-aaaaaaaaaaaa'), before);
  });
});

// A ref manifest as another writer may have left it under a tag: the local
// push's title, media type, size and sha256 annotation unless `o` says otherwise.
const refManifest = (o = {}) =>
  JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: o.type ?? TYPE,
    config: EMPTY,
    layers: [
      {
        mediaType: o.mediaType ?? 'text/plain',
        digest: o.digest ?? `sha256:${SHA_LIST}`,
        size: Buffer.byteLength(LIST_TEXT),
        annotations: { 'org.opencontainers.image.title': o.title ?? 'public_suffix_list.dat' },
      },
    ],
    annotations: { 'dev.pkgforge.domains.sha256': o.sha256 ?? SHA_LIST, 'org.opencontainers.image.created': '2026-10-01T00:00:00Z' },
  });

test('push: a planted rewrite of an existing tag is refused with exit 3 and nothing is written', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    // The tag holds another manifest: other content, another sha256 annotation.
    w.manifest('ref:psl-aaaaaaaaaaaa', [['public_suffix_list.dat', `sha256:${'c'.repeat(64)}`, 9]], { artifactType: TYPE, annotations: { 'dev.pkgforge.domains.sha256': SHA_B } });
    const before = new Map(w.manifests);
    const oras = fakeOras(w);
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, 3);
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch']);
    assert.match(r.out[0], /^replaced ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/ref:psl-aaaaaaaaaaaa holds sha256:[0-9a-f]{64}, not sha256:[0-9a-f]{64}; nothing was written$/);
    assert.deepEqual(w.manifests, before);
    assert.equal(w.requests.length, 0);
  });
});

test('push: a ref tag with the same sha256 annotation over another file is a rewrite, exit 3, and nothing is written', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    // Everything the local manifest holds but the layer digest: the annotation claims bytes the layer is not.
    w.manifests.set('ref:psl-aaaaaaaaaaaa', refManifest({ digest: `sha256:${'c'.repeat(64)}` }));
    const before = new Map(w.manifests);
    const oras = fakeOras(w);
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, 3, r.err.join('\n'));
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch']);
    assert.match(r.out[0], /^replaced /);
    assert.deepEqual(w.manifests, before);
    // The same manifest with the file's own digest is present: the digest alone made the difference.
    w.manifests.set('ref:psl-aaaaaaaaaaaa', refManifest());
    assert.equal((await runPush(s, argsFor(s), { oras: fakeOras(w) })).code, 0);
  });
});

test('push: the same sha256 annotation under another artifact type is a rewrite, not present', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    w.manifest('ref:psl-aaaaaaaaaaaa', [['x', `sha256:${'c'.repeat(64)}`, 9]], { artifactType: 'application/vnd.pkgforge.domains.pack.v1', annotations: { 'dev.pkgforge.domains.sha256': SHA_LIST } });
    const r = await runPush(s, argsFor(s), { oras: fakeOras(w) });
    assert.equal(r.code, EXIT.replaced);
  });
});

test('push: a 429 costs no attempt: two 429s on the copy pause 20 s each and the push goes through', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const busy = { code: 1, stderr: 'Error: response status code 429: toomanyrequests: retry later\n' };
    const oras = fakeOras(w, { copy: [busy, busy] });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.ok, r.err.join('\n'));
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch', 'copy', 'copy', 'copy']);
    assert.deepEqual(r.sleeps, [20_000, 20_000]);
    // No read of the tag between: a 429 is not a failed attempt.
    assert.ok(r.err.some((l) => /429; pausing 20 s \(40 s of at most 1800 s\), which costs no attempt/.test(l)));
  });
});

test('push: the 429 pauses stop at their cap, and the push fails with exit 1', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const busy = { code: 1, stderr: 'Error: 429 Too Many Requests\n' };
    // 1,800 s of 20-second pauses is 90 pauses; the 91st 429 would pass the cap.
    const oras = fakeOras(w, { copy: Array.from({ length: 200 }, () => busy) });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.fault);
    assert.equal(r.sleeps.length, RATE_CAPS_S.part / 20);
    assert.equal(r.verbs.filter((v) => v === 'copy').length, RATE_CAPS_S.part / 20 + 1);
    assert.match(r.err.at(-1), /GHCR answered 429 again after 1800 s of pauses; the next pause of 20 s would pass the cap of 1800 s/);
    assert.equal(w.manifests.size, 0);
  });
});

test('push: a copy that fails three times (not a 429) is a fault, each failure followed by a read of the tag', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const broken = { code: 1, stderr: 'Error: failed to push: connection reset by peer\n' };
    const oras = fakeOras(w, { copy: [broken, broken, broken] });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.fault);
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch', 'copy', 'fetch', 'copy', 'fetch', 'copy', 'fetch']);
    assert.deepEqual(r.sleeps, [10_000, 10_000]);
    assert.match(r.err.at(-1), /oras copy to .* failed 3 times; the last: exit 1: Error: failed to push: connection reset by peer/);
  });
});

test('push: a copy that exits 1 after its manifest landed counts as pushed', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const oras = fakeOras(w, {
      copy: [
        async (args, _w, real) => {
          await real(args);
          return { code: 1, stdout: '', stderr: 'Error: connection reset after the manifest\n' };
        },
      ],
    });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.ok, r.err.join('\n'));
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch', 'copy', 'fetch']);
    assert.match(r.out[0], /^pushed /);
  });
});

test('push: a manifest that does not read anonymously after the push is PRIVATE PACKAGE, exit 4', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    // GHCR as for a private package: the dummy token gets a challenge, the token endpoint denies.
    w.intercept = (url, init) => {
      if (url.startsWith('https://ghcr.io/token')) return w.response(403, '{"errors":[{"code":"DENIED"}]}', {}, { url });
      if (init.headers?.authorization === 'Bearer QQ==') return w.response(401, '', { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' }, { url });
      return undefined;
    };
    const r = await runPush(s, argsFor(s), { oras: fakeOras(w) });
    assert.equal(r.code, 4);
    assert.deepEqual(r.out, ['PRIVATE PACKAGE']);
    assert.deepEqual(r.sleeps, [10_000, 10_000]);
  });
});

test('push: a tag another writer moved between the copy and the read-back is exit 3', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const other = w.manifest('ref:elsewhere', [['x', `sha256:${'d'.repeat(64)}`, 1]]);
    const oras = fakeOras(w, {
      copy: [
        async (args, world, real) => {
          const r = await real(args);
          world.manifests.set('ref:psl-aaaaaaaaaaaa', other);
          return r;
        },
      ],
    });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, 3);
    assert.match(r.out[0], /read anonymously after the copy: another writer moved it$/);
  });
});

test('push: a failed copy after which the tag holds another writer’s manifest is exit 3, and the copy is not tried again', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const other = refManifest({ sha256: SHA_B, digest: `sha256:${SHA_B}` });
    const oras = fakeOras(w, {
      copy: [
        (_args, world) => {
          // Another writer's manifest lands under the tag; this copy fails with no 429.
          world.manifests.set('ref:psl-aaaaaaaaaaaa', other);
          return { code: 1, stdout: '', stderr: 'Error: failed to push: connection reset by peer\n' };
        },
      ],
    });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, 3, r.err.join('\n'));
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch', 'copy', 'fetch']);
    assert.match(r.out[0], /^replaced ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/ref:psl-aaaaaaaaaaaa holds sha256:[0-9a-f]{64}, not sha256:[0-9a-f]{64}; nothing was written$/);
    assert.deepEqual([...w.manifests], [['ref:psl-aaaaaaaaaaaa', other]]);
    assert.deepEqual(r.sleeps, []);
    assert.equal(w.requests.length, 0);
  });
});

// A planted answer to `oras push --oci-layout`: the real layout, then `plant`
// changes it ({ manifest, index, dir } in place) and the manifest blob and the
// index are written back under the new digest, unless `plant` returns 'keep'.
const plantLayout = (s, plant) => async (args, _w, real) => {
  const r = await real(args, { cwd: join(s.dir, 'in') });
  const [layout] = splitRef(parseOras(args).pos[0]);
  const indexPath = join(layout, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const entry = index.manifests[0];
  const manifest = JSON.parse(readFileSync(join(layout, 'blobs', 'sha256', entry.digest.slice(7)), 'utf8'));
  if (plant({ manifest, index, dir: layout }) !== 'keep') {
    const body = JSON.stringify(manifest);
    entry.digest = sha(body);
    entry.size = Buffer.byteLength(body);
    writeFileSync(join(layout, 'blobs', 'sha256', entry.digest.slice(7)), body);
  }
  writeFileSync(indexPath, JSON.stringify(index));
  return { ...r, stdout: JSON.stringify({ digest: index.manifests[0].digest }) };
};

const PACK = 'application/vnd.pkgforge.domains.pack.v1';
const packArgs = (s) => [
  'names',
  'names-d-20261026',
  '--artifact-type',
  PACK,
  '--created',
  '2026-10-27T00:00:00Z',
  `${s.file('part.000')}:application/octet-stream`,
  `${s.file('idx')}:application/octet-stream`,
];

test('push: each fault of the layout oras built, planted alone, is exit 1 before anything is read or copied', async (t) => {
  const ref = (s) => argsFor(s);
  const pack = (s) => packArgs(s);
  const cases = [
    [
      'another artifact type',
      ref,
      ({ manifest }) => (manifest.artifactType = PACK),
      /oras built sha256:[0-9a-f]{64} with the artifact type "application\/vnd\.pkgforge\.domains\.pack\.v1", not application\/vnd\.pkgforge\.domains\.ref\.v1/,
    ],
    ['one layer short', pack, ({ manifest }) => manifest.layers.pop(), /oras built sha256:[0-9a-f]{64} with 1 layers, not 2/],
    [
      'a layer titled otherwise',
      pack,
      ({ manifest }) => (manifest.layers[1].annotations['org.opencontainers.image.title'] = 'other'),
      /with layer 1 titled "other", application\/octet-stream, 2 B, not idx/,
    ],
    [
      'a layer of another media type',
      pack,
      ({ manifest }) => (manifest.layers[0].mediaType = 'application/x-other'),
      /with layer 0 titled "part\.000", application\/x-other, 2 B, not part\.000, application\/octet-stream, 2 B/,
    ],
    [
      'a layer size off by one',
      pack,
      ({ manifest }) => (manifest.layers[0].size += 1),
      /with layer 0 titled "part\.000", application\/octet-stream, 3 B, not part\.000, application\/octet-stream, 2 B/,
    ],
    ['two manifests under the tag', ref, ({ index }) => index.manifests.push({ ...index.manifests[0] }), /the OCI layout's index\.json names 2 manifests under psl-aaaaaaaaaaaa, not 1/],
    [
      'a manifest blob that does not hash to its digest',
      ref,
      ({ index, dir }) => {
        writeFileSync(join(dir, 'blobs', 'sha256', index.manifests[0].digest.slice(7)), `${readFileSync(join(dir, 'blobs', 'sha256', index.manifests[0].digest.slice(7)), 'utf8')} `);
        index.manifests[0].size += 1;
        return 'keep';
      },
      /the manifest blob of the OCI layout does not hash to sha256:[0-9a-f]{64} at \d+ bytes/,
    ],
    [
      'a manifest blob the layout does not hold',
      ref,
      ({ index, dir }) => {
        rmSync(join(dir, 'blobs', 'sha256', index.manifests[0].digest.slice(7)));
        return 'keep';
      },
      /the OCI layout names the manifest blob sha256:[0-9a-f]{64}, which it does not hold: ENOENT/,
    ],
    [
      'a manifest blob of another size than the index names',
      ref,
      ({ index }) => {
        index.manifests[0].size += 1;
        return 'keep';
      },
      /the manifest blob of the OCI layout does not hash to sha256:[0-9a-f]{64} at \d+ bytes/,
    ],
  ];
  for (const [what, args, plant, re] of cases) {
    const s = scratch(t, { 'public_suffix_list.dat': LIST_TEXT, 'part.000': 'p0', idx: 'ix' });
    await world(async (w) => {
      const oras = fakeOras(w, { push: [plantLayout(s, plant)] });
      const r = await runPush(s, args(s), { oras });
      assert.equal(r.code, 1, `${what}: ${r.err.join('\n')}`);
      assert.match(r.err.at(-1), re, what);
      assert.deepEqual(r.verbs, ['login', 'push'], what);
      assert.equal(w.manifests.size, 0, what);
    });
  }
});

test('push: a ref is one file whose sha256 annotation is its layer digest, or exit 1 before anything is read', async (t) => {
  const s = scratch(t, { 'public_suffix_list.dat': LIST_TEXT, 'b.dat': 'b' });
  await world(async (w) => {
    // An annotation that names other bytes than the file.
    const wrong = await runPush(s, argsFor(s, { sha256: SHA_A }), { oras: fakeOras(w) });
    assert.equal(wrong.code, 1);
    assert.match(wrong.err.at(-1), new RegExp(`with the layer sha256:${SHA_LIST}, not the dev\\.pkgforge\\.domains\\.sha256 "${SHA_A}"`));
    assert.deepEqual(wrong.verbs, ['login', 'push']);
    // Two files, the annotation the first one's: the count alone refuses it.
    const two = await runPush(s, argsFor(s, { extra: [`${s.file('b.dat')}:text/plain`] }), { oras: fakeOras(w) });
    assert.equal(two.code, 1);
    assert.match(two.err.at(-1), /with 2 layers; a ref holds one file$/);
    // No annotation at all.
    const none = argsFor(s).filter((a, i, all) => !a.startsWith('dev.pkgforge.domains.sha256=') && !all[i + 1]?.startsWith('dev.pkgforge.domains.sha256='));
    const bare = await runPush(s, none, { oras: fakeOras(w) });
    assert.equal(bare.code, 1);
    assert.match(bare.err.at(-1), /not the dev\.pkgforge\.domains\.sha256 null$/);
    assert.equal(w.manifests.size, 0);
  });
});

test('push: a layout whose manifest is not the one asked for is a fault, and nothing is copied', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const oras = fakeOras(w, {
      push: [
        (args, _w, real) => {
          // oras writing its own created time instead of the one given.
          const i = args.indexOf(`org.opencontainers.image.created=${CREATED}`);
          const changed = [...args];
          changed[i] = 'org.opencontainers.image.created=2026-10-29T00:00:00Z';
          return real(changed, { cwd: join(s.dir, 'in') });
        },
      ],
    });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.fault);
    assert.match(r.err.at(-1), /the annotation org\.opencontainers\.image\.created = "2026-10-29T00:00:00Z", not "2026-10-22T08:36:41Z"/);
    assert.deepEqual(r.verbs, ['login', 'push']);
  });
});

test('push: oras printing a digest the layout does not hold is a fault', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const oras = fakeOras(w, {
      push: [
        async (args, _w, real) => {
          const r = await real(args, { cwd: join(s.dir, 'in') });
          return { ...r, stdout: JSON.stringify({ digest: `sha256:${'e'.repeat(64)}` }) };
        },
      ],
    });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.fault);
    assert.match(r.err.at(-1), /oras printed the digest sha256:e{64}, and the layout holds sha256:/);
  });
});

test('push: a read of the tag that exits 0 and writes no manifest is a fault, exit 1, and nothing is copied', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const oras = fakeOras(w, { fetch: [{ code: 0 }] });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.fault, r.err.join('\n'));
    assert.match(r.err.at(-1), /oras read ghcr\.io\/\S+ with exit 0 and wrote no manifest: ENOENT/);
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch']);
    assert.equal(w.manifests.size, 0);
  });
});

test('push: a read of the tag that fails with neither a 429 nor not found is tried three times, then a fault', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const denied = { code: 1, stderr: 'Error: denied: permission_denied: read_package\n' };
    const oras = fakeOras(w, { fetch: [denied, denied, denied] });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, EXIT.fault);
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch', 'fetch', 'fetch']);
    assert.match(r.err.at(-1), /read .* failed 3 times; the last: exit 1: Error: denied/);
  });
});

test('push: the arguments are checked before oras runs', async (t) => {
  const s = scratch(t, { 'a.dat': 'a', 'b.dat': 'b', '.hidden': 'x' });
  mkdirSync(join(s.dir, 'other'));
  writeFileSync(join(s.dir, 'other', 'c.dat'), 'c');
  const base = ['ref', 'psl-aaaaaaaaaaaa', '--artifact-type', TYPE, '--created', CREATED];
  const cases = [
    [['probe', 'x', '--artifact-type', TYPE, '--created', CREATED, `${s.file('a.dat')}:text/plain`], /not one of the packages/],
    [['ref', 'Psl-A', '--artifact-type', TYPE, '--created', CREATED, `${s.file('a.dat')}:text/plain`], /not a tag/],
    [['ref', 'psl-a', '--artifact-type', 'application/vnd.pkgforge.domains.probe.v1', '--created', CREATED, `${s.file('a.dat')}:text/plain`], /--artifact-type/],
    [['ref', 'psl-a', '--artifact-type', TYPE, `${s.file('a.dat')}:text/plain`], /--created null/],
    [['ref', 'psl-a', '--artifact-type', TYPE, '--created', '2026-10-22T08:36:41.5Z', `${s.file('a.dat')}:text/plain`], /never the push time/],
    [['ref', 'psl-a', '--artifact-type', TYPE, '--created', '2026-02-30T00:00:00Z', `${s.file('a.dat')}:text/plain`], /never the push time/],
    [[...base, '--annotation', 'org.opencontainers.image.created=x', `${s.file('a.dat')}:text/plain`], /the tool's own/],
    [[...base, '--annotation', 'org.opencontainers.image.source=x', `${s.file('a.dat')}:text/plain`], /the tool's own/],
    [[...base, '--annotation', 'dev.pkgforge.domains.sha256=XYZ', `${s.file('a.dat')}:text/plain`], /64 lowercase hex/],
    [[...base, '--annotation', 'a=1', '--annotation', 'a=2', `${s.file('a.dat')}:text/plain`], /given twice/],
    [[...base, '--annotation', 'novalue', `${s.file('a.dat')}:text/plain`], /not KEY=VALUE/],
    [[...base, '--annotation', 'k=line\nbreak', `${s.file('a.dat')}:text/plain`], /control character/],
    [[...base, '--tag', 'x', `${s.file('a.dat')}:text/plain`], /unknown flag --tag/],
    [[...base, `${s.file('a.dat')}:text/plain; charset=utf-8`], /not FILE:MEDIATYPE/],
    [[...base], /at least one FILE/],
    [[...base, ...Array.from({ length: MAX_LAYERS + 1 }, (_, i) => `${s.file(`f${i}`)}:text/plain`)], /257 files; one manifest holds at most 256 layers/],
  ];
  for (const [argv, re] of cases) {
    assert.throws(
      () => parsePushArgs(argv),
      (e) => e instanceof UsageError && re.test(e.message),
      argv.join(' ').slice(0, 300),
    );
  }
  // 256 layers, DOM-006's largest accepted count, is a plan.
  assert.equal(MAX_LAYERS, 256);
  assert.equal(parsePushArgs([...base, ...Array.from({ length: 256 }, (_, i) => `${s.file(`f${i}`)}:text/plain`)]).files.length, 256);
  await world(async (w) => {
    const run = async (argv, env) => runPush(s, argv, { oras: fakeOras(w), env });
    const files = async (...names) => run([...base, ...names]);
    assert.equal((await files(`${s.file('a.dat')}:text/plain`, `${join(s.dir, 'other', 'c.dat')}:text/plain`)).code, 2);
    assert.equal((await files(`${s.file('missing.dat')}:text/plain`)).code, EXIT.usage);
    assert.equal((await files(`${s.file('.hidden')}:text/plain`)).code, EXIT.usage);
    assert.equal((await files(`${s.file('a.dat')}:text/plain`, `${s.file('a.dat')}:text/plain`)).code, EXIT.usage);
    const dir = await files(`${join(s.dir, 'other')}:text/plain`);
    assert.equal(dir.code, 2);
    assert.match(dir.err[0], /other is not a file/);
    assert.deepEqual(dir.verbs, []);
    const noToken = await run([...base, `${s.file('a.dat')}:text/plain`], { GITHUB_ACTOR: ACTOR });
    assert.equal(noToken.code, EXIT.usage);
    assert.match(noToken.err[0], /REGISTRY_TOKEN is not set/);
    const noActor = await run([...base, `${s.file('a.dat')}:text/plain`], { REGISTRY_TOKEN: TOKEN });
    assert.equal(noActor.code, EXIT.usage);
    assert.deepEqual(noActor.verbs, []);
    assert.deepEqual(readdirSync(s.tmp), []);
  });
});

test('push: two files in one directory are two layers in the order given, titled by their names', async (t) => {
  const s = scratch(t, { 'part.000': 'p0', idx: 'ix' });
  await world(async (w) => {
    const argv = [
      'names',
      'names-d-20261026',
      '--artifact-type',
      'application/vnd.pkgforge.domains.pack.v1',
      '--created',
      '2026-10-27T00:00:00Z',
      `${s.file('part.000')}:application/octet-stream`,
      `${s.file('idx')}:application/octet-stream`,
    ];
    const r = await runPush(s, argv, { oras: fakeOras(w) });
    assert.equal(r.code, EXIT.ok, r.err.join('\n'));
    const m = JSON.parse(w.manifests.get('names:names-d-20261026'));
    assert.deepEqual(
      m.layers.map((l) => [l.annotations['org.opencontainers.image.title'], l.size]),
      [
        ['part.000', 2],
        ['idx', 2],
      ],
    );
  });
});

test('push: decide reads present, absent and replaced from the digests, the sha256 annotation, the type and the layers', () => {
  const layer = { mediaType: 'text/plain', digest: `sha256:${SHA_LIST}`, size: 22, annotations: { 'org.opencontainers.image.title': 'f.dat' } };
  const m = (digest, sha256, { type = TYPE, layers = [layer] } = {}) => ({ digest, json: { artifactType: type, layers, annotations: sha256 ? { 'dev.pkgforge.domains.sha256': sha256 } : {} } });
  const other = (o) => [{ ...layer, ...o }];
  assert.deepEqual(decide(m('sha256:1', SHA_A), null), { outcome: 'absent' });
  assert.equal(decide(m('sha256:1', SHA_A), m('sha256:1', SHA_B)).outcome, 'present');
  assert.deepEqual(decide(m('sha256:1', SHA_A), m('sha256:2', SHA_A)), { outcome: 'present', why: 'the same dev.pkgforge.domains.sha256 and layers' });
  assert.equal(decide(m('sha256:1', SHA_A), m('sha256:2', SHA_B)).outcome, 'replaced');
  assert.equal(decide(m('sha256:1', null), m('sha256:2', null)).outcome, 'replaced');
  assert.equal(decide(m('sha256:1', SHA_A), m('sha256:2', null)).outcome, 'replaced');
  // Each difference of the layers, planted alone under the same annotation and type.
  assert.equal(decide(m('sha256:1', SHA_A), m('sha256:2', SHA_A, { layers: other({ digest: `sha256:${SHA_B}` }) })).outcome, 'replaced');
  assert.equal(decide(m('sha256:1', SHA_A), m('sha256:2', SHA_A, { layers: other({ mediaType: 'application/json' }) })).outcome, 'replaced');
  assert.equal(decide(m('sha256:1', SHA_A), m('sha256:2', SHA_A, { layers: other({ annotations: { 'org.opencontainers.image.title': 'g.dat' } }) })).outcome, 'replaced');
  assert.equal(decide(m('sha256:1', SHA_A), m('sha256:2', SHA_A, { layers: [layer, layer] })).outcome, 'replaced');
  // A pack keeps one content across zlib builds: another layer digest and size are present.
  const pack = { type: PACK };
  assert.equal(decide(m('sha256:1', SHA_A, pack), m('sha256:2', SHA_A, { ...pack, layers: other({ digest: `sha256:${SHA_B}`, size: 23 }) })).outcome, 'present');
  assert.equal(decide(m('sha256:1', SHA_A, pack), m('sha256:2', SHA_A, { ...pack, layers: other({ annotations: { 'org.opencontainers.image.title': 'g.dat' } }) })).outcome, 'replaced');
  // Two kinds whose layers compare alike: the type alone refuses.
  assert.equal(decide(m('sha256:1', SHA_A, pack), m('sha256:2', SHA_A, { type: 'application/vnd.pkgforge.domains.segment.v1' })).outcome, 'replaced');
});

test('push: an error push.mjs does not know is exit 70, an internal error with its stack, never 1, and the registry config is still removed', async (t) => {
  const s = scratch(t);
  await world(async (w) => {
    const oras = fakeOras(w, {
      copy: [
        () => {
          throw new TypeError('synthetic defect');
        },
      ],
    });
    const r = await runPush(s, argsFor(s), { oras });
    assert.equal(r.code, 70);
    assert.deepEqual(r.out, []);
    assert.match(r.err.at(-1), /^push: internal error: TypeError: synthetic defect\n\s+at /);
    assert.deepEqual(r.verbs, ['login', 'push', 'fetch', 'copy']);
    assert.equal(w.manifests.size, 0);
    assert.deepEqual(readdirSync(s.tmp), []);
  });
});

test('push: the exit codes are the numbers the header names', () => {
  assert.deepEqual({ ...EXIT }, { ok: 0, fault: 1, usage: 2, replaced: 3, private: 4, internal: 70 });
});

// push.mjs as a process: `env` over this process's environment, ORAS and the
// token unset unless `env` gives them.
function runScript(s, argv, env) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['REGISTRY_TOKEN', 'ORAS', 'NODE_OPTIONS'].includes(k.toUpperCase())));
  return spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', env: { ...base, RUNNER_TEMP: s.tmp, ...env }, timeout: 60_000 });
}

test('push: as a process with no REGISTRY_TOKEN, exit 2 before oras runs', (t) => {
  const s = scratch(t);
  const r = runScript(s, argsFor(s), { GITHUB_ACTOR: ACTOR, ORAS: join(s.dir, 'no-such-oras') });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /REGISTRY_TOKEN is not set/);
  assert.equal(r.stdout, '');
});

test('push: as a process with fixtures/fake-oras.mjs as oras, a tag holding another manifest is exit 3, and no oras process holds the token in its environment', (t) => {
  const s = scratch(t);
  const log = join(s.dir, 'oras.log');
  const remote = join(s.dir, 'remote.json');
  writeFileSync(remote, refManifest({ sha256: SHA_B, digest: `sha256:${SHA_B}` }));
  const r = runScript(s, argsFor(s), {
    GITHUB_ACTOR: ACTOR,
    REGISTRY_TOKEN: TOKEN,
    ORAS: process.execPath,
    NODE_OPTIONS: `--import=${pathToFileURL(FAKE_ORAS).href}`,
    FAKE_ORAS_LOG: log,
    FAKE_ORAS_REMOTE: remote,
  });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /^replaced ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/ref:psl-aaaaaaaaaaaa holds sha256:[0-9a-f]{64}, not sha256:[0-9a-f]{64}; nothing was written\n$/);
  const calls = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    calls.map((c) => c.verb),
    ['login', 'push', 'manifest'],
  );
  assert.deepEqual(
    calls.map((c) => c.envHasToken),
    [false, false, false],
  );
  assert.equal(calls[0].stdin, TOKEN);
  assert.ok(calls.every((c) => !c.args.some((a) => a.includes(TOKEN))));
  assert.ok(!`${r.stdout}${r.stderr}`.includes(TOKEN));
  assert.deepEqual(readdirSync(s.tmp), []);
});

test('push: orasRunner, the production default, gives oras this environment without REGISTRY_TOKEN', async (t) => {
  const was = process.env.REGISTRY_TOKEN;
  process.env.REGISTRY_TOKEN = TOKEN;
  t.after(() => {
    if (was === undefined) delete process.env.REGISTRY_TOKEN;
    else process.env.REGISTRY_TOKEN = was;
  });
  const r = await orasRunner(process.execPath)(['-e', 'process.stdout.write(JSON.stringify([process.env.REGISTRY_TOKEN ?? null, process.env.PATH !== undefined || process.env.Path !== undefined]))']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [null, true]);
});

test('push: an attempt lasts 300 s plus its bytes at 2 MiB/s, at most 600 s; a 429 pauses 20 to 60 s', () => {
  assert.equal(attemptSeconds(0), 300);
  assert.equal(attemptSeconds(2 * 1024 * 1024), 301);
  assert.equal(attemptSeconds(2 * 1024 * 1024 + 1), 302);
  assert.equal(attemptSeconds(600 * 1024 * 1024), 600);
  assert.equal(attemptSeconds(2 ** 30), 600);
  assert.equal(
    pauseSeconds(() => 0),
    20,
  );
  assert.equal(
    pauseSeconds(() => 0.999999),
    60,
  );
  assert.throws(() => pauseSeconds(() => 1), RangeError);
  assert.equal(excerpt('noise\nError: failed https://x.example/u?state=secret\nmore'), 'Error: failed https://x.example/u');
});

test('push: spawnProcess, the production runner, passes stdin and cwd, returns the exit code, and ends a process past its time', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcr-spawn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const echo = await spawnProcess(
    process.execPath,
    ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s.length+" "+process.cwd());process.stderr.write("e");process.exit(7)})'],
    { input: TOKEN, cwd: dir },
  );
  assert.equal(echo.code, 7);
  assert.equal(echo.stdout, `${TOKEN.length} ${dir}`);
  assert.equal(echo.stderr, 'e');
  assert.equal(echo.timedOut, false);
  const hang = await spawnProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300 });
  assert.equal(hang.code, 124);
  assert.equal(hang.timedOut, true);
  const none = await spawnProcess(join(dir, 'no-such-oras'), ['version']);
  assert.equal(none.code, 127);
  assert.match(none.stderr, /cannot start/);
});
