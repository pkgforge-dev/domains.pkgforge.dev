// scripts/ingest/pack.mjs — what scripts/ingest/run.mjs and scripts/state/
// share to verify and push a pack directory, and the pinned list (DOM-024).
//
//   verifyDir({ blobs, annotations, require, psl, sources, history, rawBytes, work }, deps)
//       verify-pack.mjs `main` in process with --json, over the files of
//       blobs.json and the manifest's annotations: { code, verdict, result, lines }
//   pushFiles({ pkg, tag, artifactType, created, annotations, files }, deps)
//       push.mjs `main` in process: { code, line, digest }; deps.push stands
//       in for push.mjs's main (a test plants its lines)
//   pushPlanOf(manifest, blobs)    the artifact type, created, annotations and files of a manifest.json and its blobs.json
//   pslFile(reader, sha256, dir, deps)   the list ref:psl-<sha12> pins, its layer held to its hash, as a file
//   rootPsl(reader, dir, deps)     the list root:latest names (D23 of DOM-024), as a file
//
// ⚠ A verify and push of a pack from manifest.json and blobs.json also lives
// in the bash of the four compaction workflows ("Verify the pack", "Push the
// pack", the PSL pull). This is a second place, not a third, and an open item
// of DOM-024: a later change can point the workflows at it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATEST, refTag, repoOf } from '@domains/ghcr';
import { main as pushMain } from '../ghcr/push.mjs';
import { readPaused } from '../ghcr/rate.mjs';
import { pinnedPsl } from '../root/promote.mjs';
import { Fault, readBlob, readRoot } from '../root/lib.mjs';
import { main as verifyMain } from '../verify-pack.mjs';

const TITLE = 'org.opencontainers.image.title';
const CREATED = 'org.opencontainers.image.created';
const SOURCE = 'org.opencontainers.image.source';
const PSL_TITLE = 'public_suffix_list.dat';
// The list is about 0.3 MB; a layer above this is refused unread.
const PSL_MAX_BYTES = 16 * 1024 * 1024;
const PUSHED = /^(?:pushed|present) \S+ (sha256:[0-9a-f]{64})\b/;

let files = 0;

// verify-pack.mjs over a pack on disk: the part files and idx of `blobs`
// (blobs.json), and its time copy's when it carries one, the expectation `annotations` (the manifest's), the list
// `psl`, the registry `sources`, the checks `require`, and for the volume
// check `history` (a list of { day, count, quarantined }) and `rawBytes`.
// Returns verify-pack's exit code, the verdict and result of its --json (null
// when it could not run), and its stderr lines. deps.verify stands in for
// verify-pack's main (a test reads the arguments it is given).
export async function verifyDir({ blobs, annotations, require, psl, sources, history = null, rawBytes = null, work }, deps = {}) {
  mkdirSync(work, { recursive: true });
  const n = ++files;
  const annPath = join(work, `verify-${n}.annotations.json`);
  writeFileSync(annPath, `${JSON.stringify(annotations)}\n`);
  const argv = [...blobs.filter((b) => b.file !== null && /^(?:time\.)?(?:part\.\d{3,}|idx)$/.test(b.title)).map((b) => b.file), '--annotations', annPath, '--psl', psl, '--sources', sources];
  argv.push('--require', require.join(','), '--json');
  if (history !== null) {
    const historyPath = join(work, `verify-${n}.history.json`);
    writeFileSync(historyPath, `${JSON.stringify(history)}\n`);
    argv.push('--history', historyPath);
    if (rawBytes !== null) argv.push('--raw-bytes', String(rawBytes));
  }
  let text = '';
  const lines = [];
  const code = await (deps.verify ?? verifyMain)(argv, { write: (t) => (text += t), err: (l) => lines.push(l), sleep: deps.sleep, random: deps.random });
  if (code !== 0 && code !== 1) return { code, verdict: null, result: null, lines };
  const result = JSON.parse(text);
  return { code, verdict: result.verdict, result, lines };
}

