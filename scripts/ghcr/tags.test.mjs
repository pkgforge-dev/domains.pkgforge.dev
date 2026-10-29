// scripts/ghcr/tags.mjs and scripts/ghcr/check-public.mjs, offline, against the
// mock registry of packages/testkit (world) through the global fetch, the
// production dial. The tag list is paged as GHCR pages it (a relative Link to
// `?last=<tag>&n=<n>`, MEASURED 2026-10-29T00:38:16Z on the probe package), a
// private package answers the dummy token with a challenge and its token
// request with 403, and an absent one answers 404 NAME_UNKNOWN (MEASURED the
// same minute for `ref`). Each refusal is planted alone. The tags, digests
// and manifests are synthetic, and so are the stub readers that plant a cut
// list or a defect.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inWorld, manifestJson } from '@domains/testkit';
import { resetTokens } from '../../packages/ghcr/src/reader.ts';
import { EXIT as CHECK_EXIT, main as checkPublic } from './check-public.mjs';
import { EXIT, main as tags } from './tags.mjs';

const NOOP = { fetch: () => new Response(null, { status: 204 }) };
const NS = 'pkgforge-dev/domains.pkgforge.dev';
const world = (fn) => inWorld(NOOP, () => undefined, fn, { resetIsolate: resetTokens });

// GHCR's tag list of `pkg`: `count` tags t-00000 up, paged by `n`.
function tagList(w, pkg, count, { status = null } = {}) {
  const all = Array.from({ length: count }, (_, i) => `t-${String(i).padStart(5, '0')}`);
  const before = w.intercept;
  w.intercept = (url, init) => {
    const u = new URL(url);
    if (u.pathname === `/v2/${NS}/${pkg}/tags/list`) {
      if (status !== null) return w.response(status, '{"errors":[{"code":"X"}]}', {}, { url });
      const n = Number(u.searchParams.get('n'));
      const last = u.searchParams.get('last');
      const from = last === null ? 0 : all.indexOf(last) + 1;
      const page = all.slice(from, from + n);
      const headers = { 'content-type': 'application/json' };
      if (from + n < all.length) headers.link = `</v2/${NS}/${pkg}/tags/list?last=${page.at(-1)}&n=${n}>; rel="next"`;
      return w.response(200, JSON.stringify({ name: `${NS}/${pkg}`, tags: page }), headers, { url });
    }
    return before ? before(url, init) : undefined;
  };
  return all;
}

