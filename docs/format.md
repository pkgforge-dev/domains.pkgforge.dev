# The pack format, DPK1

A pack stores sorted records in compressed blocks, with a sparse index beside
them. Every dataset of this project is stored as packs: `names`, `domains`,
`feed`, `new-name` and the reverse IP index. This document states every byte
of the format. `docs/architecture.md` section 4.4 owns the design, and this
document owns the bytes.

The reference code is `packages/pack`. Its reader runs in Node and in workerd.
The test vectors in `packages/pack/test/vectors/` are packs as JSON: the input
records, the raw blocks as hex, and the parts and the index as one writer wrote
them. A reader outside this repository can test itself against them.

## 1. Conventions

| Item | Rule |
| --- | --- |
| Byte order | Every fixed-width integer is little-endian. |
| `u8`, `u16`, `u32`, `u64` | Unsigned integers of 1, 2, 4 and 8 bytes. A `u64` holds at most 2^53 - 1. A reader refuses a larger value. |
| `varint` | Unsigned LEB128: 7 bits a byte, the low group first, the high bit set on every byte but the last. At most 8 bytes, and a value of at most 2^53 - 1. A varint of more than one byte does not end with `0x00`, so each value has one encoding. |
| `mask` | A set of source bits 0 to 63, written as the LEB128 of a 64-bit integer whose bit `b` is set for source bit `b`. At most 10 bytes. The tenth byte holds bit 63 alone. At least one bit is set. A mask of more than one byte does not end with `0x00`. |
| key | A byte string of 1 to 65,535 bytes. Keys compare bytewise as unsigned bytes. A key that is a prefix of another sorts first. In `packages/pack` a key is a JavaScript string with one code unit per byte, so `<` on two keys is their byte order. |
| CRC-32 | The CRC of zlib and of gzip: polynomial `0xEDB88320` reflected, initial value `0xFFFFFFFF`, final XOR `0xFFFFFFFF`. The CRC-32 of the ASCII bytes `123456789` is `0xCBF43926`. |
| Time | `day` values count days since 2026-01-01. `second` values count seconds since 2026-01-01T00:00:00Z. The unit of a value is the precision of its source (`docs/architecture.md` section 3.5). No record states the unit. A time is unsigned, so no time before 2026-01-01T00:00:00Z can be stored. An RDAP creation date before it is not evidence: the domain's row is flagged `suspect` instead (`TODO/RULES.md` §5, ruling 19). |

For the datasets `names`, `domains`, `feed` and `new-name`, a key is a reversed
name (`docs/architecture.md` section 3.2). It holds only the bytes
`[a-z0-9_.-]`, so its bytes are ASCII, and it is at most 253 bytes long, the
longest name of `docs/architecture.md` section 3.1. A writer refuses a longer
key of these datasets, and a reader refuses one from its two lengths before it
reads its bytes. The format itself accepts any byte in a key, and the reverse
IP dataset uses binary keys, which DOM-043 defines and the format bounds only
at 65,535 bytes.

## 2. A pack

A pack is one OCI manifest of kind `pack` or `segment` (`docs/architecture.md`
section 4.2). Its layers by title:

| Layer | Content |
| --- | --- |
| `part.000`, `part.001`, and up | The parts: a 16-byte header, then compressed blocks back to back. A title has at least three digits. |
| `idx` | The index: a head and a second level. |
| `time.idx`, `time.part.000` and up | Optional, on a pack of `feed` or `new-name`: its time copy, the same rows in `(first_seen, key)` order as a DPK1 pack of its own, with the index `time.idx` and the parts `time.part.NNN` (section 14). |
| other titles | Optional layers (`txt.gz`, `summary.json`). A reader that does not know a layer ignores it. |

A pack holds its records in ascending key order, with no key twice. The records
fill blocks in order. Every block holds `records a block` records, except the
last block of the pack, which holds 1 to `records a block`. A block never spans
two parts. A pack of zero records has one part with the header alone, and an
index with zero blocks.

## 3. The part

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 4 | magic | `DPK1`: `44 50 4b 31` |
| 4 | 1 | version | `1` |
| 5 | 1 | dataset | `1` names, `2` domains, `3` feed, `4` reverse IP, `5` new-name, `6` the time copy of feed, `7` the time copy of new-name (section 14) |
| 6 | 2 | records a block | `u16`, 1 to 65,535 |
| 8 | 2 | part number | `u16`, 0 for `part.000` |
| 10 | 1 | codec | `1` deflate-raw, `2` gzip |
| 11 | 5 | reserved | zero |
| 16 | | blocks | back to back, to the end of the part |

The first block of a part starts at offset 16. Each next block starts where the
block before it ends. The last block ends at the end of the part. A part holds
at most the part limit of the writer, 2^30 bytes by default (`docs/architecture.md`
section 4.4). The dataset, the records a block and the codec are the same in
every part and in the index.

## 4. The block

A raw block is its records back to back (section 5). The block in the part is
the raw block compressed by the codec of the header.

| Codec | Name | Bytes of a block |
| --- | --- | --- |
| 1 | `deflate-raw` | One raw DEFLATE stream (RFC 1951) that ends with a final block. |
| 2 | `gzip` | One gzip member (RFC 1952). A reader ignores its header fields: the time and the system byte do not change the records. |

A raw block is at most 16 MiB (16,777,216 bytes). The keys of its records, each
counted whole, add up to at most 16 MiB too. Front coding stores a shared
prefix once, and a reader holds each key whole. A block that
`packages/pack/test/pack.test.ts` builds holds 137,040 raw bytes and names
8,000 synthetic keys of 65,002 bytes, 520,016,000 bytes of keys (the test
holds both figures), and `deflateRawSync` at level 9 compressed it to 1,034
bytes (MEASURED 2026-10-29T03:21:22Z, Node v26.7.0, zlib
1.3.2.1-motley-42c2f19). A writer refuses a block
that passes either bound, and a reader refuses a block whose keys pass 16 MiB
at the record that passes it. A key of the datasets 1, 2, 3 and 5 is at most
253 bytes, so a block of theirs never passes the key bound: 65,535 keys of 253
bytes are 16,580,355 bytes. A key of the time copies 6 and 7 is at most 257
bytes (section 14.1), so a block of at most 65,280 of their records never
passes it: 65,280 keys of 257 bytes are 16,776,960 bytes.

A block in the part is 1 to `raw + floor(raw / 8) + 1,024` bytes, `raw` being
its raw length. An encoder that cannot shrink a block stores it, and the fixed
codes of DEFLATE spend at most 9 bits a byte, so a sound encoder stays within
this. A reader refuses an index entry that claims more, before it reads the
block.

The index states the compressed length, the raw length, the record count and
the CRC-32 of each raw block. `deflate-raw` has no checksum of its own. The
CRC-32 lets a reader check one block that it read by range from a signed URL,
with no other read.

Front coding starts again in each block. The first record of a block shares no
byte with a key before it. So a reader decodes any block alone.

## 5. The record

### 5.1 The key prefix

A record of the datasets `names`, `domains`, `feed` and `new-name`, and of
their time copies 6 and 7 (section 14.1), starts with its key:

| Field | Encoding | Meaning |
| --- | --- | --- |
| `shared` | `varint` | The bytes this key shares with the key of the record before it in the block. `0` for the first record of a block. |
| `word` | `varint` | `suffix_len << 2 \| flags`. |
| suffix | `suffix_len` bytes | The key is the first `shared` bytes of the key before it, then these bytes. |
| fields | by dataset | Sections 5.2 to 5.4. |

The writer writes the longest shared prefix. So `suffix_len` is at least 1,
and when `shared` is less than the length of the key before it, the first
suffix byte is above the byte of the key before it at that offset. A reader
refuses a record that breaks this, because the key is then not above the key
before it.

`flags` describes how the name was seen:

| Bit | Name | Meaning |
| --- | --- | --- |
| 0 | exact | The name itself was seen. |
| 1 | wildcard | The name was seen as `*.` followed by the name. |

A `names` record has at least one of the two bits. A `domains`, `feed` or
`new-name` record may have neither.

### 5.2 Dataset 1, `names`

| Field | Encoding | Meaning |
| --- | --- | --- |
| sources | `mask` | The source bits that saw the name. At least one. |
| for each set bit, in ascending order: `first` | `varint` | The first time the source saw the name, in the unit of the source. |
| then `span` | `varint` | `last - first`. The last time is `first + span`. |

### 5.3 Dataset 2, `domains`

The fields of `names`, then the evidence list:

| Field | Encoding | Meaning |
| --- | --- | --- |
| count | `varint` | The number of evidence entries. Zero or more. |
| for each entry: `tier` | `u8` | `1` T1, `2` T2, `3` T3 (`docs/architecture.md` section 3.3). |
| `basis` | `u8` | Below. |
| `source` | `u8` | The source bit, 0 to 63. |
| `at` | `varint` | The time of the evidence, in the unit of the source. |
| `confidence` | `u8` | `0` when the source states none. OpenINTEL's confidence of 1 to 10 passes through unchanged. |

The entries ascend by `(tier, basis, source)`, and no triple occurs twice.

| `basis` | Name | Tier |
| --- | --- | --- |
| 0 | `zone` | 1 |
| 1 | `rdap` | 1 |
| 2 | `nrd-list` | 2 |
| 3 | `nrd-ct+rdap` | 2 |
| 4 | `ct-first` | 3 |

