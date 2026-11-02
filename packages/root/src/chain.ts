// packages/root/src/chain.ts — two questions a reader asks of one root: which
// entry it names under a repository and a tag, and which pack of a higher tier
// spans a span and carries a source. replacedOnChain and heldBy of
// scripts/state/lib.mjs ask them of the live root and of each older root on
// the chain of `previous` (DOM-063); settle of @domains/state reads no root:
//
//   packNamed(root, repo, tag)                  { dataset, pack }: the entry `root` lists under repo and tag, or null
//   packSpanning(root, dataset, span, source)   the pack of a tier above seg in datasets[dataset] whose span covers
//                                               `span` and whose sources carry `source`, or null
//
// A pack leaves the live set by a replacement or by a rollback (build.ts). A
// replacement spans each pack it replaces and carries each of their sources
// (checkCovers), and so does each later pack that replaces the replacement:
// from the root that replaced a pack on, a pack of a higher tier that carries
// its source spans it. A rollback lists the manifest in `withdrawn` for
// WITHDRAWN_DAYS. Two compacted packs never overlap (checkLiveSet), so
// packSpanning finds at most one.
//
// Runs in Node and in workerd alike: it imports nothing from `node:`.
import type { PackEntry, RootJson, Span } from "./root.ts";

export interface NamedPack {
  readonly dataset: string;
  readonly pack: PackEntry;
}

export function packNamed(root: RootJson, repo: string, tag: string): NamedPack | null {
  for (const [dataset, packs] of Object.entries(root.datasets)) {
    const pack = packs.find((p) => p.repo === repo && p.tag === tag);
    if (pack !== undefined) return { dataset, pack };
  }
  return null;
}

export function packSpanning(root: RootJson, dataset: string, span: Span, source: string): PackEntry | null {
  // Object.hasOwn: a dataset such as `constructor` is no key of Object.prototype here.
  const packs = Object.hasOwn(root.datasets, dataset) ? (root.datasets[dataset] ?? []) : [];
  return packs.find((p) => p.tier !== "seg" && p.span.start <= span.start && span.end <= p.span.end && p.sources.includes(source)) ?? null;
}
