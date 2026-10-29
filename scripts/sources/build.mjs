// scripts/sources/build.mjs — write the source registry, config/sources.json,
// from every adapters/*/source.json, or check that the committed file is that.
//
// Each source.json is checked by packages/adapter/src/validate.ts: every field
// of a source, the id grammar, a failure_modes list, the band, and the bit
// against config/source-bits.json, the append-only map. The registry lists the
// sources by bit, then the sources with no bit by id, each with the adapter
// directory it came from. With no adapters/ directory, or no adapter in it, the
// registry lists no source: `{ "format", "comment", "sources": [] }`.
// DOM-019's ref-refresh.yml is to push the file to the `ref` package as
// `sources-SHA12`.
//
// Usage:
//   node scripts/sources/build.mjs            write config/sources.json
//   node scripts/sources/build.mjs --check    write nothing; compare with the committed file
//   --root DIR                                read and write under DIR instead of this checkout
// Prints `sources N adapters M` and `wrote config/sources.json`, `config/sources.json
// is current`, or each problem as `PATH: CODE: DETAIL`.
// Exit codes: 0 written, or with --check the committed file equals the build ·
// 1 a source.json or config/source-bits.json failed a check, or with --check
// config/sources.json is absent or differs · 2 could not run (bad arguments, a
// file that cannot be read or written).
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BITS_PATH, REGISTRY_PATH, readBits, readSourceFiles } from '../../packages/adapter/node/files.ts';
import { buildRegistry, renderRegistry, SourceError } from '../../packages/adapter/src/validate.ts';
import { ROOT } from '../files.mjs';
import { parseArgs } from '../lib/args.mjs';

const USAGE = 'usage: node scripts/sources/build.mjs [--check] [--root DIR]';

// The registry text of the tree at root. Throws SourceError on a check that failed.
export function build(root) {
  const bits = readBits(root);
  const { files, problems } = readSourceFiles(root);
  let registry;
  try {
    registry = buildRegistry(files, bits);
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    throw new SourceError([...problems, ...err.problems]);
  }
  if (problems.length > 0) throw new SourceError(problems);
  return { text: renderRegistry(registry), sources: registry.sources.length, adapters: files.length };
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const known = new Set(['_', 'check', 'root']);
  if (args._.length > 0 || Object.keys(args).some((k) => !known.has(k)) || (args.check !== undefined && args.check !== true) || args.root === true) {
    console.error(USAGE);
    return 2;
  }
  const root = typeof args.root === 'string' ? resolve(args.root) : ROOT;
  let out;
  try {
    out = build(root);
  } catch (err) {
    if (err instanceof SourceError) {
      for (const p of err.problems) console.error(`${p.at}: ${p.code}: ${p.detail}`);
      return 1;
    }
    if (err?.code === 'ENOENT' || err?.code === 'EACCES' || err?.code === 'EISDIR') {
      console.error(`sources: cannot read ${err.path ?? 'a file'}: ${err.code} (is ${BITS_PATH} there?)`);
      return 2;
    }
    throw err;
  }
  console.log(`sources ${out.sources} adapters ${out.adapters}`);
  const path = join(root, REGISTRY_PATH);
  if (args.check === true) {
    let committed;
    try {
      committed = readFileSync(path, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      console.error(`sources: ${REGISTRY_PATH} is absent: run node scripts/sources/build.mjs`);
      return 1;
    }
    if (committed !== out.text) {
      console.error(`sources: ${REGISTRY_PATH} differs from adapters/*/source.json: run node scripts/sources/build.mjs`);
      return 1;
    }
    console.log(`${REGISTRY_PATH} is current`);
    return 0;
  }
  try {
    writeAtomic(path, out.text);
  } catch (err) {
    console.error(`sources: cannot write ${REGISTRY_PATH}: ${err.message}`);
    return 2;
  }
  console.log(`wrote ${REGISTRY_PATH}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