The writer refuses a basis that is not in this table, and a tier that is not
the tier of its basis. A reader keeps a value it does not know and does not
refuse it (section 11).

### 5.4 Dataset 3, `feed`, and dataset 5, `new-name`

The two datasets share one record layout. The key of a `feed` record is a reversed
registrable domain. The key of a `new-name` record is a reversed name: any name
that `packages/names` accepts, not only a registrable domain
(`docs/architecture.md` section 3.3).

| Field | Encoding | Meaning |
| --- | --- | --- |
| `first_seen` | `varint` | Seconds since 2026-01-01T00:00:00Z. |
| sources | `mask` | The source bits that carry the event. At least one. |
| `basis` | `varint` | The basis bits: bit `n` is set for basis `n` of the table in section 5.3. |
| `confidence` | `u8` | As in section 5.3. |
| `feed_flags` | `u8` | Below. |

| Bit of `feed_flags` | Name |
| --- | --- |
| 0 | provisional |
| 1 | suspect |
| 2 | corroborated |
| 3 | censored |
| 4 | suspect-cert: a reason of `suspect`, an event whose certificate is older than 7 days |
| 5 | suspect-rdap: a reason of `suspect`, an RDAP creation date before 2026-01-01 (`TODO/RULES.md` §5, ruling 19) |
| 6 and 7 | reserved: the writer writes zero, the verifier refuses another value, and a reader keeps what it reads |

A row is suspect exactly when it holds at least one reason: bit 1 is set when
bit 4 or bit 5 is, and only then. The writer refuses a row that breaks this
(`record`), and so does the verifier: its `record` check fails a pack that
holds one, or a row with bit 6 or 7 set, by the writer's own rule
(`feedFlagsFault` of `packages/pack`), so a pack from another writer is held
to it before it is promoted. A reader keeps what it reads. The merge of section 5.6 ORs the
three bits, so a merged row keeps the rule. A stored suspect row so says which
rule made it suspect; the certificate age and the RDAP date themselves are not
stored. The two reason bits are additive under section 11.

A `feed` or `new-name` pack holds one record a key. `first_seen` is a field of
the record, not part of the key. The same rows in `first_seen` order are the
pack's optional time copy (section 14), so a page of a window in time order
reads blocks of the time copy from the bound of its window instead of sorting
the pack: 1 or 2 for a page of 1,000 rows with no filter in the runs of
section 14.6, and up to 50 when a filter drops most of the rows it reads.

### 5.5 Dataset 4, reverse IP

DOM-043 defines the record of dataset 4 and its index key. Its record does not
start with the key prefix of section 5.1.

### 5.6 Merge

A merge of packs is not a byte layout, but every writer of a higher tier
follows the same rule, so the rule is here. Two records with one key become
one record:

| Field | Merge |
| --- | --- |
| `flags` | OR |
| sources of `names` and `domains` | the union of the bits; for a bit that both carry, the minimum `first` and the maximum `last` |
| evidence of `domains` | the union by `(tier, basis, source)`; for a triple that both carry, the minimum `at` and the stronger `confidence` |
| `first_seen` of `feed` and `new-name` | the minimum |
| sources and `basis` of `feed` and `new-name` | OR |
| `confidence` of `feed` and `new-name` | the stronger |
| `feed_flags` | `provisional` only when both records are provisional; every other bit is the OR |

The stronger `confidence` is the lowest value that is not `0`. OpenINTEL's
level 1 is within 5 minutes of the RDAP date and level 10 within 18 to 24
hours, and `0` is a source that states none. So `0` merged with `7` is `7`, and
`3` merged with `7` is `3`.

Each rule is commutative, associative and idempotent. So `merge(a, a)` is `a`,
the order of the inputs does not change the output, and a record stores no
count (`docs/architecture.md` section 3.3).

## 6. The index

The index is the layer `idx`. It has a head and a second level. A reader keeps
the head, which is small, and reads one page of the second level by range for
each lookup.

### 6.1 The header

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 4 | magic | `DPKI`: `44 50 4b 49` |
| 4 | 1 | version | `1` |
| 5 | 1 | dataset | as in the part header |
| 6 | 2 | records a block | `u16`, as in the part header |
| 8 | 1 | codec | as in the part header |
| 9 | 1 | reserved | zero |
| 10 | 2 | parts | `u16`, at least 1 |
| 12 | 2 | entries a page | `u16`, at least 1. The writer writes 64. |
| 14 | 2 | reserved | zero |
| 16 | 8 | records | `u64` |
| 24 | 4 | blocks | `u32` |
| 28 | 4 | pages | `u32`, `ceil(blocks / entries a page)` |
| 32 | 4 | head bytes | `u32`: the length of the head, which is the offset of the second level in the index |
| 36 | 4 | reserved | zero |
| 40 | 8 | second level bytes | `u64`. The index is `head bytes + second level bytes` long. |
| 48 | 12 | reserved | zero |
| 60 | 4 | head CRC | the CRC-32 of the head, computed with these four bytes as zero |

`records` is 0 when `blocks` is 0. Otherwise it is above
`(blocks - 1) * records a block` and at most `blocks * records a block`.

### 6.2 The parts table

It starts at offset 64, with one entry of 16 bytes for each part, in part order:

| Offset in the entry | Size | Field |
| --- | --- | --- |
| 0 | 8 | bytes of the part, its header included, `u64` |
| 8 | 4 | the index of the first block of the part, `u32` |
| 12 | 4 | the blocks of the part, `u32` |

The first block of part 0 is block 0. The first block of each next part is the
first block after the blocks of the part before it. The blocks of all parts add
up to `blocks`. Each part has at least one block, except the one part of a pack
of zero records. A pack of zero records has exactly one part, and a reader
refuses an index of no block that names another number of parts.

### 6.3 The key bounds

After the parts table:

| Field | Encoding |
| --- | --- |
| length of the smallest key | `u16` |
| the smallest key | that many bytes |
| length of the largest key | `u16` |
| the largest key | that many bytes |

Both lengths are 0 when the pack holds no record. These are the `key_min` and
`key_max` of the root (`docs/architecture.md` section 4.6).

### 6.4 The top level

After the key bounds, one entry for each page, in order, to the end of the head:

| Field | Encoding |
| --- | --- |
| length of the page key | `u16` |
| the page key | the index key of the first block of the page |
| offset of the page | `u64`, from the start of the second level |
| bytes of the page | `u32` |
| CRC-32 of the page | `u32`, of the bytes of the page |

Page 0 starts at offset 0 of the second level. Each next page starts where the
page before it ends. The pages fill the second level.

### 6.5 The second level

The pages, back to back. Page `p` holds the entries of blocks
`p * entries a page` up to the last block or `(p + 1) * entries a page - 1`.
One entry for each block:

| Field | Encoding |
| --- | --- |
| length of the index key | `u16` |
| the index key | the key of the first record of the block, for the datasets 1, 2, 3, 5, 6 and 7 (for 6 and 7 its time key, section 14.1) |
| part | `u16` |
| offset of the block in its part | `u64` |
| compressed length | `u32`, 1 to `raw + floor(raw / 8) + 1,024` (section 4) |
| raw length | `u32`, 1 to 16,777,216 |
| records | `u16`: `records a block`, except for the last block of the pack |
| CRC-32 of the raw block | `u32` |

Index keys never descend. For the datasets 1, 2, 3, 5, 6 and 7 they ascend,
because the index key of a block is the key of its first record.

### 6.6 What a reader checks

A reader of `packages/pack` refuses, with the error `PackError` and a code:

| Code | Check |
| --- | --- |
| `magic` | A part or an index does not start with its magic. |
| `version` | The version is not 1. |
| `dataset` | The reader has no codec for the dataset, or the codec it was given is for another dataset. |
| `codec` | The codec byte is not 1 or 2. |
| `header` | A field of the fixed header of a part or of the index is out of its range, or a reserved byte is not zero. |
| `head` | The head CRC does not match, the head does not parse to its stated length, or the parts table, the key bounds or the top level break a rule of sections 6.2 to 6.4. |
| `page` | A page CRC does not match, or its entries break a rule of section 6.5, a compressed length above the bound of section 4 among them. A block's raw length is above the `maxRawBlockBytes` of the reader (section 6.6). |
| `tiling` | The blocks do not tile their parts: a gap, an overlap, or a block past the end of its part. When the caller gives the sizes the store holds (`partSizes`), the parts table states another number of parts or another size. |
| `short-read` | A range read answered fewer or more bytes than it asked for. |
| `inflate` | A block does not decompress, or decompresses to more or fewer bytes than its raw length. |
| `crc` | The CRC-32 of a raw block does not match its index entry. |
| `record` | A record does not decode: a varint, a mask, a length or a list breaks section 5, or runs past the end of its block. A key is longer than its dataset allows (section 1), or the keys of a block pass 16 MiB (section 4). |
| `count` | A block holds another number of records than its index entry. |
| `order` | A key is not above the key before it, within a block or across blocks, or a block does not start with its index key. |

The writer refuses with the same error: `order` for records that do not
ascend, `record` for a record that breaks a rule of section 5 or a key longer
than its dataset allows, `span` for a block that does not fit in a part of the
part limit, a raw block above 16 MiB or a block whose keys pass 16 MiB, and
`usage` for a compressor that gives no byte or more than the bound of section
4. After a refusal, the writer refuses every later call.

