// scripts/ghcr/push.mjs — the one writer of GHCR: push one artifact to a
// write-once tag of this project's namespace with the pinned oras, under the
// job's own GITHUB_TOKEN (DOM-019, TODO/storage.md; ruling 6).
//
// The order, and why:
// 1. Log in: `oras login ghcr.io --username "$GITHUB_ACTOR" --password-stdin`
//    into a registry config in a temporary directory that `finally` removes.
//    The token reaches oras on the login's stdin, never on a command line, and
//    no oras process holds REGISTRY_TOKEN in its environment.
// 2. Build the manifest locally with `oras push --oci-layout`, so its digest is
//    known before anything is written. The layout is read back and checked:
//    one manifest under the tag, whose bytes hash to the digest oras printed,
//    with the artifact type, every annotation, and one layer a file, titled by
//    the file's name, in the order given. A ref holds one layer, whose digest
//    is its `dev.pkgforge.domains.sha256`.
// 3. Read the tag with the job's token, so a private package counts too:
//    - the same manifest digest, or the same `dev.pkgforge.domains.sha256`,
//      artifact type and layers (title and media type, and for a ref the
//      digest; a pack's compressed bytes may differ between zlib builds,
//      docs/format.md section 8): `present`, exit 0, nothing written;
//    - any other manifest: `replaced`, exit 3, nothing written. A tag is
//      written once (docs/architecture.md section 4.7 rule 1), and `oras push`
//      to an existing tag would replace it without a word: the answer is
//      needed before the write, never after it;
//    - absent (oras: not found, manifest unknown, name unknown, the only
//      answers that mean absent): go on.
// 4. Copy the layout up with `oras copy --from-oci-layout`. A failed attempt
//    is followed by a read of the tag, so an attempt that landed counts and
//    one that met another writer's manifest is `replaced`.
// 5. Read it back with no credential (packages/ghcr's reader): by digest, its
//    bytes hash to it; by tag, the tag names it. A 401, 403 or 404 there is
//    PRIVATE PACKAGE, exit 4 (section 4.7 rule 7).
//
// `org.opencontainers.image.created` is --created (the window end, or a ref
// file's own time), never the push time, so identical inputs give an identical
// manifest digest: oras 1.3.4 keeps the created it is given (READ
// mirror-archlinux docs/measurements.md, 3 of 3). The tool adds
// `org.opencontainers.image.source`, which links the package to this
// repository. A 429 costs no attempt and pauses 20 to 60 s, up to 1,800 s for
// the copy and 600 s for a manifest read (scripts/ghcr/rate.mjs). An attempt
// may last 300 s plus its bytes at 2 MiB/s, at most 600 s. A failed attempt
// that is not a 429 is tried again after 10 s, 3 attempts in all.
//
// Usage:
//   node scripts/ghcr/push.mjs PACKAGE TAG --artifact-type TYPE --created ISO [--annotation K=V]... FILE:MEDIATYPE...
// PACKAGE is one of the eight packages of docs/architecture.md section 4.1 and
// TAG a lowercase tag; every FILE sits in one directory, and its name is its
// layer's title. TYPE is application/vnd.pkgforge.domains.<kind>.v1.
// Environment: GITHUB_ACTOR and REGISTRY_TOKEN (the job's GITHUB_TOKEN, which
// goes to the oras login on stdin only; every oras process gets this
// environment without it); ORAS, the oras binary (default `oras` on PATH,
// where scripts/install-oras puts it); RUNNER_TEMP, where the temporary
// directory goes (default the system's).
// Prints one line: `pushed REF DIGEST`, `present REF DIGEST (WHY)`,
// `replaced REF holds REMOTE, not LOCAL; nothing was written`, or
// `PRIVATE PACKAGE`.
// Exit codes: 0 pushed and read back, or present · 1 a fault (oras failed
// after its attempts, the layout is not what was asked for, the read-back
// differs, the 429 pauses passed their cap, the registry config outlived the
// run) · 2 could not run (bad arguments, no token, a file that cannot be read) ·
// 3 replaced: the tag holds another manifest · 4 PRIVATE PACKAGE: the pushed
// manifest did not read with no credential · 70 an internal error, a defect of
// this script (its stack goes to stderr), never a fault or a verdict on the tag.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANNOTATION_MAX_CHARS, ARTIFACT_KINDS, annotationProblem, artifactType, checkPackage, checkTag, LayoutError, REGISTRY_HOST, repoOf, SOURCE_URL } from '../../packages/ghcr/src/layout.ts';
import { GhcrError, MANIFEST_LIMIT_BYTES, parseManifest } from '../../packages/ghcr/src/reader.ts';
import { anonymousReader, isNotPublic, PRIVATE_LINE } from './check-public.mjs';
import { attemptSeconds, RATE_CAPS_S, RATE_LIMITED, RateLimitError, readPaused, realSleep, underRateLimit } from './rate.mjs';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2, replaced: 3, private: 4, internal: 70 });
export const SHA256_ANNOTATION = 'dev.pkgforge.domains.sha256';
export const CREATED = 'org.opencontainers.image.created';
export const SOURCE = 'org.opencontainers.image.source';
export const TITLE = 'org.opencontainers.image.title';
export const REF_NAME = 'org.opencontainers.image.ref.name';
export const ATTEMPTS = 3;
export const RETRY_PAUSE_S = 10;
export const READBACK_ATTEMPTS = 3;
export const LOGIN_TIMEOUT_S = 120;
export const READ_TIMEOUT_S = 120;
// DOM-006: 256 layers is the largest count both runs accepted; a year pack needs about 100.
export const MAX_LAYERS = 256;
// The longest annotation value this tool takes, in characters, and the one
// rule of a value (annotationProblem of packages/ghcr/src/layout.ts), which
// packManifest of packages/compact and the disk writer of scripts/ingest/
// apply before any push.
export { ANNOTATION_MAX_CHARS };
// oras's words for an absent tag or package, the only answers that mean absent
// (READ mirror-archlinux docs/design.md rules; .github/workflows/measure-push.yml).
export const NOT_FOUND = /not found|manifest unknown|name unknown/i;
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ANNOTATION_KEY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF_TYPE = artifactType('ref');
const USAGE = 'usage: node scripts/ghcr/push.mjs PACKAGE TAG --artifact-type TYPE --created ISO [--annotation K=V]... FILE:MEDIATYPE...';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}
export class PushFault extends Error {
  constructor(message) {
    super(message);
    this.name = 'PushFault';
  }
}

