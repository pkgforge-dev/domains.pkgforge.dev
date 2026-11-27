// Local, unpublished historical day and original-span pack builds.
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FACTS_MAX_BYTES, FACTS_MEDIA_TYPE, FACTS_TITLE, factKeysWalk, mergeFacts } from '@domains/adapter';
import {
  basePacks,
  bindFault,
  buildDay,
  checkMerged,
  CREATED_ANNOTATION,
  dayOf,
  eventFactsOf,
  joinInputs,
  mergeSpan,
  packManifest,
  planTier,
  QUARANTINED_INPUTS_ANNOTATION,
  RUN_ANNOTATION,
  SUMMARY_MEDIA_TYPE,
  SUMMARY_TITLE,
} from '@domains/compact';
import { DirPartsSink, fileDigest, openCopy } from '@domains/compact/node';
import { writeFeedPack } from '@domains/feed';
import { MANIFEST_LIMIT_BYTES, nextTierTag, packageOfDataset, repoOf } from '@domains/ghcr';
import { DOMAINS_CODEC, FEED_CODEC, IDX_TITLE, mergePacks, parseHead, partTitle, TIME_IDX_TITLE, VERIFY_ANNOTATIONS } from '@domains/pack';
import { nodeCompress, writerId } from '@domains/pack/node';
import { buildRoot, packFromManifest, validatePack } from '@domains/root';
import { Fault } from '../root/lib.mjs';
import { main as assemble } from './assemble.mjs';
import { dayFactsLayer } from './day.mjs';
import { HISTORY_PLAN_FORMAT } from './history-plan.mjs';
import { bitsOf, factsTableOf } from './hour.mjs';
import { main as plan } from './plan.mjs';
import { main as range, openInputs } from './range.mjs';

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const describe = (bytes) => ({ digest: sha(bytes), size: bytes.length });
const titleOf = (layer) => layer?.annotations?.['org.opencontainers.image.title'];
const ALL_COPIES = ['key', 'time'];
const BUILD_ANNOTATIONS = new Set([CREATED_ANNOTATION, RUN_ANNOTATION, VERIFY_ANNOTATIONS.bytes, VERIFY_ANNOTATIONS.writer]);
const file = (dir, title, data) => writeFileSync(join(dir, title), data, { flag: 'wx' });

function readArchiveManifest(dir, entry) {
  const manifest = join(dir, 'manifest.json');
  if (statSync(manifest).size > MANIFEST_LIMIT_BYTES) throw new Fault(`${entry.tag}: archived manifest exceeds ${MANIFEST_LIMIT_BYTES} B`);
  const input = readFileSync(manifest);
  if (sha(input) !== entry.manifest) throw new Fault(`${entry.tag}: archived manifest digest differs from the proved root entry`);
  const json = JSON.parse(input);
  if (!Array.isArray(json.layers)) throw new Fault(`${entry.tag}: archived manifest has no layer list`);
  const layers = new Map();
  for (const layer of json.layers) {
    const title = titleOf(layer);
    if (typeof title !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(title)) throw new Fault(`${entry.tag}: invalid archive layer title`);
    if (layers.has(title) || !/^sha256:[0-9a-f]{64}$/.test(layer.digest ?? '') || !Number.isSafeInteger(layer.size) || layer.size < 1 || typeof layer.mediaType !== 'string') {
      throw new Fault(`${entry.tag}: invalid archive layer descriptor for ${title}`);
    }
    layers.set(title, layer);
  }
  return { dir, json, layers, read: new Set() };
}

