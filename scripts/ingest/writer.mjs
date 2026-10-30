// scripts/ingest/writer.mjs — the disk SegmentWriter of scripts/ingest/run.mjs
// (DOM-024, TODO/ingest.md; docs/architecture.md sections 3.4 and 4.2): the
// one writer an adapter run of a workflow gets as ctx.writer. It writes, and
// pushes nothing; run.mjs verifies and pushes what it wrote.
//
//   const w = diskWriter({ dir, adapter, sources, psl, run, fetched });
//   const segment = await w.write(draft, records, raw);   // the Segment of @domains/adapter
//   w.segments, w.raws                                     // what was written, in write order
//
// One write, in this order:
//   1. the draft held to the contract (checkWindow, checkCursor of
//      @domains/adapter; ContractError): its source is one of the adapter's,
//      with that source's precision and one of its datasets. Each cursor's
//      canonical JSON is a value the push tool takes (annotationProblem of
//      @domains/ghcr: at most ANNOTATION_MAX_CHARS, 1024 characters, and no
//      control character), else WriteFault `cursor`: it is the segment's
//      annotation cursor.before or cursor.after. checkCursor allows 4 KiB, the
//      limit of a cursor in state.json, so a stream adapter keeps its cursor
//      within 1024;
//   2. its dataset is names or domains, else WriteFault `tag`; a second-precision
//      window crosses no hour edge, else `straddle` (D19 of DOM-024: planHour
//      refuses such a segment in every hour pack);
//   3. the raw bytes, streamed to disk and hashed as they arrive, never whole in
//      memory: a `day` source's file into the segment's own layer `raw`, at most
//      RAW_PART_BYTES (else `raw-size`); any other source's into the raw lane
//      object raw-<source>.<start>.<end> (D10 of DOM-024), raw.000 and up of at
//      most RAW_PART_BYTES each and members.json, once per source and window (a
//      second raw input of one window must be the same bytes, else `raw`). A
//      raw input of no byte writes no layer and no object;
//   4. the tag (D11 of DOM-024): fileTag for a `day` segment with raw bytes,
//      segTag for any other, with the variant `d` for domains and none for
//      names. A second segment of one source, one window and one dataset in
//      this run is `tag`, whatever its tag, and so is one whose write overlaps
//      the first (the check holds the kind before the first await): a file
//      segment's tag names its bytes, so two files of one day would otherwise
//      take two tags. A tag taken already in this run is `tag` too: two day
//      windows that start on one day and hold the same bytes take one file tag;
//   5. the records, through writePackFiles of @domains/pack/node with the
//      dataset's codec (codecOf of @domains/compact): strictly increasing keys,
//      one record a key, or PackError;
//   6. the manifest (packManifest, tier seg, D12 of DOM-024), manifest.json and
//      blobs.json beside the files, as scripts/compact/hour.mjs writes them.
// The directory is DIR/<tag>/ for a segment and DIR/<raw tag>/ for a raw lane
// object; DIR must hold none of them (a file is written once, flag wx).
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, ContractError, checkCursor, checkWindow, validateSegment } from '@domains/adapter';
import { CompactError, codecOf, EMPTY_CONFIG, packManifest } from '@domains/compact';
import { fileDigest } from '@domains/compact/node';
import { annotationProblem, artifactType, fileTag, LayoutError, rawTag, segTag } from '@domains/ghcr';
import { IDX_TITLE } from '@domains/pack';
import { writePackFiles, writerId } from '@domains/pack/node';
import { isSecond } from '@domains/state';
import { writeOut } from '../compact/plan.mjs';

// The most bytes of one raw layer (D10 of DOM-024), as GHCR's 10-minute upload
// of one attempt at 2 MiB/s bounds it (scripts/ghcr/rate.mjs,
// docs/architecture.md section 4.3).
export const RAW_PART_BYTES = 1024 * 1024 * 1024;
export const RAW_TYPE = artifactType('raw');
export const RAW_MEDIA_TYPE = 'application/octet-stream';
export const RAW_TITLE = 'raw';
export const MEMBERS_TITLE = 'members.json';
export const MEMBERS_FORMAT = 'domains.raw-members.v1';
// The variant of a segment's tag, by its dataset (D11 of DOM-024).
export const VARIANTS = Object.freeze({ names: undefined, domains: 'd' });
const HOUR_MS = 3_600_000;
const P = 'dev.pkgforge.domains.';

