// scripts/test.mjs — run the repository's tests the same way in every shell,
// with a name filter that cannot pass vacuously. `npm test` runs it with no
// arguments; a Prove names a directory and a filter. It replaces
// `npm test -- --test-name-pattern=<x>`, which fails three ways: npm places the
// pattern after a file glob, where node ignores it; a pattern that matches
// nothing still exits 0; and PowerShell drops the `--`, so npm rejects the flag
// as its own.
//
// Every `*.test.{mjs,js,cjs,ts,mts,cts}` file under the directory runs under
// node:test, in the files the walk finds (scripts/, and later apps/ and
// packages/). node_modules, dot-directories and docs/research (dated evidence,
// kept as it ran) are skipped. A run is bounded: it ends every process it
// started when it is ended itself, and is stopped past `TEST_TIMEOUT_MIN`
// minutes (default 30). It runs `TEST_CONCURRENCY` files at a time (default a
// fifth of the cores, 1 to 4).
//
//   node scripts/test.mjs                                  every test
//   node scripts/test.mjs scripts/todo                     one directory's tests; fails when it has none
//   node scripts/test.mjs scripts/todo --name "check 4"    tests whose name matches; fails when none ran
//
// Exit: 0 the selected tests passed · 1 a test failed, no test ran (none in the
// directory, or none matching --name), or the run timed out · 2 no such directory.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './files.mjs';
import { parseArgs } from './lib/args.mjs';

const args = parseArgs(process.argv.slice(2));
const where = args._[0] ?? '.';
const dir = resolve(ROOT, where);
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`test: no directory ${where}`);
  process.exit(2);
}
const name = typeof args.name === 'string' ? args.name : null;
const timeoutMin = Number(process.env.TEST_TIMEOUT_MIN) > 0 ? Number(process.env.TEST_TIMEOUT_MIN) : 30;
const concurrency = Number(process.env.TEST_CONCURRENCY) > 0 ? Number(process.env.TEST_CONCURRENCY) : Math.min(4, Math.max(1, Math.floor(cpus().length / 5)));

// Test files are named *.test.*; node's default discovery would also run any
// file named test.mjs or test-*.mjs, which is this runner and its reporter.
const NODE_TEST = /\.test\.(mjs|js|cjs|ts|mts|cts)$/;
const skipped = (full, entryName) => entryName.startsWith('.') || entryName === 'node_modules' || relative(ROOT, full).split(sep).join('/') === 'docs/research';

// Walks a directory for test files, skipping node_modules, dot-directories and
// docs/research.
function walkTests(at, out = []) {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const full = join(at, entry.name);
    if (skipped(full, entry.name)) continue;
    if (entry.isDirectory()) walkTests(full, out);
    else if (NODE_TEST.test(entry.name)) out.push(full);
  }
  return out;
}

// Ends a process and everything it started, by PID: on Windows a child's
// children outlive it, so the tree is ended by taskkill /PID. Never by image name.
function endTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

const files = walkTests(dir);
if (files.length === 0) {
  console.error(`test: no test ran under ${where} (it holds no *.test.* file)`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'domains-test-'));
const ranFile = join(tmp, 'ran.json');
const counter = pathToFileURL(join(ROOT, 'scripts', 'lib', 'test-counter.mjs')).href;
let child = null;
const finish = () => {
  endTree(child);
  rmSync(tmp, { recursive: true, force: true });
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    finish();
    process.exit(1);
  });
}

// A test run started from inside another test file must not read the outer
// run's context, or node reports its events to the outer run instead.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

let timedOut = false;
const status = await new Promise((done) => {
  child = spawn(
    process.execPath,
    [
      '--test',
      `--test-concurrency=${concurrency}`,
      ...(name ? [`--test-name-pattern=${name}`] : []),
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${counter}`,
      `--test-reporter-destination=${ranFile}`,
      ...files,
    ],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env },
  );
  const timer = setTimeout(() => {
    timedOut = true;
    endTree(child);
  }, timeoutMin * 60_000);
  child.on('close', (code) => {
    clearTimeout(timer);
    done(code);
  });
  child.on('error', () => {
    clearTimeout(timer);
    done(1);
  });
});

let ran = [];
try {
  ran = JSON.parse(readFileSync(ranFile, 'utf8')).ran;
} catch {
  ran = [];
}
finish();

if (timedOut) {
  console.error(`test: stopped after ${timeoutMin} minutes, every process it started ended (TEST_TIMEOUT_MIN)`);
  process.exit(1);
}
if (status !== 0) process.exit(1);
// Zero tests is never a pass: a Prove naming a directory with no tests, or a
// filter matching none, would otherwise succeed whatever the code does.
if (ran.length === 0) {
  console.error(name ? `test: --name ${name} matched no test under ${where}` : `test: no test ran under ${where}`);
  process.exit(1);
}
console.log(`test: ${ran.length} test(s) passed${name ? ` matching ${name}` : ''} under ${where} (${files.length} file(s))`);