async function verifyLocalInput(directory, entry, useFacts, cache) {
  if (!cache.has(entry.manifest)) cache.set(entry.manifest, readArchiveManifest(join(directory, entry.tag), entry));
  const { dir, json, layers, read } = cache.get(entry.manifest);
  // The manifest binds every descriptor. Hash only the key copy and any
  // facts the day consumes; raw layers, time copies and saved summaries
  // are not inputs to the chronological join or its carry.
  const used = [[IDX_TITLE, entry.idx], ...entry.parts.map((part, i) => [partTitle(i), part])];
  const facts = layers.get(FACTS_TITLE);
  if (useFacts && facts !== undefined) {
    if (facts.size > FACTS_MAX_BYTES) throw new Fault(`${entry.tag}: archived ${FACTS_TITLE} exceeds ${FACTS_MAX_BYTES} B`);
    used.push([FACTS_TITLE, facts]);
  }
  for (const [title, expected] of used) {
    const layer = layers.get(title);
    if (layer?.digest !== expected.digest || layer.size !== expected.size) throw new Fault(`${entry.tag}: archive layer ${title} differs from the proved root entry`);
    if (read.has(title)) continue;
    const path = join(dir, title);
    if (statSync(path).size !== layer.size) throw new Fault(`${entry.tag}: archive layer ${title} does not match its manifest`);
    const got = await fileDigest(path);
    if (got.digest !== layer.digest || got.size !== layer.size) throw new Fault(`${entry.tag}: archive layer ${title} does not match its manifest`);
    read.add(title);
  }
  return json;
}

export function entryOfOutput(dir, dataset, tag) {
  const input = readFileSync(join(dir, 'manifest.json'));
  const json = JSON.parse(input);
  const head = (title) => {
    const bytes = readFileSync(join(dir, title));
    const h = parseHead(bytes, bytes.length);
    return { dataset: h.header.dataset, records: h.header.records, keyMin: h.keyMin, keyMax: h.keyMax, parts: h.parts.map((p) => p.bytes) };
  };
  return packFromManifest({
    repo: repoOf(packageOfDataset(dataset)),
    tag,
    digest: sha(input),
    json,
    head: head(IDX_TITLE),
    timeHead: json.layers.some((layer) => titleOf(layer) === TIME_IDX_TITLE) ? head(TIME_IDX_TITLE) : null,
  });
}

function observableManifest({ json, layers }) {
  const annotations = new Map(Object.entries(json.annotations ?? {}).filter(([name]) => !BUILD_ANNOTATIONS.has(name)));
  const extras = new Map();
  for (const [title, { digest, size, mediaType }] of layers) {
    if (title !== IDX_TITLE && !/^part\.[0-9]{3,}$/.test(title)) extras.set(title, { digest, size, mediaType });
  }
  return { artifactType: json.artifactType, annotations, extras };
}

// The record digest covers the key data. A proved original manifest also
// accounts for annotations and for non-key layers such as the time copy.
function equivalentOriginal(pack, candidate, inputDir, verified) {
  const next = candidate.entry.pack;
  if (next.pack.sha256 !== pack.pack.sha256 || !isDeepStrictEqual(next.sources, pack.sources)) return false;
  const dir = join(inputDir, pack.tag);
  const original = verified.get(pack.manifest) ?? (existsSync(join(dir, 'manifest.json')) ? readArchiveManifest(dir, pack) : null);
  return original !== null && isDeepStrictEqual(observableManifest(original), observableManifest(readArchiveManifest(candidate.dir, next)));
}

const precisionOf = (sources, registry) => (sources.length === 1 ? { precision: registry.find((source) => source.id === sources[0]).precision } : {});

async function writeLocalManifest({ dataset, tier, span, tag, dir, sources, psl, registry, run, summary, timeSummary, sinks, extra = [], annotations }) {
  file(dir, IDX_TITLE, summary.idx);
  const parts = await Promise.all(sinks.key.files.map(fileDigest));
  let time = null;
  if (sinks.time) {
    file(dir, TIME_IDX_TITLE, timeSummary.idx);
    time = { idxBytes: timeSummary.idx, idx: describe(timeSummary.idx), parts: await Promise.all(sinks.time.files.map(fileDigest)) };
  }
  for (const layer of extra) file(dir, layer.title, layer.bytes);
  const manifest = packManifest({
    dataset,
    tier,
    span,
    tag,
    sources,
    ...precisionOf(sources, registry),
    psl,
    run,
    summary,
    writer: writerId(),
    parts,
    idx: describe(summary.idx),
    time,
    extra,
    annotations,
  });
  file(dir, 'manifest.json', manifest.text);
  return entryOfOutput(dir, dataset, tag);
}

