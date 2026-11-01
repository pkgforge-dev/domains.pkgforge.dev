// packages/adapter/node/files.ts — the Node-only readers of the adapter
// package: recorded answers from a fixture directory, and the registry files of
// a checkout. src/ imports nothing from `node:` so it runs in workerd; these
// read the disk, so they live beside it.
//
//   readRecordings(dir)       every DIR/*.http.json, by file name → Recording[]
//   readTcpRecordings(dir)    every DIR/*.tcp.json, by file name → TcpRecording[]
//   readBits(root)            ROOT/config/source-bits.json → SourceBits
//   readSourceFiles(root)     ROOT/adapters/*/source.json → { files, problems }
//   readRegistry(root, bits)  ROOT/config/sources.json → Registry
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTcpRecording, TCP_RECORDING_SUFFIX, type TcpRecording } from "../src/connect.ts";
import { parseRecording, type Recording } from "../src/harness.ts";
import type { Registry, SourceBits } from "../src/types.ts";
import { ContractError, type Problem, SourceError, type SourceFileText, validateBits, validateRegistry } from "../src/validate.ts";

export const RECORDING_SUFFIX = ".http.json";
export const BITS_PATH = "config/source-bits.json";
export const REGISTRY_PATH = "config/sources.json";
export const ADAPTERS_DIR = "adapters";

// Each DIR/*SUFFIX file, by file name, parsed; a file that is not JSON is
// refused as `recording`.
function readEach<T>(dir: string, suffix: string, parse: (json: unknown, name: string) => T): T[] {
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(suffix))
    .sort();
  return names.map((name) => {
    const text = readFileSync(join(dir, name), "utf8");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new ContractError("recording", `${name}: not JSON: ${(err as Error).message}`);
    }
    return parse(json, name);
  });
}

export function readRecordings(dir: string): Recording[] {
  return readEach(dir, RECORDING_SUFFIX, parseRecording);
}

export function readTcpRecordings(dir: string): TcpRecording[] {
  return readEach(dir, TCP_RECORDING_SUFFIX, parseTcpRecording);
}

function readJson(root: string, rel: string): unknown {
  const text = readFileSync(join(root, rel), "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SourceError([{ at: rel, code: "json", detail: (err as Error).message }]);
  }
}

export function readBits(root: string): SourceBits {
  return validateBits(readJson(root, BITS_PATH));
}

// Each adapter directory and its source.json text. A directory with no
// source.json is a problem; no adapters/ directory is no adapter.
export function readSourceFiles(root: string): { files: SourceFileText[]; problems: Problem[] } {
  const base = join(root, ADAPTERS_DIR);
  if (!existsSync(base)) return { files: [], problems: [] };
  const files: SourceFileText[] = [];
  const problems: Problem[] = [];
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  for (const dir of dirs) {
    const path = join(base, dir, "source.json");
    if (!existsSync(path)) problems.push({ at: `${ADAPTERS_DIR}/${dir}`, code: "missing", detail: "an adapter directory holds a source.json" });
    else files.push({ adapter: dir, text: readFileSync(path, "utf8") });
  }
  return { files, problems };
}

export function readRegistry(root: string, bits: SourceBits): Registry {
  return validateRegistry(readJson(root, REGISTRY_PATH), bits);
}
