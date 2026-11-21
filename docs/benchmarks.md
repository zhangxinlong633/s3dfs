# Benchmarks

| | |
| --- | --- |
| 读者 | 需要复现或引用本机数字的人 |
| 测量 | 2026-11-17 00:40（Asia/Shanghai），Bun 1.4.2，MacBook Pro（Apple M5 Pro，15 核，48 GB，Apple SSD AP1024Z） |
| 范围 | 单机 localhost。N=3 是同一台机器上的三个 block 进程，不是多机网络 |
| 效力 | 选型时的形状说明，不是容量承诺。上线容量以目标集群的测量为准 |

数字对应当时的代码：locator 使用稳定的 `recId`（`v: 3`），记录为 TLV，控制面可压缩，空闲或手动 compact 可回收删除空间。本次关闭了后台 compact（`S3DFS_COMPACT_INTERVAL_MS=0`）。README 只保留规划用的摘要表，完整表格在本文。

N 是对象正文副本数。N=1 是一台 dleveldb 加一台 block。带宽是**逻辑** MiB/s（未压缩对象大小 / 时间，1 MiB = 1,048,576 字节）。压缩比是逻辑大小 / 存储大小。重复内容是全部 `0x61` 的字节，属于最好情况；随机内容是密码学随机数。压不小则 locator 记 `compressType=none`。下文 HTTP 表强制 `none`，避免和默认 zstd 混在一起。

多数用例在 500 次预热后测 5,000 次。16 KiB 测 2,000 次。1 MiB 在 8 次预热后测 80 次。「32 in flight」是 32 个并发请求。

复现：

```bash
pnpm --filter @s3dfs/engine build
pnpm --filter @s3dfs/control build
S3DFS_COMPACT_INTERVAL_MS=0 pnpm bench
# or: S3DFS_COMPACT_INTERVAL_MS=0 bun scripts/bench-split.mjs
```

原始结果在 [bench-2026-11-17.json](bench-2026-11-17.json)。这些数字不要和 dleveldb 仓库里的进程内 KV 基准混比。


## 规划摘要

这些数字是选型时的起点，不是服务承诺。它们来自一台 MacBook Pro 上的一次 localhost 测试。换机器、走真实网络或多机部署，绝对值都会变。产品比较请看集群路径（API + 索引 + block），不要看不经索引、直接打到 block 的那一行。

表与表之间混了不同对象大小、副本数、串行和流水线，以及专门用来看压缩上限的重复内容，不能加成一个「平均 ops/s」。这台机器上比较有代表性的规划数字如下。

| Planning case | Write | Read | What it represents |
| --- | ---: | ---: | --- |
| 1 KiB, N=1, sequential, `none` | 6,937 ops/s, 6.8 MiB/s | 8,869 ops/s, 8.7 MiB/s | Typical single-copy baseline on this host |
| 1 KiB, N=1, 32 in flight, `none` | 31,119 ops/s, 30.4 MiB/s | 51,859 ops/s, 50.6 MiB/s | Concurrent small-object peak on this host |
| 1 KiB, N=3, sequential, `none` | 2,785 ops/s, 2.7 MiB/s | 4,151 ops/s, 4.1 MiB/s | Closer to the default three-copy write |
| 16 KiB, N=1, sequential, `none` | 4,664 ops/s, 72.9 MiB/s | 6,349 ops/s, 99.2 MiB/s | When bandwidth starts to matter |
| 1 MiB, N=1, incompressible | 208 ops/s, 208.2 MiB/s | 409 ops/s, 409.3 MiB/s | Large-object rate when compression cannot help |

On the 1 KiB, N=1 sequential path, put p50 / p99 was 137 µs / 221 µs, and get was 109 µs / 171 µs. Under 32 in-flight requests the same 1 KiB path still completes, but latency rises (put p50 / p99 914 µs / 3,518 µs); compare throughput, not p50, for those rows.

Small objects are limited by HTTP and the index write, not by disk bandwidth. A 100 B cluster put (6,985 ops/s) is almost the same as a 1 KiB put (6,937 ops/s). At 16 KiB, ops/s fall but logical bandwidth rises to 72.9 MiB/s write and 99.2 MiB/s read. A 1 MiB incompressible object on the N=1 cluster path wrote at 208 ops/s (208.2 MiB/s) and read at 409 ops/s (409.3 MiB/s). Use ops/s when you are planning for many small objects, and MiB/s when objects are larger.