// Stream a key-ordered difference. The callbacks may count changes or write
// an NDJSON evidence record without retaining the entire feed in memory.
export async function compareFeed(before, after, onChange) {
  const left = before[Symbol.asyncIterator]();
  const right = after[Symbol.asyncIterator]();
  let a = await left.next();
  let b = await right.next();
  try {
    while (!a.done || !b.done) {
      if (b.done || (!a.done && a.value.key < b.value.key)) {
        await onChange({ kind: 'removed', key: a.value.key });
        a = await left.next();
      } else if (a.done || b.value.key < a.value.key) {
        await onChange({ kind: 'added', key: b.value.key });
        b = await right.next();
      } else {
        if (!isDeepStrictEqual(a.value, b.value)) await onChange({ kind: 'changed', key: a.value.key });
        a = await left.next();
        b = await right.next();
      }
    }
  } finally {
    await left.return?.();
    await right.return?.();
  }
}

async function replayDay({ date, earlier, inputs, carry, inputDir, out, registry, run, onChange, verify }) {
  const day = dayOf(date);
  const base = basePacks({ datasets: { domains: earlier } }, day);
  if (base.length !== earlier.length || inputs.some((p) => p.span.start < day.start || p.span.end > day.end)) throw new Fault(`${date}: replay input overlaps the as-of-day boundary`);
  if (new Set([...base, ...inputs, carry].map((p) => p.psl)).size !== 1) throw new Fault(`${date}: replay inputs do not share a PSL`);
  const psl = carry.psl;
  const providers = [inputs, base, [carry]];
  const opened = [];
  try {
    for (const entry of [...base, carry]) await verify(entry, false);
    const factInputs = [];
    for (const entry of inputs) {
      const manifest = await verify(entry, true);
      if (manifest.annotations[QUARANTINED_INPUTS_ANNOTATION] !== undefined) throw new Fault(`${entry.tag}: recover separate canonical quarantine inputs`);
      const factsLayer = manifest.layers.find((layer) => titleOf(layer) === FACTS_TITLE);
      const facts = factsLayer !== undefined ? factsTableOf(readFileSync(join(inputDir, entry.tag, FACTS_TITLE)), bitsOf(registry, entry.sources, entry.tag), entry.tag) : null;
      factInputs.push({ entry, facts });
    }
    for (const [i, entries] of providers.entries()) {
      opened.push(await openInputs({ inputs: entries, by: 'historical replay' }, 'key', i === 2 ? FEED_CODEC : DOMAINS_CODEC, inputDir));
    }
    const [today, prior, original] = opened.map((input) => input.readers);
    const eligible = joinInputs(inputs, today);
    const facts = factInputs.filter(({ entry, facts }) => facts !== null && !eligible.left.includes(entry)).map(({ facts }) => facts);
    const feedDir = join(out, day.feedTag);
    mkdirSync(feedDir, { recursive: true });
    const sinks = Object.fromEntries(ALL_COPIES.map((copy) => [copy, new DirPartsSink(feedDir, copy)]));
    let built;
    try {
      built = await buildDay({
        day,
        records: () => mergePacks(eligible.readers, DOMAINS_CODEC),
        base: prior,
        carry: original[0].scan(),
        registry,
        facts: eventFactsOf(facts),
        compress: nodeCompress,
        sink: sinks.key,
        time: { sink: sinks.time },
      });
    } finally {
      await Promise.all(Object.values(sinks).map((sink) => sink.close()));
    }
    const feed = await writeLocalManifest({
      dataset: 'feed',
      tier: 'd',
      span: { start: day.start, end: day.end },
      tag: day.feedTag,
      dir: feedDir,
      sources: [...new Set([...eligible.sources, ...carry.sources])].sort(),
      psl,
      registry,
      run,
      summary: built.summary,
      timeSummary: built.time,
      sinks,
      extra: [{ title: SUMMARY_TITLE, mediaType: SUMMARY_MEDIA_TYPE, bytes: built.summaryBytes }],
    });
    const result = await openCopy(feedDir, 'key', FEED_CODEC);
    opened.push(result);
    await compareFeed(original[0].scan(), result.reader.scan(), onChange);

    const domainDir = join(out, day.domainsTag);
    mkdirSync(domainDir, { recursive: true });
    const key = new DirPartsSink(domainDir, 'key');
    let merged;
    try {
      merged = await mergeSpan(today, DOMAINS_CODEC, key, { compress: nodeCompress });
    } finally {
      await key.close();
    }
    const quarantined = [...new Set(eligible.left.flatMap((p) => p.sources))].sort();
    const mergedFacts = mergeFacts(factInputs.filter(({ facts }) => facts !== null).map(({ facts }) => facts));
    const factLayer = dayFactsLayer(mergedFacts, day.domainsTag);
    const domains = await writeLocalManifest({
      dataset: 'domains',
      tier: 'd',
      span: { start: day.start, end: day.end },
      tag: day.domainsTag,
      dir: domainDir,
      sources: [...new Set(inputs.flatMap((p) => p.sources))].sort(),
      psl,
      registry,
      run,
      summary: merged,
      sinks: { key },
      ...(quarantined.length === 0 ? {} : { annotations: { [QUARANTINED_INPUTS_ANNOTATION]: quarantined.join(' ') } }),
      ...(factLayer === null ? {} : { extra: [{ title: FACTS_TITLE, mediaType: FACTS_MEDIA_TYPE, bytes: factLayer }] }),
    });
    const domain = await openCopy(domainDir, 'key', DOMAINS_CODEC);
    opened.push(domain);
    const walk = factKeysWalk([...mergedFacts.keys()].map((key) => ({ key })));
    async function* checked() {
      for await (const record of domain.reader.scan()) {
        walk.see(record.key);
        yield record;
      }
    }
    await checkMerged(
      today.map((reader) => reader.scan()),
      checked(),
      DOMAINS_CODEC,
    );
    const problem = walk.problem();
    if (problem !== null) throw new Fault(`${day.domainsTag}: ${problem}`);
    return { domains, feed, exact: built.exact, carry: built.carry };
  } finally {
    await Promise.all(opened.map((input) => input.close()));
  }
}

