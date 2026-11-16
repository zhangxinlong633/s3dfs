# Benchmarks

Numbers below were measured on 16 Nov 2026, 12:33 (Asia/Shanghai) with Bun 1.4.2 (node-compat v26.3.0), on a MacBook Pro (Apple M5 Pro, 15 cores, 48 GB, Apple SSD AP1024Z, macOS arm64). They describe the current tree: locators in dleveldb, TLV block records, and optional control-plane compression. They are single-host results, not a multi-machine network test.

N is the object-body replica count. N=1 is one dleveldb process plus one block process. N=3 is one index plus three block processes on the same machine, talking over HTTP on localhost. `direct block` calls the block HTTP API only and does not go through the index.

Bandwidth is **logical** MiB/s: uncompressed object size divided by elapsed time, with 1 MiB = 1,048,576 bytes. On a highly compressible object the logical write rate is much higher than the bytes actually written to disk. Compression ratio is logical size / stored size (larger means more compact). The repeated payload is filled with `0x61` bytes and is a best-case pattern. The random payload is `crypto.randomBytes`. If compression does not shrink the value, the body is stored as-is and the locator records `compressType=none`. Default `S3DFS_COMPRESS` is `zstd`; the HTTP throughput table below forces `none` so it is not mixed with the default path.

Most cases run 5,000 operations after 500 warmup operations. The 16 KiB cases run 2,000 operations. The 1 MiB cases run 80 operations after 8 warmup operations. Latency percentiles come from the same sequential run, or from the named concurrent run. The “32 in flight” rows pipeline 32 concurrent requests and still report latency, but throughput is the number to compare.

Reproduce:

```bash
pnpm --filter @s3dfs/engine build
pnpm --filter @s3dfs/control build
pnpm bench
# or: bun scripts/bench-split.mjs
```

The script starts a fresh temporary index and block process for each cluster setup. The raw result is in [bench-2026-11-16-tlv.json](bench-2026-11-16-tlv.json). The same summary tables are also in the [English README](../README.md) and the [Chinese README](../README.zh-CN.md).

Do not mix these numbers with the in-process KV benches in the dleveldb repository. That path is pure KV. This one is an object-store HTTP index + block path.

## HTTP throughput, compress=none

| Workload | Operations | Throughput | Bandwidth | p50 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| direct block put 1 KiB (no index) | 5,000 | 18,716 ops/s | 18.3 MiB/s | 49 µs | 96 µs |
| direct block get 1 KiB (no index) | 5,000 | 19,334 ops/s | 18.9 MiB/s | 50 µs | 77 µs |
| cluster put 100 B, N=1 | 5,000 | 6,938 ops/s | 0.7 MiB/s | 137 µs | 231 µs |
| cluster get 100 B, N=1 | 5,000 | 8,816 ops/s | 0.8 MiB/s | 109 µs | 194 µs |
| cluster put 1 KiB, N=1 | 5,000 | 6,795 ops/s | 6.6 MiB/s | 138 µs | 341 µs |
| cluster get 1 KiB, N=1 | 5,000 | 8,708 ops/s | 8.5 MiB/s | 110 µs | 179 µs |
| cluster put 16 KiB, N=1 | 2,000 | 4,663 ops/s | 72.9 MiB/s | 199 µs | 566 µs |
| cluster get 16 KiB, N=1 | 2,000 | 6,507 ops/s | 101.7 MiB/s | 144 µs | 348 µs |
| cluster put 1 KiB, N=1, 32 in flight | 5,000 | 31,157 ops/s | 30.4 MiB/s | 950 µs | 2,620 µs |
| cluster get 1 KiB, N=1, 32 in flight | 5,000 | 49,001 ops/s | 47.9 MiB/s | 578 µs | 1,637 µs |
| cluster put 1 KiB, N=3 | 5,000 | 2,775 ops/s | 2.7 MiB/s | 337 µs | 760 µs |
| cluster get 1 KiB, N=3 | 5,000 | 4,119 ops/s | 4.0 MiB/s | 232 µs | 545 µs |
| cluster put 1 KiB, N=3, 32 in flight | 5,000 | 11,225 ops/s | 11.0 MiB/s | 2,742 µs | 4,633 µs |

