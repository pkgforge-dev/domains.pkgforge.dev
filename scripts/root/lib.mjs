// scripts/root/lib.mjs — what promote.mjs, rollback.mjs and show.mjs share:
// reading a root and the packs it names from GHCR with no credential, and the
// one way `root:latest` moves (docs/architecture.md sections 4.6 and 4.7).
//
//   readRoot(reader, ref)         a root manifest, its three layers checked by digest, root.json validated
//   packFacts(reader, 'PKG:TAG')  the root's entry for a pack: its manifest and its index head, and its time index head when it has a time copy (one range read each)
//   missingPacks(reader, root)    every pack the root names that GHCR does not hold, by a HEAD by digest
//   publish({ root, layers, expected, live, rollback }, ctx)   the dated push, the guard, the move, the read-back
//
// The move, in this order (TODO/storage.md DOM-020, Decision):
//   1. the guard: root:latest, read with the job's token (oras manifest
//      fetch), still holds the digest this run read when it planned, and the
//      new root is above the live one (checkForward). Otherwise exit 1 and
//      nothing is written;
//   2. push the root under its dated tag r-<created> with scripts/ghcr/push.mjs
//      (write-once; rootTag of packages/ghcr names it);
//   3. the guard again, immediately before the move. A refusal here leaves the
//      dated root unreferenced, which is harmless, and latest unmoved;
//   4. `oras tag` the dated manifest, by its digest, as `latest`;
//   5. read `latest` back as a consumer does: anonymously, the manifest is the
//      pushed digest, and its root.json, read through the 307, is the root
//      that was built.
// latest moves only here, and only in the concurrency group root-writer
// (.github/workflows/root-promote.yml, ruling 18). Nothing here deletes
// anything from GHCR (AGENTS.md absolute 13).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactType, GhcrError, LATEST, MANIFEST_LIMIT_BYTES, NAMESPACE, REGISTRY_HOST, repoOf, rootTag, sha256Digest } from '@domains/ghcr';
import { IDX_TITLE, PackIndex, TIME_IDX_TITLE } from '@domains/pack';
import { canonical, checkForward, checkSourcesLayer, packFromManifest, RootError, validateRoot } from '@domains/root';
import { isNotPublic } from '../ghcr/check-public.mjs';
import { ATTEMPTS, excerpt, LOGIN_TIMEOUT_S, NOT_FOUND, main as pushMain, READ_TIMEOUT_S, READBACK_ATTEMPTS, RETRY_PAUSE_S } from '../ghcr/push.mjs';
import { RATE_CAPS_S, RATE_LIMITED, readPaused, underRateLimit } from '../ghcr/rate.mjs';
import { blobSource } from '../verify-pack.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, replaced: 3, private: 4, internal: 70 });
export const ROOT_REPO = repoOf('root');
export const ROOT_REF = `${REGISTRY_HOST}/${ROOT_REPO}`;
export const ROOT_TYPE = artifactType('root');
export const LAYERS = Object.freeze(['root.json', 'sources.json', 'coverage.json']);
export const LAYER_MEDIA_TYPE = 'application/json';
// root.json, compact JSON (layerBytes), is about 0.73 KB a pack entry of one
// part and three sources, and about 182 KB for 50 packs in each of the five
// datasets (section 4.6, [E] from synthetic entries by scripts/root/size.mjs,
// 2026-10-29T14:34:49Z); a layer above this is refused unread.
export const LAYER_MAX_BYTES = 8 * 1024 * 1024;
const RUN_ATTEMPT = /^[1-9][0-9]{0,8}$/;
// HEADs at once when the next root's packs are checked.
export const HEAD_CONCURRENCY = 8;
const TITLE = 'org.opencontainers.image.title';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}
// A refusal or a failure after the arguments were accepted: exit 1.
export class Fault extends Error {
  constructor(message) {
    super(message);
    this.name = 'Fault';
  }
}
// root:latest exists and does not read with no credential: exit 4.
export class PrivateRoot extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrivateRoot';
  }
}

const pausing = (deps) => ({ sleep: deps.sleep, random: deps.random, log: deps.log });

