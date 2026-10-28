// scripts/install-oras (DOM-014): the three pinned values are written in the
// script, and an archive that does not hash to the pin is never installed,
// whether it came from ORAS_CACHE or from a download. The download is a fake
// `curl` first on PATH, so the test never reaches the network. Skipped where
// no bash is found.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './files.mjs';
import { BASH } from './lib/workflow-step.mjs';

const SCRIPT = join(ROOT, 'scripts', 'install-oras');
const SKIP = BASH ? false : 'no bash on this machine';
const posix = (p) => p.replaceAll('\\', '/');

test('install-oras: the version and both checksums are the pinned ones, written in the script', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  assert.match(text, /^ORAS_VERSION=1\.3\.4$/m);
  assert.match(text, /^ORAS_SHA256_AMD64=f27adb935022d94df8dc77719c322dda592c78a0d57a6f7dcdd8d900b248c454$/m);
  assert.match(text, /^ORAS_SHA256_ARM64=15702c6e3a4a56a8bd8ac5c17efdbcab56d9bada661ccbcf017f5b10c1d89399$/m);
  // The sums are checked, never fetched.
  assert.doesNotMatch(text, /checksums\.txt"?\s*(?:\||>)/);
  assert.match(text, /\[ "\$got" = "\$want" \] \|\| die/);
});

const FAKE_CURL = `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = --output ]; then out="$2"; fi
  shift
done
printf 'curl %s\\n' "$out" >> "$FAKE_LOG"
[ "$FAKE_CURL" = fail ] && exit 22
printf 'not the oras archive' > "$out"
`;

function install(t, { cache = null, curl = 'junk' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'install-oras-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  chmodSync(join(bin, 'curl'), 0o755);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const dest = join(dir, 'dest');
  const env = { ...process.env, FAKE_DIR: bin, FAKE_LOG: posix(log), FAKE_CURL: curl };
  if (cache !== null) {
    const cacheDir = join(dir, 'cache');
    mkdirSync(cacheDir);
    for (const arch of ['amd64', 'arm64']) writeFileSync(join(cacheDir, `oras_1.3.4_linux_${arch}.tar.gz`), cache);
    env.ORAS_CACHE = posix(cacheDir);
  }
  const prelude = 'if command -v cygpath >/dev/null 2>&1; then PATH="$(cygpath -u "$FAKE_DIR"):$PATH"; else PATH="$FAKE_DIR:$PATH"; fi; ';
  const r = spawnSync(BASH, ['-c', `${prelude}exec bash "$0" "$1"`, posix(SCRIPT), posix(dest)], { encoding: 'utf8', env });
  return { ...r, dest, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean), cacheDir: env.ORAS_CACHE };
}

test('install-oras: a cached archive that does not hash to the pin is not used, and a download that does not either is not installed', { skip: SKIP }, (t) => {
  const r = install(t, { cache: 'a tampered archive' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /does not hash to the pinned [0-9a-f]{64}; downloading again/);
  assert.match(r.stderr, /has sha256 [0-9a-f]{64}, pinned [0-9a-f]{64}/);
  assert.equal(r.calls.length, 1, 'one download was tried');
  assert.equal(existsSync(join(r.dest, 'oras')), false, 'nothing is installed');
  assert.equal(r.stdout, '');
});

test('install-oras: a failed download exits 1 and installs nothing; no directory is no usage', { skip: SKIP }, (t) => {
  const r = install(t, { curl: 'fail' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /could not download https:\/\/github\.com\/oras-project\/oras\/releases\/download\/v1\.3\.4\/oras_1\.3\.4_linux_(amd64|arm64)\.tar\.gz \(curl 22\)/);
  assert.equal(existsSync(join(r.dest, 'oras')), false);
  const bare = spawnSync(BASH, [posix(SCRIPT)], { encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /usage: scripts\/install-oras DIR/);
});