A lookup reads no part header, so it does not compare the part headers with
the index. `readPartHeader` reads and checks one part header, and a verifier
compares each part header with the index. A lookup trusts the part sizes of
the index unless the caller gives `partSizes`, the sizes the store gives (the
layer sizes of the manifest, or the sizes of the files): `PackIndex.open` and
`PackReader.open` then hold the parts table to them before any block is read.

A block within the 16 MiB bound can still decode to more memory than a reader
holds: one `domains` record of 3,000,000 evidence entries is 15,000,021 raw
bytes and decodes to about 235 MB of heap (MEASURED 2026-10-29, the wave 3
fix verification, Node v26.7.0). So a reader takes `maxRawBlockBytes`, 1 to
16 MiB and 16 MiB by default, and refuses a block whose index entry states a
raw length above it with `page`, before it reads the block. A Worker sets it
near its blocks' size.

## 7. A lookup and a scan

A lookup of one key:

1. Binary search the top level for the last page whose key is not above the key.
   If no page qualifies, the pack does not hold the key.
2. Read that page by range. Check its CRC-32.
3. Binary search the page for the last block whose index key is not above the key.
4. Read that block by range, decompress it, and check its raw length and its CRC-32.
5. Decode the block and look for the key.

With the head held in memory, a lookup costs two range reads: one page and one
block. A key below the first page key, or above the largest key of the pack,
costs no read. A scan of the half-open key range `[lo, hi)` starts at the block of
`lo` and reads blocks in order until a block starts at or above `hi`.
`rangeOfDescendants` of `packages/names` gives the range of every name below a
parent.

## 8. Identity and integrity

`packAnnotations` of `packages/pack` builds these OCI annotations for the
manifest of a pack, and `writePackFiles` returns them. The push tool of DOM-019
(`scripts/ghcr/push.mjs`) sets only `org.opencontainers.image.source` and
`org.opencontainers.image.created` itself: a caller passes each of these with
one `--annotation`. The callers that push packs pass them from the manifest
that `packManifest` of `packages/compact` built: the steps "Push the pack" of
the four compaction workflows, and `pushFiles` of `scripts/ingest/pack.mjs`,
which `scripts/ingest/run.mjs` (a segment) and `scripts/state/hours.mjs` (an
hour pack) run in their own process. `ref-refresh.yml` pushes reference
files, not packs.

| Annotation | Value |
| --- | --- |
| `dev.pkgforge.domains.dataset` | the dataset name: `names`, `domains`, `feed`, `rev` or `new-name` |
| `dev.pkgforge.domains.count` | the records |
| `dev.pkgforge.domains.bytes` | the bytes of all parts and the index |
| `dev.pkgforge.domains.sha256` | the SHA-256 of the raw blocks, concatenated in order |
| `dev.pkgforge.domains.writer` | the Node version and the zlib version of the writer |

The annotations describe the key copy alone: `idx` and the parts `part.NNN`.
A time copy (section 14) has no manifest and no annotation of its own, and
`packAnnotations` refuses the datasets 6 and 7. Its layers ride in the manifest
of its key copy, and the `time` check of the verifier holds it to that copy
(section 14.2).

The SHA-256 is of the decoded records, not of the compressed blobs. Two writers
with one input and one `records a block` give one SHA-256, even when their
zlib builds give other compressed bytes. The push tool of DOM-019 treats a tag
as present when its manifest is the same, or when its artifact type, its
`dev.pkgforge.domains.sha256` annotation and its layers are the same: each
layer's title and media type, and for a ref each layer's digest too. A pack's
compressed sizes and digests may differ between zlib builds, so they are not
compared. The raw blocks depend on
`records a block`, because front coding starts again in each block. So two
packs of one input at two block sizes have two SHA-256 values.

The writer of `packages/pack` compresses with `node:zlib` at level 9, with the
default memory level, window and strategy. It decompresses each block it wrote
and compares the bytes before it keeps the block. A test of `packages/pack`
writes one input twice in one process and gets the same bytes. A zlib build
may compress the same block to other bytes, so `.node-version` pins the build
in CI. The writer module is `packages/pack/node/index.ts`, outside `src/`, so
no Worker imports `node:zlib`.

## 9. Defaults

These are defaults of the writer, not of the format. The header of each part
and of the index states the values a pack uses, so a reader never assumes them.
A test of `packages/pack` holds this table equal to the constants of the code.

| Constant | Value |
| --- | --- |
| `DEFAULT_RECORDS_PER_BLOCK` | 4096 |
| `DEFAULT_CODEC` | 1 |
| `DEFAULT_PART_LIMIT` | 1073741824 |
| `DEFAULT_PAGE_ENTRIES` | 64 |
| `MAX_RAW_BLOCK_BYTES` | 16777216 |

DOM-008 measures the decode CPU in a Worker. If its verdict prefers 1,024
records a block or the `gzip` codec, it changes the first two constants and this
table. A pack written before the change still reads.

## 10. The runtime

The reader decompresses with `DecompressionStream("deflate-raw")` and
`DecompressionStream("gzip")`. It uses no `node:` module, so it runs in Node and
in workerd. A test runs it in workerd through `packages/testkit`, at the
compatibility date 2026-10-13 with the flags `no_nodejs_compat` and
`no_nodejs_compat_v2`.

DOM-008 found the line for the compatibility date (`TODO/storage.md`, the Found
lines of 2026-10-28T15:54Z). In workerd 1.20261006.1, a `deflate-raw` round
trip through `DecompressionStream` and `CompressionStream` worked at each of
the ten compatibility dates tried: 2021-01-01, 2021-11-03, 2022-01-01,
2022-06-01, 2023-01-01, 2023-06-01, 2023-08-01, 2024-01-01, 2025-01-01 and
2026-10-13, under the two flags `no_nodejs_compat` and `no_nodejs_compat_v2`.
Only `deflate-raw` was tried at those dates: `gzip`, which the reader also
decodes, was tried at 2026-10-13 alone, by the test above. Cloudflare's own
runtime was not tried at an older date.

## 11. Versioning

These are the rules of `docs/architecture.md` section 11, applied to the pack.

- A reader refuses a magic, a `version` or a `dataset` that it does not know,
  and a codec byte that it does not know.
- A reader ignores a layer that it does not know, and an annotation that it does
  not know.
- A change inside `DPK1` version 1 is additive: a new optional layer, a new
  annotation, a new value of a field that a reader keeps when it does not know
  the value (the `tier` and the `basis` of an evidence entry, section 5.3), or a
  new bit of the `basis` bits or of `feed_flags` of a `feed` or `new-name`
  record (section 5.4).
- A change that a reader of version 1 refuses is a new version: a change to any
  byte table of this document, a new codec byte, a new dataset id, or a new
  value of any other `u8` enumeration that the reader refuses.
- The datasets 6 and 7 are new dataset ids in the layers of a time copy alone
  (section 14). A reader of version 1 that does not know them reads the parts
  and the index of the pack, which are unchanged, and ignores the layers
  `time.idx` and `time.part.NNN` as it ignores any layer it does not know. So
  the time copy is a new optional layer: an additive change. A pack whose own
  `idx` and parts were of dataset 6 or 7 would be a new version. No manifest of
  its own carries one: `packAnnotations` refuses them (section 8).

## 12. A worked example

The vector `packages/pack/test/vectors/names-one-source.json` holds three names
and one source. The names are synthetic. All three records have `flags` 1 and
source bit 0 with `first` and `last` 298, the day 2026-10-26. The keys are
`com.example`, `com.example.api` and `com.example.www`.

| Record | `shared` | `word` | suffix | mask | `first` | `span` |
| --- | --- | --- | --- | --- | --- | --- |
| `com.example` | `00` | `2d`: 11 << 2 \| 1 | `63 6f 6d 2e 65 78 61 6d 70 6c 65` | `01` | `aa 02`: 298 | `00` |
| `com.example.api` | `0b`: 11 | `11`: 4 << 2 \| 1 | `2e 61 70 69` | `01` | `aa 02` | `00` |
| `com.example.www` | `0c`: 12 | `0d`: 3 << 2 \| 1 | `77 77 77` | `01` | `aa 02` | `00` |

The raw block is these 36 bytes, which a test holds equal to the vector:

```text
002d636f6d2e6578616d706c6501aa02000b112e61706901aa02000c0d77777701aa0200
```

## 13. Measured cost

`scripts/bench/pack.mjs` writes the same names four times: with the key and
its flags alone, then with 1, 2 and 3 sources a record. It reads every pack
back and compares each record with its input. The source fields are synthetic
in both runs below, so their cost is the cost of these values:

- bit 0 is a day source that saw every name on day 298;
- bit 1 is a second source at a random second of day 298, with `last` equal to
  `first` for half the names and later that day for the rest;
- bit 2 is a day source first seen 0 to 298 days before day 298.

The bytes a name are the bytes of the parts and the index, divided by the
names. "Fields" is that figure minus the figure of the keys alone. "Decode" is
the Node wall time of reading, decompressing, checking and decoding every block,
for 1,000 names. It is not CPU time in workerd, which DOM-008 measures. Both
runs used Node v26.7.0 with zlib 1.3.2.1-motley-42c2f19, 4,096 records a
block, `deflate-raw` at level 9. Each run's JSON is in
`docs/research/measure/DOM-017/`: `names-1000000.json`, `cs2-first.json`, and
`result.json`, the cs2 run on the code after the review fixes.

