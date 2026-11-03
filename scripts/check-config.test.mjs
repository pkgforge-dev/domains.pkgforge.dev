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
  assert.deepEqual(worker.include, ['apps/*/src', 'adapters/*/src', 'probes/*/src', 'probes/*/test/*-entry.ts', 'packages/*/src', 'packages/*/test/*-worker.ts']);
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

// wrangler, the miniflare of the harness, the workerd that both load and the
// Workers types move as one set (TODO/serve.md, DOM-030's D16). package.json,
// the lock and node_modules name one version of each. miniflare and workerd are
// the ones wrangler depends on, and the types carry the harness's date in their
// version (5.YYYYMMDD.N). So a move of one of them alone fails here.
test('config: wrangler, miniflare, workerd and the Workers types are one set in package.json, the lock and node_modules, and the types are of the harness date', async () => {
  const { COMPATIBILITY_DATE } = await import('../packages/testkit/src/workerd.ts');
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const installed = (name) => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
  const dev = pkg.devDependencies;
  for (const name of ['wrangler', 'miniflare', '@cloudflare/workers-types']) {
    assert.equal(lock.packages[''].devDependencies[name], dev[name], `the lock's root names ${name} ${dev[name]}`);
    assert.equal(lock.packages[`node_modules/${name}`].version, dev[name], `the lock installs ${name} ${dev[name]}`);
    assert.equal(installed(name).version, dev[name], `node_modules holds ${name} ${dev[name]}`);
  }
  const wrangler = installed('wrangler');
  const locked = lock.packages['node_modules/wrangler'].dependencies;
  assert.equal(wrangler.dependencies.miniflare, dev.miniflare, 'the harness runs the miniflare that wrangler depends on');
  assert.equal(locked.miniflare, dev.miniflare, "the lock's wrangler depends on the harness's miniflare");
  const workerd = wrangler.dependencies.workerd;
  assert.equal(locked.workerd, workerd, "the lock's wrangler depends on the installed wrangler's workerd");
  assert.equal(lock.packages['node_modules/workerd'].version, workerd, `the lock installs workerd ${workerd}`);
  assert.equal(installed('workerd').version, workerd, `node_modules holds workerd ${workerd}`);
  assert.equal(installed('miniflare').dependencies.workerd, workerd, 'miniflare loads the workerd that wrangler depends on');
  const date = /^\d+\.(\d{4})(\d{2})(\d{2})\.\d+$/.exec(dev['@cloudflare/workers-types']);
  assert.ok(date, `@cloudflare/workers-types ${dev['@cloudflare/workers-types']} carries no date`);
  assert.equal(`${date[1]}-${date[2]}-${date[3]}`, COMPATIBILITY_DATE, 'the types are of COMPATIBILITY_DATE of packages/testkit');
});

// Every wrangler command that a procedure of the tree tells a reader to run
// names the pinned wrangler: the comments of each wrangler.toml, the workflows,
// HUMAN.md, docs/worker.md and the delete column of docs/resources.md. A record
// keeps the version that ran, so the entries, CHANGELOG.md, docs/research/ and
// the created columns of the ledger are not read. docs/worker.md names the
// harness's date in its row of compatibility_date.
test('config: every wrangler command of a procedure names the pinned wrangler, and docs/worker.md names the harness date', async () => {
  const { COMPATIBILITY_DATE } = await import('../packages/testkit/src/workerd.ts');
  const pin = pkg.devDependencies.wrangler;
  const tomls = ['apps', 'probes'].flatMap((d) => readdirSync(join(ROOT, d)).map((n) => `${d}/${n}/wrangler.toml`)).filter((p) => existsSync(join(ROOT, p)));
  const workflows = readdirSync(join(ROOT, '.github', 'workflows'))
    .filter((n) => /\.ya?ml$/.test(n))
    .map((n) => `.github/workflows/${n}`);
  const commands = [];
  for (const file of [...tomls, ...workflows, 'HUMAN.md', 'docs/worker.md']) {
    for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(/wrangler@([^\s`'"]+)/g)) commands.push({ file, version: m[1] });
  }
  // The last cell of each row of a table whose header ends with `delete`.
  const rows = readFileSync(join(ROOT, 'docs', 'resources.md'), 'utf8').split('\n');
  let header = null;
  for (const [i, line] of rows.entries()) {
    if (!line.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = line.slice(1, -1).split('|');
    if (header === null) {
      header = cells.map((c) => c.trim());
      continue;
    }
    if (header.at(-1) !== 'delete' || /^\s*-+\s*$/.test(cells[0])) continue;
    assert.equal(cells.length, header.length, `docs/resources.md line ${i + 1}: ${cells.length} cells, not ${header.length}`);
    for (const m of cells.at(-1).matchAll(/wrangler@([^\s`'"]+)/g)) commands.push({ file: `docs/resources.md:${i + 1}`, version: m[1] });
  }
  for (const file of ['apps/api/wrangler.toml', 'probes/worker/wrangler.toml', '.github/workflows/worker.yml', 'HUMAN.md', 'docs/worker.md']) {
    assert.ok(
      commands.some((c) => c.file === file),
      `${file} names no wrangler@ command`,
    );
  }
  assert.ok(commands.some((c) => c.file.startsWith('docs/resources.md:')));
  assert.deepEqual(
    commands.filter((c) => c.version !== pin),
    [],
    `each names wrangler@${pin}`,
  );
  const row = /^\| `compatibility_date` \| `(\d{4}-\d{2}-\d{2})`/m.exec(readFileSync(join(ROOT, 'docs', 'worker.md'), 'utf8'));
  assert.equal(row?.[1], COMPATIBILITY_DATE, 'docs/worker.md names COMPATIBILITY_DATE in its row of compatibility_date');
});
