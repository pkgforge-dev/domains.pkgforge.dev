// packages/ledger/src/errors.ts — the one error of the ledger. Its `code` names
// the check that refused, so a job can print `FAIL <code> <detail>` and a test
// can tell one guard from another.
//
//   usage      a call outside the contract: a bad option, a size out of range
//   order      an input that does not ascend by key, or an output that would not
//   precision  a source bit with no precision in the table given
//   time       a time that is not ISO 8601 UTC, or before 2026-01-01
//   format     filter or delta bytes that are not this format: magic, version,
//              hash, length, a field out of range, hashes not ascending
//   crc        filter or delta bytes whose CRC-32 does not match
//   pair       a delta that was not built against the filter it is given with

export type LedgerErrorCode = "usage" | "order" | "precision" | "time" | "format" | "crc" | "pair";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}