MEASURED 2026-10-29T00:21:11Z to 00:21:32Z, `node scripts/bench/pack.mjs --names
1000000`, 1,000,000 synthetic names (seed 1), 245 blocks, an index of
10,416 bytes:

| Variant | Raw bytes a name | Bytes a name | Fields | Decode, ms for 1,000 names |
| --- | --- | --- | --- | --- |
| keys alone | 7.801 | 4.666 | 0 | 0.67 |
| 1 source | 11.801 | 5.114 | 0.448 | 0.66 |
| 2 sources | 17.544 | 10.804 | 6.138 | 0.82 |
| 3 sources | 20.688 | 13.215 | 8.548 | 0.86 |

MEASURED 2026-10-29T00:21:39Z to 00:22:36Z, `node scripts/bench/pack.mjs --sample
cs2`. The range `bytes=0-19999999` of `https://cs2.ip.thc.org/2026-10-26.txt.gz`
answered 206 with `Content-Range: bytes 0-19999999/319917410`. It decompressed to
78,100,284 characters, 1,627,369 whole lines. The names package refused 1,173
of them as `numeric-tld` and left 1,415,107 distinct keys, in 346 blocks with
an index of 26,405 bytes:

| Variant | Raw bytes a name | Bytes a name | Fields | Decode, ms for 1,000 names |
| --- | --- | --- | --- | --- |
| keys alone | 19.797 | 10.950 | 0 | 1.00 |
| 1 source | 23.797 | 11.280 | 0.330 | 1.39 |
| 2 sources | 29.540 | 17.547 | 6.597 | 1.52 |
| 3 sources | 32.684 | 20.039 | 9.090 | 1.69 |

That run was made before the last edits to the writer and the reader of
DOM-017. MEASURED again 2026-10-29T03:25:29Z to 03:27:07Z on the code after the
review fixes, with the same command, the same range (ETag
`"6adfea7c-13118d62"`): the four SHA-256 values of the raw blocks were the same
(`baddd6a0…` for the keys alone, `e5f93e46…`, `ed7a40e1…` and `97bf384c…` for
1, 2 and 3 sources), and so were every count and every bytes-a-name figure of
the table. Decode is wall time and varies between runs: the second run read
2.70 to 6.04 ms for 1,000 names.

⚠ The sample is the first lines of the dump, and the dump runs roughly in
forward name order from `0`: the first lines of each day in
`packages/ledger/test/fixtures/thc-slice.json` start with `000`, after any `*.`, though the
dump is not bytewise sorted (`docs/architecture.md` section 3.1). So the
sample is the names of one forward-name region, spread thin over the reversed
keys, and its keys share less with each other than the keys of the whole day
do. Its keys alone cost 10.950 bytes a name, against 6.04 for all 32,554,702
names of the same day (design B M10, `docs/architecture.md` section 4.4). Slices
that are contiguous in reversed-key order cost less: DOM-008's five slices of
the same day, in the record layout of `scripts/measure/blockenc.mjs` (not
DPK1), cost 3.01 to 5.74 bytes a
name at 4,096 a block (`TODO/storage.md`, DOM-008, the correction of
2026-10-28T23:38Z). This sample's figure is one thin prefix, not the day's
figure and not a bound on it.

In both runs a day source that saw every name on one day costs 0.3 to 0.45
bytes a name. A second source with random seconds costs about 6 bytes a name
more. In both runs, 1,000 lookups through an index opened once, with no page
cache, each read one index page and one block: two range reads.

## 14. The time copy

A pack of the dataset `feed` or `new-name` holds its rows in key order. A page
of a window in `first_seen` order needs them in time order. The time copy is
the same rows in `(first_seen, key)` order: optional on each pack, written by
`writeFeedPack` of `packages/feed` and read by `readFeed` of the same
package. A reader that does not know it ignores its
layers (section 11), so a pack with a time copy reads as a pack without one.

Why a copy of the rows, and not an index of positions. The design before this
one was an optional layer of `(first_seen, ordinal)` pairs over the key copy.
A pair names a row, not its bytes, so a reader of a row in time order reads the
row's block of the key copy. The newest rows of a day hold keys spread over the
whole key range, so one page of them read almost every block: MEASURED
2026-10-29T09:05:25Z to 09:05:45Z, `node scripts/bench/feed-window.mjs --rows
500000 --order first_seen.desc --limit 1000` on the code of that design, 122 of
the 123 blocks of the pack read and 499,712 rows decoded for one page of 1,000
rows (`docs/research/measure/DOM-022/replaced-ordinal-index-desc.json`). The
time copy holds the rows themselves, so the newest rows are in its last blocks:
the same command reads 2 blocks (section 14.6). It costs 0.982 to 1.104 of the
key copy's bytes in the runs of section 14.6, by how many rows share one
second, so a pack that carries one is about twice the size.

### 14.1 The layout

The time copy is a DPK1 pack in its own right, sections 2 to 6, in the layers
`time.idx` (its index) and `time.part.000`, `time.part.001` and up (its parts,
numbered as the parts of section 2) of the manifest of its key copy. It is of
its own dataset: `6` for the time copy of `feed` (3), `7` for that of
`new-name` (5). It holds every row of its key copy once.

The key of a record of 6 or 7 is the row's time key: its `first_seen` as 4
bytes, big-endian, then the row's own key (a reversed name, section 1).
Big-endian makes the bytewise order of time keys the order by
`(first_seen, key)`. A time key is 5 to 257 bytes. Its `first_seen` is 0 to
2^32 - 1, a time in the year 2162; the key copy's is a `varint` of up to
2^53 - 1, and section 14.3 says what the writer does with a larger one.

The record is the key prefix of section 5.1 over the time key, with the row's
`flags` in its `word`, then the fields of section 5.4 after `first_seen`, which
the time key holds: sources (`mask`), `basis` (`varint`), `confidence` (`u8`)
and `feed_flags` (`u8`). A record decodes to the row of the key copy: the key
is the time key without its first 4 bytes, and `first_seen` is those 4 bytes.
A test of `packages/pack` (`test/time.test.ts`) holds one record by hand: the
row `com.a` at `first_seen` 300 with source bit 1, basis bits `04`,
confidence 0 and `feed_flags` `12` (suspect and suspect-cert) is the raw
block

```text
00240000012c636f6d2e6102040012
```

`shared` 0, `word` `24` (9 << 2), the time key `00 00 01 2c` and `com.a`, the
mask `02`, the basis bits `04`, the confidence `00` and `feed_flags` `12`.

The index is the index of section 6. Its index keys and its key bounds are time
keys, so `key_min` and `key_max` of its head hold the first and the last
`first_seen` of the copy. Its head parses with the head reader of
`packages/pack` (`parseHead`), so a root can hold its record count and the
size of each part as it holds the key copy's: `packFromManifest` of
`packages/root` does, and the root lists the copy as the pack's `time`
(`docs/architecture.md` section 4.6).

The time copy has no manifest and no annotation of its own (section 8).

Why this encoding. Sections 2 to 6 serve it unchanged: one writer, one
reader, one index, one verifier, and no third format. It takes a dataset byte
of its own because a reader opens a pack with the codec of its dataset, and a
record of 6 or 7 is not a record of 3 or 5: its key holds 4 bytes of time and
is not a name. The rules of section 1 for a name key are kept on the row key
inside the time key, not on the time key: the writer refuses a row key above
253 bytes, as the key copy's writer does; the row keys are the key copy's,
whose names the verifier's `name` check holds to `[a-z0-9_.-]`, and the `time`
check holds the two copies to the same rows (section 14.2). The format itself
accepts any byte in a key, the 4 bytes of time among them. A reader of 6 or 7
refuses a time key of 4 bytes or fewer (`record`): it holds no row key.

### 14.2 The bind

A time copy is bound to its key copy. A reader that holds the two index heads
checks the half of the bind the heads hold (`timeBindFault` of
`packages/pack`):

1. its dataset is the time dataset of the key copy's: 6 for 3, 7 for 5;
2. it holds as many records as the key copy;
3. its first and last `first_seen`, read from its key bounds, lie inside the
   span `[start, end)` of the pack, when the caller gives the span.

That the time copy holds exactly the rows of its key copy needs every row of
both. The `time` check of the verifier (`verifyPack` of `packages/pack`,
`scripts/verify-pack.mjs`) reads the time copy whole, as a pack of its own:
its index, the size of each part against the index, each part header, every
block through the reader with the checks of section 6.6, the order of time keys
across block boundaries, and the head's key bounds against its first and last
time key. It checks the bind of the heads, with the span of the annotations.
Then it compares the rows: it sums the rows of each copy with an order-free sum
(`RowSum`: the SHA-256 of each row's fields as JSON, added in eight 32-bit lanes
modulo 2^32, and the count of rows), and the two sums must be equal. The key
copy is read in key order and the time copy in time order, and addition does
not depend on the order. The sum finds a time copy written from other rows,
one changed field of one row among them. It is no defence against rows forged
to collide.

The verifier prints the check as `time`. It is `SKIP` when no time copy is
given, so the job that writes a pack that must carry one runs the verifier
with `--require time` before it calls the promotion, which makes that skip
unverified, exit 1. The promotion does not check that the verifier ran
(`docs/architecture.md` section 4.7, rule 2). The check runs only when every
block of the key copy decoded, since it compares their rows. The local form
takes the files `time.idx` and `time.part.NNN` beside `idx` and `part.NNN`,
and the GHCR form reads the layers of those titles from the manifest.

