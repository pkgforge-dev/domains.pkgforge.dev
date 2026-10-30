// scripts/ingest/fixture.mjs — what the tests of scripts/ingest/ and
// scripts/state/ share (DOM-024): the paths of the synthetic fixtures (two
// adapters, their recordings, a registry built from them, a lanes file), the
// GHCR double of scripts/root/fixture.mjs with the list and a root seeded the
// way run.mjs --psl root reads them, and a call that collects a CLI's lines.
// Everything here is synthetic: no byte, digest or token was recorded from GHCR.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactType, refTag } from '@domains/ghcr';
import { buildRoot, sourcesLayer } from '@domains/root';
import { encodeState } from '@domains/state';
import { depsFor, registry } from '../root/fixture.mjs';
import { DEFAULT_PSL, loadRegistry } from '../verify-pack.mjs';

export const F = fileURLToPath(new URL('./fixtures', import.meta.url));
export const ADAPTERS = join(F, 'adapters');
export const SOURCES = join(F, 'sources.json');
export const LANES_FILE = join(F, 'lanes.json');
export const RECORDINGS = (adapter) => join(ADAPTERS, adapter, 'recordings');
// The list of the names package's tests, the verifier's default (its sha256:
// packages/compact/test/daily-helpers.ts, MEASURED 2026-10-29T22:06Z).
export const PSL_FILE = DEFAULT_PSL;
export const PSL_BYTES = readFileSync(DEFAULT_PSL);
export const PSL = createHash('sha256').update(PSL_BYTES).digest('hex');

// A test in a fresh double and a temporary directory; it fails when a GHCR
// answer body was left neither read nor cancelled.
export async function inRegistry(fn, options = {}) {
  const reg = registry(options);
  const tmp = mkdtempSync(join(tmpdir(), 'ingest-test-'));
  try {
    await fn(reg, tmp);
    assert.deepEqual(reg.w.unusedBodies(), [], 'every GHCR answer body is read or cancelled');
  } finally {
    reg.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// A temporary directory with no double.
export async function inTmp(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'ingest-test-'));
  try {
    await fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ref:psl-<sha12> holding the list itself, as ref-refresh.yml pushes it.
export function seedList(reg) {
  return reg.seed('ref', refTag('psl', PSL), artifactType('ref'), { 'dev.pkgforge.domains.sha256': PSL }, [{ title: 'public_suffix_list.dat', bytes: PSL_BYTES, mediaType: 'text/plain' }]);
}

// A first root (root_seq 1) pinning the list, with the packs `add` and the
// sources.json layer of the fixture registry, as root:latest.
export function seedRoot(reg, { now = '2026-10-30T07:00:00Z', add = [] } = {}) {
  seedList(reg);
  const root = buildRoot({ live: null, psl: PSL, now, add });
  return { root, digest: reg.seedRoot(root, { sources: sourcesLayer({ registry: loadRegistry(SOURCES), root }) }) };
}

// A state file in `dir`.
export function stateFile(dir, state, name = 'state.json') {
  const path = join(dir, name);
  writeFileSync(path, encodeState(state));
  return path;
}

// `main` with the double's deps (a synthetic token and actor), collecting its
// lines: { code, out, err, text }.
export async function call(main, argv, { reg = null, now = '2026-10-30T08:35:00Z', env, extra = {} } = {}) {
  const out = [];
  const err = [];
  const base = reg === null ? { env: {}, sleep: async () => undefined, random: () => 0 } : depsFor(reg, { now });
  const deps = { ...base, ...(env === undefined ? {} : { env }), now: () => Date.parse(now), out: (l) => out.push(l), err: (l) => err.push(l), ...extra };
  const code = await main(argv, deps);
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

export const verbs = (reg) => reg.calls.map((c) => c.verb);
// The tag each `copy` wrote, in order.
export const copied = (reg) => reg.calls.filter((c) => c.verb === 'copy').map((c) => c.args.at(-1).slice(c.args.at(-1).lastIndexOf(':') + 1));