// GITHUB_RUN_ATTEMPT as a whole number from 1, digits only (1 when it is not
// set), or UsageError: a value Number() would read anyway ('1e0', ' 2') is
// refused with the rest, before anything is read or written.
export function runAttempt(env) {
  const v = env.GITHUB_RUN_ATTEMPT;
  if (v === undefined) return 1;
  if (typeof v !== 'string' || !RUN_ATTEMPT.test(v)) throw new UsageError(`GITHUB_RUN_ATTEMPT ${JSON.stringify(v)} is not a whole number of at least 1`);
  return Number(v);
}

// ---------------------------------------------------------------- reading

// The whole blob `desc` of `repo`, read by range and held to its digest.
export async function readBlob(reader, repo, desc, deps = {}, max = LAYER_MAX_BYTES) {
  if (!Number.isSafeInteger(desc.size) || desc.size < 1 || desc.size > max) throw new Fault(`the blob ${desc.digest} of ${repo} is ${desc.size} B; a layer here is 1 B to ${max} B`);
  const bytes = await blobSource(reader, repo, desc, pausing(deps)).read(0, desc.size);
  const got = await sha256Digest(bytes);
  if (bytes.length !== desc.size || got !== desc.digest) throw new Fault(`the blob ${desc.digest} of ${repo} read as ${bytes.length} B hashing to ${got}`);
  return bytes;
}

const parseJson = (bytes, what) => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (e) {
    throw new Fault(`${what} is not UTF-8 JSON: ${e.message}`);
  }
};

// The root `ref` names (a tag or a digest), read with no credential. Its
// manifest is at most the Worker's 64 KiB, its type is the root's, it holds
// the three layers once each, and each layer hashes to its digest. root.json
// passes validateRoot (`strict`: a writer; false: a reader), and sources.json
// is held to it. GhcrError passes through: the caller decides what an absent
// or a private root means.
export async function readRoot(reader, ref, deps = {}, { strict = true } = {}) {
  const m = await readPaused(`the manifest ${ref} of ${ROOT_REPO}`, () => reader.getManifest(ROOT_REPO, ref), pausing(deps));
  const at = `${ROOT_REF}:${ref}`;
  if (m.json.artifactType !== ROOT_TYPE) throw new Fault(`${at} is ${JSON.stringify(m.json.artifactType ?? null)}, not ${ROOT_TYPE}`);
  const byTitle = new Map();
  for (const layer of m.json.layers ?? []) {
    const title = layer.annotations?.[TITLE];
    if (byTitle.has(title)) throw new Fault(`${at} holds the layer ${title} twice`);
    if (!LAYERS.includes(title) && strict) throw new Fault(`${at} holds the layer ${JSON.stringify(title ?? null)}; a root holds ${LAYERS.join(', ')}`);
    byTitle.set(title, layer);
  }
  const layers = {};
  for (const title of LAYERS) {
    const desc = byTitle.get(title);
    if (desc === undefined) throw new Fault(`${at} holds no layer ${title}`);
    layers[title] = await readBlob(reader, ROOT_REPO, desc, deps);
  }
  try {
    const root = validateRoot(parseJson(layers['root.json'], `${at} root.json`), { strict });
    const sources = checkSourcesLayer(root, parseJson(layers['sources.json'], `${at} sources.json`));
    const coverage = parseJson(layers['coverage.json'], `${at} coverage.json`);
    if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) throw new Fault(`${at} coverage.json is not an object`);
    return { digest: m.digest, annotations: m.json.annotations ?? {}, root, sources, coverage, layers };
  } catch (e) {
    if (e instanceof RootError) throw new Fault(`${at}: ${e.message}`);
    throw e;
  }
}

// `PKG:TAG` as { pkg, repo, tag }, or UsageError.
export function parsePackRef(ref) {
  const m = typeof ref === 'string' ? /^([a-z0-9]+(?:[._-][a-z0-9]+)*):([a-z0-9_][a-z0-9._-]{0,127})$/.exec(ref) : null;
  if (m === null) throw new UsageError(`${JSON.stringify(ref)} is not PACKAGE:TAG, a pack of the namespace by its tag`);
  return { pkg: m[1], repo: repoOf(m[1]), tag: m[2] };
}

