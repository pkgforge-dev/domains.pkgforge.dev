# ISC snapshots

`empty.http.json` keeps the exact 55-byte gzip from ISC's `2026-11-27` dated
path on 2026-11-27 at 08:48 UTC. It decompresses to `[]`.

`2026-07-18-empty.http.json` keeps the historical ISC gzip read on
2026-11-28. Its 55 bytes decompress to `[]`, as in the DOM-027 receipt.

`slice.http.json` is a synthetic replay response containing the first 200
complete objects from a 16 KiB HTTP Range read of the `2026-11-26` dated path
on 2026-11-27. The objects retain their original fields. The array framing,
gzip and HTTP 200 response were constructed for replay.

`alias-head.http.json` supplies synthetic HEAD metadata for the conditional
monitor. The saved response carries no feed rows.

Both paths are part of the [Internet Storm Center's new domain feed](https://isc.sans.edu/feeds_doc.html).
The rows describe when each domain was first seen by ISC.
