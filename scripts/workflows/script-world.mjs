// scripts/workflows/script-world.mjs — the `node` of a workflow step in
// scripts/workflows/ingest-live-scripts.test.mjs (DOM-024): it runs one real
// script of the step, by its own `main`, against the GHCR double of
// scripts/root/fixture.mjs, and keeps the double in a file between the steps
// of a test, so each step's script reads what the earlier steps' scripts
// pushed. Everything in the double is synthetic.
//
// The step's own arguments reach the script unchanged, and so does the step's
// environment: a step that holds no REGISTRY_TOKEN gives the script none. The
// double stands for ghcr.io (packages/ghcr's reader runs its production dial
// on the double's fetch) and for oras (the double's oras). After the step's
// arguments come the paths a runner's tree gives by default, here the
// fixtures of scripts/ingest/fixtures/ (the lanes, the source registry, the
// adapters and their recordings), and the run's clock, JOIN_NOW:
//   scripts/ingest/plan.mjs     --lanes --sources --adapters --now
//   scripts/ingest/run.mjs      --lanes --sources --adapters --recordings (of its --adapter) --now
//   scripts/state/advance.mjs   --now
//   scripts/state/hours.mjs     --now --sources
//   scripts/state/move.mjs, scripts/ghcr/push.mjs   nothing (the clock is JOIN_NOW)
//   scripts/root/promote.mjs    --sources
// Any other script exits 99, so a step cannot pass on a script this file does
// not run.
//
// Usage: node scripts/workflows/script-world.mjs SCRIPT ARG...
// Environment: JOIN_WORLD (the double's file; absent is an empty double),
// JOIN_NOW (ISO 8601 UTC), and the step's own.
// Exit: the script's own code; 99 a script this file does not run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../files.mjs';
import { ADAPTERS, LANES_FILE, RECORDINGS, SOURCES } from '../ingest/fixture.mjs';
import { registry } from '../root/fixture.mjs';

const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const FIXTURE = {
  'scripts/ingest/plan.mjs': (now) => ['--lanes', LANES_FILE, '--sources', SOURCES, '--adapters', ADAPTERS, '--now', now],
  'scripts/ingest/run.mjs': (now, argv) => ['--lanes', LANES_FILE, '--sources', SOURCES, '--adapters', ADAPTERS, '--recordings', RECORDINGS(after(argv, '--adapter')), '--now', now],
  'scripts/state/advance.mjs': (now) => ['--now', now],
  'scripts/state/hours.mjs': (now) => ['--now', now, '--sources', SOURCES],
  'scripts/state/move.mjs': () => [],
  'scripts/ghcr/push.mjs': () => [],
  'scripts/root/promote.mjs': () => ['--sources', SOURCES],
};

// The double's state in FILE: its manifests by PKG:REF, its blobs by
// PKG@DIGEST and their bytes by digest. The test seeds the first one with
// saveWorld and reads the last one with readWorld.
export function loadWorld(reg, file) {
  if (!existsSync(file)) return;
  const s = JSON.parse(readFileSync(file, 'utf8'));
  for (const [k, v] of s.manifests) reg.w.manifests.set(k, v);
  for (const [k, v] of s.blobs) reg.w.blobs.set(k, v);
  for (const [d, b] of s.bytes) reg.bytes.set(d, new Uint8Array(Buffer.from(b, 'base64')));
}

export function saveWorld(reg, file) {
  const bytes = [...reg.bytes].map(([d, b]) => [d, Buffer.from(b).toString('base64')]);
  writeFileSync(file, JSON.stringify({ manifests: [...reg.w.manifests], blobs: [...reg.w.blobs], bytes }));
}

// What FILE holds: { manifests: Map PKG:REF -> text, bytes: Map DIGEST -> Uint8Array }.
export function readWorld(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  return { manifests: new Map(s.manifests), bytes: new Map(s.bytes.map(([d, b]) => [d, new Uint8Array(Buffer.from(b, 'base64'))])) };
}

async function run(script, argv) {
  if (!Object.hasOwn(FIXTURE, script)) {
    process.stderr.write(`script-world: no world for ${JSON.stringify(script)}; it runs ${Object.keys(FIXTURE).join(', ')}\n`);
    return 99;
  }
  const now = process.env.JOIN_NOW;
  const file = process.env.JOIN_WORLD;
  const { main } = await import(pathToFileURL(join(ROOT, script)).href);
  // registry() takes over fetch, console.error and Date.now until close(): the
  // lines go to the process's own streams.
  const reg = registry({ t0: Date.parse(now) });
  try {
    loadWorld(reg, file);
    const code = await main([...argv, ...FIXTURE[script](now, argv)], {
      env: { ...process.env },
      oras: reg.oras,
      sleep: async () => undefined,
      random: () => 0,
      now: () => Date.parse(now),
      out: (l) => process.stdout.write(`${l}\n`),
      err: (l) => process.stderr.write(`${l}\n`),
    });
    saveWorld(reg, file);
    return code;
  } finally {
    reg.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await run(process.argv[2], process.argv.slice(3));