// The root's entry for the pack `ref` (PKG:TAG): its manifest read with no
// credential, its index head read by range, and, when the manifest holds a
// time copy (docs/format.md section 14), the head of its time.idx alike; each
// fact held to the other (packFromManifest). RootError becomes a Fault naming
// the pack.
export async function packFacts(reader, ref, deps = {}) {
  const { repo, tag } = parsePackRef(ref);
  const m = await readPaused(`the manifest ${tag} of ${repo}`, () => reader.getManifest(repo, tag, { maxBytes: MANIFEST_LIMIT_BYTES }), pausing(deps));
  const layer = (title) => (m.json.layers ?? []).find((l) => l.annotations?.[TITLE] === title);
  const headOf = async (desc, what) => {
    try {
      const head = (await PackIndex.open(blobSource(reader, repo, desc, pausing(deps)))).head;
      return { dataset: head.header.dataset, records: head.header.records, keyMin: head.keyMin, keyMax: head.keyMax, parts: head.parts.map((p) => p.bytes) };
    } catch (e) {
      if (e instanceof GhcrError) throw e;
      throw new Fault(`${what} of ${REGISTRY_HOST}/${repo}:${tag} does not read: ${e.message}`);
    }
  };
  const idx = layer(IDX_TITLE);
  if (idx === undefined) throw new Fault(`${REGISTRY_HOST}/${repo}:${tag} holds no idx layer`);
  const head = await headOf(idx, 'the index');
  const timeIdx = layer(TIME_IDX_TITLE);
  const timeHead = timeIdx === undefined ? null : await headOf(timeIdx, 'the time index');
  try {
    return packFromManifest({ repo, tag, digest: m.digest, json: m.json, head, timeHead });
  } catch (e) {
    if (e instanceof RootError) throw new Fault(e.message);
    throw e;
  }
}

// Every pack of `root` whose manifest GHCR does not hold, by an anonymous
// HEAD by digest, HEAD_CONCURRENCY at a time. A 404 is missing; any other
// failure throws.
export async function missingPacks(reader, root, deps = {}) {
  const all = Object.values(root.datasets).flat();
  const missing = [];
  let next = 0;
  const worker = async () => {
    while (next < all.length) {
      const p = all[next++];
      try {
        await readPaused(`the HEAD of ${p.manifest}`, () => reader.headManifest(p.repo, p.manifest), pausing(deps));
      } catch (e) {
        if (e instanceof GhcrError && (e.code === 'missing' || e.code === 'refused')) missing.push(`${p.repo.slice(NAMESPACE.length + 1)}:${p.tag} ${p.manifest} (${e.message})`);
        else throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HEAD_CONCURRENCY, all.length) }, worker));
  return missing.sort();
}

// ---------------------------------------------------------------- oras with the job's token

// One oras call, a 429 paused for and asked again (no attempt spent).
async function orasCall(label, args, opts, cap, deps) {
  const { result } = await underRateLimit(
    label,
    cap,
    async () => {
      const r = await deps.oras(args, opts);
      return r.code !== 0 && RATE_LIMITED.test(`${r.stderr}\n${r.stdout}`) ? { ...r, limited: true } : r;
    },
    pausing(deps),
  );
  return result;
}

async function retryOr(label, attempt, r, deps) {
  if (attempt >= ATTEMPTS) throw new Fault(`${label} failed ${ATTEMPTS} times; the last: exit ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${excerpt(r.stderr)}`);
  deps.log(`${label}: attempt ${attempt} of ${ATTEMPTS} failed (exit ${r.code}): ${excerpt(r.stderr)}; again in ${RETRY_PAUSE_S} s`);
  await deps.sleep(RETRY_PAUSE_S * 1000);
}