Default production writes make three object-body copies. In this localhost test, a 1 KiB put that had to succeed on three local block processes ran at 2,785 ops/s, down from 6,937 ops/s at N=1. A multi-machine deployment will add network cost on top, which this test does not include. Pipelining recovers some of that write rate: 32 in-flight 1 KiB puts reached 11,196 ops/s at N=3.

Compression is zstd by default and is recorded per object. It helps most on logs and other repetitive text. The repeated `0x61` payload is a best case: 1 KiB shrinks 53.89×, 16 KiB 862.32×, and 1 MiB 20,971.52×. The 1 MiB logical write rate of 2,422.8 MiB/s is not a disk-bandwidth number; almost nothing was written to disk. Real logs and text usually compress well, but not this well. Already-compressed or random data does not shrink; this run stored those objects as `none`, and the rates stayed close to the uncompressed baseline (6,624 vs 6,750 ops/s at 1 KiB; 208 vs 224 ops/s at 1 MiB). On 1 KiB objects, even a 53.89× shrink barely moves ops/s, because the index and HTTP still dominate. At 16 KiB and 1 MiB, a highly compressible body improves both ops/s and logical MiB/s. zstd is the better default than gzip here: similar ratios when the data compresses, and much less CPU when it will not (3,662 vs 101 MiB/s on a 1 MiB random attempt).

The layout is meant for a large number of small objects. 5,000 × 1 KiB objects landed in a single `.blk` file, with 6 group fsyncs when uncompressed and 1 fsync when zstd shrank the payload. There is no per-object directory and no local LevelDB on the block node. The on-disk ratio after zstd (10.06×) is lower than the payload ratio (53.89×) because each record still carries TLV headers, including a 14-byte `recId` tag. Deletes issue a ticket immediately; idle or manual compaction rewrites live records and reclaims holes without updating the index. This official suite did not measure compact throughput or the reclaimed ratio.

Do not compare these rows with the in-process KV benches in the dleveldb repository, or with a local engine that skips HTTP. The direct-block 1 KiB rate (18,619 puts/s and 19,361 gets/s) is the engine-plus-HTTP ceiling without the index; the cluster rows are the ones to use for product comparison. This was not a bake-off against another object store on the same data set.

If you are choosing software in this class: s3dfs is aimed at many small to medium objects, where packing into large files, group commit, and optional compression matter more than a per-object directory tree. Plan capacity by adding block machines, and keep a small 3–5 node dleveldb index. If your data is already compressed, assume the `none` rows. If you need three copies, start from the N=3 rows and then measure on your own network. Multipart upload and automatic replica repair exist now; erasure coding does not. Those affect day-to-day operations more than the peak numbers above. The most reliable next step is to run `pnpm bench` on your hardware, and to replay a sample of your own objects.

## HTTP throughput, compress=none

| Workload | Operations | Throughput | Bandwidth | p50 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| direct block put 1 KiB (no index) | 5,000 | 18,619 ops/s | 18.2 MiB/s | 49 µs | 99 µs |
| direct block get 1 KiB (no index) | 5,000 | 19,361 ops/s | 18.9 MiB/s | 50 µs | 72 µs |
| cluster put 100 B, N=1 | 5,000 | 6,985 ops/s | 0.7 MiB/s | 135 µs | 247 µs |
| cluster get 100 B, N=1 | 5,000 | 8,965 ops/s | 0.9 MiB/s | 107 µs | 178 µs |
| cluster put 1 KiB, N=1 | 5,000 | 6,937 ops/s | 6.8 MiB/s | 137 µs | 221 µs |
| cluster get 1 KiB, N=1 | 5,000 | 8,869 ops/s | 8.7 MiB/s | 109 µs | 171 µs |
| cluster put 16 KiB, N=1 | 2,000 | 4,664 ops/s | 72.9 MiB/s | 198 µs | 618 µs |
| cluster get 16 KiB, N=1 | 2,000 | 6,349 ops/s | 99.2 MiB/s | 143 µs | 482 µs |
| cluster put 1 KiB, N=1, 32 in flight | 5,000 | 31,119 ops/s | 30.4 MiB/s | 914 µs | 3,518 µs |
| cluster get 1 KiB, N=1, 32 in flight | 5,000 | 51,859 ops/s | 50.6 MiB/s | 548 µs | 1,700 µs |
| cluster put 1 KiB, N=3 | 5,000 | 2,785 ops/s | 2.7 MiB/s | 337 µs | 760 µs |
| cluster get 1 KiB, N=3 | 5,000 | 4,151 ops/s | 4.1 MiB/s | 232 µs | 396 µs |
| cluster put 1 KiB, N=3, 32 in flight | 5,000 | 11,196 ops/s | 10.9 MiB/s | 2,730 µs | 4,854 µs |