### 14.3 The writer

`writeFeedPack(rows, { codec, compress, sink, time: { sink } })` writes the key
copy to `sink` and, when `time` is given, the time copy to the sink of `time`.
The rows come in ascending key order, one a key. With a time copy it reads
every row into memory first and checks each `first_seen` before it writes a
byte: a `first_seen` that is not 0 to 2^32 - 1 is refused (`FeedError`, code
`time`), and neither sink then holds a byte. A test of `packages/feed` plants
the value at the first, a middle and the last of 300 rows and counts the
writes of both sinks: 0 and 0. Then it writes the key copy. A row that the
key copy's writer refuses (a key out of order, a field out of range) is refused
as it is written, and the key sink then holds what the writer wrote before it,
as after any refusal of the writer (section 6.6), and the time sink holds
nothing. Then it sorts the rows by `(first_seen, key)` and writes the time
copy. It does not check the bind of the two heads it wrote: the time copy is
written from the rows the key copy took, with the time codec of the key copy's
dataset, so the heads bind by construction and no check there could refuse.
The reader and the verifier hold the bind.

Without `time`, the rows stream to the key copy, none is held, and a
`first_seen` of up to 2^53 - 1 is written. DOM-023 is to write a time copy for
each pack of the tiers `d`, `w`, `m` and `y` of `feed` and `new-name`, and
`readFeed` refuses such a pack without one (section 14.4). The memory an
in-memory sort of a `w`, `m` or `y` pack takes is not measured, nor is the size
of an hour pack of `feed`, which is read from its key copy and a sort.
`new-name` has no hour pack: it enters only through the exact day pack of
DOM-041 (`docs/architecture.md` section 4.5).

### 14.4 A read in time order

`readFeed` reads the live packs of a window one after another, in the order of
their spans, newest first for `first_seen.desc`. Every row's `first_seen` lies
in the span of its pack (the builder refuses another), so the rows of the
packs follow each other in order. Each pack is read from one of its copies.

- A pack of tier `h` or `seg` with no time copy: every block of the key range
  of the key copy is read, the rows kept, and sorted in memory. The range is
  read whole within the block budget or not at all, since the rows of a part
  of it are not the first rows of the order.
- A pack of tier `d`, `w`, `m` or `y` with no time copy: refused
  (`FeedError` `time`, `TIME_COPY_TIERS` of `packages/feed`) before a block of
  it is read, so no page sorts such a pack whole.
- A pack with a time copy and no key range (no `suffix`, no `under`): the time
  copy.
- A pack with a time copy and a key range. Let `R` be the blocks of the key
  copy that the range spans, which its index gives with no block read, `B` the
  blocks of the key copy, `r` the records a block of the time copy, and `w` the
  rows the page still takes. The key copy reads the `R` blocks. The time copy
  reads blocks until it holds `w` rows of the range: if the rows of the range
  are spread over time as the rows of the pack are, a block of the time copy
  holds about `r * R / B` of them, so it reads about `w * B / (r * R)` blocks.
  The reader takes the key copy when `R * R * r <= w * B` and the `R` blocks fit
  the budget left (`keyCopyFirst`), and the time copy otherwise. For a page of
  1,000 rows over a pack of 123 blocks of 4,096 records, that is a range of 5
  blocks or fewer. The rule weighs blocks read: the key copy also sorts the rows
  of its `R` blocks, at most 20,480 rows at that threshold. The estimate does
  not know the filters, and a filter that drops most rows (`suspect=only`,
  `basis=rdap`) makes the time copy read more than it estimates; the block
  budget bounds that page.

In the time copy, a bound is a time key. The pair `(t, "")`, the time key of
`t` alone, is the first time key of the second `t`. A window `[t0, t1)` is the
run of time keys from `(t0, "")` up to `(t1, "")`. A day-precision row has its
`first_seen` at the start of its day and stands for the whole day
(`docs/architecture.md` section 7.4), so a window that starts inside a day also
reads the run of that day's first second, `(day start, "")` up to
`(day start + 1, "")`. Both runs are cut to the span of the pack. A cursor
`(first_seen, key)` cuts the runs: `first_seen.asc` starts at the time key of
`(first_seen, key + 0x00)`, the smallest pair above the cursor, and
`first_seen.desc` ends at the cursor's time key, exclusive. The index gives the
block of a bound (section 7: a search of the top level held in memory, one page
read, a search of the page). The page reads blocks from there in order,
backwards for `first_seen.desc`, until it holds its rows. Each row is checked
against the key range, the window and the filters after its block is read, so
a row they drop costs its block too. No block is read twice in one page.

The block budget, 2,000 blocks a request (`docs/architecture.md` section 7.6),
counts the blocks of both copies. When the next block would pass it, the page
ends with `partial` and a cursor at its last row. A page that cannot give one
row inside the budget is refused (`budget`).

### 14.5 What a reader checks

| Who | Check | Refusal |
| --- | --- | --- |
| `packFromManifest` of `packages/root`, at promotion | The layers `time.idx` and `time.part.NNN` both or neither, in order, on a pack of `feed` or `new-name` alone; the time index head's dataset byte (6 or 7), its record count against the key index's, each part's size against its layer, and, for a pack of records, the first and last `first_seen` of its key bounds inside the pack's span: the half of the bind (section 14.2) that the heads hold. | `RootError` `pack` |
| `validateRoot` of `packages/root` | A pack's `time` is `{ idx, parts }` of digests and sizes, on a pack of `feed` or `new-name` alone. | `RootError` `pack`, or `schema` for a field missing or unknown |
| `validateRoot` of `packages/root`, a writer's (strict) | A pack of `feed` or `new-name` of tier `d`, `w`, `m` or `y` that holds records lists its time copy (`TIME_COPY_TIERS`, equal to that of `packages/feed`, a test holds). A reader's leaves it to `readFeed`, so a bad pack fails the pages over it, not the root. | `RootError` `pack` |
| `readFeed` | The pack opened is of the dataset the plan reads. | `FeedError` `usage` |
| `readFeed` | The pack has a time copy exactly when the live set lists one. | `FeedError` `usage` |
| `readFeed` | A pack of tier `d`, `w`, `m` or `y` has a time copy. | `FeedError` `time` |
| `readFeed`, before a block of either copy is read | The bind of the two heads (section 14.2), with the pack's span from the live set. | `FeedError` `time` |
| `writeFeedPack` | A `first_seen` that is not 0 to 2^32 - 1, before any write. | `FeedError` `time` |
| `PackReader` | Every check of section 6.6 on each block either copy reads, and, when the live set gives them, the part sizes against the parts table. | `PackError` and its code |
| The codecs of 6 and 7 | A time key of 4 bytes or fewer when read. A row key above 253 bytes, a `first_seen` above 2^32 - 1, or a row that breaks a rule of section 5.4, when written. | `PackError` `record` |
| `verifyPack`, `scripts/verify-pack.mjs` | The `time` check of section 14.2. | `FAIL time` |

The checks of `readFeed` run in that order, before the page reads a block of
either copy; a test of `packages/feed` counts the reads of both copies' parts
and finds 0 for each refusal of the last three.

A reader that holds only the heads cannot tell a time copy of other rows with
the same count inside the same span: it would serve those rows. The `time`
check sees it, so the job that writes a pack with a time copy runs the
verifier with `--require time` before it calls the promotion, which does not
check that it ran (section 14.2).

### 14.6 Measured cost

`scripts/bench/feed-window.mjs` writes a day pack and its time copy with
`writeFeedPack`, the production writer at 4,096 records a block, reads one page
of a window of the day with `readFeed` and its defaults, counts each range read
of either copy, and compares the page, row by row and field by field, with a
sort of every row of the window that passes the filter of the page: a page that
differs exits 3, and none did. The bench exits 1 when a page reads more than 40
blocks. The rows are synthetic from the seed 1: 500,000 distinct registrable
domains of 2026-10-26 under a weighted list of suffixes, 200,374 of them (the
share 0.4 of `--day-share`, its default) at the start of the day from a day
source and the rest at a random second from a second source. Node v26.7.0, zlib
1.3.2.1-motley-42c2f19, on win32 x64. Each run's JSON is in
`docs/research/measure/DOM-022/`, named in the tables, and `runs.tsv` there
holds each run's command, its UTC start and end, and its exit code, read from
the process itself.

MEASURED 2026-10-29T14:41:06Z to 14:41:15Z, `node scripts/bench/feed-window.mjs
--rows 500000 --order first_seen.desc --limit 1000`, exit 0 (`result.json`):

| Copy | Blocks | Parts | Index | Bytes a row |
| --- | --- | --- | --- | --- |
| key | 123 | 4,405,063 B | 5,127 B | 8.82 |
| time | 123 | 4,359,671 B | 5,596 B | 8.731 |

The time copy is 0.99 of the key copy's bytes here, so the pack with both is
1.99 times the key copy alone. These synthetic `first_seen` values put 40% of
the rows at one second, where the time copy holds them in key order and front
codes them as the key copy does.

One page of 1,000 rows, each run the same command with the changes named,
MEASURED 2026-10-29T14:41:06Z to 14:43:05Z. The window is the whole day unless
`--from` cuts it at 12:00.

