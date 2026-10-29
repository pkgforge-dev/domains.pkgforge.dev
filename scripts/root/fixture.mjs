// scripts/root/fixture.mjs — a GHCR double for the tests of scripts/root/ and
// of the GHCR form of scripts/verify-pack.mjs, and the named cases of
// `node scripts/root/promote.mjs --fixture NAME`. Everything here is
// synthetic: no byte, digest or token was recorded from GHCR.
//
// It stands on packages/testkit's world, which replaces the global fetch for
// as long as it is open, so packages/ghcr's reader runs its production dial:
//   - a manifest GET or HEAD answers from w.manifests ("PKG:REF") with the
//     docker-content-digest GHCR sends, and 404 MANIFEST_UNKNOWN otherwise;
//   - a blob answers the world's 307 to its signed URL, and the signed URL
//     answers a Range with 206 from the bytes held by digest;
//   - oras (the four verbs push.mjs runs, and `tag`) reads and writes the same
//     maps: `login` writes the registry config, `push --oci-layout` writes a
//     real OCI layout, `manifest fetch` writes the manifest or says not found,
//     `copy --from-oci-layout` puts the layout's manifest and blobs under the
//     tag and its digest, `tag` puts a manifest under a new tag. A verb it
//     does not know exits 2. Each call is logged in `calls`.
// `hooks.beforeFetch(key, n, api)`, set on the double at any time, runs before
// the n-th `manifest fetch` of KEY: the place a test plants a second writer.
//
// ⚠ world() also replaces console.error, Date.now (with the world's clock)
// and AbortSignal.timeout until close(); a caller writes to stderr itself.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactType, NAMESPACE, rootTag } from '@domains/ghcr';
import { writeFeedPack } from '@domains/feed';
import { FEED_CODEC, IDX_TITLE, MemorySink, NAMES_CODEC, NEW_NAME_CODEC, packAnnotations, partTitle, TIME_IDX_TITLE, timePartTitle } from '@domains/pack';
import { nodeCompress, writePackFiles, writerId } from '@domains/pack/node';
import { buildRoot, EMPTY_COVERAGE, layerBytes, SOURCES_LAYER_FORMAT, TIER_ANNOTATION } from '@domains/root';
import { BLOB_HOST, MANIFEST_TYPE, REGISTRY, world } from '@domains/testkit';
import { resetTokens } from '../../packages/ghcr/src/reader.ts';

export const PREFIX = `ghcr.io/${NAMESPACE}/`;
export const TOKEN = 'synthetic-test-token';
export const ACTOR = 'synthetic-actor';
// The list the ref package pins (DOM-019, MEASURED 2026-10-29T05:01:54Z); the
// double's ref:psl manifest is synthetic, with a one-byte stand-in for the list.
export const PSL_LIVE = '1f96bae40adfc22ca2474d7c0099bbcfcb25aefd3e2547b5c2147c0dd2e3ebd9';
export const PSL_TAG = 'psl-1f96bae40adf';
const EMPTY = { mediaType: 'application/vnd.oci.empty.v1+json', digest: `sha256:${createHash('sha256').update('{}').digest('hex')}`, size: 2, data: 'e30=' };
const NOOP = { fetch: () => new Response(null, { status: 204 }) };
const TITLE = 'org.opencontainers.image.title';
const VALUE_FLAGS = new Set(['--format', '--artifact-type', '--annotation', '--registry-config', '--to-registry-config', '--output', '--username']);

export const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const splitRef = (r) => [r.slice(0, r.lastIndexOf(':')), r.slice(r.lastIndexOf(':') + 1)];