A cluster put writes the blocks first, then the locators in dleveldb. This localhost N=3 run had all three block processes up, so all three copies were written and the put is slower than N=1. Current code publishes after a majority.

## Compression, cluster N=1

End-to-end put and get through the control plane, one index process and one block process. “Stored type” is the type recorded on the locator, which can fall back to `none`.

| Workload | Stored type | Stored / logical | Ratio | Space saved | Write | Read | Write p50 / p99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 KiB repeated, none | none | 1,024 / 1,024 B | 1.00x | 0.00% | 6,750 ops/s, 6.6 MiB/s | 8,762 ops/s, 8.6 MiB/s | 140 µs / 281 µs |
| 1 KiB repeated, zstd | zstd | 19 / 1,024 B | 53.89x | 98.14% | 6,611 ops/s, 6.5 MiB/s | 8,416 ops/s, 8.2 MiB/s | 137 µs / 476 µs |
| 1 KiB repeated, gzip | gzip | 30 / 1,024 B | 34.13x | 97.07% | 6,747 ops/s, 6.6 MiB/s | 8,506 ops/s, 8.3 MiB/s | 137 µs / 390 µs |
| 1 KiB random, zstd | none | 1,024 / 1,024 B | 1.00x | 0.00% | 6,624 ops/s, 6.5 MiB/s | 8,785 ops/s, 8.6 MiB/s | 140 µs / 383 µs |
| 1 KiB random, gzip | none | 1,024 / 1,024 B | 1.00x | 0.00% | 6,174 ops/s, 6.0 MiB/s | 8,758 ops/s, 8.6 MiB/s | 150 µs / 356 µs |
| 16 KiB repeated, none | none | 16,384 / 16,384 B | 1.00x | 0.00% | 4,455 ops/s, 69.6 MiB/s | 6,607 ops/s, 103.2 MiB/s | 201 µs / 660 µs |
| 16 KiB repeated, zstd | zstd | 19 / 16,384 B | 862.32x | 99.88% | 6,754 ops/s, 105.5 MiB/s | 7,990 ops/s, 124.8 MiB/s | 137 µs / 322 µs |
| 16 KiB random, zstd | none | 16,384 / 16,384 B | 1.00x | 0.00% | 4,298 ops/s, 67.2 MiB/s | 6,660 ops/s, 104.1 MiB/s | 208 µs / 653 µs |
| 1 MiB repeated, none | none | 1,048,576 / 1,048,576 B | 1.00x | 0.00% | 224 ops/s, 224.1 MiB/s | 400 ops/s, 400.2 MiB/s | 4,424 µs / 5,483 µs |
| 1 MiB repeated, zstd | zstd | 50 / 1,048,576 B | 20,971.52x | 99.995% | 2,423 ops/s, 2,422.8 MiB/s | 2,202 ops/s, 2,202.4 MiB/s | 399 µs / 582 µs |
| 1 MiB random, zstd | none | 1,048,576 / 1,048,576 B | 1.00x | 0.00% | 208 ops/s, 208.2 MiB/s | 409 ops/s, 409.3 MiB/s | 4,700 µs / 5,902 µs |

Small objects are still limited by HTTP and index operations, so zstd does not change 1 KiB ops/s much even when the payload shrinks. At 16 KiB and 1 MiB, a highly compressible body improves both ops/s and logical MiB/s because the stored record is tiny. Incompressible bodies stay close to the `none` baseline.

## In-process codec

Control-plane compress / decompress only: no HTTP, no disk. Decompress is omitted when the type falls back to `none`, because that path is a no-op.

