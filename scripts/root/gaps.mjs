// A compacted pack's sources cover the unit collectively. To suppress a
// stale --gap after compaction, find the original full-day segment on the
// chain of previous roots and follow its replacements in the same dataset.
import { NEW_DATASETS } from '@domains/compact';
import { segmentOfDay, spansDay, WITHDRAWN_DAYS } from '@domains/root';
import { GAP_DAYS } from '@domains/state';
import { previousRoots, readRootJson } from './lib.mjs';

const WITHDRAWN_MS = WITHDRAWN_DAYS * 86_400_000;
export const gapKey = (source, day) => `${source}=${day}`;
export const gapListed = (root, source, day) => Object.hasOwn(root.gaps, source) && root.gaps[source].includes(day);
export const addedSegmentOfDay = (add, source, day) => add.find(({ pack }) => pack.tier === 'seg' && pack.sources.includes(source) && spansDay(pack, day));

function packOfDay(root, dataset, source, day) {
  return root.datasets[dataset]?.find((p) => p.sources.includes(source) && spansDay(p, day));
}

// Source and span must survive every edge. If the old and new manifests
// differ, a forward promotion could only have removed the old pack by
// replacing it (buildRoot's checkCovers). Rollback lists a removed pack in
// withdrawn provided the preceding root was created within WITHDRAWN_DAYS.
function carries(next, before, withdrawn) {
  return next.span.start <= before.span.start && before.span.end <= next.span.end && before.sources.every((source) => next.sources.includes(source)) && !withdrawn.has(before.manifest);
}

export async function repairedOnChain(live, reported, add, deps) {
  const repaired = new Map();
  if (live === null) return repaired;
  let open = [];
  let beyondLimit = 0;
  const datasets = Object.keys(live.datasets);
  for (const [source, days] of Object.entries(reported)) {
    for (const day of days) {
      if (gapListed(live, source, day) || addedSegmentOfDay(add, source, day) !== undefined || segmentOfDay(live, source, day) !== null) continue;
      if (open.length === GAP_DAYS) {
        beyondLimit += 1;
        continue;
      }
      const holders = new Map();
      for (const dataset of datasets) {
        const pack = packOfDay(live, dataset, source, day);
        if (pack !== undefined && pack.tier !== 'seg') holders.set(dataset, pack);
      }
      if (holders.size > 0) open.push({ source, day, holders });
    }
  }
  if (beyondLimit > 0) deps.log(`gap proof checks at most ${GAP_DAYS} reported days; ${beyondLimit} remaining reports kept`);

  const readOlder = async (digest, sleep) => (await readRootJson(deps.reader, digest, { ...deps, sleep })).root;
  const walk = previousRoots(live, readOlder, { clock: deps.now, sleep: deps.sleep });
  while (open.length > 0) {
    const edge = await walk.step();
    if (edge === null) break;
    const { newer, older } = edge;
    const withdrawn = new Set(newer.withdrawn.map((entry) => entry.manifest));
    const elapsed = Date.parse(newer.created) - Date.parse(older.created);
    const still = [];
    let aged = 0;
    for (const { source, day, holders } of open) {
      const previous = new Map();
      const key = gapKey(source, day);
      for (const [dataset, next] of holders) {
        const pack = packOfDay(older, dataset, source, day);
        if (pack === undefined) continue;
        if (pack.manifest !== next.manifest) {
          if (!carries(next, pack, withdrawn)) continue;
          if (elapsed > WITHDRAWN_MS) {
            aged += 1;
            continue;
          }
        }
        if (pack.tier === 'seg') {
          // Compaction excludes quarantined inputs from the new-name datasets.
          if (pack.quarantine === true && NEW_DATASETS.includes(dataset)) continue;
          repaired.set(key, { dataset, pack });
          break;
        }
        previous.set(dataset, pack);
      }
      if (!repaired.has(key) && previous.size > 0) still.push({ source, day, holders: previous });
    }
    if (aged > 0) deps.log(`gap proof cannot confirm ${aged} replacement(s) between root_seq ${older.root_seq} and ${newer.root_seq}: the edge exceeds the ${WITHDRAWN_DAYS}-day withdrawal horizon`);
    open = still;
  }
  if (open.length > 0) deps.log(`gap proof left ${open.length} reported day(s) unconfirmed after ${walk.result.read} root(s): ${walk.result.stopped}`);
  return repaired;
}
