// The configuration the gate's own steps run on: what `npm test`, `npm run lint`
// and `npm run typecheck` do, the type check's two programs, and the exact
// versions of the tools. gate.test.mjs holds the step names; this file holds
// what is behind them, so a step neutered in package.json or a tsconfig (an
// `echo ok`, a `|| true`, a dropped Worker program, strict off) fails here.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './files.mjs';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// A tsconfig with its leading // comment lines, which JSON does not allow.
const tsconfig = (name) =>
  JSON.parse(
    readFileSync(join(ROOT, name), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n'),
  );

test('config: the gate, test, lint and typecheck scripts run what the gate says they run', () => {
  assert.equal(pkg.scripts.gate, 'node scripts/gate.mjs');
  assert.equal(pkg.scripts.test, 'node scripts/test.mjs');
  assert.equal(pkg.scripts.lint, 'biome check .');
  // Both programs, the second only when the first passed: never `||`, never one alone.
  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json && tsc -p tsconfig.worker.json');
  for (const name of ['gate', 'test', 'lint', 'typecheck']) assert.doesNotMatch(pkg.scripts[name], /\|\||;|\becho\b|\btrue\b/, name);
});

test('config: every tool is pinned to an exact version', () => {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(Object.keys(deps).length >= 7);
  for (const [name, version] of Object.entries(deps)) assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, `${name}@${version}`);
  for (const name of ['typescript', '@cloudflare/workers-types', '@types/node', 'miniflare', 'wrangler', 'esbuild', '@biomejs/biome']) assert.ok(deps[name], name);
  assert.match(pkg.packageManager, /^npm@\d+\.\d+\.\d+$/);
});

test('config: the base tsconfig is strict, erasable and emits nothing', () => {
  const base = tsconfig('tsconfig.base.json').compilerOptions;
  for (const flag of ['strict', 'noEmit', 'erasableSyntaxOnly', 'verbatimModuleSyntax', 'allowImportingTsExtensions', 'noImplicitOverride']) assert.equal(base[flag], true, flag);
  assert.deepEqual(base.types, []);
});

test('config: the Node program checks every workspace and the scripts against Node types', () => {
  const node = tsconfig('tsconfig.json');
  assert.equal(node.extends, './tsconfig.base.json');
  assert.deepEqual(node.compilerOptions.types, ['node']);
  assert.deepEqual(node.include, ['apps', 'packages', 'adapters', 'probes', 'scripts']);
});

test('config: the Worker program checks every Worker source against the runtime types alone', () => {
  const worker = tsconfig('tsconfig.worker.json');
  assert.equal(worker.extends, './tsconfig.base.json');
  assert.deepEqual(worker.compilerOptions.types, ['@cloudflare/workers-types']);
  assert.deepEqual(worker.include, ['apps/*/src', 'probes/*/src', 'probes/*/test/*-entry.ts', 'packages/*/src', 'packages/*/test/*-worker.ts']);
  assert.equal(worker.files, undefined, 'the test Worker entries are matched by the pattern, not listed');
  // The Worker entry each package's workerd test loads from its own directory
  // (`join(import.meta.dirname, "<entry>.ts")`) is a *-worker.ts the pattern
  // matches, so none runs in workerd unchecked against the runtime's types.
  // An entry under test/fixtures/ is a planted fault (a node: import) and stays out.
  for (const name of readdirSync(join(ROOT, 'packages'))) {
    const harness = join(ROOT, 'packages', name, 'test', 'workerd.test.ts');
    if (!existsSync(harness)) continue;
    const entries = [...readFileSync(harness, 'utf8').matchAll(/join\(import\.meta\.dirname, "([^"/]+\.ts)"\)/g)].map((m) => m[1]);
    assert.ok(entries.length > 0, `packages/${name}/test/workerd.test.ts loads no entry of its own directory`);
    for (const entry of entries) {
      assert.match(entry, /-worker\.ts$/, `packages/${name}/test/${entry} runs in workerd and packages/*/test/*-worker.ts does not match it`);
      assert.ok(existsSync(join(ROOT, 'packages', name, 'test', entry)), `packages/${name}/test/${entry}`);
    }
  }
  // A package source left out of the Worker program is named Node-only, and
  // each name is a package that exists.
  const nodeOnly = worker.exclude.filter((p) => /^packages\/[^/*]+\/src$/.test(p));
  assert.deepEqual(nodeOnly, ['packages/testkit/src']);
  for (const p of nodeOnly) assert.ok(existsSync(join(ROOT, p)), p);
  const others = worker.exclude.filter((p) => !nodeOnly.includes(p));
  assert.deepEqual(others, ['**/*.test.ts', '**/*.test.mts', '**/*.test.cts', '**/node_modules']);
  // Every package with a src directory is in one program's list or the other.
  for (const name of readdirSync(join(ROOT, 'packages'))) {
    if (!existsSync(join(ROOT, 'packages', name, 'src'))) continue;
    assert.ok(nodeOnly.includes(`packages/${name}/src`) || worker.include.includes('packages/*/src'), name);
  }
});