| Workload | Applied | Stored / logical | Ratio | Compress | Decompress |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 MiB repeated, zstd | zstd | 50 / 1,048,576 B | 20,971.52x | 8,863 MiB/s | 5,271 MiB/s |
| 1 MiB repeated, gzip | gzip | 1,052 / 1,048,576 B | 996.75x | 4,081 MiB/s | 4,032 MiB/s |
| 1 MiB random, zstd | none | 1,048,576 / 1,048,576 B | 1.00x | 3,662 MiB/s | — |
| 1 MiB random, gzip | none | 1,048,576 / 1,048,576 B | 1.00x | 101 MiB/s | — |
| 16 KiB repeated, zstd | zstd | 19 / 16,384 B | 862.32x | 3,567 MiB/s | 2,241 MiB/s |
| 16 KiB random, zstd | none | 16,384 / 16,384 B | 1.00x | 1,400 MiB/s | — |

The gzip attempt on incompressible 1 MiB data is slower than zstd (101 MiB/s vs 3,662 MiB/s) because gzip spends more work before giving up. Both correctly fall back to `none`.

## On-disk layout

The same machine, opening the C engine directly (no HTTP). 5,000 objects of 1 KiB were written in order and flushed. There is no `index/` directory; locators belong in dleveldb. Inode and file count follow the block file, not the object count.

| Case | Files | On disk | Logical | Stored payload | On-disk ratio | flush / fsync |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw repeated (no compression) | 1 × `blocks/00000000000000000001.blk` | 5,533,890 B | 5,120,000 B | 5,120,000 B | 0.93x | 6 |
| zstd repeated (19 B payload each) | 1 × `blocks/00000000000000000001.blk` | 508,890 B | 5,120,000 B | 95,000 B | 10.06x | 1 |
| zstd random (fell back to `none`) | 1 × `blocks/00000000000000000001.blk` | 5,533,890 B | 5,120,000 B | 5,120,000 B | 0.93x | 6 |

The zstd on-disk ratio (10.06x) is lower than the payload ratio (53.89x) because each record still carries TLV tags, lengths, a CRC, and a 14-byte `recId` tag. This run was not an IOPS bake-off against RustFS on the same data set. Compared with the 16 Nov 2026, 12:33 layout (5,463,890 B uncompressed; 438,890 B after zstd), the extra 70,000 bytes are exactly 14 bytes times 5,000 records. Object-replica repair and compaction exist in the current tree; this suite did not measure either.

## Previous TLV design (16 Nov 2026, 12:33 Asia/Shanghai)

The tables below are a historical measurement of the previous tree: locators still stored `(blockId, offset, recLen)`, records were already TLV, and compression was already in the control plane, but `recId` and compaction were not implemented yet. Do not treat these numbers as the current tree. The raw file is [bench-2026-11-16-tlv.json](bench-2026-11-16-tlv.json). Same machine and Bun version as above.

On that run, the 1 KiB, N=1 sequential cluster path was 6,795 ops/s write (p50 138 µs) and 8,708 ops/s read (p50 110 µs); direct-block 1 KiB was 18,716 puts/s and 19,334 gets/s. The 17 Nov 2026 run stayed within a few percent of those hot-path rates.

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

On-disk layout from that run, 5,000 × 1 KiB objects: raw repeated 5,463,890 B (0.94x), zstd repeated 438,890 B (11.67x), zstd random 5,463,890 B (0.94x).

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

## 2026-11-21 三副本补测

同一台 MacBook Pro（Apple M5 Pro，Bun 1.4.2），三个 block 进程在本机，`compress=none`，后台 compact 关闭。1 KiB 预热 100 次、测量 1,000 次。1 MiB 预热 4 次、测量 40 次。这组数字填上了 1 MiB、3 副本这一格，仍然是 localhost，不是目标集群的容量。

| 负载 | 吞吐 | p50 | p99 |
| --- | ---: | ---: | ---: |
| put 1 KiB，N=3 | 2,567 ops/s | 360 µs | 876 µs |
| get 1 KiB，N=3 | 3,967 ops/s | 238 µs | 481 µs |
| put 1 MiB，N=3 | 160 ops/s（160 MiB/s） | 5.9 ms | 8.3 ms |
| get 1 MiB，N=3 | 364 ops/s（364 MiB/s） | 2.7 ms | 3.4 ms |

复现：`S3DFS_COMPACT_INTERVAL_MS=0 S3DFS_BENCH_FOCUS=n3 S3DFS_BENCH_OPS=1000 S3DFS_BENCH_WARMUP=100 bun scripts/bench-split.mjs`。原始结果在 [bench-2026-11-21-n3.json](bench-2026-11-21-n3.json)。
