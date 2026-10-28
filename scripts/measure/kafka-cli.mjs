// scripts/measure/kafka-cli.mjs — the command-line plumbing the Kafka
// measurement scripts share: the common flags, the data directory, an atomic
// file write and the mapping of errors to exit codes.
//
// The design A scripts wrote their outputs to ../kafka/ beside themselves. Here
// every output goes under --data DIR, whose default is .tmp/measure/DOM-004/ at
// the repository root (gitignored), and no script reads an input from there.
//
// Common flags: --host H (default kafka.zonestream.openintel.nl), --port P
// (default 9092), --data DIR.
//
// Usage: import { commonArgs, run, writeJson } from './kafka-cli.mjs'
// It is a module; run() sets the exit code of the script that calls it:
// 0 done, 1 the work failed, 2 bad arguments.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../files.mjs';
import { parseArgs } from '../lib/args.mjs';
import { ZONESTREAM_HOST, ZONESTREAM_PORT } from './kafka-client.mjs';

export const DEFAULT_DATA = '.tmp/measure/DOM-004';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// An integer flag of at least min, or UsageError.
export function intArg(value, name, min = 0) {
  const n = Number(value);
  if (typeof value !== 'string' || value.trim() === '' || !Number.isInteger(n) || n < min) throw new UsageError(`${name} needs an integer of at least ${min}`);
  return n;
}

// A number flag above zero, or UsageError.
export function positiveArg(value, name) {
  const n = Number(value);
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(n) || n <= 0) throw new UsageError(`${name} needs a number above zero`);
  return n;
}

// An ISO 8601 time flag as milliseconds, or UsageError.
export function timeArg(value, name) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new UsageError(`${name} needs an ISO 8601 time, such as 2026-10-27T12:00:00Z`);
  return ms;
}

// The data directory: --data resolved against the working directory, or the
// default under the repository root.
export function resolveData(arg) {
  if (arg === undefined) return join(ROOT, DEFAULT_DATA);
  if (typeof arg !== 'string') throw new UsageError('--data needs a directory');
  return resolve(arg);
}

// The parsed arguments and the three flags every script takes.
export function commonArgs(argv) {
  const args = parseArgs(argv);
  if (args.host !== undefined && typeof args.host !== 'string') throw new UsageError('--host needs a name');
  return {
    args,
    host: args.host ?? ZONESTREAM_HOST,
    port: args.port === undefined ? ZONESTREAM_PORT : intArg(args.port, '--port', 1),
    data: resolveData(args.data),
  };
}

// Writes a file through a temporary file in the same directory and a rename,
// so a killed run leaves the old file whole rather than a truncated one.
export function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export const writeJson = (path, value) => writeFileAtomic(path, `${JSON.stringify(value, null, 1)}\n`);

// True when the module at url is the script node was started with.
export const isMain = (url) => Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]).href;

// Runs main(argv) and sets the exit code: main's own number, 2 for a UsageError,
// 1 for any other error. It sets process.exitCode rather than calling
// process.exit, which can cut short output still queued for a pipe.
export async function run(name, main) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  } catch (e) {
    console.error(`${name}: ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
