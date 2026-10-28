// scripts/install-oras (DOM-014): the three pinned values are written in the
// script, the script carries the executable bit in the index, and an archive
// that does not hash to the pin is never installed, whether it came from
// ORAS_CACHE or from a download. An oras already installed at the pinned
// version is kept. The install path itself runs on a copy whose two sums are
// those of a synthetic archive built here, the only change to the copy. The
// download is a fake `curl` first on PATH, so no test reaches the network.
// Skipped where no bash is found.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// A stand-in oras that answers `oras version` as the release does.
const fakeOras = (version) => `#!/usr/bin/env bash
printf 'Version:        %s\\nGo version:     go1.25.3\\n' '${version}'
`;

// Runs SCRIPT (or `script`, a copy) into DIR/dest with the fake curl. `cache`
// is the text of both cached archives, or `archive` a path whose bytes are;
// `installed` is the version of an oras already in dest.
function install(t, { cache = null, archive = null, curl = 'junk', installed = null, script = SCRIPT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'install-oras-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  chmodSync(join(bin, 'curl'), 0o755);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const dest = join(dir, 'dest');
  if (installed !== null) {
    mkdirSync(dest);
    writeFileSync(join(dest, 'oras'), fakeOras(installed));
    chmodSync(join(dest, 'oras'), 0o755);
  }
  const env = { ...process.env, FAKE_DIR: bin, FAKE_LOG: posix(log), FAKE_CURL: curl };
  if (cache !== null || archive !== null) {
    const cacheDir = join(dir, 'cache');
    mkdirSync(cacheDir);
    const bytes = archive !== null ? readFileSync(archive) : cache;
    for (const arch of ['amd64', 'arm64']) writeFileSync(join(cacheDir, `oras_1.3.4_linux_${arch}.tar.gz`), bytes);
    env.ORAS_CACHE = posix(cacheDir);
  }
  const prelude = 'if command -v cygpath >/dev/null 2>&1; then PATH="$(cygpath -u "$FAKE_DIR"):$PATH"; else PATH="$FAKE_DIR:$PATH"; fi; ';
  const r = spawnSync(BASH, ['-c', `${prelude}exec bash "$0" "$1"`, posix(script), posix(dest)], { encoding: 'utf8', env });
  return { ...r, dest, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean), cacheDir: env.ORAS_CACHE };
}

test('install-oras: the script carries the executable bit in the git index', (t) => {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-s', '--', 'scripts/install-oras'], { encoding: 'utf8' });
  if (r.error || r.status !== 0 || r.stdout.trim() === '') {
    t.skip('git cannot read the index here, or the script is not in it yet');
    return;
  }
  // A workflow step runs `scripts/install-oras DIR` directly: mode 100644 is "Permission denied" on the runner.
  assert.match(r.stdout, /^100755 [0-9a-f]{40,64} 0\tscripts\/install-oras$/m, 'run: git update-index --chmod=+x scripts/install-oras');
});

test('install-oras: an oras already installed at the pinned version is kept and nothing is downloaded; another version is not kept', { skip: SKIP }, (t) => {
  const kept = install(t, { installed: '1.3.4', curl: 'fail' });
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.equal(kept.stdout.trim(), `${posix(kept.dest)}/oras`);
  assert.deepEqual(kept.calls, [], 'no download');
  const old = install(t, { installed: '1.2.0', curl: 'fail' });
  assert.equal(old.status, 1, old.stdout + old.stderr);
  assert.equal(old.calls.length, 1, 'a download was tried');
  assert.match(old.stderr, /could not download .* \(curl 22\)/);
});

