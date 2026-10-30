// packages/compact/src/manifest.ts — the OCI manifest of a compacted pack
// (docs/architecture.md section 4.2, docs/format.md sections 2, 8 and 14).
// The workflows take its artifact type, its annotations and its layers and
// give them to scripts/ghcr/push.mjs, which builds the pushed manifest itself,
// so its digest differs from the one built here.
//
//   const { text, digest, annotations } = packManifest({ dataset, tier, span, tag, sources, psl, run, summary, writer, parts, idx, time, extra });
//
// The manifest is an OCI image manifest of artifactType
// application/vnd.pkgforge.domains.pack.v1, its config the empty descriptor,
// its layers part.000 up, idx, then for a time copy time.part.000 up and
// time.idx, each application/octet-stream and titled, then each extra layer
// (summary.json of a day pack of feed) with its own media type. Its annotations are
// packAnnotations of @domains/pack (dataset, count, bytes, sha256, writer),
// the tier, the span, the PSL, the sources (and the precision when there is
// one source), the workflow run, and org.opencontainers.image.created (the
// span's end, never the push time) and .source, which the push tool sets on
// the manifests it pushes (scripts/ghcr/push.mjs).
//
// Before it returns, the manifest is read back through packFromManifest of
// @domains/root with the two index heads, so a manifest the promotion would
// refuse is refused here (CompactError plan), before any push. A manifest of
// more than MAX_LAYERS layers is refused too: the push tool refuses it.
//
// Runs in Node and in workerd alike: it imports nothing from `node:`.
import { artifactType, repoOf, SOURCE_URL, type Tier, type TierDataset, packageOfDataset } from "@domains/ghcr";
import { IDX_TITLE, type PackSummary, packAnnotations, parseHead, partTitle, sha256Hex, TIME_IDX_TITLE, timePartTitle, VERIFY_ANNOTATIONS } from "@domains/pack";
import { packFromManifest, RootError, TIER_ANNOTATION, TIME_COPY_TIERS, TIME_DATASETS } from "@domains/root";
import { CompactError } from "./errors.ts";

export const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const LAYER_MEDIA_TYPE = "application/octet-stream";
// The OCI empty descriptor: the two bytes `{}`, the config of the manifest
// built here. blobs.json of scripts/compact/assemble.mjs lists it with no
// file, and the workflows push no config of their own: scripts/ghcr/push.mjs
// builds the manifest it pushes.
export const EMPTY_CONFIG = Object.freeze({ mediaType: "application/vnd.oci.empty.v1+json", digest: `sha256:${sha256Hex(new TextEncoder().encode("{}"))}`, size: 2, data: "e30=" });
export const RUN_ANNOTATION = "dev.pkgforge.domains.run";
export const CREATED_ANNOTATION = "org.opencontainers.image.created";
export const SOURCE_ANNOTATION = "org.opencontainers.image.source";
// The most layers one manifest holds: MAX_LAYERS of scripts/ghcr/push.mjs, the
// largest count both push runs of DOM-006 accepted, which the push tool
// refuses past. A test of scripts/compact holds the two equal.
export const MAX_LAYERS = 256;
const TITLE = "org.opencontainers.image.title";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RUN = /^[1-9][0-9]{0,19}$/;
// An extra layer's title, and the titles of the pack's own layers, which it never takes.
const EXTRA_TITLE = /^[a-z0-9][a-z0-9._-]*$/;
const PACK_TITLE = /^(idx|time\.idx|part\.\d{3,}|time\.part\.\d{3,})$/;

export interface Blob {
  readonly digest: string;
  readonly size: number;
}

