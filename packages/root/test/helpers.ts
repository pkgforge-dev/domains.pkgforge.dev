// Synthetic pack entries and roots for the tests of packages/root. Every
// digest, hash, key and source list here is made up for the test; the one
// measured value is PSL_LIVE, the sha256 of the list the ref package pins as
// psl-1f96bae40adf (TODO/storage.md, DOM-019's Found of 2026-10-29T05:20Z).
import { createHash } from "node:crypto";
import { repoOf, segTag, type TierDataset, tierTag } from "@domains/ghcr";
import { type LiveRoot, type NewPack, type PackEntry, type RootJson, type RootTier, TIME_COPY_TIERS, TIME_DATASETS, tierEnd } from "../src/index.ts";

export const PSL_LIVE = "1f96bae40adfc22ca2474d7c0099bbcfcb25aefd3e2547b5c2147c0dd2e3ebd9";
// A second list, synthetic: a pack built under an older pin.
export const PSL_OLD = "0".repeat(63).concat("1");

export const hex = (s: string): string => createHash("sha256").update(s).digest("hex");
export const digestOf = (s: string): string => `sha256:${hex(s)}`;
const digestBlob = (s: string, size: number) => ({ digest: digestOf(s), size });

export interface PackOptions {
  sources?: string[];
  count?: number;
  psl?: string;
  // The end of a segment's window; a compacted pack's end is its tier's.
  end?: string;
  // Makes a second, different manifest of the same span.
  salt?: string;
  // A rebuild of a compacted pack's span: its tag takes -rN (ruling 25), and
  // every digest follows the tag, so the manifest is another one.
  rebuild?: number;
  // Lists a time copy of one part (docs/format.md section 14). By default a
  // pack of feed or new-name of tier d, w, m or y that holds records lists
  // one, as a writer must (TIME_COPY_TIERS); false leaves it out.
  time?: boolean;
}

// A pack entry of `dataset` and `tier` from `start`, every digest derived from its identity.
export function pack(dataset: TierDataset, tier: RootTier, start: string, o: PackOptions = {}): NewPack {
  const sources = [...(o.sources ?? ["thc-ct"])].sort();
  let repo: string;
  let tag: string;
  let end: string;
  if (tier === "seg") {
    end = o.end ?? new Date(Date.parse(start) + 600_000).toISOString().replace(".000Z", "Z");
    repo = repoOf("obs");
    tag = segTag(sources[0] ?? "thc-ct", start, end);
  } else {
    end = new Date(tierEnd(tier, Date.parse(start))).toISOString().replace(".000Z", "Z");
    repo = repoOf(dataset === "feed" || dataset === "new-name" ? "feed" : dataset === "rev" ? "rev" : "names");
    tag = tierTag(dataset, tier, start, o.rebuild);
  }
  const id = `${repo}:${tag}:${o.salt ?? ""}`;
  const count = o.count ?? 10;
  const entry: PackEntry = {
    repo,
    tag,
    tier,
    span: { start, end },
    manifest: digestOf(`manifest ${id}`),
    pack: { sha256: hex(`raw ${id}`), bytes: 1200 },
    idx: { digest: digestOf(`idx ${id}`), size: 200 },
    parts: [{ digest: digestOf(`part ${id}`), size: 1000 }],
    ...((o.time ?? (Object.hasOwn(TIME_DATASETS, dataset) && TIME_COPY_TIERS.includes(tier) && count > 0))
      ? { time: { idx: digestBlob(`time.idx ${id}`, 180), parts: [digestBlob(`time.part ${id}`, 1010)] } }
      : {}),
    count,
    key_min: count === 0 ? null : "com.example",
    key_max: count === 0 ? null : "com.example.www",
    sources,
    psl: o.psl ?? PSL_LIVE,
  };
  return { dataset, pack: entry };
}

// The hour packs of one day, 00 to 23.
export function hours(dataset: TierDataset, day: string, o: PackOptions = {}): NewPack[] {
  return Array.from({ length: 24 }, (_, h) => pack(dataset, "h", `${day}T${String(h).padStart(2, "0")}:00:00Z`, o));
}

export const live = (root: RootJson, tag = `live ${root.root_seq}`): LiveRoot => ({ root, digest: digestOf(tag) });

// A root as plain JSON, to plant a fault in.
export const plain = (root: RootJson): Record<string, unknown> => JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