| Run | File | Rows of the window | Copy read | Blocks read | Bytes read | Rows decoded | Exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| as above | `result.json` | 500,000 | time | 2 | 44,071 | 4,384 | 0 |
| `--order first_seen.asc` | `asc.json` | 500,000 | time | 1 | 29,477 | 4,096 | 0 |
| `--suffix com.np` | `suffix-com-np.json` | 6,703 | key, 3 blocks of range | 3 | 113,855 | 12,288 | 0 |
| `--suffix com.np --copy time` | `suffix-com-np-time.json` | 6,703 | time | 20 | 781,322 | 78,112 | 0 |
| `--suffix de` | `suffix-de.json` | 33,141 | time | 5 | 167,042 | 16,672 | 0 |
| `--suffix de --copy key` | `suffix-de-key.json` | 33,141 | key, 9 blocks of range | 9 | 332,385 | 36,864 | 0 |
| `--suffix de --copy time` | `suffix-de-time.json` | 33,141 | time | 5 | 167,042 | 16,672 | 0 |
| `--suffix com` | `suffix-com.json` | 267,121 | time | 2 | 44,071 | 4,384 | 0 |
| `--suffix com --copy key` | `suffix-com-key.json` | 267,121 | key, 66 blocks of range | 66 | 2,318,359 | 270,336 | 1 |
| `--suspect-share 0.01 --suspect only` | `suspect-only.json` | 4,900 | time | 25 | 988,350 | 98,592 | 0 |
| `--from 2026-10-26T12:00:00Z` | `from-desc.json` | 349,840 | time | 2 | 44,071 | 4,384 | 0 |
| `--from 2026-10-26T12:00:00Z --order first_seen.asc` | `from-asc.json` | 349,840 | time | 1 | 29,477 | 4,096 | 0 |
| `--from 2026-10-26T12:00:00Z --order first_seen.asc --source oi-nrd` | `from-asc-oi-nrd.json` | 149,466 | time | 50 | 1,408,937 | 204,800 | 1 |
| `--from 2026-10-26T12:00:00Z --source isc-new` | `from-desc-isc-new.json` | 200,374 | time | 39 | 1,548,169 | 155,936 | 0 |

The rule of section 14.4 chose the copy that read fewer blocks in each pair:
the key copy for `com.np` (3 blocks against 20), the time copy for `de` (5
against 9) and for `com` (2 against 66). `--copy` forces a copy. The
`--suspect only` page is a filtered scan of the time copy: 4,900 of the
500,000 rows carry the flag, and the page read the newest blocks until it held
1,000 of them.

A window cut inside the day reads the run of the day's first second too,
since a day-precision row stands for its whole day (section 14.4). With no
filter that costs nothing more: the 200,374 day rows are rows of the window,
and an ascending page takes its 1,000 rows from the first block of that run.
A filter that drops them makes the page read the run whole: `--source oi-nrd`,
ascending from 12:00, read the 49 blocks of the day rows and kept none of
them, then 1 block from 12:00, 50 blocks in all, above the 40 of DOM-022's
Prove. Descending with `--source isc-new`, the page read the blocks from the
end of the day down to 12:00, whose second-precision rows the filter drops,
before it reached the day rows: 39 blocks. So a page reads 1 or 2 blocks for
a window with no filter, or a filter most rows pass; a filter that drops most
rows, on a window cut inside a day or not, reads the blocks of the rows it
drops until the page is full, within the block budget of 2,000 (section 14.4).

Real names. MEASURED 2026-10-29T14:43:05Z to 14:43:34Z, the same bench with
`--names FILE` in place of `--rows`: the keys are the names of a real list,
each normalised and reduced to its registrable domain, and their `first_seen`
values and sources are synthetic, from the seed, as above, at the
`--day-share` named. Two lists of `docs/sources.md`, fetched 2026-10-29:
WhoisDS's daily file of 2026-10-28 (`newly-registered-domains-2026-10-28.zip`,
580,041 bytes, SHA-256 `32da7cfc…`, the response dated 11:47:37Z), and ISC's
dated file `domaindata.2026-10-28.json.gz` (2,936,790 bytes, SHA-256
`94250002…`, the response dated 11:48:11Z, its `Last-Modified` 11:31:01Z). The
files given to `--names`, one name a line, are made by `unzip -p
newly-registered-domains-2026-10-28.zip domain-names.txt > whoisds.txt` and by
`gzip -dc domaindata.2026-10-28.json.gz | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).map(r=>r.domainname).join("\n")))' > isc.txt`
(SHA-256 `4c8f5bae…` and `6bca0a0a…`, each exit 0, 2026-10-29T14:35:02Z and
14:35:19Z). ISC's own `firstseen` is `2026-10-28` on all 343,215 rows of that
file (MEASURED 2026-10-29T14:35:19Z, the same `gzip -dc` piped to a `node -e`
that counts the rows by `firstseen`), so `--day-share 1`, every row at the
start of its day from a day source, is the shape ISC's own day gives. WhoisDS
is a day source too (precision `day` in `docs/sources.md`).

| List | Rows | Day share | Key copy, bytes a row | Time copy, bytes a row | Time to key | One page | Files |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WhoisDS 2026-10-28 | 69,798 distinct of 70,000 lines | 0.4 | 9.311 (18 blocks) | 9.86 (18 blocks) | 1.059 | desc 2, asc 1 blocks | `whoisds-desc.json`, `whoisds-asc.json` |
| WhoisDS 2026-10-28 | 69,798 | 1 | 7.185 | 7.071 | 0.984 | desc 2 blocks | `whoisds-day-desc.json` |
| ISC 2026-10-28 | 343,215 | 0.4 | 8.266 (84 blocks) | 8.744 (84 blocks) | 1.058 | desc 1, asc 1 blocks | `isc-desc.json`, `isc-asc.json` |
| ISC 2026-10-28 | 343,215 | 1, ISC's own shape | 6.115 | 6.007 | 0.982 | desc 1 block | `isc-day-desc.json` |
| ISC 2026-10-28 | 343,215 | 0, every row at a second | 9.051 | 9.99 | 1.104 | desc 1 block | `isc-second-desc.json` |

The time copy's bytes depend on how many rows share one second: rows of one
second sit in key order in the time copy too, and front code as the key copy
does, while rows spread over the seconds of the day do not. Over these runs
the time copy is 0.982 to 1.104 of the key copy's bytes, so a pack with both is
1.982 to 2.104 times the key copy alone. These are bytes a row of a day pack
of the sizes measured; the rows a day of `feed` and `new-name` are not
measured.

## 15. The provisional filter, DLBF, and its delta, DLBD

The hourly job asks one question of each registrable domain it meets: did any
source see it before? The `domains` packs answer exactly, and the daily job
asks them (`exactNew` of `packages/ledger`). The hourly job asks two smaller
objects instead: a Bloom filter of every domain of the table, `DLBF`, and an
exact sorted set of the hashes of the domains first seen since the filter
was built, `DLBD`. Neither is a pack. The reference code is
`packages/ledger/src/filter.ts`; its reader runs in Node and in workerd.