// ---------------------------------------------------------------- arguments

// The plan of one push from argv: { pkg, repo, ref, tag, artifactType, created,
// annotations: [[key, value]], files: [{ path, mediaType }] }. Throws UsageError.
export function parsePushArgs(argv) {
  const pos = [];
  const annotations = [];
  let type = null;
  let created = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || value === '') throw new UsageError(`${name} needs a value`);
    if (name === '--artifact-type') {
      if (type !== null) throw new UsageError('--artifact-type is given twice');
      type = value;
    } else if (name === '--created') {
      if (created !== null) throw new UsageError('--created is given twice');
      created = value;
    } else if (name === '--annotation') {
      const k = value.indexOf('=');
      if (k < 1 || k === value.length - 1) throw new UsageError(`--annotation ${JSON.stringify(value)} is not KEY=VALUE`);
      annotations.push([value.slice(0, k), value.slice(k + 1)]);
    } else {
      throw new UsageError(`unknown flag ${name}`);
    }
  }
  if (pos.length < 3) throw new UsageError('name a package, a tag and at least one FILE:MEDIATYPE');
  const [pkg, tag, ...fileArgs] = pos;
  try {
    checkPackage(pkg);
    checkTag(tag);
  } catch (e) {
    if (e instanceof LayoutError) throw new UsageError(e.message);
    throw e;
  }
  const types = ARTIFACT_KINDS.map((k) => artifactType(k));
  if (type === null || !types.includes(type)) throw new UsageError(`--artifact-type ${JSON.stringify(type)} is not one of ${types.join(', ')}`);
  if (created === null || !ISO_SECOND.test(created) || new Date(created).toISOString().replace('.000Z', 'Z') !== created) {
    throw new UsageError(`--created ${JSON.stringify(created)} is not YYYY-MM-DDTHH:MM:SSZ (the window end, or the file's own time; never the push time)`);
  }
  const keys = new Set();
  for (const [k, v] of annotations) {
    if (!ANNOTATION_KEY.test(k)) throw new UsageError(`the annotation key ${JSON.stringify(k)} is not lowercase words joined by . _ or -`);
    if (k === CREATED || k === SOURCE) throw new UsageError(`${k} is the tool's own (--created, and this repository)`);
    if (keys.has(k)) throw new UsageError(`the annotation ${k} is given twice`);
    keys.add(k);
    const problem = annotationProblem(v);
    if (problem !== null) throw new UsageError(`the annotation ${k} ${problem}`);
    if (k === SHA256_ANNOTATION && !/^[0-9a-f]{64}$/.test(v)) throw new UsageError(`${SHA256_ANNOTATION} is 64 lowercase hex digits`);
  }
  if (fileArgs.length > MAX_LAYERS) throw new UsageError(`${fileArgs.length} files; one manifest holds at most ${MAX_LAYERS} layers`);
  const files = fileArgs.map((f) => {
    const c = f.lastIndexOf(':');
    const path = c > 0 ? f.slice(0, c) : '';
    const mediaType = c > 0 ? f.slice(c + 1) : '';
    if (path === '' || !MEDIA_TYPE.test(mediaType)) throw new UsageError(`${JSON.stringify(f)} is not FILE:MEDIATYPE (a media type with no parameters)`);
    return { path, mediaType };
  });
  return { pkg, repo: repoOf(pkg), ref: `${REGISTRY_HOST}/${repoOf(pkg)}:${tag}`, tag, artifactType: type, created, annotations, files };
}