test('install-oras: a cached archive that hashes to the pin is installed with no download, and the installed version is read back', { skip: SKIP }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'install-oras-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'oras'), fakeOras('1.3.4'));
  chmodSync(join(dir, 'oras'), 0o755);
  // Relative names: GNU tar reads a `C:` in an archive path as a remote host.
  const tar = spawnSync(BASH, ['-c', 'cd "$0" && tar -czf archive.tar.gz oras', posix(dir)], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const archive = join(dir, 'archive.tar.gz');
  const sum = createHash('sha256').update(readFileSync(archive)).digest('hex');
  // The copy differs from the script in its two pinned sums and nothing else.
  const text = readFileSync(SCRIPT, 'utf8');
  const copy = text.replace(/^(ORAS_SHA256_(?:AMD64|ARM64))=[0-9a-f]{64}$/gm, `$1=${sum}`);
  assert.equal(copy.split('\n').filter((l, i) => l !== text.split('\n')[i]).length, 2);
  const script = join(dir, 'install-oras');
  writeFileSync(script, copy);
  const r = install(t, { archive, curl: 'fail', script });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), `${posix(r.dest)}/oras`);
  assert.deepEqual(r.calls, [], 'the cached archive was used, not a download');
  assert.equal(existsSync(join(r.dest, 'oras')), true);
  // The same copy refuses the archive once one byte of it changes.
  const bad = Buffer.from(readFileSync(archive));
  bad[bad.length - 1] ^= 0xff;
  writeFileSync(archive, bad);
  const refused = install(t, { archive, curl: 'fail', script });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /does not hash to the pinned [0-9a-f]{64}; downloading again/);
  assert.equal(existsSync(join(refused.dest, 'oras')), false);
});

// A synthetic archive holding a fake oras that reports `version`, and a copy
// of the script whose AMD64 and ARM64 sums are `sums(archiveSum)`.
function archiveAndCopy(t, version, sums) {
  const dir = mkdtempSync(join(tmpdir(), 'install-oras-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'oras'), fakeOras(version));
  chmodSync(join(dir, 'oras'), 0o755);
  const tar = spawnSync(BASH, ['-c', 'cd "$0" && tar -czf archive.tar.gz oras', posix(dir)], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const archive = join(dir, 'archive.tar.gz');
  const sum = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const { amd64, arm64 } = sums(sum);
  const copy = readFileSync(SCRIPT, 'utf8')
    .replace(/^ORAS_SHA256_AMD64=[0-9a-f]{64}$/m, `ORAS_SHA256_AMD64=${amd64}`)
    .replace(/^ORAS_SHA256_ARM64=[0-9a-f]{64}$/m, `ORAS_SHA256_ARM64=${arm64}`);
  const script = join(dir, 'install-oras');
  writeFileSync(script, copy);
  return { archive, script };
}

test('install-oras: an installed oras that reports another version than the pin fails the install', { skip: SKIP }, (t) => {
  const { archive, script } = archiveAndCopy(t, '1.9.9', (sum) => ({ amd64: sum, arm64: sum }));
  const r = install(t, { archive, curl: 'fail', script });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /the installed oras reports version '1\.9\.9', expected 1\.3\.4/);
  assert.equal(r.stdout, '');
});

test("install-oras: the sum checked is the one for this machine's architecture", { skip: SKIP }, (t) => {
  const machine = spawnSync(BASH, ['-c', 'uname -m'], { encoding: 'utf8' }).stdout.trim();
  const mine = machine === 'x86_64' ? 'amd64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : null;
  if (mine === null) {
    t.skip(`no pinned oras for ${machine}`);
    return;
  }
  const other = 'e'.repeat(64);
  const pin = (sum, right) => ((mine === 'amd64') === right ? { amd64: sum, arm64: other } : { amd64: other, arm64: sum });
  const right = archiveAndCopy(t, '1.3.4', (sum) => pin(sum, true));
  assert.equal(install(t, { archive: right.archive, curl: 'fail', script: right.script }).status, 0, `${mine}: its own sum installs`);
  const wrong = archiveAndCopy(t, '1.3.4', (sum) => pin(sum, false));
  const refused = install(t, { archive: wrong.archive, curl: 'fail', script: wrong.script });
  assert.equal(refused.status, 1, `${mine}: the other architecture's sum is not this one's`);
  assert.match(refused.stderr, new RegExp(`does not hash to the pinned ${other}`));
});

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