// A registry config in `work`, logged in with the job's token on stdin.
export async function login(work, deps) {
  const config = join(work, 'login', 'config.json');
  mkdirSync(join(work, 'login'), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const r = await orasCall(
      'oras login',
      ['login', '--registry-config', config, '--username', deps.env.GITHUB_ACTOR, '--password-stdin', REGISTRY_HOST],
      { input: deps.env.REGISTRY_TOKEN, timeoutMs: LOGIN_TIMEOUT_S * 1000 },
      RATE_CAPS_S.manifest,
      deps,
    );
    if (r.code === 0) return config;
    await retryOr('oras login', attempt, r, deps);
  }
}

// The manifest a root tag holds, read with the job's token, so a private
// package counts too: { digest, bytes }, or null when the tag is absent.
export async function fetchTag(ctx, tag) {
  const { deps, config, work } = ctx;
  const ref = `${ROOT_REF}:${tag}`;
  for (let attempt = 1; ; attempt++) {
    const out = join(work, `fetch-${tag}-${attempt}.json`);
    rmSync(out, { force: true });
    const r = await orasCall(`read ${ref}`, ['manifest', 'fetch', '--registry-config', config, '--output', out, ref], { timeoutMs: READ_TIMEOUT_S * 1000 }, RATE_CAPS_S.manifest, deps);
    if (r.code === 0) {
      let bytes;
      try {
        bytes = readFileSync(out);
      } catch (e) {
        throw new Fault(`oras read ${ref} with exit 0 and wrote no manifest: ${e.message}`);
      }
      return { digest: await sha256Digest(new Uint8Array(bytes)), bytes };
    }
    if (NOT_FOUND.test(r.stderr)) return null;
    await retryOr(`read ${ref}`, attempt, r, deps);
  }
}

// The live root: read anonymously, as a consumer reads it. When that read
// finds nothing, latest is read with the job's token: absent too is the first
// promotion (null); present is a root that does not read publicly, refused.
export async function liveRoot(reader, ctx) {
  try {
    return await readRoot(reader, LATEST, ctx.deps);
  } catch (e) {
    if (!isNotPublic(e)) throw e;
    const held = await fetchTag(ctx, LATEST);
    if (held === null) return null;
    throw new PrivateRoot(`${ROOT_REF}:${LATEST} holds ${held.digest}, and it does not read with no credential (${e.message})`);
  }
}

// ---------------------------------------------------------------- the move

// The guard of steps 1 and 3: latest holds `expected` (null: nothing), and
// `next` is above `live`. A refusal is a Fault naming what latest holds. The
// forward half repeats what buildRoot and rollbackRoot checked against the same
// live root (defence in depth): a race is refused by the digest first.
export async function guardLatest({ expected, found, live, next, rollback = false }, reader, deps = {}) {
  if (found !== expected) {
    let now = '';
    if (found !== null) {
      try {
        const r = (await readRoot(reader, found, deps, { strict: false })).root;
        now = ` (root_seq ${r.root_seq}, as_of ${r.as_of}; this root is root_seq ${next.root_seq})`;
      } catch {
        // What it holds is reported by digest alone: the refusal stands either way.
      }
    }
    throw new Fault(`${ROOT_REF}:${LATEST} holds ${found ?? 'nothing'}${now}, and this run planned on ${expected ?? 'nothing'}: another writer moved it. latest is left as it is`);
  }
  if (live !== null) {
    try {
      checkForward(live, next, { rollback });
    } catch (e) {
      if (e instanceof RootError) throw new Fault(`refused: ${e.message}. latest is left as it is`);
      throw e;
    }
  }
}

