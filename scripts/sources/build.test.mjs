// scripts/sources/build.mjs: the committed registry is current, and in a
// temporary tree (--root) each fault, planted alone, gives its exit code: a
// reused bit and a missing failure_modes exit 1, a stale or absent registry
// exits 1 under --check, and a tree with no bit map exits 2. The sources are
// synthetic; the bit map is a copy of config/source-bits.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../files.mjs';

const SCRIPT = fileURLToPath(new URL('./build.mjs', import.meta.url));
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Runs the script in its own process and reads its exit code from it.
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tree({ bits = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'domains-sources-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'config'));
  if (bits) copyFileSync(join(ROOT, 'config', 'source-bits.json'), join(dir, 'config', 'source-bits.json'));
  return dir;
}

// Synthetic: the shape of a THC row.
const SOURCE = {
  id: 'thc-ct',
  bit: 0,
  family: 'ct',
  datasets: ['names', 'domains'],
  precision: 'day',
  kind: 'ct_name',
  basis: ['ct-first'],
  cadence: 'P1D',
  band: { metric: 'bytes', min: 0.4, max: 2.5, relative: true },
  urls: ['https://feed.example.test/{date}.txt.gz'],
  retention: 'unknown',
  parser: 'thc-lines/1',
  failure_modes: ['A file is late or missing.'],
};

function adapter(dir, name, sources) {
  mkdirSync(join(dir, 'adapters', name), { recursive: true });
  writeFileSync(join(dir, 'adapters', name, 'source.json'), JSON.stringify({ format: 'domains.source.v1', sources }, null, 2));
}

test("sources build: this checkout's config/sources.json is what its adapters build", () => {
  const r = run(['--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /config\/sources\.json is current/);
});

test('sources build: with no adapters it writes a registry of no source, and --check then passes', () => {
  const dir = tree();
  const r = run(['--root', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^sources 0 adapters 0$/m);
  const json = JSON.parse(readFileSync(join(dir, 'config', 'sources.json'), 'utf8'));
  assert.deepEqual(Object.keys(json), ['format', 'comment', 'sources']);
  assert.equal(json.format, 'domains.sources.v1');
  assert.deepEqual(json.sources, []);
  assert.equal(run(['--check', '--root', dir]).status, 0);
  // The committed file of this checkout is that same text.
  assert.equal(readFileSync(join(dir, 'config', 'sources.json'), 'utf8'), readFileSync(join(ROOT, 'config', 'sources.json'), 'utf8'));
});

test('sources build: an adapter is written in, and --check fails once its source.json changes or the registry is absent', () => {
  const dir = tree();
  adapter(dir, 'thc', [SOURCE]);
  assert.equal(run(['--root', dir]).status, 0);
  const reg = JSON.parse(readFileSync(join(dir, 'config', 'sources.json'), 'utf8'));
  assert.deepEqual(
    reg.sources.map((s) => [s.id, s.bit, s.adapter]),
    [['thc-ct', 0, 'thc']],
  );
  assert.equal(run(['--check', '--root', dir]).status, 0);
  adapter(dir, 'thc', [{ ...SOURCE, cadence: 'PT12H' }]);
  const stale = run(['--check', '--root', dir]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /differs from adapters\/\*\/source\.json/);
  rmSync(join(dir, 'config', 'sources.json'));
  const absent = run(['--check', '--root', dir]);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /is absent/);
});

test('sources build: a source.json with a reused bit exits 1 and writes nothing', () => {
  const dir = tree();
  adapter(dir, 'nrd', [{ ...SOURCE, id: 'oi-nrd' }]);
  const r = run(['--root', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^adapters\/nrd\/source\.json\.sources\[0\]\.bit: bit-taken: bit 0 belongs to thc-ct/m);
  assert.equal(existsSync(join(dir, 'config', 'sources.json')), false);
});

test('sources build: a source.json without failure_modes exits 1', () => {
  const dir = tree();
  const { failure_modes: _, ...rest } = SOURCE;
  adapter(dir, 'thc', [rest]);
  const r = run(['--root', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^adapters\/thc\/source\.json\.sources\[0\]\.failure_modes: missing: required$/m);
});

test('sources build: an adapter directory with no source.json exits 1, and so does one id in two directories', () => {
  const dir = tree();
  mkdirSync(join(dir, 'adapters', 'empty'), { recursive: true });
  const r = run(['--root', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^adapters\/empty: missing:/m);
  rmSync(join(dir, 'adapters', 'empty'), { recursive: true });
  adapter(dir, 'one', [SOURCE]);
  adapter(dir, 'two', [SOURCE]);
  const dup = run(['--root', dir]);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /^adapters\/two\/source\.json: duplicate: thc-ct is also in adapters\/one\/source\.json$/m);
});

test('sources build: a tree with no bit map, or bad arguments, exits 2', () => {
  const r = run(['--root', tree({ bits: false })]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read/);
  assert.equal(run(['--chek']).status, 2);
  assert.equal(run(['extra']).status, 2);
  assert.equal(run(['--root']).status, 2);
  assert.equal(run(['--check=yes']).status, 2);
});