| Object | Tag of the package `state` | File and layer title | Written by |
| --- | --- | --- | --- |
| The filter | `ledger-filter-YYYYMMDD`, write-once: the table through the end of that day | `filter.dlbf` | `scripts/compact/day.mjs` |
| The delta | `ledger-delta`, which moves under the `state` guard (section 17.2) to a write-once run tag `ledger-delta-YYYYMMDDtHHMMSSz` | `delta.dlbd` | `scripts/compact/hour.mjs` (each hour's new domains added), and `scripts/state/move.mjs` and `scripts/state/hours.mjs` (the live delta rebased onto a newer filter) |

The scripts of `scripts/compact/` write the files and print the tags, and
push nothing. Two workflows push them, each from a job in the group
`root-writer` (READ `.github/workflows/compact-daily.yml` and
`.github/workflows/ingest-live.yml`, the job `push` of each):

- The step "Push the ledger filters" of the job `push` of
  `compact-daily.yml` pushes each day's `state:ledger-filter-YYYYMMDD` once,
  through `scripts/ghcr/push.mjs`. The artifact type is
  `application/vnd.pkgforge.domains.state.v1`, the one layer is
  `filter.dlbf`, `created` is the end of the day, and the annotations are
  `dev.pkgforge.domains.sha256` and `dev.pkgforge.domains.run`.
- The step skips the filter of a day whose `domains` unit the run planned
  and whose leg of `assemble` wrote no replacement: a filter is written
  once, and one built beside a pack that failed its checks would never be
  replaced.
- The next step, "Move ledger-delta", runs
  `scripts/state/move.mjs ledger-delta --onto` the newest filter that the
  step before pushed or found present. It reads the live delta inside
  `root-writer` and rebases it onto that filter (`HashDelta.rebase`), so the
  hours that `ingest-live.yml` added to the delta after the day leg read it
  stay in it. With no live delta, it moves the empty delta of the filter. A
  live delta that pairs with the filter already is left as it is
  (`present`), and one that pairs with a newer filter refuses the move. The
  `delta.dlbd` that `scripts/compact/day.mjs` writes is not pushed.
- The step "Build the closed hours" of the job `push` of `ingest-live.yml`
  runs `scripts/state/hours.mjs`. For each closed hour that it builds, oldest
  first, it runs `scripts/compact/hour.mjs` on the newest filter and the live
  delta, pushes `feed:feed-h-HOUR`, and then moves `ledger-delta` to the
  delta that `hour.mjs` wrote, under the guard, against the delta digest
  that the hour read. A delta moved first would hold the hour's own domains,
  and a re-run would then write an empty pack under the hour's write-once
  tag. A live delta that is absent, or that pairs with an older filter, is
  healed first: the empty delta of the newest filter, or the live delta
  rebased onto it. With no `ledger-filter-` tag, no hour is built.
- When an hour's pack is `present`, `hour.mjs` writes no delta, and the delta
  does not move. If the run that pushed the pack failed before its delta
  moved, later hours judge that hour's domains new again, until the day's
  exact join corrects the rows of the day (the verdicts are `provisional`,
  `docs/architecture.md` section 5.8 step 5).
- Each move of `ledger-delta` first pushes the delta under its run tag: the
  artifact type `application/vnd.pkgforge.domains.state.v1`, the one layer
  `delta.dlbd` (`application/octet-stream`), `created` the time of the move,
  and the annotations `dev.pkgforge.domains.sha256` (of the file),
  `dev.pkgforge.domains.run` and `dev.pkgforge.domains.filter` (the
  `ledger-filter-YYYYMMDD` tag of the filter it pairs with, the day whose
  end is the filter's `as_of`).

### 15.1 The hash

Both objects store a 64-bit hash of a key, never the key. The key is a
reversed registrable domain (section 1), as bytes. The hash is the first 8
bytes of MurmurHash3_x86_128 of the key with seed 0, read as a little-endian
`u64`: `lo` is the first output word, `hi` the second, and the value is
`hi * 2^32 + lo` (`hashKey` of `packages/ledger/src/hash.ts`). A test of
`packages/ledger` holds the function to SMHasher's verification value
`0xB3ECE62A`. Both headers name the hash by its id, `1`. A reader refuses
another id, because a filter of one hash answers wrongly for another.

### 15.2 The filter

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 4 | magic | `DLBF`: `44 4c 42 46` |
| 4 | 1 | version | `1` |
| 5 | 1 | hash id | `1` (section 15.1) |
| 6 | 1 | `k` | the hashes, and the partitions: 1 to 32 |
| 7 | 1 | reserved | zero |
| 8 | 4 | `P` | `u32`, the bits of one partition: a multiple of 64, at least 64 |
| 12 | 8 | keys | `u64`, the number of adds, at most 2^53 - 1 |
| 20 | 8 | `as_of` | `u64`, seconds since 2026-01-01T00:00:00Z: the time through which the table the filter was built from is complete |
| 28 | 4 | bits CRC | the CRC-32 (section 1) of the bits |
| 32 | 4 | header CRC | the CRC-32 of bytes 0 to 31 |
| 36 | `k * P / 8` | bits | the partitions, back to back |

Bit `b` of partition `i` is bit `b & 7` of byte `i * P / 8 + (b >>> 3)` of
the bits. A key of hash `(hi, lo)` sets one bit in each partition: bit
`(lo + i * hi) mod P` of partition `i`, for `i` from 0 to `k - 1`. The filter
holds a key when every one of those `k` bits is set. It has no false
negative. Its false positives are about `(1 - e^(-n/P))^k` for `n` keys. The
writer of `packages/ledger` takes 10 bits a key and 7 hashes, so
`P = max(64, ceil(10 * n / 7 / 64) * 64)` for `n` expected keys, and the rate
is about 0.82%. MEASURED by DOM-021: 8,279 false positives in 1,000,000
absent keys, and 12,500,076 B for 10,000,000 keys
(`docs/research/measure/DOM-021/bench-10M.json`, 2026-10-29T01:01:23Z).

### 15.3 The delta

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 4 | magic | `DLBD`: `44 4c 42 44` |
| 4 | 1 | version | `1` |
| 5 | 1 | hash id | `1` (section 15.1) |
| 6 | 2 | reserved | zero |
| 8 | 4 | `n` | `u32`, the hashes |
| 12 | 8 | filter `as_of` | `u64`, the `as_of` of the filter the delta pairs with |
| 20 | 4 | filter bits CRC | the bits CRC of that filter |
| 24 | 4 | hashes CRC | the CRC-32 of the hashes |
| 28 | 4 | header CRC | the CRC-32 of bytes 0 to 27 |
| 32 | `8 * n` | hashes | each a `u64` of section 15.1, ascending by value, none twice |

The delta is exact: it holds a hash or it does not. It names the filter it
pairs with by that filter's `as_of` and bits CRC. `ProvisionalFilter` of
`packages/ledger` holds a domain when the filter or the delta holds it, and
refuses a delta that names another filter (`LedgerError` `pair`): a delta of
an older filter lacks the domains the newer filter's table gained, and a
delta of a newer one lacks those first seen between the two.

### 15.4 The daily rebuild

The daily job builds a new filter from every `domains` pack through the end
of its day, with `as_of` that end. It does not empty the delta. It rebases
it: the new delta pairs with the new filter and keeps each hash the new
filter does not hold (`HashDelta.rebase`). Those are the domains the hour jobs
saw after the day ended. A hash the new filter holds leaves the delta: the
table holds its domain, or the hash is a false positive of the new filter,
which the filter answers the same way. `scripts/compact/day.mjs` holds the
live delta to the live filter before it reads a pack, refuses a live filter
whose `as_of` is after the end of its day, and writes nothing when that
`as_of` is the end of its day.

### 15.5 What a reader checks

`BloomFilter.decode` and `HashDelta.decode` of `packages/ledger` refuse,
with `LedgerError`:

| Code | Check |
| --- | --- |
| `format` | Fewer bytes than the header, a magic, version or hash id it does not know, a reserved byte that is not zero, `k` outside 1 to 32, a `P` that is not a multiple of 64 of at least 64, a `u64` above 2^53 - 1, a length other than the header gives, or delta hashes that do not ascend. Each length is compared before anything is allocated. |
| `crc` | The header CRC or the CRC of the bits or the hashes does not match. |
| `pair` | A delta given with a filter it does not name. |

`scripts/compact/hour.mjs` also refuses a filter whose `as_of` is after the
start of its hour (`CompactError` `plan`): that filter holds the hour's own
domains and would judge every one of them old.

### 15.6 A worked example

One filter of one key, `com.example`, as of 2026-10-27T00:00:00Z (`as_of`
25,833,600), and a delta of one key, `com.fresh-synthetic`, paired with it.
Both keys are synthetic. MEASURED 2026-10-29T22:24:11Z and 22:24:22Z, Node
v26.7.0: `BloomFilter.forKeys(1, { asOf: 25833600 })`, one `add` of
`hashKey("com.example")`, and `encode`; `HashDelta.empty` of that filter, one
`add` of `hashKey("com.fresh-synthetic")`, and `encode`, each through
`node --input-type=module -e` with an import of `@domains/ledger`. The hash of
`com.example` is `441c49c88c09f832`, so `lo` is `0x8c09f832` and `hi` is
`0x441c49c8`. With `P` 64 and `k` 7 the bits are 50, 58, 2, 10, 18, 26 and 34
of the partitions 0 to 6. The filter is 92 bytes:

```text
444c4246 01 01 07 00 40000000 0100000000000000 80308a0100000000 12084740 3a54dabe
0000000000000400 0000000000000004 0400000000000000 0004000000000000
0000040000000000 0000000400000000 0000000004000000
```

The delta is 40 bytes. Its one hash is `df22c50638d2143e`, and its filter
fields repeat the filter's `as_of` and bits CRC:

```text
444c4244 01 01 0000 01000000 80308a0100000000 12084740 8aea82ab 09a2fe31
3e14d23806c522df
```

The spaces split the fields of sections 15.2 and 15.3. The file holds none.

## 16. The day summary, `summary.json`

A day pack of `feed` carries one more layer, `summary.json`, of media type
`application/json` (`docs/architecture.md` section 4.2). It counts the rows of
the pack by suffix and by source, so `GET /v1/suffixes` of DOM-033 sums the
layers of a window's days and reads no block. `SummaryCounter` of
`packages/compact/src/daily.ts` writes it, and `scripts/compact/day.mjs` adds
it to the manifest after the pack's own layers, as an `extra` layer of
`packManifest` (`packages/compact/src/manifest.ts`), which refuses a title of
the pack's own layers and a title given twice. A reader of the pack ignores
it (section 2).

```json
{"format":"domains.feed-summary.v1","day":"2026-10-27","rows":5,"suffixes":{"com":{"new_registrable":3,"suspect":0,"by_source":{"isc-new":1,"oi-nrd":1,"thc-ct":1}},"com.np":{"new_registrable":1,"suspect":0,"by_source":{"oi-nrd":1,"thc-ct":1}},"net":{"new_registrable":1,"suspect":1,"by_source":{"oi-nrd":1}}}}
```

| Field | Meaning |
| --- | --- |
| `format` | `domains.feed-summary.v1`. A reader refuses a format it does not know. |
| `day` | The day of the pack, `YYYY-MM-DD`. |
| `rows` | The rows of the pack: the sum of `new_registrable` over the suffixes. |
| `suffixes` | One entry for each ICANN public suffix that a row of the pack is under, by its name (`com.np`). |
| `new_registrable` | The rows under the suffix. A row is one registrable domain, new on the day by the exact join. |
| `suspect` | The rows under the suffix whose `feed_flags` hold `suspect` (section 5.4). The default feed hides them. |
| `by_source` | For each source id, the rows under the suffix that carry its bit. A row of two sources counts once under each. |

The suffix of a row is its registrable domain less the first label: the key
less its last label, as a name. `np.com.example` is `example.com.np`, under
`com.np`. No list is read, because the key of a `feed` row is a registrable
domain under the PSL of the pack. Every object holds its keys in ascending
order, and the layer is compact JSON with one final newline, so one day gives
one byte string. The example above is the summary of the test
`daily: the day pack holds the domains the exact join keeps with since` of
`packages/compact/test/daily.test.ts`, whose keys and sources are synthetic.

## 17. The state, `state.json`

`state:latest` holds the state of the ingest: the cursor of each adapter, the
volume history of each source, and the packs that the state owes to the root
(`docs/architecture.md` section 5.4). Neither it nor its file is a pack. The
reference code is `packages/state` (`@domains/state`): `validateState`,
`parseState` and `encodeState` hold the rules below, and `advance`, `settle`
and `guard` move the state. It imports nothing from `node:` and is type-checked as Worker code; no test runs it in workerd.

The file is canonical JSON (`canonicalJson` of `@domains/adapter`: the keys
of every object sorted, no space) with one final newline. It is at most
1 MiB (`STATE_MAX_BYTES`), and a reader compares the size before it parses.
An example, with the lines broken and the keys in the order of the table
below for reading, and with synthetic values:

```json
{
  "format": "domains.state.v1",
  "updated": "2026-10-30T08:30:12Z",
  "cursors": { "oi-cs": { "through": "2026-10-30T08:10:00Z" } },
  "moved": { "oi-cs": { "at": "2026-10-30T08:30:12Z", "run": "40000000001" } },
  "history": { "isc-new": [ { "day": "2026-10-29", "count": 1203, "quarantined": false } ] },
  "owed": [
    { "ref": "obs:oi-cs.20261030t080000z.20261030t081000z-d", "digest": "sha256:<64 hex>", "dataset": "domains",
      "tier": "seg", "start": "2026-10-30T08:00:00Z", "end": "2026-10-30T08:10:00Z", "since": "2026-10-30T08:30:12Z" }
  ]
}
```

| Field | Value |
| --- | --- |
| `format` | `domains.state.v1`. A reader refuses another format. |
| `updated` | The time of the last change, ISO 8601 UTC to the second. A move that changes nothing keeps it. |
| `cursors` | One cursor for each adapter, keyed by the adapter's directory name (`ID_GRAMMAR` of `@domains/adapter`, at most 63 characters). A cursor is any JSON value of at most 4 KiB (`checkCursor` of `@domains/adapter`). Its shape belongs to the adapter. A cursor that a segment carries, in its annotations `cursor.before` and `cursor.after`, is at most 1024 characters of canonical JSON with no control character (`annotationProblem` of `@domains/ghcr`, `ANNOTATION_MAX_CHARS`): the writer of `scripts/ingest/run.mjs` refuses another, and `run.mjs` refuses such a cursor returned by a live run before it proposes it. |
| `moved` | Exactly the keys of `cursors`, each `{ at, run }`: the time and the run of the last proposal accepted for the adapter, a backfill's among them, which keeps the cursor. `run` is a workflow run id, digits with no leading zero and at most 20 of them (`WORKFLOW_RUN_ID` of `@domains/ghcr`), or `local`. |
| `history` | For each source id, the volume of its verified days: `{ day, count, quarantined }`, sorted by day, each day once (`checkHistory` of `@domains/adapter`), the newest 90 kept (`HISTORY_DAYS`). `count` is in the metric of the source's band. A day verified again replaces its item. A source of `day` precision writes one item for each verified day of one whole UTC day: the names segment's when the day has one, else the domains segment's, its `quarantined` that segment's verdict. A source of `second` precision writes none. `scripts/verify-pack.mjs --history` reads one source's list for the volume check (`docs/architecture.md` section 5.8 step 3). |
| `owed` | The packs that the state is past and the root does not hold yet: `{ ref, digest, dataset, tier, start, end, since }`, sorted by `start`, then `ref`, each `ref` once. `ref` is `obs:TAG` (tier `seg`, dataset `names` or `domains`) or `feed:TAG` (tier `h`, dataset `feed`). `digest` is `sha256:` and 64 hex digits. `start` is before `end`. `since` is the time the pack became owed. A quarantined segment is never owed. Before a state moves, `settle` drops each owed pack that the live root names, covers or withdrew, and each owed more than 7 days (`OWED_DAYS`): `expired`. |

`validateState` refuses a break of these rules with `StateError`: the code
`format` for another format, and `schema` for a missing or extra key or a
value out of its rule. `parseState` first refuses a file over the limit with
`size`, before it parses, and bytes that are not UTF-8 JSON with `format`;
`encodeState` refuses a state whose file would pass the limit with `size`.

The limit bounds `owed`: an owed domains segment of a stream source takes
262 bytes, and a state with nothing else holds at most 3,986 of them
(MEASURED 2026-10-30T16:32:56Z: `encodeState` over synthetic owed segments
of oi-cs, 1,048,427 bytes at 3,986). One stream source of a 10-minute
window that writes names and domains owes 288 segments a day, so two such
sources whose promotion fails for 7 days pass the limit before `expired`
drops their oldest. `scripts/state/advance.mjs` then exits 1 and names the packs owed
and the oldest `since`; nothing is written, and the cursors stay where they
are until the root takes owed packs or they expire. No bound below the
limit is set: that is an open item of DOM-024.

### 17.1 The manifests and the tags

A state is pushed under its write-once run tag `state-YYYYMMDDtHHMMSSz`,
whose time is its `updated` (`stateRunTag` of `packages/ghcr`). The artifact type is
`application/vnd.pkgforge.domains.state.v1`, the one layer is `state.json`
(`application/json`), `created` is `updated`, and the annotations are
`dev.pkgforge.domains.sha256` (the SHA-256 of the file) and
`dev.pkgforge.domains.run`. `state:latest` then moves to that manifest. A
re-run of a move writes a new run tag, which is harmless: the guard decides.

The snapshot `state-YYYYMMDD` is the first state moved in each UTC day of
its `updated`. `scripts/state/move.mjs` tags it with `oras tag` when the tag
is absent, and never again. A day with no move has no snapshot. Every state
stays under its run tag, so the snapshot is a name for a restore point, not
the only copy.

### 17.2 The guard

`state:latest` and `state:ledger-delta` move only through `moveTag` of
`scripts/state/lib.mjs`, in a job of the group `root-writer`. It reads the
tag with the job's token and compares its digest with the one that the run
read (`guard` of `packages/state`). It pushes the new object under its run
tag with `scripts/ghcr/push.mjs`, reads the tag again and compares again,
then moves the tag with `oras tag`. Last, it reads the tag back with no
credential: its digest is the one pushed, and its layer hashes to the file.
A digest that changed refuses the move, exit 1, with the line:

```text
refused state:TAG holds X, and this run read Y: another writer moved it. The live one is kept
```

A state that is equal to the live one in everything but `updated`
(`sameState`) is `unchanged`, and nothing is written.

## 18. The raw lane object, and `members.json`

A source that streams (Kafka, names tiles) keeps the bytes it read in the
raw lane of the package `obs` (`docs/architecture.md` section 3.4): one
object for each source and window in a run, pushed before the segment that
names it in its annotation `dev.pkgforge.domains.raw`. A source that fetches
a file keeps the file in its segment's own layer `raw` instead, at most
1 GiB.

| Part | Value |
| --- | --- |
| Tag | `raw-<source>.<start>.<end>` (`rawTag` of `packages/ghcr`), the window's times as `YYYYMMDDtHHMMSSz` |
| Artifact type | `application/vnd.pkgforge.domains.raw.v1` |
| Layers | `raw.000`, `raw.001` and up (`application/octet-stream`): the bytes as received, concatenated in member order, each layer at most 1 GiB; then `members.json` (`application/json`) |
| Annotations | under `dev.pkgforge.domains.`: `source`, `span.start`, `span.end`, `bytes` (all the raw bytes), `sha256` (the hex SHA-256 of all the raw bytes in member order), `members` (their count), `adapter`, `parser`, `url`, `fetched` and `run`. `created` is the end of the window. |

A second push of one window finds the object `present` by the same
`sha256`, artifact type and layers (section 8), and names the digest that
the tag holds.

`members.json` is one JSON object, canonical JSON with its keys sorted as
in section 17, and one final newline. An example, the file's bytes, with
synthetic values:

```json
{"end":"2026-10-30T08:10:00Z","format":"domains.raw-members.v1","members":[{"length":77594624,"offset":0,"sha256":"<64 hex>"}],"source":"oi-cs","start":"2026-10-30T08:00:00Z"}
```

| Field | Value |
| --- | --- |
| `format` | `domains.raw-members.v1`. A reader refuses another format. |
| `source`, `start`, `end` | The source and the window, as the annotations name them. |
| `members` | One item for each member, in offset order: `offset` into the concatenation of `raw.000` and up, `length`, and `sha256`, the hex SHA-256 of the member's bytes. The members are contiguous and cover every byte. |

A reader ignores a field of a member that it does not know. The stream
adapters add the fields of their source: a Kafka topic, partition and
offsets, or a tile's log and number. The writer contract of
`packages/adapter` carries no such field yet, so `members.json` holds one
member for each source and window: the window's bytes as the adapter gave
them. A second raw input of the window must be the same bytes, and adds no
member.
