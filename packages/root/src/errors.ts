// packages/root/src/errors.ts — the one error of the root package. Its code
// says which rule a root, a pack entry or a promotion broke:
//   usage     a call this package refuses before it reads anything
//   format    a root whose `format` is not domains.root.v1 (a reader refuses it)
//   schema    a field missing, of the wrong type, or (strict) unknown
//   pack      a pack entry, or a pack manifest, that breaks its own rules
//   live-set  the packs of a dataset overlap, leave a hole, or are out of order
//   derived   a field that is derived from the packs disagrees with them
//   replace   a replacement names a pack the live root does not hold, or
//             does not cover the spans and the sources of what it replaces
//   stale     a root that is not above the live one (root_seq), or that
//             shrinks it outside a rollback (as_of, corpus_since, through)
//   time      a root created before the live one
//   psl       a PSL hash that is not 64 lowercase hex digits
//   sources   the sources layer disagrees with the root, or a pack names a
//             source the registry does not hold
//   withdrawn an addition or a replacement whose manifest a rollback took out
//             of the live set (the root's `withdrawn`), or a root that lists
//             such a manifest as live
export type RootErrorCode = "usage" | "format" | "schema" | "pack" | "live-set" | "derived" | "replace" | "stale" | "time" | "psl" | "sources" | "withdrawn";

export class RootError extends Error {
  readonly code: RootErrorCode;
  constructor(code: RootErrorCode, message: string) {
    super(message);
    this.name = "RootError";
    this.code = code;
  }
}