// Steps 1 to 5 of the header. `layers` maps each title of LAYERS to its bytes;
// `expected` is the digest root:latest held when the run planned; `live` its
// root.json (null for the first root). ctx: { deps, config, work, reader }.
// Returns { code, lines }: 0 moved, or push.mjs's own 3 or 4 (a dated tag that
// holds another manifest, a dated root that does not read anonymously).
export async function publish({ root, layers, expected, live, rollback = false }, ctx) {
  const { deps, reader, work } = ctx;
  const lines = [];
  const tag = rootTag(root.created);
  const guard = async () => guardLatest({ expected, found: (await fetchTag(ctx, LATEST))?.digest ?? null, live, next: root, rollback }, reader, deps);
  await guard();
  const dir = join(work, 'layers');
  mkdirSync(dir, { recursive: true });
  const files = LAYERS.map((title) => {
    writeFileSync(join(dir, title), layers[title]);
    return `${join(dir, title)}:${LAYER_MEDIA_TYPE}`;
  });
  const said = [];
  const argv = [
    'root',
    tag,
    '--artifact-type',
    ROOT_TYPE,
    '--created',
    root.created,
    '--annotation',
    `dev.pkgforge.domains.root_seq=${root.root_seq}`,
    '--annotation',
    `dev.pkgforge.domains.run=${deps.env.GITHUB_RUN_ID ?? 'local'}`,
    ...files,
  ];
  const code = await pushMain(argv, { env: deps.env, oras: deps.oras, reader, sleep: deps.sleep, random: deps.random, tmp: work, out: (l) => said.push(l), err: deps.err });
  lines.push(...said);
  if (code !== 0) {
    if (code === EXIT.replaced || code === EXIT.private) return { code, lines };
    throw new Fault(`scripts/ghcr/push.mjs exited ${code} for ${ROOT_REF}:${tag}: ${said.join(' ') || 'see its error above'}`);
  }
  const m = /^(?:pushed|present) \S+ (sha256:[0-9a-f]{64})\b/.exec(said.at(-1) ?? '');
  if (m === null) throw new Fault(`scripts/ghcr/push.mjs exited 0 and printed no digest: ${said.join(' ')}`);
  const digest = m[1];
  // The dated root is this root: its root.json is the one built. Defence in
  // depth: push.mjs's own layout check refuses other bytes before this, and no
  // test reaches the refusal below through the CLI.
  const dated = await readRoot(reader, digest, deps);
  if (canonical(dated.root) !== canonical(root)) throw new Fault(`${ROOT_REF}@${digest} holds another root.json than this run built`);
  await guard();
  const source = `${ROOT_REF}@${digest}`;
  for (let attempt = 1; ; attempt++) {
    const r = await orasCall(`oras tag ${tag} as ${LATEST}`, ['tag', '--registry-config', ctx.config, source, LATEST], { timeoutMs: READ_TIMEOUT_S * 1000 }, RATE_CAPS_S.tag, deps);
    if (r.code === 0) break;
    const now = (await fetchTag(ctx, LATEST))?.digest ?? null;
    if (now === digest) {
      deps.log(`oras tag: attempt ${attempt} exited ${r.code}, and latest holds ${digest}: it landed`);
      break;
    }
    if (now !== expected) throw new Fault(`oras tag failed (${excerpt(r.stderr)}), and ${ROOT_REF}:${LATEST} now holds ${now ?? 'nothing'}: another writer moved it`);
    await retryOr(`oras tag ${tag} as ${LATEST}`, attempt, r, deps);
  }
  // The read a consumer makes, with no credential. The digest decides; the
  // root.json compare after it is defence in depth (one digest, one content).
  for (let attempt = 1; ; attempt++) {
    try {
      const back = await readRoot(reader, LATEST, deps);
      if (back.digest !== digest) throw new Fault(`${ROOT_REF}:${LATEST} reads as ${back.digest} with no credential, not ${digest}`);
      if (back.root.root_seq !== root.root_seq || canonical(back.root) !== canonical(root))
        throw new Fault(`${ROOT_REF}:${LATEST} reads back root_seq ${back.root.root_seq}, not the root this run built`);
      lines.push(`latest ${ROOT_REF}:${LATEST} ${digest} root_seq ${root.root_seq} as_of ${root.as_of ?? 'none'} (${tag}), read back with no credential`);
      return { code: EXIT.ok, lines, digest, tag };
    } catch (e) {
      if (!isNotPublic(e) || attempt >= READBACK_ATTEMPTS) {
        if (isNotPublic(e)) throw new PrivateRoot(`${ROOT_REF}:${LATEST} did not read with no credential after ${READBACK_ATTEMPTS} attempts: ${e.message}`);
        throw e;
      }
      deps.log(`the anonymous read of ${LATEST}: ${e.message}; again in ${RETRY_PAUSE_S} s`);
      await deps.sleep(RETRY_PAUSE_S * 1000);
    }
  }
}
