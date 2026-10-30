// packages/compact/src/tags.ts — whether a compaction writes, and under which
// tag (docs/architecture.md section 4.7 rule 1, ruling 25).
//
//   tagDecision("names", "d", "2026-10-26T00:00:00Z", existingTags, false)
//     { action: "present", tag: "names-d-20261026", builds: ["names-d-20261026"] }
//   tagDecision("names", "d", "2026-10-26T00:00:00Z", existingTags, true, { sha256, buildSha256 })
//     { action: "present", tag: "names-d-20261026-r2", builds: [...] } when -r2 holds sha256
//
// Tags are write-once. A unit whose tag, or a rebuild of it, the package
// already holds is present: the compaction writes nothing (a re-run of the
// job skips). With `rebuild` it takes the next tag of the span, -r2 then -r3
// (nextTierTag of @domains/ghcr), so a rebuilt pack never meets a tag that
// holds another digest. A rebuild asked of a span with no build takes the
// span's own tag: the first build carries no suffix.
//
// nextTierTag names a tag for bytes that no build of the span holds. So a
// re-run of a rebuild whose push succeeded must find the build that holds its
// bytes, or it pushes the same bytes again under the next tag (D3 of
// DOM-023). The caller passes `opts.sha256`, the dev.pkgforge.domains.sha256
// it is about to write, and `opts.buildSha256`, that annotation of each build
// it read: a build that holds the same sha256 is present. When two do, the
// latest is: the run that pushed it is the newest. A build with no entry in
// `buildSha256` is refused (usage), so a caller cannot skip a read by
// accident. Without opts.sha256 the answer is the one above.
//
// It imports nothing from `node:` and is type-checked as Worker code
// (tsconfig.worker.json); no test runs it in workerd.
import { LayoutError, nextTierTag, parseTierTag, type Tier, type TierDataset, tierTag } from "@domains/ghcr";
import { CompactError } from "./errors.ts";

export interface TagDecision {
  readonly action: "write" | "present";
  // The tag to write, or for `present` the build found: the latest, or the one that holds opts.sha256.
  readonly tag: string;
  // The tags of the package that are builds of the span, oldest first.
  readonly builds: readonly string[];
}

export interface TagOptions {
  // The dev.pkgforge.domains.sha256 the caller is about to write, 64 lowercase hex digits.
  readonly sha256?: string;
  // The dev.pkgforge.domains.sha256 annotation of each build, by its tag in lowercase.
  readonly buildSha256?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}

const HEX64 = /^[0-9a-f]{64}$/;

// The annotation of `tag` in `m`, or undefined when `m` holds none for it.
function shaOf(m: TagOptions["buildSha256"], tag: string): unknown {
  if (m === undefined) return undefined;
  if (m instanceof Map) return m.get(tag);
  return Object.hasOwn(m, tag) ? (m as Readonly<Record<string, unknown>>)[tag] : undefined;
}

// `tier` is h to y: the hour job (scripts/compact/hour.mjs) asks it of tier h.
export function tagDecision(dataset: TierDataset, tier: Tier, start: string, existing: readonly string[], rebuild: boolean, opts?: TagOptions): TagDecision {
  try {
    const base = tierTag(dataset, tier, start);
    if (!Array.isArray(existing)) throw new CompactError("usage", "the existing tags are not a list");
    const builds: { tag: string; n: number }[] = [];
    for (const t of existing) {
      if (typeof t !== "string") throw new CompactError("usage", "the existing tags hold a value that is not a tag");
      const lower = t.toLowerCase();
      if (lower !== base && !lower.startsWith(`${base}-r`)) continue;
      try {
        const parts = parseTierTag(lower);
        if (parts.base === base) builds.push({ tag: lower, n: parts.rebuild });
      } catch (e) {
        if (!(e instanceof LayoutError)) throw e;
      }
    }
    builds.sort((a, b) => a.n - b.n);
    const tags = builds.map((b) => b.tag);
    if (builds.length > 0 && !rebuild) return { action: "present", tag: tags[tags.length - 1], builds: tags };
    const sha = opts?.sha256;
    if (rebuild && sha !== undefined && builds.length > 0) {
      if (typeof sha !== "string" || !HEX64.test(sha)) throw new CompactError("usage", `opts.sha256 is ${JSON.stringify(sha)}, not 64 lowercase hex digits`);
      const held = tags.map((tag) => {
        const v = shaOf(opts?.buildSha256, tag);
        if (typeof v !== "string") throw new CompactError("usage", `the build ${tag} has no dev.pkgforge.domains.sha256 in opts.buildSha256: read its manifest before a rebuild`);
        return v;
      });
      for (let i = tags.length - 1; i >= 0; i -= 1) if (held[i] === sha) return { action: "present", tag: tags[i], builds: tags };
    }
    return { action: "write", tag: nextTierTag(dataset, tier, start, existing), builds: tags };
  } catch (e) {
    if (e instanceof LayoutError) throw new CompactError("tag", e.message);
    throw e;
  }
}