// A refusal of the writer that no ContractError check names: `cursor`,
// `tag`, `straddle`, `raw`, `raw-size`, `manifest`. run.mjs prints it as the adapter
// run's fault and pushes nothing (exit 1).
export class WriteFault extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'WriteFault';
    this.code = code;
  }
}

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const partName = (n) => `raw.${String(n).padStart(3, '0')}`;

// The raw input as chunks: one Uint8Array, or an async iterable of them.
async function* chunksOf(raw) {
  if (raw instanceof Uint8Array) {
    yield raw;
    return;
  }
  if (raw === null || typeof raw !== 'object' || typeof raw[Symbol.asyncIterator] !== 'function') throw new ContractError('draft', 'raw is neither a Uint8Array nor an async iterable of them');
  for await (const chunk of raw) {
    if (!(chunk instanceof Uint8Array)) throw new ContractError('draft', 'a raw chunk is not a Uint8Array');
    yield chunk;
  }
}

// Streams `raw` into DIR/raw.000 and up, each at most `partBytes`
// (RAW_PART_BYTES; a test names a smaller one), hashing as it writes:
// { files, bytes, sha256 }. More than `maxParts` parts is `raw-size`. A file
// is written once (flag wx).
export async function writeRaw(raw, dir, { maxParts, what, partBytes = RAW_PART_BYTES }) {
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256');
  const files = [];
  let handle = null;
  let inPart = 0;
  let bytes = 0;
  try {
    for await (const chunk of chunksOf(raw)) {
      let at = 0;
      while (at < chunk.length) {
        if (handle === null || inPart === partBytes) {
          if (handle !== null) await handle.close();
          handle = null;
          if (files.length === maxParts) throw new WriteFault('raw-size', `${what}: the raw bytes pass ${maxParts * partBytes} B, ${maxParts} layer(s) of at most ${partBytes} B (D10 of DOM-024)`);
          const path = join(dir, partName(files.length));
          handle = await open(path, 'wx');
          files.push(path);
          inPart = 0;
        }
        const n = Math.min(chunk.length - at, partBytes - inPart);
        const piece = chunk.subarray(at, at + n);
        let done = 0;
        while (done < piece.length) done += (await handle.write(piece, done, piece.length - done)).bytesWritten;
        hash.update(piece);
        at += n;
        inPart += n;
        bytes += n;
      }
    }
  } finally {
    if (handle !== null) await handle.close();
  }
  return { files, bytes, sha256: hash.digest('hex') };
}