// A private package: the dummy token gets a challenge, the token endpoint denies.
function privatePackage(w) {
  w.intercept = (url, init) => {
    if (url.startsWith('https://ghcr.io/token')) return w.response(403, '{"errors":[{"code":"DENIED"}]}', {}, { url });
    if (init.headers?.authorization === 'Bearer QQ==') return w.response(401, '', { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' }, { url });
    return undefined;
  };
}

async function cli(fn, argv, opts = {}) {
  const out = [];
  const err = [];
  const sleeps = [];
  const code = await fn(argv, { out: (l) => out.push(l), err: (l) => err.push(l), sleep: async (ms) => sleeps.push(ms), random: () => 0, ...opts });
  return { code, out, err, sleeps };
}

test('tags: every page of a package of 2,500 tags is read by Link, printed in order, and counted', async () => {
  await world(async (w) => {
    const all = tagList(w, 'obs', 2500);
    const r = await cli(tags, ['obs']);
    assert.equal(r.code, EXIT.ok);
    assert.deepEqual(r.out, all);
    assert.equal(w.requests.length, 3);
    assert.ok(w.requests.every((q) => q.init.headers.authorization === 'Bearer QQ=='));
    assert.deepEqual((await cli(tags, ['obs', '--count'])).out, ['2500']);
  });
});

test('tags: --prefix filters, --count counts the matches, and --min exits 1 when fewer match', async () => {
  await world(async (w) => {
    tagList(w, 'ref', 2500);
    const r = await cli(tags, ['ref', '--prefix', 't-01', '--count', '--min', '1000']);
    assert.equal(r.code, EXIT.ok);
    assert.deepEqual(r.out, ['1000']);
    const fewer = await cli(tags, ['ref', '--prefix=t-01', '--count', '--min=1001']);
    assert.equal(fewer.code, EXIT.fewer);
    assert.deepEqual(fewer.out, ['1000']);
    assert.match(fewer.err[0], /1000 tag\(s\) of .* start with "t-01", fewer than 1001 \(2500 in all, 3 page\(s\)\)/);
    const none = await cli(tags, ['ref', '--prefix', 'psl-', '--min', '1']);
    assert.equal(none.code, EXIT.fewer);
    assert.deepEqual(none.out, []);
  });
});

test('tags: a package that does not read with no credential is PRIVATE PACKAGE, exit 4, private or absent alike', async () => {
  await world(async (w) => {
    privatePackage(w);
    const r = await cli(tags, ['ref']);
    assert.equal(r.code, EXIT.private);
    assert.deepEqual(r.out, ['PRIVATE PACKAGE']);
  });
  await world(async (w) => {
    tagList(w, 'ref', 0, { status: 404 });
    const r = await cli(tags, ['ref', '--min', '1']);
    assert.equal(r.code, EXIT.private);
    assert.deepEqual(r.out, ['PRIVATE PACKAGE']);
  });
});

test('tags: a 429 pauses and asks again; a 500 or a list cut at the page limit is exit 2', async () => {
  await world(async (w) => {
    const all = tagList(w, 'ref', 5);
    const real = w.intercept;
    let busy = 2;
    w.intercept = (url, init) => (busy-- > 0 ? w.response(429, '', {}, { url }) : real(url, init));
    const r = await cli(tags, ['ref']);
    assert.equal(r.code, EXIT.ok);
    assert.deepEqual(r.out, all);
    assert.deepEqual(r.sleeps, [20_000, 20_000]);
  });
  await world(async (w) => {
    tagList(w, 'ref', 0, { status: 500 });
    const r = await cli(tags, ['ref']);
    assert.equal(r.code, EXIT.usage);
    assert.match(r.err[0], /answered 500/);
  });
  const cut = { dial: { tokenRequests: 0 }, listTags: async () => ({ tags: ['a'], pages: 10_000, truncated: true }) };
  const r = await cli(tags, ['ref'], { reader: cut });
  assert.equal(r.code, EXIT.usage);
  assert.deepEqual(r.out, []);
  assert.match(r.err[0], /longer than 10000 pages; nothing is printed/);
});

test('tags: bad arguments are exit 2 before any request', async () => {
  await world(async (w) => {
    for (const argv of [[], ['ref', 'obs'], ['Ref'], ['ref', '--min', 'x'], ['ref', '--min'], ['ref', '--prefix', 'PSL-'], ['ref', '--bogus'], ['ref', '--count=1']]) {
      const r = await cli(tags, argv);
      assert.equal(r.code, EXIT.usage, argv.join(' '));
      assert.match(r.err.join('\n'), /usage: node scripts\/ghcr\/tags\.mjs/);
    }
    assert.equal(w.requests.length, 0);
  });
  const script = fileURLToPath(new URL('./tags.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /name one package/);
});

const MANIFEST = manifestJson([['public_suffix_list.dat', `sha256:${'1'.repeat(64)}`, 338012]]);

test('check-public: the newest tag (the last listed) reads with the dummy token: exit 0', async () => {
  await world(async (w) => {
    tagList(w, 'ref', 3);
    w.manifests.set('ref:t-00002', MANIFEST);
    const r = await cli(checkPublic, ['ref']);
    assert.equal(r.code, CHECK_EXIT.ok, r.err.join('\n'));
    assert.match(r.out[0], /^public ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/ref:t-00002 sha256:[0-9a-f]{64} via dummy token$/);
    assert.ok(w.requests.every((q) => q.init.headers.authorization === 'Bearer QQ=='));
  });
});

test('check-public: a package that needs the anonymous token flow is public too, and says so', async () => {
  await world(async (w) => {
    w.manifests.set('ref:psl-a', MANIFEST);
    w.intercept = (url, init) => {
      if (url.startsWith('https://ghcr.io/token')) return w.response(200, '{"token":"anon"}', {}, { url });
      if (init.headers?.authorization === 'Bearer QQ==') return w.response(401, '', { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' }, { url });
      return undefined;
    };
    const r = await cli(checkPublic, ['ref', '--tag', 'psl-a']);
    assert.equal(r.code, CHECK_EXIT.ok, r.err.join('\n'));
    assert.match(r.out[0], /via anonymous token$/);
    // --tag reads the manifest alone, never the tag list.
    assert.ok(!w.requests.some((q) => q.url.includes('/tags/list')));
  });
});

test('check-public: a private package and an absent one are PRIVATE PACKAGE, exit 4', async () => {
  await world(async (w) => {
    privatePackage(w);
    const r = await cli(checkPublic, ['ref']);
    assert.equal(r.code, CHECK_EXIT.private);
    assert.deepEqual(r.out, ['PRIVATE PACKAGE']);
    assert.match(r.err[0], /did not read with no credential: GHCR answered 401 for an anonymous pull of .*token request answered 403/);
  });
  await world(async (w) => {
    tagList(w, 'ref', 0, { status: 404 });
    const r = await cli(checkPublic, ['ref']);
    assert.equal(r.code, CHECK_EXIT.private);
  });
  await world(async (w) => {
    tagList(w, 'ref', 2);
    // The list reads, the newest manifest does not.
    const r = await cli(checkPublic, ['ref']);
    assert.equal(r.code, CHECK_EXIT.private);
    assert.match(r.err[0], /holds no manifest t-00001/);
  });
});

test('check-public: a manifest that answers 403 to the pull token after the anonymous flow is PRIVATE PACKAGE, exit 4', async () => {
  await world(async (w) => {
    // The list reads with the dummy token; the newest manifest wants the
    // anonymous flow, gets a token, and is then denied.
    w.intercept = (url, init) => {
      if (url.startsWith('https://ghcr.io/token')) return w.response(200, '{"token":"anon"}', {}, { url });
      if (!new URL(url).pathname.includes('/manifests/')) return undefined;
      if (init.headers?.authorization === 'Bearer QQ==') return w.response(401, '', { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' }, { url });
      return w.response(403, '{"errors":[{"code":"DENIED"}]}', {}, { url });
    };
    tagList(w, 'ref', 3);
    const r = await cli(checkPublic, ['ref']);
    assert.equal(r.code, CHECK_EXIT.private, r.err.join('\n'));
    assert.deepEqual(r.out, ['PRIVATE PACKAGE']);
    assert.match(r.err[0], /403/);
  });
});

test('check-public: a package that lists no tag is exit 1; a 500 is exit 2', async () => {
  await world(async (w) => {
    tagList(w, 'ref', 0);
    const r = await cli(checkPublic, ['ref']);
    assert.equal(r.code, CHECK_EXIT.empty);
    assert.match(r.err[0], /lists no tag/);
  });
  await world(async (w) => {
    tagList(w, 'ref', 0, { status: 500 });
    assert.equal((await cli(checkPublic, ['ref'])).code, CHECK_EXIT.usage);
  });
});

test('check-public: a manifest over the reader’s 64 KiB default still reads: the question is whether it reads', async () => {
  await world(async (w) => {
    const layers = Array.from({ length: 1000 }, (_, i) => [`l${i}.bin`, `sha256:${String(i % 10).repeat(64)}`, 1024]);
    const big = manifestJson(layers);
    assert.ok(big.length > 64 * 1024);
    w.manifests.set('probe:layers-1000', big);
    const r = await cli(checkPublic, ['probe', '--tag', 'layers-1000']);
    assert.equal(r.code, CHECK_EXIT.ok, r.err.join('\n'));
  });
});

test('check-public: bad arguments are exit 2 before any request, and the script reads no credential from the environment', async () => {
  await world(async (w) => {
    for (const argv of [[], ['ref', 'obs'], ['ref', '--tag'], ['ref', '--tag', 'Latest'], ['ref', '--tag', 'a'.repeat(129)], ['ref', '--x']]) {
      const r = await cli(checkPublic, argv);
      assert.equal(r.code, CHECK_EXIT.usage, argv.join(' '));
    }
    assert.equal(w.requests.length, 0);
  });
  for (const f of ['./check-public.mjs', './tags.mjs']) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /process\.env/);
  // As a process: a name that is not a package is exit 2, with no request.
  const script = fileURLToPath(new URL('./check-public.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, 'Not-A-Package'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /usage: node scripts\/ghcr\/check-public\.mjs/);
  assert.equal(r.stdout, '');
});

test('check-public: a tag list cut at the page limit is exit 2, and no manifest is read as the newest', async () => {
  let manifests = 0;
  const cut = {
    dial: { tokenRequests: 0 },
    listTags: async () => ({ tags: ['a', 'b'], pages: 10_000, truncated: true }),
    getManifest: async () => {
      manifests += 1;
      return { digest: `sha256:${'1'.repeat(64)}` };
    },
  };
  const r = await cli(checkPublic, ['ref'], { reader: cut });
  assert.equal(r.code, 2);
  assert.deepEqual(r.out, []);
  assert.match(r.err[0], /longer than 10000 pages; name the tag with --tag/);
  assert.equal(manifests, 0);
});

test('tags and check-public: an error neither knows is exit 70, an internal error, never a verdict', async () => {
  const broken = {
    dial: { tokenRequests: 0 },
    listTags: async () => {
      throw new TypeError('synthetic defect');
    },
    getManifest: async () => {
      throw new TypeError('synthetic defect');
    },
  };
  for (const [fn, argv, name] of [
    [tags, ['ref'], 'tags'],
    [checkPublic, ['ref'], 'check-public'],
    [checkPublic, ['ref', '--tag', 'psl-a'], 'check-public'],
  ]) {
    const r = await cli(fn, argv, { reader: broken });
    assert.equal(r.code, 70, `${name} ${argv.join(' ')}`);
    assert.deepEqual(r.out, []);
    assert.match(r.err[0], new RegExp(`^${name}: internal error: TypeError: synthetic defect`));
  }
});

test('tags and check-public: the exit codes are the numbers their headers name', () => {
  assert.deepEqual({ ...EXIT }, { ok: 0, fewer: 1, usage: 2, private: 4, internal: 70 });
  assert.deepEqual({ ...CHECK_EXIT }, { ok: 0, empty: 1, usage: 2, private: 4, internal: 70 });
});