// A layer after the pack's own, such as summary.json of a day pack of feed
// (docs/format.md section 16). Its title is none of the pack's own layers'.
export interface ExtraLayer {
  readonly title: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ManifestInput {
  readonly dataset: TierDataset;
  // h to y: an hour pack's manifest has the layers and annotations of the
  // tiers a compaction builds, and packFromManifest reads tier h.
  readonly tier: Tier;
  readonly span: { readonly start: string; readonly end: string };
  // The tag the manifest is pushed under: the span's, or a rebuild's.
  readonly tag: string;
  readonly sources: readonly string[];
  // The precision of the one source, when there is one ("day" or "second").
  readonly precision?: "day" | "second";
  readonly psl: string;
  // The id of the workflow run that pushes it (GITHUB_RUN_ID).
  readonly run: string;
  // The key copy: its summary (records, bytes, SHA-256, index) and the blobs of its parts and index.
  readonly summary: PackSummary;
  readonly writer: string;
  readonly parts: readonly Blob[];
  readonly idx: Blob;
  // The time copy: its index bytes and the blobs of its parts and index.
  readonly time?: { readonly idxBytes: Uint8Array; readonly parts: readonly Blob[]; readonly idx: Blob } | null;
  // Layers after the key copy's and the time copy's, in this order.
  readonly extra?: readonly ExtraLayer[];
}

export interface BuiltManifest {
  readonly json: Record<string, unknown>;
  // The manifest as compact JSON, no final newline, which `digest` hashes.
  // The pushed manifest is the one scripts/ghcr/push.mjs builds: its digest differs.
  readonly text: string;
  readonly digest: string;
  readonly annotations: Readonly<Record<string, string>>;
}

const fail = (message: string): CompactError => new CompactError("plan", message);

function blob(b: Blob, what: string): Blob {
  if (b === null || typeof b !== "object" || typeof b.digest !== "string" || !DIGEST.test(b.digest) || !Number.isSafeInteger(b.size) || b.size < 1)
    throw fail(`${what} is not { digest: sha256:<64 hex>, size }`);
  return { digest: b.digest, size: b.size };
}

const headFacts = (bytes: Uint8Array) => {
  const head = parseHead(bytes, bytes.length);
  return { dataset: head.header.dataset, records: head.header.records, keyMin: head.keyMin, keyMax: head.keyMax, parts: head.parts.map((p) => p.bytes) };
};

export function packManifest(input: ManifestInput): BuiltManifest {
  const s = input.summary;
  if (!Array.isArray(input.sources) || input.sources.length === 0) throw fail("the pack names no source");
  for (const [i, id] of input.sources.entries()) if (i > 0 && !(id > input.sources[i - 1])) throw fail("the sources are not sorted and distinct");
  if (input.sources.length === 1 && input.precision !== "day" && input.precision !== "second") throw fail(`the pack has the one source ${input.sources[0]} and no precision: give day or second`);
  if (input.sources.length > 1 && input.precision !== undefined) throw fail("a precision belongs to a pack of one source");
  if (!HEX64.test(input.psl)) throw fail("psl is not 64 lowercase hex digits");
  if (!RUN.test(input.run)) throw fail(`the run ${JSON.stringify(input.run)} is not a workflow run id`);
  if (input.parts.length !== s.parts.length) throw fail(`${input.parts.length} part blob(s) for the ${s.parts.length} part(s) of the index`);
  const parts = input.parts.map((p, i) => {
    const b = blob(p, partTitle(i));
    if (b.size !== s.parts[i].bytes) throw fail(`${partTitle(i)} is ${b.size} B and the index gives it ${s.parts[i].bytes} B`);
    return b;
  });
  const idx = blob(input.idx, IDX_TITLE);
  if (idx.size !== s.idx.length) throw fail(`idx is ${idx.size} B and the index written is ${s.idx.length} B`);
  const wantsTime = Object.hasOwn(TIME_DATASETS, input.dataset) && TIME_COPY_TIERS.includes(input.tier) && s.records > 0;
  const time = input.time ?? null;
  if (wantsTime && time === null) throw new CompactError("time", `a ${input.dataset} pack of tier ${input.tier} that holds records carries its time copy (docs/format.md section 14)`);
  if (time !== null && !Object.hasOwn(TIME_DATASETS, input.dataset)) throw new CompactError("time", `a ${input.dataset} pack has no time copy`);

  const layer = (b: Blob, title: string) => ({ mediaType: LAYER_MEDIA_TYPE, digest: b.digest, size: b.size, annotations: { [TITLE]: title } });
  const layers = [...parts.map((b, i) => layer(b, partTitle(i))), layer(idx, IDX_TITLE)];
  if (time !== null) {
    const timeHead = parseHead(time.idxBytes, time.idxBytes.length);
    if (time.parts.length !== timeHead.parts.length) throw fail(`${time.parts.length} time part blob(s) for the ${timeHead.parts.length} part(s) of the time index`);
    time.parts.forEach((p, i) => {
      const b = blob(p, timePartTitle(i));
      if (b.size !== timeHead.parts[i].bytes) throw fail(`${timePartTitle(i)} is ${b.size} B and the time index gives it ${timeHead.parts[i].bytes} B`);
      layers.push(layer(b, timePartTitle(i)));
    });
    const t = blob(time.idx, TIME_IDX_TITLE);
    if (t.size !== time.idxBytes.length) throw fail(`time.idx is ${t.size} B and the time index written is ${time.idxBytes.length} B`);
    layers.push(layer(t, TIME_IDX_TITLE));
  }
  for (const x of input.extra ?? []) {
    if (!EXTRA_TITLE.test(x.title) || PACK_TITLE.test(x.title)) throw new CompactError("usage", `${JSON.stringify(x.title)} is not the title of an extra layer`);
    if (layers.some((l) => l.annotations[TITLE] === x.title)) throw new CompactError("usage", `the manifest holds a layer ${x.title} already`);
    layers.push({ mediaType: x.mediaType, digest: `sha256:${sha256Hex(x.bytes)}`, size: x.bytes.length, annotations: { [TITLE]: x.title } });
  }
  if (layers.length > MAX_LAYERS) throw fail(`the manifest holds ${layers.length} layers, and the push takes at most ${MAX_LAYERS} (scripts/ghcr/push.mjs): plan fewer ranges`);
  const A = VERIFY_ANNOTATIONS;
  const annotations: Record<string, string> = {
    ...packAnnotations(s, input.writer),
    [TIER_ANNOTATION]: input.tier,
    [A.spanStart]: input.span.start,
    [A.spanEnd]: input.span.end,
    [A.psl]: input.psl,
    [A.source]: input.sources.join(","),
    ...(input.precision === undefined ? {} : { [A.precision]: input.precision }),
    [RUN_ANNOTATION]: input.run,
    [CREATED_ANNOTATION]: input.span.end,
    [SOURCE_ANNOTATION]: SOURCE_URL,
  };
  const json = { schemaVersion: 2, mediaType: MANIFEST_MEDIA_TYPE, artifactType: artifactType("pack"), config: { ...EMPTY_CONFIG }, layers, annotations };
  const text = JSON.stringify(json);
  const digest = `sha256:${sha256Hex(new TextEncoder().encode(text))}`;
  try {
    packFromManifest({
      repo: repoOf(packageOfDataset(input.dataset)),
      tag: input.tag,
      digest,
      json,
      head: headFacts(s.idx),
      timeHead: time === null ? null : headFacts(time.idxBytes),
    });
  } catch (e) {
    if (e instanceof RootError) throw fail(`the promotion would refuse this manifest: ${e.message}`);
    throw e;
  }
  return { json, text, digest, annotations };
}