function parseOras(args) {
  const pos = [];
  const flags = {};
  const annotations = [];
  for (let i = args[0] === 'manifest' ? 2 : 1; i < args.length; i++) {
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

// `ghcr.io/<namespace>/PKG:TAG` or `...PKG@DIGEST` as the world's key PKG:REF.
function keyOf(ref) {
  if (!ref.startsWith(PREFIX)) throw new Error(`fixture oras: ${ref} is outside ${PREFIX}`);
  const rest = ref.slice(PREFIX.length);
  const at = rest.indexOf('@');
  return at === -1 ? rest : `${rest.slice(0, at)}:${rest.slice(at + 1)}`;
}

// The manifest JSON oras 1.3.4 builds: the empty config, one layer a file,
// the annotations sorted.
export function manifestText(type, annotations, layers) {
  const ann = Object.fromEntries(Object.entries(annotations).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify({ schemaVersion: 2, mediaType: MANIFEST_TYPE, artifactType: type, config: EMPTY, layers, annotations: ann });
}

// The double: a world with the registry above, the bytes it holds, a fake
// oras, and seeding helpers. close() restores the globals.
export function registry({ t0 } = {}) {
  const w = world(NOOP, { resetIsolate: resetTokens, ...(t0 === undefined ? {} : { t0 }) });
  const bytes = new Map();
  const fetches = new Map();
  const calls = [];
  const loggedIn = new Set();

  const putBlob = (pkg, b) => {
    const d = sha(b);
    bytes.set(d, new Uint8Array(b));
    w.blobs.set(`${pkg}@${d}`, true);
    return { digest: d, size: b.length };
  };
  const putManifest = (pkg, tag, text) => {
    const d = sha(text);
    w.manifests.set(`${pkg}:${d}`, text);
    if (tag !== null) w.manifests.set(`${pkg}:${tag}`, text);
    return d;
  };

  w.intercept = (url, init) => {
    const headers = init.headers ?? {};
    if (url.startsWith(`${REGISTRY}/`)) {
      const m = /^(.+)\/manifests\/(.+)$/.exec(url.slice(REGISTRY.length + 1));
      if (m === null) return undefined;
      const body = w.manifests.get(`${m[1]}:${decodeURIComponent(m[2] ?? '')}`);
      if (body === undefined) return undefined;
      const h = { 'content-type': MANIFEST_TYPE, 'docker-content-digest': sha(body), 'content-length': String(Buffer.byteLength(body)) };
      return w.response(200, init.method === 'HEAD' ? '' : body, h, { url });
    }
    if (url.startsWith(`${BLOB_HOST}/`)) {
      const d = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
      const b = bytes.get(d);
      const r = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? '');
      if (b === undefined || r === null) return w.response(404, 'no such blob', {}, { url });
      const start = Number(r[1]);
      const end = Math.min(Number(r[2]), b.length - 1);
      if (start >= b.length) return w.response(416, '', { 'content-range': `bytes */${b.length}` }, { url });
      return w.response(206, b.slice(start, end + 1), { 'content-range': `bytes ${start}-${end}/${b.length}`, 'content-length': String(end - start + 1) }, { url });
    }
    return undefined;
  };

  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const oras = async (args, opts = {}) => {
    calls.push({ verb: args[0] === 'manifest' ? `manifest ${args[1]}` : args[0], args, input: opts.input ?? '' });
    const { pos, flags, annotations } = parseOras(args);
    const authed = () => {
      const config = flags['--registry-config'] ?? flags['--to-registry-config'];
      return loggedIn.has(config) && existsSync(config);
    };
    const unauthorized = { code: 1, stdout: '', stderr: 'Error: unauthorized: authentication required\n' };
    switch (args[0]) {
      case 'login': {
        if (!opts.input) return { code: 1, stdout: '', stderr: 'Error: no password on stdin\n' };
        mkdirSync(join(flags['--registry-config'], '..'), { recursive: true });
        writeFileSync(flags['--registry-config'], JSON.stringify({ auths: { 'ghcr.io': { auth: 'synthetic' } } }));
        loggedIn.add(flags['--registry-config']);
        return ok('Login Succeeded\n');
      }
      case 'push': {
        const [layout, tag] = splitRef(pos[0]);
        mkdirSync(join(layout, 'blobs', 'sha256'), { recursive: true });
        const layers = pos.slice(1).map((f) => {
          const [path, mediaType] = splitRef(f);
          const b = readFileSync(join(opts.cwd ?? '.', path));
          writeFileSync(join(layout, 'blobs', 'sha256', sha(b).slice(7)), b);
          return { mediaType, digest: sha(b), size: b.length, annotations: { [TITLE]: path.replace(/^\.\//, '') } };
        });
        const ann = Object.fromEntries(annotations.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
        const text = manifestText(flags['--artifact-type'], ann, layers);
        const d = sha(text);
        writeFileSync(join(layout, 'blobs', 'sha256', d.slice(7)), text);
        const entry = { mediaType: MANIFEST_TYPE, digest: d, size: Buffer.byteLength(text), annotations: { 'org.opencontainers.image.ref.name': tag } };
        writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [entry] }));
        return ok(JSON.stringify({ reference: `${layout}@${d}`, mediaType: MANIFEST_TYPE, digest: d, size: entry.size, annotations: ann, artifactType: flags['--artifact-type'] }));
      }
      case 'manifest': {
        if (args[1] !== 'fetch') return { code: 2, stdout: '', stderr: `Error: the fixture oras does not know manifest ${args[1]}\n` };
        if (!authed()) return unauthorized;
        const ref = pos.at(-1);
        const key = keyOf(ref);
        const n = (fetches.get(key) ?? 0) + 1;
        fetches.set(key, n);
        await api.hooks.beforeFetch?.(key, n, api);
        const body = w.manifests.get(key);
        if (body === undefined) return { code: 1, stdout: '', stderr: `Error: failed to fetch the content of "${ref}": ${ref}: not found\n` };
        writeFileSync(flags['--output'], body);
        return ok();
      }
      case 'copy': {
        if (!authed()) return unauthorized;
        const [layout, tag] = splitRef(pos[0]);
        const key = keyOf(pos[1]);
        const pkg = key.slice(0, key.indexOf(':'));
        const index = JSON.parse(readFileSync(join(layout, 'index.json'), 'utf8'));
        const entry = index.manifests.find((x) => x.annotations['org.opencontainers.image.ref.name'] === tag);
        const text = readFileSync(join(layout, 'blobs', 'sha256', entry.digest.slice(7)), 'utf8');
        for (const l of JSON.parse(text).layers) putBlob(pkg, readFileSync(join(layout, 'blobs', 'sha256', l.digest.slice(7))));
        putManifest(pkg, key.slice(key.indexOf(':') + 1), text);
        return ok(`Copied [oci-layout] ${pos[0]} => [registry] ${pos[1]}\nDigest: ${entry.digest}\n`);
      }
      case 'tag': {
        if (!authed()) return unauthorized;
        const source = keyOf(pos[0]);
        const body = w.manifests.get(source);
        if (body === undefined) return { code: 1, stdout: '', stderr: `Error: ${pos[0]}: not found\n` };
        const pkg = source.slice(0, source.indexOf(':'));
        for (const t of pos.slice(1)) w.manifests.set(`${pkg}:${t}`, body);
        return ok(`Tagged ${pos.slice(1).join(', ')}\n`);
      }
      default:
        return { code: 2, stdout: '', stderr: `Error: the fixture oras does not know ${args[0]}\n` };
    }
  };

  // A manifest of PKG under TAG (or none), its layers [{ title, bytes, mediaType }].
  const seed = (pkg, tag, type, annotations, layers) => {
    const descs = layers.map((l) => ({ mediaType: l.mediaType ?? 'application/octet-stream', ...putBlob(pkg, l.bytes), annotations: { [TITLE]: l.title } }));
    return putManifest(pkg, tag, manifestText(type, annotations, descs));
  };

  const api = {
    w,
    bytes,
    calls,
    oras,
    seed,
    hooks: {},
    // The ref package's psl tag, its one layer standing in for the list.
    seedPsl(sha256 = PSL_LIVE, tag = PSL_TAG) {
      const body = new TextEncoder().encode('// synthetic stand-in for the list\n');
      const d = putManifest(
        'ref',
        tag,
        manifestText(artifactType('ref'), { 'dev.pkgforge.domains.sha256': sha256 }, [
          { mediaType: 'text/plain', digest: `sha256:${sha256}`, size: body.length, annotations: { [TITLE]: 'public_suffix_list.dat' } },
        ]),
      );
      return d;
    },
    // A root with its three layers, under its dated tag and, with `latest`, latest.
    seedRoot(root, { latest = true, sources = { format: SOURCES_LAYER_FORMAT, sources: [] }, coverage = EMPTY_COVERAGE } = {}) {
      const layers = [
        { title: 'root.json', bytes: layerBytes(root), mediaType: 'application/json' },
        { title: 'sources.json', bytes: layerBytes(sources), mediaType: 'application/json' },
        { title: 'coverage.json', bytes: layerBytes(coverage), mediaType: 'application/json' },
      ];
      const tag = rootTag(root.created);
      const d = seed('root', tag, artifactType('root'), { 'org.opencontainers.image.created': root.created }, layers);
      if (latest) w.manifests.set('root:latest', w.manifests.get(`root:${d}`));
      return d;
    },
    // A real DPK1 pack of synthetic records under PKG:TAG, with the
    // annotations of section 4.2: { digest, ref }. A pack of `feed` or
    // `new-name` holds feed rows, one a second from `start`, newest key first,
    // and with `time` its time copy too (docs/format.md section 14), written by
    // writeFeedPack of packages/feed; any other dataset holds `names` records.
    async seedPack(pkg, tag, { dataset = 'names', tier, start, end, sources = ['thc-ct'], psl = PSL_LIVE, records = 3, extra = {}, time = false }) {
      const dir = mkdtempSync(join(tmpdir(), 'root-fixture-pack-'));
      try {
        const keyOf = (i) => `com.synthetic${String(i).padStart(4, '0')}`;
        let summary;
        let layers;
        if (dataset === 'feed' || dataset === 'new-name') {
          const t0 = (Date.parse(start) - Date.UTC(2026, 0, 1)) / 1000;
          const rows = Array.from({ length: records }, (_, i) => ({ key: keyOf(i), flags: 0, firstSeen: t0 + records - 1 - i, sources: [1], basis: 4, confidence: 0, feedFlags: 0 }));
          const sink = new MemorySink();
          const timeSink = new MemorySink();
          const codec = dataset === 'feed' ? FEED_CODEC : NEW_NAME_CODEC;
          const pack = await writeFeedPack(rows, { codec, compress: nodeCompress, sink, recordsPerBlock: 64, ...(time ? { time: { sink: timeSink, recordsPerBlock: 64 } } : {}) });
          summary = pack.summary;
          layers = [...sink.parts().map((bytes, i) => ({ title: partTitle(i), bytes })), { title: IDX_TITLE, bytes: pack.summary.idx }];
          if (pack.time !== null) layers.push(...timeSink.parts().map((bytes, i) => ({ title: timePartTitle(i), bytes })), { title: TIME_IDX_TITLE, bytes: pack.time.idx });
        } else {
          if (time) throw new Error(`fixture seedPack: a ${dataset} pack has no time copy`);
          const recs = Array.from({ length: records }, (_, i) => ({ key: keyOf(i), flags: 1, sources: [{ bit: 0, first: 298, last: 298 }] }));
          const out = join(dir, 'pack');
          summary = (await writePackFiles(recs, out, { codec: NAMES_CODEC, recordsPerBlock: 64 })).summary;
          layers = readdirSync(out)
            .sort((a, b) => (a === 'idx' ? 1 : b === 'idx' ? -1 : a < b ? -1 : 1))
            .map((title) => ({ title, bytes: readFileSync(join(out, title)) }));
        }
        const annotations = {
          ...packAnnotations(summary, writerId()),
          'dev.pkgforge.domains.dataset': dataset,
          [TIER_ANNOTATION]: tier,
          'dev.pkgforge.domains.span.start': start,
          'dev.pkgforge.domains.span.end': end,
          'dev.pkgforge.domains.source': sources.join(','),
          'dev.pkgforge.domains.psl': psl,
          ...extra,
        };
        const digest = seed(pkg, tag, artifactType(tier === 'seg' ? 'segment' : 'pack'), annotations, layers);
        return { digest, ref: `${pkg}:${tag}` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    close: () => w.close(),
  };
  return api;
}

// The deps of promote.mjs and rollback.mjs against the double: a synthetic
// token and actor, its oras, no pause, and the clock `now`.
export function depsFor(reg, { now, out, err, attempt = '1', tmp } = {}) {
  return {
    env: { GITHUB_ACTOR: ACTOR, REGISTRY_TOKEN: TOKEN, GITHUB_RUN_ATTEMPT: attempt, GITHUB_RUN_ID: '1' },
    oras: reg.oras,
    sleep: async () => undefined,
    random: () => 0,
    now: () => Date.parse(now),
    out: out ?? (() => undefined),
    err: err ?? (() => undefined),
    tmp,
  };
}

// ---------------------------------------------------------------- the named cases

const say = (stream, line) => stream.write(`${line}\n`);

// stale: root:latest is root_seq 1. This run reads it and plans root_seq 2;
// before its guard, a second writer moves latest to its own root_seq 2. The
// guard refuses: exit 1, latest as the second writer left it, and no tag of
// this run written.
async function stale(main, io) {
  const reg = registry();
  const out = (l) => io.out(`fixture stale: ${l}`);
  const err = (l) => say(process.stderr, `fixture stale: ${l}`);
  const tmp = mkdtempSync(join(tmpdir(), 'root-fixture-'));
  try {
    reg.seedPsl();
    const one = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z' });
    const oneDigest = reg.seedRoot(one);
    const other = buildRoot({ live: { root: one, digest: oneDigest }, psl: PSL_LIVE, now: '2026-10-29T08:10:00Z', gaps: { 'thc-ct': ['2026-10-04'] } });
    const otherDigest = reg.seedRoot(other, { latest: false });
    let moved = false;
    reg.hooks.beforeFetch = (key) => {
      if (key !== 'root:latest' || moved) return;
      moved = true;
      reg.w.manifests.set('root:latest', reg.w.manifests.get(`root:${otherDigest}`));
      err(`a second writer moved root:latest from ${oneDigest} (root_seq 1) to ${otherDigest} (root_seq ${other.root_seq})`);
    };
    const now = '2026-10-29T08:20:00Z';
    const code = await main(['--gap', 'thc-ct=2026-10-09'], depsFor(reg, { now, out, err, tmp }));
    const latest = sha(reg.w.manifests.get('root:latest') ?? '');
    const mine = reg.w.manifests.has(`root:${rootTag(now)}`);
    out(`exit ${code}; root:latest holds ${latest === otherDigest ? "the second writer's root" : latest}; this run's dated tag ${rootTag(now)} ${mine ? 'was written' : 'was not written'}`);
    return code;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    reg.close();
  }
}

export const FIXTURES = Object.freeze({ stale });

// Runs the case `name` with promote.mjs's main; its exit code, or 2 for a name
// that is not a case.
export async function runFixture(name, main, io) {
  const fn = Object.hasOwn(FIXTURES, name) ? FIXTURES[name] : null;
  if (fn === null) {
    io.err(`promote: --fixture ${JSON.stringify(name)} is not one of ${Object.keys(FIXTURES).join(', ')}`);
    return 2;
  }
  return fn(main, io);
}
