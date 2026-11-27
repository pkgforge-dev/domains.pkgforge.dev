# Rebuilding historical feed packs offline

`scripts/compact/history.mjs` plans from immutable GHCR roots and builds
replacement candidates from a local archive. It reconstructs the exact
feed of each day against the observations available before that day.
An earlier sighting can retract a later feed record even when the later
day has no usable THC input.

## Plan

Use the Node version in `.node-version`. Supply a pinned root manifest
digest and an inclusive UTC interval that contains every affected live
span in full.

```bash
node scripts/compact/history.mjs plan \
  --ref ROOT_DIGEST --inventory ARCHIVE_INVENTORY.json \
  --edges ROOT_EDGES.json --from 2026-11-02 --to 2026-11-22 \
  --out .tmp/history-plan
```

The inventory is a JSON array of manifest descriptors. Each entry has
`dataset`, `repo`, `tag`, `digest`, `annotations` and `layers`. Use the
digest and descriptors from an anonymous manifest read. `repo` is the
package name from the root. Include every original domains day and feed
day in each covered span, and the known tags needed when choosing new
revision names.

The edge file is a JSON array. Each entry supplies an immediate
`before.digest` and `after.digest`. Add `planAnchor.digest` when planning
used an earlier root. The CLI reads the roots anonymously, verifies their
immutable digests and adjacency, checks the original inputs against the
planning anchor, and binds the installed pack digest to the pinned target.
The anchor may precede the immediate predecessor by up to eight root
transitions. The edge comparison binds pack digests across those roots.
A read of the current root and three original publication edges does not
walk every intervening root.

The plan is written as `history-plan.json` in a new or empty output
directory. Use its `earlier` and `replay` entries to assemble the local
archive. Earlier domains inputs establish membership before each day.
Each replay day uses the proved original domains day, an archived feed
day as carry, and any live domains segments that fall inside that day.
`downstream` lists later or provisional feed packs that still need
reconciliation.

## Build

For each required reference, place the exact OCI manifest bytes at
`ARCHIVE_DIR/<tag>/manifest.json` and the used layers beside it under
their OCI titles. Save the received manifest bytes without reserializing
the JSON. Supply `idx` and each key part for every input, and
`facts.json` where the replay consumes it. Raw gzip, saved time copies
and saved summaries are unnecessary for this replay. The builder checks
the manifest digest, then the length and digest of every used layer.

```bash
node scripts/compact/history.mjs build \
  --plan .tmp/history-plan/history-plan.json \
  --inputs ARCHIVE_DIR --out .tmp/history-build --run RUN_ID
```

Use a numeric run identifier for candidate manifest annotations. The
default source registry is `config/sources.json`. Supply `--sources`
with the matching registry if the build needs a different one. The
command regenerates the exact rows, both feed copies, and the applicable
facts and summaries, then assembles local domains and feed candidates for
the original spans. Its NDJSON records changed keys. `history-build.json`
binds the plan digest to the candidates and the old live manifest
digests, including any live domains segments to consume. Keep these
outputs together. A failed build can leave partial files in its output
directory.

The current path covers complete day, week and month spans, with at most
366 replay days and 64 historical edges. It refuses ambiguous or
incomplete lineage, rollback edges offered as original compactions, mixed
PSL inputs and yearly reconstruction. If an
archived domains day has already mixed quarantined and eligible records,
recover its separate canonical inputs before attempting an exact replay.

An original live target manifest at `ARCHIVE_DIR/<tag>/manifest.json` is
optional. The builder accepts it only at the digest pinned by the plan.
It can then omit an unchanged candidate after comparing record identity,
sources, nonvolatile annotations and sidecar descriptors, including the
feed time copy. A required live domains segment consumption keeps the
replacement in the report even when the other properties match.

## November reading and remaining proof

An anonymous plan against root sequence 1248, pinned at
`sha256:9a57c30e0db7e5d7d36aee83f3e0f69f56f141ddc293173d6bea48013cbc8bec`,
exited 0 on 2026-11-27. The verified original archive covers November 2
through November 22, with 63 daily manifest digests across names, domains
and feed. The replay plan targets six domains and feed weeks and lists
126 earlier domains inputs. It leaves 12 downstream feed packs unresolved:
the November 23–26 day packs and the November 27 hourly packs starting
at 00:00 through 07:00 UTC.

| Week | Planning root | Previous root | Publication root | Daily manifest digests |
| --- | ---: | ---: | --- | ---: |
| w45 | 419 | 420 | `r-20261109t043319z`, sequence 421 | 21 |
| w46 | 745 | 746 | `r-20261116t043338z`, sequence 747 | 21 |
| w47 | 1069 | 1069 | `r-20261123t043413z`, sequence 1070 | 21 |

The nine published week digests match the pinned root. The 63 archived
daily manifest digests match the original inputs read on the verified
edges. Those checks establish membership and manifest readability.
Production pack blobs and the full November replay remain unverified.
Use the actual post-backfill root for a new plan. The original
publication runs were
[w45](https://github.com/pkgforge-dev/domains.pkgforge.dev/actions/runs/42562197270),
[w46](https://github.com/pkgforge-dev/domains.pkgforge.dev/actions/runs/43804507102)
and [w47](https://github.com/pkgforge-dev/domains.pkgforge.dev/actions/runs/45112248539).

Keep the inventory and edge JSON with any plan. To regenerate the November
inputs, list the anonymous `names` and `feed` package tags using
`node scripts/ghcr/tags.mjs`. Read the daily `names-d-`, `domains-d-` and
`feed-d-` manifests for November 2–22 and the corresponding weekly
manifests. Save their descriptor rows in the inventory. Read each dated
publication root in the table with
`node scripts/root/show.mjs --ref DATED_ROOT` and follow its `previous`
digest for the predecessor. Use the start of the original planning job
in each linked run to identify the planning root. Preserve those immutable
digests as `before`, `after` and `planAnchor` in the edge file. A later
root or changed target span needs its own verified inputs. Retrieve the
actual manifest, index, key part and required facts bytes separately
before attempting a build.

`node --test scripts/compact/history.test.mjs` exercises the local
fixture and CLI, eight tests on Node v26.13.0. It covers earlier eligible
and quarantined observations changing later verdicts, surviving suspect
carry, matching feed key and time copies, semantic candidate selection,
and refusal of bad lineage or altered archive bytes. When the replay
retracts a week's last feed row, the replacement preserves the span and
both its key and time copies read as zero rows.

Check every later exact feed pack that could still contain an affected
key. Reconcile provisional hourly rows against the corrected history and
record the last checked pack. One unchanged day gives no bound for later
days. This CLI requires an original domains day and feed day for each
replay date. The hourly tail needs a separate reconciliation path.

The ordinary root promotion command refuses higher-tier domains and feed
replacements while their span contains an eligible live domains segment
that still needs an exact daily join. The offline report always sets
`publicationReady: false`. A future repair operation must verify the
archived inputs and exact joins, recheck the affected live digests and
write-once tags under `root-writer`, and promote the related replacements
and consumed inputs together. Names and ledger coverage require separate
proof. See
[DOM-029](../TODO/ingest.md#dom-029--thc-ct-thcs-daily-dumps-and-the-54-day-backfill).