A cluster put writes the block first, then the locator in dleveldb. At N=3 the put must succeed on three block processes, so it is slower than N=1.

## Compression, cluster N=1

End-to-end put and get through the control plane, one index process and one block process. “Stored type” is the type recorded on the locator, which can fall back to `none`.

| Workload | Stored type | Stored / logical | Ratio | Space saved | Write | Read | Write p50 / p99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 KiB repeated, none | none | 1,024 / 1,024 B | 1.00x | 0.00% | 6,716 ops/s, 6.6 MiB/s | 8,823 ops/s, 8.6 MiB/s | 138 µs / 372 µs |
| 1 KiB repeated, zstd | zstd | 19 / 1,024 B | 53.89x | 98.14% | 6,680 ops/s, 6.5 MiB/s | 8,363 ops/s, 8.2 MiB/s | 138 µs / 349 µs |
| 1 KiB repeated, gzip | gzip | 30 / 1,024 B | 34.13x | 97.07% | 6,682 ops/s, 6.5 MiB/s | 8,520 ops/s, 8.3 MiB/s | 140 µs / 294 µs |
| 1 KiB random, zstd | none | 1,024 / 1,024 B | 1.00x | 0.00% | 6,485 ops/s, 6.3 MiB/s | 8,770 ops/s, 8.6 MiB/s | 142 µs / 512 µs |
| 1 KiB random, gzip | none | 1,024 / 1,024 B | 1.00x | 0.00% | 6,172 ops/s, 6.0 MiB/s | 8,947 ops/s, 8.7 MiB/s | 151 µs / 371 µs |
| 16 KiB repeated, none | none | 16,384 / 16,384 B | 1.00x | 0.00% | 4,747 ops/s, 74.2 MiB/s | 6,600 ops/s, 103.1 MiB/s | 197 µs / 535 µs |
| 16 KiB repeated, zstd | zstd | 19 / 16,384 B | 862.32x | 99.88% | 6,777 ops/s, 105.9 MiB/s | 7,691 ops/s, 120.2 MiB/s | 138 µs / 370 µs |
| 16 KiB random, zstd | none | 16,384 / 16,384 B | 1.00x | 0.00% | 4,423 ops/s, 69.1 MiB/s | 6,678 ops/s, 104.3 MiB/s | 206 µs / 648 µs |
| 1 MiB repeated, none | none | 1,048,576 / 1,048,576 B | 1.00x | 0.00% | 225 ops/s, 225.2 MiB/s | 419 ops/s, 419.1 MiB/s | 4,305 µs / 6,689 µs |
| 1 MiB repeated, zstd | zstd | 50 / 1,048,576 B | 20,971.52x | 99.995% | 2,319 ops/s, 2,319.4 MiB/s | 2,159 ops/s, 2,159.1 MiB/s | 409 µs / 1,204 µs |
| 1 MiB random, zstd | none | 1,048,576 / 1,048,576 B | 1.00x | 0.00% | 209 ops/s, 208.5 MiB/s | 417 ops/s, 416.9 MiB/s | 4,683 µs / 6,572 µs |

Small objects are still limited by HTTP and index operations, so zstd does not change 1 KiB ops/s much even when the payload shrinks. At 16 KiB and 1 MiB, a highly compressible body improves both ops/s and logical MiB/s because the stored record is tiny. Incompressible bodies stay close to the `none` baseline.

## In-process codec

Control-plane compress / decompress only: no HTTP, no disk. Decompress is omitted when the type falls back to `none`, because that path is a no-op.

| Workload | Applied | Stored / logical | Ratio | Compress | Decompress |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 MiB repeated, zstd | zstd | 50 / 1,048,576 B | 20,971.52x | 8,414 MiB/s | 5,407 MiB/s |
| 1 MiB repeated, gzip | gzip | 1,052 / 1,048,576 B | 996.75x | 4,100 MiB/s | 4,059 MiB/s |
| 1 MiB random, zstd | none | 1,048,576 / 1,048,576 B | 1.00x | 3,589 MiB/s | — |
| 1 MiB random, gzip | none | 1,048,576 / 1,048,576 B | 1.00x | 98 MiB/s | — |
| 16 KiB repeated, zstd | zstd | 19 / 16,384 B | 862.32x | 3,522 MiB/s | 2,279 MiB/s |
| 16 KiB random, zstd | none | 16,384 / 16,384 B | 1.00x | 1,328 MiB/s | — |