// The push plan of a pack written with manifest.json and blobs.json: the
// manifest's artifact type, its created, every other annotation but
// org.opencontainers.image.source (push.mjs sets the two itself), and its
// layers as files in the manifest's order, each with its media type.
export function pushPlanOf(manifest, blobs) {
  const ann = manifest.annotations ?? {};
  const byTitle = new Map(blobs.filter((b) => b.file !== null).map((b) => [b.title, b]));
  const layerFiles = (manifest.layers ?? []).map((l) => {
    const title = l.annotations?.[TITLE];
    const b = byTitle.get(title);
    if (b === undefined || b.digest !== l.digest || b.size !== l.size) throw new Fault(`blobs.json names no file of ${l.size} B hashing to ${l.digest} for the layer ${title} of the manifest`);
    return { path: b.file, mediaType: l.mediaType };
  });
  return {
    artifactType: manifest.artifactType,
    created: ann[CREATED],
    annotations: Object.entries(ann).filter(([k]) => k !== CREATED && k !== SOURCE),
    files: layerFiles,
  };
}

// One push with scripts/ghcr/push.mjs in process. `annotations` are [key,
// value] pairs; `files` [{ path, mediaType }], in one directory. Returns
// push.mjs's exit code, its one stdout line, and the digest a `pushed` or
// `present` line names (null otherwise).
export async function pushFiles({ pkg, tag, artifactType, created, annotations, files: layers }, deps) {
  const argv = [pkg, tag, '--artifact-type', artifactType, '--created', created];
  for (const [k, v] of annotations) argv.push('--annotation', `${k}=${v}`);
  for (const f of layers) argv.push(`${f.path}:${f.mediaType}`);
  const said = [];
  const code = await (deps.push ?? pushMain)(argv, {
    env: deps.env,
    oras: deps.oras,
    reader: deps.reader,
    sleep: deps.sleep,
    random: deps.random,
    tmp: deps.tmp,
    out: (l) => said.push(l),
    err: deps.err,
  });
  const line = said.at(-1) ?? '';
  const m = PUSHED.exec(line);
  if (code === 0 && m === null) throw new Fault(`scripts/ghcr/push.mjs exited 0 for ${pkg}:${tag} and printed no digest: ${said.join(' ')}`);
  return { code, line, digest: code === 0 ? m[1] : null };
}

// The list `sha256` names, read with no credential: ref:psl-<sha12> through
// pinnedPsl of scripts/root/promote.mjs, its one layer through readBlob, held
// to the hash, and written to DIR/psl-<sha12>.dat. Returns the file's path.
// The manifest is read twice (pinnedPsl's read, then this one), so the layer
// and its hash are held again: a tag moved between the two reads is refused.
export async function pslFile(reader, sha256, dir, deps = {}) {
  const tag = refTag('psl', sha256);
  const pinned = await pinnedPsl(reader, tag, deps);
  if (pinned !== sha256) throw new Fault(`ref:${tag} pins ${pinned}, not ${sha256}`);
  const repo = repoOf('ref');
  const m = await readPaused(`the manifest ${tag} of ${repo}`, () => reader.getManifest(repo, tag), deps);
  const layer = (m.json.layers ?? []).find((l) => l.annotations?.[TITLE] === PSL_TITLE);
  if (layer === undefined) throw new Fault(`ref:${tag} holds no layer ${PSL_TITLE}`);
  const bytes = await readBlob(reader, repo, layer, deps, PSL_MAX_BYTES);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Fault(`the layer of ref:${tag} hashes to ${got}, not ${sha256}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${tag}.dat`);
  writeFileSync(path, bytes);
  return path;
}

// The list root:latest names (`psl` of root.json), read with no credential
// (D23 of DOM-024): { path, sha256, from }. A root that does not read with no
// credential passes its GhcrError through: the caller prints PRIVATE PACKAGE.
export async function rootPsl(reader, dir, deps = {}) {
  const live = await readRoot(reader, LATEST, deps);
  const path = await pslFile(reader, live.root.psl, dir, deps);
  return { path, sha256: live.root.psl, from: `root:${LATEST} ${live.digest}` };
}