// The files of a plan on disk: one directory, names fit for a title, sizes.
export function planFiles(files) {
  const dirs = new Set();
  const names = new Set();
  const out = files.map(({ path, mediaType }) => {
    const full = resolve(path);
    let st;
    try {
      st = statSync(full);
    } catch (e) {
      throw new UsageError(`cannot read ${path}: ${e.code ?? e.message}`);
    }
    if (!st.isFile()) throw new UsageError(`${path} is not a file`);
    const name = basename(full);
    if (!FILE_NAME.test(name)) throw new UsageError(`the file name ${JSON.stringify(name)} is not a title: letters, digits, _ . and -, not starting with . or -`);
    if (names.has(name)) throw new UsageError(`two files are named ${name}`);
    names.add(name);
    dirs.add(dirname(full));
    return { name, mediaType, size: st.size };
  });
  if (dirs.size !== 1) throw new UsageError('every FILE must sit in one directory: a layer is titled by its file name');
  return { dir: [...dirs][0], entries: out, bytes: out.reduce((a, f) => a + f.size, 0) };
}

// ---------------------------------------------------------------- oras

// The production runner: `bin args` in `cwd` with `env` (default this
// process's), `input` on stdin, the output collected, and the process ended by
// its PID past `timeoutMs` (SIGTERM, then SIGKILL 10 s later). A run that timed
// out answers code 124, as coreutils `timeout` does.
export function spawnProcess(bin, args, { input = '', cwd, env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolveRun({ code: 127, stdout: '', stderr: `cannot start ${bin}: ${e.message}`, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let kill = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => undefined); // a child that exits before reading stdin; its exit code says why
    child.on('error', (e) => {
      clearTimeout(timer);
      clearTimeout(kill);
      resolveRun({ code: 127, stdout, stderr: `${stderr}cannot start ${bin}: ${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(kill);
      resolveRun({ code: timedOut ? 124 : (code ?? 128), stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

// `env` without REGISTRY_TOKEN, the environment of every oras process: the
// token reaches the login on stdin, and nothing oras runs inherits it. Windows
// names are matched without regard to case, as Windows reads them.
export const orasEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== 'REGISTRY_TOKEN'));

export const orasRunner =
  (bin = process.env.ORAS || 'oras', env = orasEnv(process.env)) =>
  (args, opts) =>
    spawnProcess(bin, args, { ...opts, env });

// The first `Error` line of oras's output, else its last line, every query
// string cut (an upload URL carries its session there), at most 300 characters.
export function excerpt(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /^Error/.test(l)) ?? lines.at(-1) ?? '(no output)';
  return line.replace(/\?[^\s"]*/g, '').slice(0, 300);
}

// One oras call, a 429 paused for and asked again (no attempt spent).
async function orasCall(label, args, opts, cap, deps) {
  const { result } = await underRateLimit(
    label,
    cap,
    async () => {
      const r = await deps.oras(args, opts);
      return r.code !== 0 && RATE_LIMITED.test(`${r.stderr}\n${r.stdout}`) ? { ...r, limited: true } : r;
    },
    deps,
  );
  return result;
}

const sha256Of = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// The manifest the layout at `dir` holds under `tag`: its digest, bytes and
// JSON, the digest checked against the bytes.
export function readLayout(dir, tag) {
  let index;
  try {
    index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  } catch (e) {
    throw new PushFault(`the OCI layout has no readable index.json: ${e.message}`);
  }
  const found = (Array.isArray(index?.manifests) ? index.manifests : []).filter((m) => m?.annotations?.[REF_NAME] === tag);
  if (found.length !== 1) throw new PushFault(`the OCI layout's index.json names ${found.length} manifests under ${tag}, not 1`);
  const { digest, size } = found[0];
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new PushFault(`the OCI layout names the digest ${JSON.stringify(digest)}`);
  let bytes;
  try {
    bytes = readFileSync(join(dir, 'blobs', 'sha256', digest.slice(7)));
  } catch (e) {
    throw new PushFault(`the OCI layout names the manifest blob ${digest}, which it does not hold: ${e.message}`);
  }
  if (sha256Of(bytes) !== digest || bytes.length !== size) throw new PushFault(`the manifest blob of the OCI layout does not hash to ${digest} at ${size} bytes`);
  let json;
  try {
    json = parseManifest(bytes, `the manifest ${digest} of the OCI layout`);
  } catch (e) {
    if (e instanceof GhcrError) throw new PushFault(e.message);
    throw e;
  }
  return { digest, bytes, json };
}

// What the built manifest must hold: the plan's type, annotations and layers.
export function checkBuilt(local, plan, files) {
  const j = local.json;
  const fail = (what) => {
    throw new PushFault(`oras built ${local.digest} with ${what}`);
  };
  if (j.artifactType !== plan.artifactType) fail(`the artifact type ${JSON.stringify(j.artifactType ?? null)}, not ${plan.artifactType}`);
  const want = [[SOURCE, SOURCE_URL], [CREATED, plan.created], ...plan.annotations];
  for (const [k, v] of want) if (j.annotations?.[k] !== v) fail(`the annotation ${k} = ${JSON.stringify(j.annotations?.[k] ?? null)}, not ${JSON.stringify(v)}`);
  const layers = j.layers ?? [];
  if (layers.length !== files.entries.length) fail(`${layers.length} layers, not ${files.entries.length}`);
  files.entries.forEach((f, i) => {
    const l = layers[i];
    if (l.annotations?.[TITLE] !== f.name || l.mediaType !== f.mediaType || l.size !== f.size) {
      fail(`layer ${i} titled ${JSON.stringify(l.annotations?.[TITLE] ?? null)}, ${l.mediaType}, ${l.size} B, not ${f.name}, ${f.mediaType}, ${f.size} B`);
    }
  });
  // A ref is one file, and its annotation names that file's bytes: the tag, the
  // annotation and the layer digest are one sha256.
  if (plan.artifactType === REF_TYPE) {
    const sha = j.annotations?.[SHA256_ANNOTATION];
    if (layers.length !== 1) fail(`${layers.length} layers; a ref holds one file`);
    if (layers[0].digest !== `sha256:${sha}`) fail(`the layer ${layers[0].digest}, not the ${SHA256_ANNOTATION} ${JSON.stringify(sha ?? null)}`);
  }
}

// The layers a tag must share with the local manifest to be present by its
// annotation: each title and media type, and for a ref, whose one layer is the
// file itself, each digest. A pack's compressed bytes may differ between zlib
// builds while its annotation names one content (docs/format.md section 8).
function layerKey(json) {
  return JSON.stringify((json.layers ?? []).map((l) => [l.annotations?.[TITLE] ?? null, l.mediaType, json.artifactType === REF_TYPE ? l.digest : null]));
}

// What the tag holding `remote` means for the manifest `local`.
export function decide(local, remote) {
  if (remote === null) return { outcome: 'absent' };
  if (remote.digest === local.digest) return { outcome: 'present', why: 'the same manifest' };
  const a = local.json.annotations?.[SHA256_ANNOTATION];
  const b = remote.json.annotations?.[SHA256_ANNOTATION];
  if (a !== undefined && a === b && local.json.artifactType === remote.json.artifactType && layerKey(local.json) === layerKey(remote.json)) {
    return { outcome: 'present', why: `the same ${SHA256_ANNOTATION} and layers` };
  }
  return { outcome: 'replaced' };
}

// ---------------------------------------------------------------- the push

// The steps of one push in `work`, with `deps` { oras, reader, sleep, random,
// log, env }. Returns { code, line }.
async function pushIn(work, plan, files, deps) {
  const config = join(work, 'login', 'config.json');
  const layout = join(work, 'layout');
  mkdirSync(dirname(config), { recursive: true });
  const retry = async (label, attempt, r) => {
    if (attempt >= ATTEMPTS) throw new PushFault(`${label} failed ${ATTEMPTS} times; the last: exit ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${excerpt(r.stderr)}`);
    deps.log(`${label}: attempt ${attempt} of ${ATTEMPTS} failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${excerpt(r.stderr)}; again in ${RETRY_PAUSE_S} s`);
    await deps.sleep(RETRY_PAUSE_S * 1000);
  };

  // 1. The login, into the temporary registry config.
  for (let attempt = 1; ; attempt++) {
    const r = await orasCall(
      'oras login',
      ['login', '--registry-config', config, '--username', deps.env.GITHUB_ACTOR, '--password-stdin', REGISTRY_HOST],
      { input: deps.env.REGISTRY_TOKEN, timeoutMs: LOGIN_TIMEOUT_S * 1000 },
      RATE_CAPS_S.manifest,
      deps,
    );
    if (r.code === 0) break;
    await retry('oras login', attempt, r);
  }

  // 2. The manifest, built locally.
  const pushArgs = ['push', '--oci-layout', '--format', 'json', '--artifact-type', plan.artifactType, '--annotation', `${SOURCE}=${SOURCE_URL}`, '--annotation', `${CREATED}=${plan.created}`];
  for (const [k, v] of plan.annotations) pushArgs.push('--annotation', `${k}=${v}`);
  pushArgs.push(`${layout}:${plan.tag}`, ...files.entries.map((f) => `./${f.name}:${f.mediaType}`));
  const built = await deps.oras(pushArgs, { cwd: files.dir, timeoutMs: attemptSeconds(files.bytes) * 1000 });
  if (built.code !== 0) throw new PushFault(`oras push --oci-layout exited ${built.code}: ${excerpt(built.stderr)}`);
  const local = readLayout(layout, plan.tag);
  let printed = null;
  try {
    printed = JSON.parse(built.stdout).digest ?? null;
  } catch {
    // oras printed no JSON: the layout alone names the digest, and it was checked above.
  }
  if (printed !== null && printed !== local.digest) throw new PushFault(`oras printed the digest ${printed}, and the layout holds ${local.digest}`);
  checkBuilt(local, plan, files);

  // 3. The tag, read with the job's token.
  const readTag = async () => {
    for (let attempt = 1; ; attempt++) {
      const outFile = join(work, `remote-${attempt}.json`);
      rmSync(outFile, { force: true });
      const r = await orasCall(`read ${plan.ref}`, ['manifest', 'fetch', '--registry-config', config, '--output', outFile, plan.ref], { timeoutMs: READ_TIMEOUT_S * 1000 }, RATE_CAPS_S.manifest, deps);
      if (r.code === 0) {
        let bytes;
        try {
          bytes = readFileSync(outFile);
        } catch (e) {
          throw new PushFault(`oras read ${plan.ref} with exit 0 and wrote no manifest: ${e.message}`);
        }
        try {
          return { digest: sha256Of(bytes), bytes, json: parseManifest(bytes, `the manifest of ${plan.ref}`) };
        } catch (e) {
          if (e instanceof GhcrError) throw new PushFault(e.message);
          throw e;
        }
      }
      if (NOT_FOUND.test(r.stderr)) return null;
      await retry(`read ${plan.ref}`, attempt, r);
    }
  };
  const replaced = (remote) => ({ code: EXIT.replaced, line: `replaced ${plan.ref} holds ${remote.digest}, not ${local.digest}; nothing was written` });
  const before = await readTag();
  const first = decide(local, before);
  // A present tag is named by the digest it holds: by the sha256 annotation it
  // may hold another manifest than the one built here (another run, another
  // fetched), and a reader of the tag finds that one.
  if (first.outcome === 'present') return { code: EXIT.ok, line: `present ${plan.ref} ${before.digest} (${first.why})` };
  if (first.outcome === 'replaced') return replaced(before);

  // 4. The copy up.
  for (let attempt = 1; ; attempt++) {
    const r = await orasCall(
      `oras copy to ${plan.ref}`,
      ['copy', '--from-oci-layout', '--to-registry-config', config, `${layout}:${plan.tag}`, plan.ref],
      { timeoutMs: attemptSeconds(files.bytes) * 1000 },
      RATE_CAPS_S.part,
      deps,
    );
    if (r.code === 0) break;
    const remote = await readTag();
    const now = decide(local, remote);
    if (now.outcome === 'present') {
      deps.log(`oras copy to ${plan.ref}: attempt ${attempt} exited ${r.code}, and the tag holds the manifest: it landed`);
      break;
    }
    if (now.outcome === 'replaced') return replaced(remote);
    await retry(`oras copy to ${plan.ref}`, attempt, r);
  }

  // 5. The anonymous read-back.
  for (let attempt = 1; ; attempt++) {
    try {
      const byDigest = await readPaused(`the anonymous read of ${local.digest}`, () => deps.reader.getManifest(plan.repo, local.digest, { maxBytes: MANIFEST_LIMIT_BYTES }), deps);
      const byTag = await readPaused(`the anonymous read of ${plan.tag}`, () => deps.reader.getManifest(plan.repo, plan.tag, { maxBytes: MANIFEST_LIMIT_BYTES }), deps);
      if (byDigest.digest !== local.digest) throw new PushFault(`the anonymous read of ${local.digest} gave ${byDigest.digest}`);
      if (byTag.digest !== local.digest)
        return { code: EXIT.replaced, line: `replaced ${plan.ref} holds ${byTag.digest}, not ${local.digest}, read anonymously after the copy: another writer moved it` };
      return { code: EXIT.ok, line: `pushed ${plan.ref} ${local.digest}` };
    } catch (e) {
      if (!isNotPublic(e)) {
        if (e instanceof GhcrError) throw new PushFault(`the anonymous read-back: ${e.message}`);
        throw e;
      }
      if (attempt >= READBACK_ATTEMPTS) {
        deps.log(`${plan.ref} did not read with no credential after ${READBACK_ATTEMPTS} attempts: ${e.message}`);
        return { code: EXIT.private, line: PRIVATE_LINE };
      }
      deps.log(`the anonymous read of ${plan.ref}: ${e.message}; again in ${RETRY_PAUSE_S} s`);
      await deps.sleep(RETRY_PAUSE_S * 1000);
    }
  }
}

// One push: the plan checked, run in a temporary directory, and that directory
// (which holds the registry config) removed whatever happened.
export async function push(plan, deps) {
  const files = planFiles(plan.files);
  const env = deps.env;
  if (!env.GITHUB_ACTOR) throw new UsageError('GITHUB_ACTOR is not set: the login is the workflow actor');
  if (!env.REGISTRY_TOKEN) throw new UsageError("REGISTRY_TOKEN is not set: give the job's own GITHUB_TOKEN through env");
  const work = mkdtempSync(join(deps.tmp ?? env.RUNNER_TEMP ?? tmpdir(), 'ghcr-push-'));
  let result;
  try {
    result = await pushIn(work, plan, files, deps);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (existsSync(work)) throw new PushFault(`the temporary directory ${work}, which holds the registry login, is still there`);
  return result;
}

// An error run does not know is a defect, exit 70: never 1, a fault, nor 3 or
// 4, which are verdicts a caller acts on.
export async function main(argv, deps = {}) {
  try {
    return await run(argv, deps);
  } catch (e) {
    (deps.err ?? console.error)(`push: internal error: ${e?.stack ?? e}`);
    return EXIT.internal;
  }
}

async function run(argv, deps) {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const full = {
    env: deps.env ?? process.env,
    oras: deps.oras ?? orasRunner(),
    reader: deps.reader ?? anonymousReader(),
    sleep: deps.sleep ?? realSleep,
    random: deps.random ?? Math.random,
    tmp: deps.tmp,
    log: (line) => err(`push: ${line}`),
  };
  try {
    const plan = parsePushArgs(argv);
    const { code, line } = await push(plan, full);
    out(line);
    return code;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`push: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof PushFault || e instanceof RateLimitError) {
      err(`push: ${e.message}`);
      return EXIT.fault;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