async function run(cli, argv) {
  const lines = [];
  const rc = await cli(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  if (rc !== 0) throw new Fault(`historical assembly exited ${rc}: ${lines.join('\n')}`);
}

async function assembleEmptyFeed(unit, dir, registry, runId) {
  if (unit.verdict !== 'ready' || unit.psl.length !== 1) throw new Fault(`${unit.tag}: empty feed rebuild needs a complete span built under one PSL`);
  mkdirSync(dir, { recursive: true });
  const sinks = Object.fromEntries(ALL_COPIES.map((copy) => [copy, new DirPartsSink(dir, copy)]));
  let built;
  try {
    built = await writeFeedPack([], { codec: FEED_CODEC, compress: nodeCompress, sink: sinks.key, time: { sink: sinks.time } });
  } finally {
    await Promise.all(Object.values(sinks).map((sink) => sink.close()));
  }
  const fault = bindFault(built.summary.idx, built.time.idx, unit.span);
  if (fault !== null) throw new Fault(`${unit.tag}: ${fault}`);
  const entry = await writeLocalManifest({
    dataset: 'feed',
    tier: unit.tier,
    span: unit.span,
    tag: unit.tag,
    dir,
    sources: unit.sources,
    psl: unit.psl[0],
    registry,
    run: runId,
    summary: built.summary,
    timeSummary: built.time,
    sinks,
  });
  return { dir, entry };
}

async function reassemble({ target, byDay, replayDir, folder, psl, registry, runId }) {
  const { dataset, pack } = target;
  const inputs = target.days.map((date) => byDay.get(date)[dataset]);
  if (pack.tier === 'd') return { dir: join(replayDir, inputs[0].pack.tag), entry: inputs[0] };
  const local = buildRoot({ live: null, psl, now: pack.span.end, add: inputs });
  const dir = join(folder, 'pack');
  // A retraction can leave no rows in a previously published span. Keep its
  // coverage under a canonical empty index instead of starting range work.
  if (dataset === 'feed' && inputs.every((input) => input.pack.count === 0)) {
    return assembleEmptyFeed(planTier(local, dataset, pack.tier, pack.span.start), dir, registry, runId);
  }
  const rootPath = join(folder, 'root.json');
  const planPath = join(folder, 'plan.json');
  const tagsPath = join(folder, 'tags.json');
  const ranges = join(folder, 'ranges');
  mkdirSync(folder, { recursive: true });
  file(folder, 'root.json', JSON.stringify(local));
  file(folder, 'tags.json', '[]\n');
  await run(plan, ['--dataset', dataset, '--tier', pack.tier, '--span', pack.span.start, '--root', rootPath, '--inputs', replayDir, '--out', planPath]);
  await run(range, ['all', '--plan', planPath, '--inputs', replayDir, '--out', ranges]);
  const planned = JSON.parse(readFileSync(planPath));
  const args = ['--plan', planPath, '--dir', ranges, '--out', dir, '--inputs', replayDir, '--tags', tagsPath, '--run', runId];
  const precision = precisionOf(planned.sources, registry).precision;
  if (precision !== undefined) args.push('--precision', precision);
  await run(assemble, args);
  for (const blob of JSON.parse(readFileSync(join(dir, 'blobs.json')))) {
    const to = join(dir, blob.title);
    if (blob.file !== null && blob.file !== to) copyFileSync(blob.file, to);
  }
  return { dir, entry: entryOfOutput(dir, dataset, planned.tag) };
}

export async function buildHistory(history, inputDir, out, registry, { run: runId, log = () => undefined }) {
  if (history.format !== HISTORY_PLAN_FORMAT) throw new Fault('the input is not a historical compaction plan');
  if (!history.root || !history.span || !['earlier', 'replay', 'targets', 'tags', 'downstream'].every((field) => Array.isArray(history[field]))) {
    throw new Fault('the historical compaction plan is incomplete');
  }
  const earlier = history.earlier.map((entry) => validatePack('domains', entry, 'earlier domains input'));
  const targetPacks = history.targets.map(({ dataset, pack, days }) => ({ dataset, pack: validatePack(dataset, pack, 'current compacted target'), days }));
  const replayDir = join(out, 'days');
  mkdirSync(replayDir);
  const verified = new Map();
  const verify = (entry, useFacts) => verifyLocalInput(inputDir, entry, useFacts, verified);

  const byDay = new Map();
  const reconciled = [];
  const changes = openSync(join(out, 'changes.ndjson'), 'wx');
  try {
    for (const saved of history.replay) {
      const date = dayOf(saved.date).date;
      const inputs = saved.domains.map((entry) => validatePack('domains', entry, `${date} domains input`));
      const carry = validatePack('feed', saved.carry, `${date} original feed carry`);
      const counts = { added: 0, removed: 0, changed: 0 };
      const day = await replayDay({
        date,
        earlier,
        inputs,
        carry,
        inputDir,
        out: replayDir,
        registry,
        run: runId,
        verify,
        onChange: (change) => {
          counts[change.kind] += 1;
          writeFileSync(changes, `${JSON.stringify({ date, ...change })}\n`);
        },
      });
      byDay.set(date, day);
      earlier.push(...inputs);
      reconciled.push({ date, carry: day.carry, exact: day.exact, ...counts });
      log(`replayed ${date}: ${counts.added} added, ${counts.removed} removed, ${counts.changed} changed`);
    }
  } finally {
    closeSync(changes);
  }

  const replacements = [];
  for (const target of targetPacks) {
    const { dataset, pack } = target;
    const folder = join(out, 'units', pack.tag);
    const candidate = await reassemble({ target, byDay, replayDir, folder, psl: history.root.psl, registry, runId });
    const next = candidate.entry.pack;
    if (next.span.start !== pack.span.start || next.span.end !== pack.span.end || pack.sources.some((source) => !next.sources.includes(source))) {
      throw new Fault(`${pack.tag}: rebuilt pack does not preserve the original span and sources`);
    }
    const consumed = dataset === 'domains' ? history.replay.filter((d) => target.days.includes(d.date)).flatMap((d) => d.domains.filter((p) => p.tier === 'seg')) : [];
    if (consumed.length === 0 && equivalentOriginal(pack, candidate, inputDir, verified)) continue;
    // This local tag is a proposal derived from the complete inventory used
    // in planning. Publication would check the then-current tag list again.
    const tag = nextTierTag(dataset, pack.tier, pack.span.start, [...history.tags, pack.tag]);
    replacements.push({ dataset, old: [pack, ...consumed], new: { ...next, tag }, dir: candidate.dir });
  }
  return {
    format: 'domains.compact-history-build.v1',
    root: history.root,
    span: history.span,
    reconciled,
    replacements,
    downstream: history.downstream,
    publicationReady: false,
  };
}
