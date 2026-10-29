// scripts/ghcr/fixtures/fake-oras.mjs — a synthetic stand-in for oras 1.3.4,
// for push.test.mjs's run of push.mjs as a process, on Windows as on Linux.
// The test sets ORAS to node itself and NODE_OPTIONS=--import=<this file>, so
// `ORAS login ...` is `node login ...`: node loads this module first, which
// answers for the verb (the name of the file node was given) and exits before
// node looks for that file. In any other process, push.mjs itself among them,
// it does nothing.
//
// Each call appends one JSON line to FAKE_ORAS_LOG: { verb, args, stdin,
// envHasToken }. `login` writes the registry config; `push --oci-layout` writes
// an OCI layout (index.json and blobs) and prints the JSON of `--format json`;
// `manifest fetch` writes the bytes of FAKE_ORAS_REMOTE, the manifest another
// writer left under the tag; `copy` exits 99, since the run that uses this fake
// ends before a copy. Nothing here touches a network.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const VERBS = new Set(['login', 'push', 'manifest', 'copy']);
const VALUE_FLAGS = new Set(['--format', '--artifact-type', '--annotation', '--registry-config', '--to-registry-config', '--output', '--username']);
const verb = basename(process.argv[1] ?? '');

if (VERBS.has(verb) && process.env.FAKE_ORAS_LOG) {
  const args = process.argv.slice(2);
  const pos = [];
  const flags = {};
  const annotations = [];
  for (let i = verb === 'manifest' ? 1 : 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (a === '--annotation') annotations.push(v);
      else flags[a] = v;
    } else if (a.startsWith('--')) flags[a] = true;
    else pos.push(a);
  }
  let stdin = '';
  if (verb === 'login') for await (const chunk of process.stdin) stdin += chunk;
  const envHasToken = Object.keys(process.env).some((k) => k.toUpperCase() === 'REGISTRY_TOKEN');
  appendFileSync(process.env.FAKE_ORAS_LOG, `${JSON.stringify({ verb, args, stdin, envHasToken })}\n`);
  const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
  const splitRef = (r) => [r.slice(0, r.lastIndexOf(':')), r.slice(r.lastIndexOf(':') + 1)];
  let code = 0;
  if (verb === 'login') {
    mkdirSync(dirname(flags['--registry-config']), { recursive: true });
    writeFileSync(flags['--registry-config'], JSON.stringify({ auths: { 'ghcr.io': { auth: 'synthetic' } } }));
    process.stdout.write('Login Succeeded\n');
  } else if (verb === 'push') {
    const [layout, tag] = splitRef(pos[0]);
    const blobs = join(layout, 'blobs', 'sha256');
    mkdirSync(blobs, { recursive: true });
    const layers = pos.slice(1).map((f) => {
      const [path, mediaType] = splitRef(f);
      const bytes = readFileSync(path);
      writeFileSync(join(blobs, sha(bytes).slice(7)), bytes);
      return { mediaType, digest: sha(bytes), size: bytes.length, annotations: { 'org.opencontainers.image.title': path.replace(/^\.\//, '') } };
    });
    const ann = Object.fromEntries(annotations.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]).sort(([a], [b]) => (a < b ? -1 : 1)));
    const empty = { mediaType: 'application/vnd.oci.empty.v1+json', digest: sha('{}'), size: 2, data: 'e30=' };
    const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', artifactType: flags['--artifact-type'], config: empty, layers, annotations: ann });
    const d = sha(manifest);
    writeFileSync(join(blobs, d.slice(7)), manifest);
    const entry = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: d, size: Buffer.byteLength(manifest), annotations: { 'org.opencontainers.image.ref.name': tag } };
    writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [entry] }));
    process.stdout.write(JSON.stringify({ reference: `${layout}@${d}`, mediaType: entry.mediaType, digest: d, size: entry.size, annotations: ann, artifactType: flags['--artifact-type'] }));
  } else if (verb === 'manifest') {
    writeFileSync(flags['--output'], readFileSync(process.env.FAKE_ORAS_REMOTE));
  } else {
    process.stderr.write('Error: the fake oras answers no copy\n');
    code = 99;
  }
  process.exit(code);
}