The gzip attempt on incompressible 1 MiB data is slower than zstd (98 MiB/s vs 3,589 MiB/s) because gzip spends more work before giving up. Both correctly fall back to `none`.

## On-disk layout

The same machine, opening the C engine directly (no HTTP). 5,000 objects of 1 KiB were written in order and flushed. There is no `index/` directory; locators belong in dleveldb. Inode and file count follow the block file, not the object count.

| Case | Files | On disk | Logical | Stored payload | On-disk ratio | flush / fsync |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw repeated (no compression) | 1 × `blocks/00000000000000000001.blk` | 5,463,890 B | 5,120,000 B | 5,120,000 B | 0.94x | 6 |
| zstd repeated (19 B payload each) | 1 × `blocks/00000000000000000001.blk` | 438,890 B | 5,120,000 B | 95,000 B | 11.67x | 1 |
| zstd random (fell back to `none`) | 1 × `blocks/00000000000000000001.blk` | 5,463,890 B | 5,120,000 B | 5,120,000 B | 0.94x | 6 |

The zstd on-disk ratio (11.67x) is lower than the payload ratio (53.89x) because each record still carries TLV tags, lengths, and a CRC. This run was not an IOPS bake-off against RustFS on the same data set. Object-replica auto-repair / migration, and compaction that reclaims deleted space, are not implemented.

## Earlier design (16 Nov 2026, 11:46 Asia/Shanghai)

The table below is a historical measurement of the previous design: each block process still had a local LevelDB, records used a fixed `^` / `$` header rather than TLV, and objects were not compressed. Do not treat these numbers as the current tree. The raw file is [bench-2026-11-16.json](bench-2026-11-16.json). Same machine and Bun version as above.

| Workload | Operations | Throughput | p50 | p99 |
| --- | ---: | ---: | ---: | ---: |
| direct block put 1 KiB (no index) | 5,000 | 15,967 ops/s | 48 µs | 92 µs |
| direct block get 1 KiB (no index) | 5,000 | 22,297 ops/s | 44 µs | 67 µs |
| cluster put 100 B, N=1 | 5,000 | 5,722 ops/s | 138 µs | 670 µs |
| cluster get 100 B, N=1 | 5,000 | 9,322 ops/s | 104 µs | 169 µs |
| cluster put 1 KiB, N=1 | 5,000 | 5,710 ops/s | 136 µs | 796 µs |
| cluster get 1 KiB, N=1 | 5,000 | 9,421 ops/s | 103 µs | 164 µs |
| cluster put 16 KiB, N=1 | 2,000 | 3,817 ops/s | 167 µs | 3,493 µs |
| cluster get 16 KiB, N=1 | 2,000 | 8,789 ops/s | 106 µs | 399 µs |
| cluster put 1 KiB, N=1, 32 in flight | 5,000 | 27,596 ops/s | 900 µs | 4,953 µs |
| cluster get 1 KiB, N=1, 32 in flight | 5,000 | 53,618 ops/s | 521 µs | 1,781 µs |
| cluster put 1 KiB, N=3 | 5,000 | 1,414 ops/s | 358 µs | 3,939 µs |
| cluster get 1 KiB, N=3 | 5,000 | 4,377 ops/s | 220 µs | 367 µs |
| cluster put 1 KiB, N=3, 32 in flight | 5,000 | 6,301 ops/s | 5,261 µs | 10,397 µs |

A separate layout check of that older engine, writing 5,000 × 1 KiB objects and flushing, left 6 files in the data directory: one packed block (`blocks/00000000000000000001.blk`, 5,323,890 bytes) plus 5 LevelDB files. Logical size was 5,120,000 bytes, with 7 flush / fsync calls.