// The disk writer of one adapter run. `sources` are the adapter's registry
// rows (with `parser` and `urls`); `psl` the hex sha256 of the list the
// segments are written under (D23 of DOM-024); `run` the workflow run id;
// `fetched` the run's ctx.now; `partBytes` the most bytes of one raw layer
// (RAW_PART_BYTES; a test names a smaller one).
export function diskWriter({ dir, adapter, sources, psl, run, fetched, partBytes = RAW_PART_BYTES }) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const segments = [];
  const raws = [];
  const tags = new Set();
  // One segment of a source, a window and a dataset in a run (D11 of DOM-024).
  const kinds = new Set();
  const rawByWindow = new Map();
  let temps = 0;

  async function write(draft, records, raw) {
    if (draft === null || typeof draft !== 'object') throw new ContractError('draft', 'the draft is not an object');
    const what = `segment ${JSON.stringify(draft.source)}`;
    const row = byId.get(draft.source);
    if (row === undefined) throw new ContractError('source', `${what}: ${JSON.stringify(draft.source)} is not one of the adapter's sources (${[...byId.keys()].join(', ')})`);
    if (draft.precision !== row.precision) throw new ContractError('source', `${what}: precision ${JSON.stringify(draft.precision)}; ${row.id} is ${row.precision}`);
    if (!row.datasets.includes(draft.dataset)) throw new ContractError('source', `${what}: dataset ${JSON.stringify(draft.dataset)}; ${row.id} feeds ${row.datasets.join(', ')}`);
    checkWindow(draft.window, draft.precision, what);
    checkCursor(draft.cursorBefore, `${what}: cursorBefore`);
    checkCursor(draft.cursorAfter, `${what}: cursorAfter`);
    for (const [field, key] of [
      ['cursorBefore', 'cursor.before'],
      ['cursorAfter', 'cursor.after'],
    ]) {
      const problem = annotationProblem(canonicalJson(draft[field]));
      if (problem !== null) {
        throw new WriteFault(
          'cursor',
          `${what}: ${field} as canonical JSON ${problem}; it is the annotation ${P}${key}, and scripts/ghcr/push.mjs takes no such value, so the adapter keeps its cursor within it`,
        );
      }
    }
    if (!Object.hasOwn(VARIANTS, draft.dataset)) throw new WriteFault('tag', `${what}: a segment of obs holds names or domains, not ${draft.dataset} (D11 of DOM-024)`);
    const { start, end } = draft.window;
    if (!isSecond(start) || !isSecond(end)) throw new WriteFault('tag', `${what}: the window ${start} to ${end} is not YYYY-MM-DDTHH:MM:SSZ to the second, as a tag names it`);
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (draft.precision === 'second' && Math.floor(s / HOUR_MS) !== Math.floor((e - 1) / HOUR_MS)) {
      throw new WriteFault('straddle', `${what}: the window ${start} to ${end} crosses an hour edge; a second-precision segment lies in one hour (D19 of DOM-024), as every hour pack reads it`);
    }
    const variant = VARIANTS[draft.dataset];
    const fileSource = draft.precision === 'day' && raw !== undefined;
    const label = `${what} ${draft.dataset} ${start} to ${end}`;
    const kind = `${draft.source} ${start} ${end} ${draft.dataset}`;
    if (kinds.has(kind)) throw new WriteFault('tag', `${label}: a segment of this source, window and dataset was written already in this run, or is being written (D11 of DOM-024)`);
    // The kind is held before the first await, so a second write of it that
    // overlaps this one is refused too; a write that fails before its tag is
    // taken gives the kind back, and one may write it again.
    kinds.add(kind);
    let taken = false;

    // 3. The raw bytes, to a temporary directory first: a file's tag names its hash.
    let got = null;
    const temp = join(dir, `.raw-${++temps}`);
    try {
      if (raw !== undefined) got = await writeRaw(raw, temp, { maxParts: fileSource ? 1 : Number.MAX_SAFE_INTEGER, what: label, partBytes });
      let tag;
      try {
        tag = fileSource ? fileTag(draft.source, start, got.sha256, variant) : segTag(draft.source, start, end, variant);
      } catch (err) {
        if (err instanceof LayoutError) throw new WriteFault('tag', `${label}: ${err.message}`);
        throw err;
      }
      if (tags.has(tag))
        throw new WriteFault(
          'tag',
          `${label}: obs:${tag} was written already in this run, and a tag is written once: a file tag names the window's start day and the bytes, not its end (D11 of DOM-024)`,
        );
      tags.add(tag);
      taken = true;
      const at = join(dir, tag);
      mkdirSync(at);
      let rawLayer = null;
      let rawObject = null;
      if (got !== null && got.bytes > 0) {
        if (fileSource) {
          renameSync(got.files[0], join(at, RAW_TITLE));
          rawLayer = { path: join(at, RAW_TITLE), digest: `sha256:${got.sha256}`, size: got.bytes };
        } else rawObject = keepRaw(draft, row, got, temp, label);
      }

      // 5. The records.
      const pack = await writePackFiles(records, at, { codec: codecOf(draft.dataset) });
      const summary = pack.summary;
      const partFiles = pack.files.slice(0, -1);
      const parts = [];
      for (const f of partFiles) parts.push(await fileDigest(f));
      const idx = { digest: sha(summary.idx), size: summary.idx.length };

      // 6. The manifest.
      const annotations = {
        [`${P}adapter`]: adapter,
        [`${P}parser`]: row.parser,
        [`${P}cursor.before`]: canonicalJson(draft.cursorBefore),
        [`${P}cursor.after`]: canonicalJson(draft.cursorAfter),
        [`${P}url`]: row.urls.join(' '),
        [`${P}fetched`]: fetched,
        ...(rawObject === null ? {} : { [`${P}raw`]: rawObject.tag }),
      };
      let manifest;
      try {
        manifest = packManifest({
          dataset: draft.dataset,
          tier: 'seg',
          span: { start, end },
          tag,
          sources: [draft.source],
          precision: draft.precision,
          psl,
          run,
          summary,
          writer: writerId(),
          parts,
          idx,
          extra: rawLayer === null ? [] : [{ title: RAW_TITLE, mediaType: RAW_MEDIA_TYPE, blob: { digest: rawLayer.digest, size: rawLayer.size } }],
          annotations,
        });
      } catch (err) {
        if (err instanceof CompactError) throw new WriteFault('manifest', `${label}: ${err.message}`);
        throw err;
      }
      writeOut(join(at, 'manifest.json'), manifest.text, 'run');
      const blobs = [
        { title: 'config', file: null, data: EMPTY_CONFIG.data, digest: EMPTY_CONFIG.digest, size: EMPTY_CONFIG.size },
        ...parts.map((b, i) => ({ title: `part.${String(i).padStart(3, '0')}`, file: partFiles[i], ...b })),
        { title: IDX_TITLE, file: join(at, IDX_TITLE), ...idx },
        ...(rawLayer === null ? [] : [{ title: RAW_TITLE, file: rawLayer.path, digest: rawLayer.digest, size: rawLayer.size }]),
      ];
      writeOut(join(at, 'blobs.json'), `${JSON.stringify(blobs)}\n`, 'run');

      const json = {
        source: draft.source,
        dataset: draft.dataset,
        window: { start, end },
        cursorBefore: JSON.parse(canonicalJson(draft.cursorBefore)),
        cursorAfter: JSON.parse(canonicalJson(draft.cursorAfter)),
        count: summary.records,
        precision: draft.precision,
        bytes: summary.bytes,
        sha256: summary.sha256,
        ...(got === null ? {} : { raw: { bytes: got.bytes, sha256: got.sha256 } }),
      };
      const segment = validateSegment(json, label);
      segments.push({ segment, tag, dir: at, manifest, blobs, raw: rawObject?.tag ?? null, rawLayer });
      return segment;
    } catch (err) {
      if (!taken) kinds.delete(kind);
      throw err;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  // The raw lane object of the draft's source and window: kept from the temp
  // directory the first time, held to the same bytes after.
  function keepRaw(draft, row, got, temp, label) {
    const key = `${draft.source} ${draft.window.start} ${draft.window.end}`;
    const kept = rawByWindow.get(key);
    if (kept !== undefined) {
      if (kept.sha256 !== got.sha256 || kept.bytes !== got.bytes)
        throw new WriteFault('raw', `${label}: a second raw input of the window, ${got.bytes} B hashing to ${got.sha256}; the first was ${kept.bytes} B hashing to ${kept.sha256}`);
      return kept;
    }
    const tag = rawTag(draft.source, draft.window.start, draft.window.end);
    const at = join(dir, tag);
    renameSync(temp, at);
    const members = { format: MEMBERS_FORMAT, source: draft.source, start: draft.window.start, end: draft.window.end, members: [{ offset: 0, length: got.bytes, sha256: got.sha256 }] };
    writeOut(join(at, MEMBERS_TITLE), `${canonicalJson(members)}\n`, 'run');
    const files = [...got.files.map((_, i) => ({ path: join(at, partName(i)), mediaType: RAW_MEDIA_TYPE })), { path: join(at, MEMBERS_TITLE), mediaType: 'application/json' }];
    const object = {
      tag,
      dir: at,
      source: draft.source,
      start: draft.window.start,
      end: draft.window.end,
      bytes: got.bytes,
      sha256: got.sha256,
      members: members.members.length,
      files,
      annotations: {
        [`${P}source`]: draft.source,
        [`${P}span.start`]: draft.window.start,
        [`${P}span.end`]: draft.window.end,
        [`${P}bytes`]: String(got.bytes),
        [`${P}sha256`]: got.sha256,
        [`${P}members`]: String(members.members.length),
        [`${P}adapter`]: adapter,
        [`${P}parser`]: row.parser,
        [`${P}url`]: row.urls.join(' '),
        [`${P}fetched`]: fetched,
        [`${P}run`]: run,
      },
    };
    rawByWindow.set(key, object);
    raws.push(object);
    return object;
  }

  return { write, segments, raws };
}
