// packages/pack/src/errors.ts — the one error of the pack format. Its `code`
// names the check that refused (docs/format.md section 6.6), so a verifier can
// print `FAIL <code> <detail>` and a test can tell one guard from another.

export type PackErrorCode = "magic" | "version" | "dataset" | "codec" | "header" | "head" | "page" | "tiling" | "short-read" | "inflate" | "crc" | "record" | "count" | "order" | "span" | "usage";

export class PackError extends Error {
  readonly code: PackErrorCode;
  constructor(code: PackErrorCode, message: string) {
    super(message);
    this.name = "PackError";
    this.code = code;
  }
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
