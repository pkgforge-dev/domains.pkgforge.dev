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
| other titles | Optional layers (`txt.gz`, `tidx`, `summary.json`). A reader that does not know a layer ignores it. |

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
| 5 | 1 | dataset | `1` names, `2` domains, `3` feed, `4` reverse IP, `5` new-name |
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
bytes are 16,580,355 bytes.

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

A record of the datasets `names`, `domains`, `feed` and `new-name` starts with
its key:

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
| 4 to 7 | reserved: the writer writes zero, and a reader keeps what it reads |

A `feed` or `new-name` pack holds one record a key. `first_seen` is a field of
the record, not part of the key. The order of the rows by `first_seen` is the
optional layer `tidx`, which DOM-022 defines.

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
| the index key | the key of the first record of the block, for the datasets 1, 2, 3 and 5 |
| part | `u16` |
| offset of the block in its part | `u64` |
| compressed length | `u32`, 1 to `raw + floor(raw / 8) + 1,024` (section 4) |
| raw length | `u32`, 1 to 16,777,216 |
| records | `u16`: `records a block`, except for the last block of the pack |
| CRC-32 of the raw block | `u32` |

Index keys never descend. For the datasets 1, 2, 3 and 5 they ascend, because the
index key of a block is the key of its first record.

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
one `--annotation`. The one workflow that calls the push tool,
`ref-refresh.yml`, pushes reference files, not packs, so no caller passes them
yet.

| Annotation | Value |
| --- | --- |
| `dev.pkgforge.domains.dataset` | the dataset name: `names`, `domains`, `feed`, `rev` or `new-name` |
| `dev.pkgforge.domains.count` | the records |
| `dev.pkgforge.domains.bytes` | the bytes of all parts and the index |
| `dev.pkgforge.domains.sha256` | the SHA-256 of the raw blocks, concatenated in order |
| `dev.pkgforge.domains.writer` | the Node version and the zlib version of the writer |

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
