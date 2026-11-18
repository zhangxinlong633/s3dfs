# s3dfs

[English](README.md) | **中文**

S3 兼容的对象存储。S3 API 和管控台用 TypeScript（Nest.js / Next.js），落盘引擎用 C。

对象索引和正文分开扩容：

- 分布式的对象 key / locator 放在独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 集群里，一般 **3–5 台**就够
- 对象正文放在大量只跑 packed-block 引擎的 **block 机器**上，机器可以很多
- 默认 3 份数据副本，在索引里记成 `bucket/key`、`bucket/key:1`、`bucket/key:2`，值里带上节点信息；API 会定期检查这些节点是否还活着，读写时跳过宕机节点，并可以从剩下的副本读取

设计上针对小文件：不会一个对象一个目录，而是把对象打进大的 block 文件，在内存里攒批后再 `write` + `fsync`。inode 和 IOPS 跟数据文件数走，而不是跟对象数走。对象按 key 哈希分散到多台 block，定位信息是 dleveldb 里的 locator，存储侧不会像普通本地文件系统那样先被 inode 撑爆。block 记录是带校验的 TLV 帧，对象定位全部放在 dleveldb 里。写入前控制面默认用 zstd 压缩，每个对象自己的类型记在 locator 的 `compressType` 里；如果压缩没有变小，就按原文落盘，并把类型记成 `none`。

## 这个仓库做什么

- 对象追加进大文件（默认 1 GiB 一块，可配）。超过当前块的对象切成多段，后一段记下前一段的 `recId`，写满再切新文件。
- 每条记录是小端 TLV 帧，带魔数 `S3R1`、CRC-32 和对称的尾部，方便扫描和校验。
- 1 MiB 写缓冲做 group commit，一批对象一次刷盘；flush 时默认 `fsync`。
- 控制面把节点信息和稳定的 `recId` 写进 dleveldb 的 locator（`v: 3`）；block 进程在内存里维护 `recId` 到文件偏移的映射（打开时扫描 `.blk` 重建），不再维护本地 LevelDB。
- 索引丢了时可以扫描 TLV 记录重建 locator。删除会写墓碑并出清理票，避免重建时把已删对象救回来。空闲或手动 compact 会保留原来的 `recId` 重写还活着的记录、回收空洞，不必改索引。

## 仓库结构

这是一个 pnpm monorepo。安装和编译用 **pnpm 9+**（需要 **Node.js 26+**）。节点进程跑在 **Bun 1.4+** 上。Nest API 要先用 `tsc` 编译（需要装饰器元数据），再用 bun 启动。控制台是 Next.js。

```
s3dfs/
  apps/api            # Nest.js 12，S3 兼容 HTTP 网关（默认 :9000），是 dleveldb 和 block 的客户端
  apps/web            # Next.js 16 控制台（默认 :9001）
  apps/block          # packed-block 存储节点（默认 :9100 起）
  packages/engine     # C 存储引擎 + N-API 绑定（追加式 TLV block 文件，recId 映射表）
  packages/control    # 索引客户端、locator、压缩、节点注册、放置与健康检查
  docs/               # 架构、设计和性能测试说明
```

对象索引请运行旁边的 [dleveldb](https://github.com/zhangxinlong633/dleveldb)（`pnpm dev:index` 默认 :9800）。本仓库里的 `packages/dleveldb` 只是历史对照，不再参与构建。

分层和读写路径见 [docs/architecture.md](docs/architecture.md)。放置与健康检查见 [docs/design-replication.md](docs/design-replication.md)。故障与恢复见 [docs/design-recovery.md](docs/design-recovery.md)。大对象见 [docs/design-large-object.md](docs/design-large-object.md)。删除空洞与 compact 见 [docs/design-compaction.md](docs/design-compaction.md)。FUSE / 挂载见 [docs/design-fuse.md](docs/design-fuse.md)。环境变量见 [docs/capabilities.md](docs/capabilities.md)。这些设计文档目前是中文。方法和完整表格见 [docs/benchmarks.md](docs/benchmarks.md)。

## 架构概览

```mermaid
flowchart TB
  subgraph Client["客户端"]
    App["S3 客户端或控制台"]
  end

  subgraph Index["dleveldb 索引集群，3–5 台"]
    KV["locator：bucket/key、bucket/key:1、bucket/key:2"]
  end

  subgraph Blocks["block 机器，可以很多"]
    B1["block 节点：打包的 TLV .blk 文件"]
    B2["block 节点"]
    B3["block 节点"]
  end

  App -->|S3 API :9000| API["s3dfs API / 控制面"]
  API -->|压缩，再按 recId put/get| B1
  API --> B2
  API --> B3
  API -->|locator JSON| KV
```

一次写入大致是这样：

1. 控制面可以按 `S3DFS_COMPRESS` 压缩正文（默认 `zstd`）。如果没有变小，就保存原文，并把 `compressType` 记成 `none`。
2. 同一份已存储字节写到 N 台存活的 block 节点上（`N = min(配置副本数, 当前存活的 block 数)`，默认 3）。
3. 每次成功写入会返回一个 `recId`。API 把 locator JSON 写进 dleveldb，键是 `bucket/key`、`bucket/key:1` 等。对外的 `size` 和 `crc` 是未压缩值；`storedSize` 和 `compressType` 描述盘上实际内容。
4. 读取时先查 locator，跳过宕机节点，按 `recId` 取数据，再用该 locator 上的类型解压。

也可以用 `s3dfs-fuse` 把一个桶挂成本地目录：路径对应对象 key，内容仍按上面的方式进 block。说明见 [docs/design-fuse.md](docs/design-fuse.md)。

## 快速开始

需要本机有 Node 26、pnpm 9、Bun 1.4+、Python 3 和 C/C++ 编译器（macOS 上是 Xcode Command Line Tools），以及旁边的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 仓库（默认 `../dleveldb`）。

```bash
git clone https://github.com/zhangxinlong633/dleveldb.git
git clone https://github.com/zhangxinlong633/s3dfs.git
cd s3dfs
pnpm install
pnpm build:engine
pnpm build:control
pnpm dev:index    # dleveldb 索引，http://127.0.0.1:9800
pnpm dev:block    # block 节点，    http://127.0.0.1:9100
pnpm dev:api      # S3 API，        http://127.0.0.1:9000
pnpm dev:web      # 控制台，        http://127.0.0.1:9001
```

单机时有效数据副本是 1。要看多副本，再起几台 block（不同的 `S3DFS_BLOCK_NODE_ID`、`S3DFS_BLOCK_PORT`、`S3DFS_DATA_DIR`），并在 API 的 `S3DFS_BLOCK_NODES` 里加上它们。索引集群若要 3 副本，按 dleveldb 的文档再起两台索引节点，把 `S3DFS_INDEX_URLS` 指过去即可；存储容量仍只靠加 block 机器。

数据目录已 gitignore。环境变量见 [docs/capabilities.md](docs/capabilities.md)。

```bash
aws --endpoint-url http://127.0.0.1:9000 s3 mb s3://logs
aws --endpoint-url http://127.0.0.1:9000 s3 cp ./a.log s3://logs/a.log
```

```bash
# 测试（原生插件需在能编译 C++ 的机器上先 build）
pnpm --filter @s3dfs/engine build
pnpm --filter @s3dfs/control build
node packages/engine/scripts/test-span.mjs
bun scripts/test-split.mjs
```

## 性能

下面的数字是 2026-11-17 00:40（Asia/Shanghai）在一台 MacBook Pro（Apple M5 Pro，15 核，48 GB，Apple SSD AP1024Z）上用 Bun 1.4.2（node-compat v26.3.0）测到的。对应现在的代码，包括 `recId` locator 和空闲 compact。这次为避免后台清理掺进数字，设置了 `S3DFS_COMPACT_INTERVAL_MS=0`。都是单机结果，不是多机网络环境。N 是对象正文副本数：N=1 是一台 dleveldb 加一台 block；N=3 是同一台机器上的一台索引加三台 block。带宽是**逻辑** MiB/s（未压缩对象大小 / 时间，1 MiB = 1,048,576 字节）。压缩比是逻辑大小 / 存储大小。重复内容是全部 `0x61` 的字节，属于最好情况；随机内容是密码学随机数，通常压不小。压不小的时候，locator 会记 `compressType=none`。可以用 `pnpm bench` 或 `bun scripts/bench-split.mjs` 复现。方法和同一张表见 [docs/benchmarks.md](docs/benchmarks.md)。


### 给选型的人看的参考

这些数字是给在比较 packed-block、S3 兼容对象存储的人用的起点，不是服务承诺。它们来自一台 MacBook Pro 上的一次本机（localhost）测试。换机器、走真实网络或多机部署，绝对值都会变。做产品比较时，请看走集群路径（API + 索引 + block）的数字，不要看直接打到 block、不经索引的那一行：前者才是 S3 客户端实际看到的路径。

表里没有一个可以简单相加的“平均 ops/s”。行与行之间混了不同对象大小、1 副本和 3 副本、串行和流水线，还有专门用来看压缩上限的重复内容。在这台机器上，比较有代表性的规划数字是：

| 规划场景 | 写入 | 读取 | 含义 |
| --- | ---: | ---: | --- |
| 1 KiB，N=1，串行，`none` | 6,937 ops/s，6.8 MiB/s | 8,869 ops/s，8.7 MiB/s | 这台机器上较典型的单副本基线 |
| 1 KiB，N=1，32 并发，`none` | 31,119 ops/s，30.4 MiB/s | 51,859 ops/s，50.6 MiB/s | 这台机器上小对象并发峰值 |
| 1 KiB，N=3，串行，`none` | 2,785 ops/s，2.7 MiB/s | 4,151 ops/s，4.1 MiB/s | 更接近默认三副本写入 |
| 16 KiB，N=1，串行，`none` | 4,664 ops/s，72.9 MiB/s | 6,349 ops/s，99.2 MiB/s | 带宽开始成为主要指标的对象大小 |
| 1 MiB，N=1，不可压缩 | 208 ops/s，208.2 MiB/s | 409 ops/s，409.3 MiB/s | 压缩帮不上忙时的大对象速率 |

1 KiB、N=1、串行路径上，写入 p50 / p99 是 137 µs / 221 µs，读取是 109 µs / 171 µs。小对象受 HTTP 和索引限制，而不是磁盘带宽：100 B 写入（6,985 ops/s）和 1 KiB 写入（6,937 ops/s）几乎一样。规划大量小对象时看 ops/s，对象变大时看 MiB/s。

生产默认会写 3 份对象正文。这次本机测试里，1 KiB 串行写入从 6,937 ops/s 降到 2,785 ops/s。多机部署还会叠加上网络开销，这些数字里没有。并发能把速率拉上去：N=3 时 32 个在途请求的 1 KiB 写入到了 11,196 ops/s。

默认压缩是 zstd，按对象记录。它对日志和重复性文本最有用。表里的重复 `0x61` 内容是最好情况；1 MiB 逻辑写入 2,423 MiB/s 不是磁盘带宽。已经压缩过或随机的数据压不小，这次会按 `none` 落盘，1 KiB / 1 MiB 的速率接近不压缩基线（1 KiB 是 6,624 vs 6,750 ops/s，1 MiB 是 208 vs 224 ops/s）。1 KiB 即使压到 53.89 倍，ops/s 也几乎不动，因为索引和 HTTP 仍占主导。

布局是为大量小对象准备的。5,000 个 1 KiB 对象落在一个 `.blk` 文件里，不压缩时 group fsync 6 次，zstd 压得很小后只有 1 次；每条记录多了 14 字节的 `recId` tag，未压缩布局是 5,533,890 字节（盘上比 0.93x）。没有按对象建目录，block 节点也不再有本地 LevelDB。与同一台机器上 2026-11-16 12:33 那次尚未使用 `recId` 和 compact 的 TLV 结果相比，1 KiB 集群热路径仍在同一水平（差异多在几个百分点内）；这次没有单独测 compact 吞吐。如果需要一个规划起点，先看上表，再在自己的硬件上用 `pnpm bench`、并回放一批真实对象。更完整的说明和此前的表格见 [docs/benchmarks.md](docs/benchmarks.md)。

HTTP 路径，`compress=none`（避免和默认的 zstd 路径混在一起）：

| 负载 | 吞吐 | 带宽 | p50 | p99 |
| --- | ---: | ---: | ---: | ---: |
| direct block put 1 KiB（不经索引） | 18,619 ops/s | 18.2 MiB/s | 49 µs | 99 µs |
| direct block get 1 KiB（不经索引） | 19,361 ops/s | 18.9 MiB/s | 50 µs | 72 µs |
| cluster put 100 B，N=1 | 6,985 ops/s | 0.7 MiB/s | 135 µs | 247 µs |
| cluster get 100 B，N=1 | 8,965 ops/s | 0.9 MiB/s | 107 µs | 178 µs |
| cluster put 1 KiB，N=1 | 6,937 ops/s | 6.8 MiB/s | 137 µs | 221 µs |
| cluster get 1 KiB，N=1 | 8,869 ops/s | 8.7 MiB/s | 109 µs | 171 µs |
| cluster put 16 KiB，N=1 | 4,664 ops/s | 72.9 MiB/s | 198 µs | 618 µs |
| cluster get 16 KiB，N=1 | 6,349 ops/s | 99.2 MiB/s | 143 µs | 482 µs |
| cluster put 1 KiB，N=1，32 并发 | 31,119 ops/s | 30.4 MiB/s | 914 µs | 3,518 µs |
| cluster get 1 KiB，N=1，32 并发 | 51,859 ops/s | 50.6 MiB/s | 548 µs | 1,700 µs |
| cluster put 1 KiB，N=3 | 2,785 ops/s | 2.7 MiB/s | 337 µs | 760 µs |
| cluster get 1 KiB，N=3 | 4,151 ops/s | 4.1 MiB/s | 232 µs | 396 µs |
| cluster put 1 KiB，N=3，32 并发 | 11,196 ops/s | 10.9 MiB/s | 2,730 µs | 4,854 µs |

走索引的 put 会先写 block，再把 locator 写入 dleveldb。N=3 时 put 要在三台 block 上都写成功，所以比 N=1 慢。这些数字不要和 dleveldb 仓库里的进程内基准混比：那是纯 KV，这条路径是对象存储的 HTTP 索引 + block。

端到端集群，N=1，带压缩。高度可压缩对象的逻辑写入速率会更高，因为落盘字节少得多；这不是磁盘带宽。

| 负载 | 实际类型 | 存储 / 逻辑 | 压缩比 | 写入 | 读取 |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 KiB 重复，none | none | 1,024 / 1,024 B | 1.00x | 6,750 ops/s，6.6 MiB/s | 8,762 ops/s，8.6 MiB/s |
| 1 KiB 重复，zstd | zstd | 19 / 1,024 B | 53.89x | 6,611 ops/s，6.5 MiB/s | 8,416 ops/s，8.2 MiB/s |
| 1 KiB 重复，gzip | gzip | 30 / 1,024 B | 34.13x | 6,747 ops/s，6.6 MiB/s | 8,506 ops/s，8.3 MiB/s |
| 1 KiB 随机，zstd | none | 1,024 / 1,024 B | 1.00x | 6,624 ops/s，6.5 MiB/s | 8,785 ops/s，8.6 MiB/s |
| 16 KiB 重复，none | none | 16,384 / 16,384 B | 1.00x | 4,455 ops/s，69.6 MiB/s | 6,607 ops/s，103.2 MiB/s |
| 16 KiB 重复，zstd | zstd | 19 / 16,384 B | 862.32x | 6,754 ops/s，105.5 MiB/s | 7,990 ops/s，124.8 MiB/s |
| 16 KiB 随机，zstd | none | 16,384 / 16,384 B | 1.00x | 4,298 ops/s，67.2 MiB/s | 6,660 ops/s，104.1 MiB/s |
| 1 MiB 重复，none | none | 1,048,576 / 1,048,576 B | 1.00x | 224 ops/s，224.1 MiB/s | 400 ops/s，400.2 MiB/s |
| 1 MiB 重复，zstd | zstd | 50 / 1,048,576 B | 20,971.52x | 2,423 ops/s，2,422.8 MiB/s | 2,202 ops/s，2,202.4 MiB/s |
| 1 MiB 随机，zstd | none | 1,048,576 / 1,048,576 B | 1.00x | 208 ops/s，208.2 MiB/s | 409 ops/s，409.3 MiB/s |

只测控制面编解码（不落盘、不走 HTTP）。当类型回退成 `none` 时，解压是空操作，所以不解压速度。

| 负载 | 实际类型 | 存储 / 逻辑 | 压缩比 | 压缩 | 解压 |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 MiB 重复，zstd | zstd | 50 / 1,048,576 B | 20,971.52x | 8,863 MiB/s | 5,271 MiB/s |
| 1 MiB 重复，gzip | gzip | 1,052 / 1,048,576 B | 996.75x | 4,081 MiB/s | 4,032 MiB/s |
| 1 MiB 随机，zstd | none | 1,048,576 / 1,048,576 B | 1.00x | 3,662 MiB/s | — |
| 1 MiB 随机，gzip | none | 1,048,576 / 1,048,576 B | 1.00x | 101 MiB/s | — |
| 16 KiB 重复，zstd | zstd | 19 / 16,384 B | 862.32x | 3,567 MiB/s | 2,241 MiB/s |

落盘布局：直接通过 C 引擎顺序写入 5,000 个 1 KiB 对象并 `flush`。没有 `index/` 目录。

| 用例 | 文件 | 盘上占用 | 逻辑大小 | 盘上比 | fsync 次数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原文重复（不压缩） | 1 个 `.blk` | 5,533,890 B | 5,120,000 B | 0.93x | 6 |
| zstd 重复（每条 payload 19 B） | 1 个 `.blk` | 508,890 B | 5,120,000 B | 10.06x | 1 |
| zstd 随机（回退为 `none`） | 1 个 `.blk` | 5,533,890 B | 5,120,000 B | 0.93x | 6 |

zstd 的盘上比低于 payload 比（53.89x），因为每条记录还带有 TLV 的 tag（包括 14 字节的 `recId`）、长度和 CRC。inode 和文件数跟 block 文件走，而不是跟对象数走。

## 已经实现和还没有做的

已经可以：Put / Get / Head / Delete / List（含 delimiter 列举）、HTTP Range GET、创建桶、索引和 block 分开部署、默认 3 份对象正文副本、一份 block 副本宕机后从剩余副本读取、活副本不足时自动或手动补齐到其他存活节点、按对象压缩、TLV 记录、`recId` locator、扫描重建 locator、block 节点用本地 `recmap.s3m` 加快重启（快照不可用则仍全量扫描）、删除写墓碑、空闲或手动 compact（回收空洞时不必改索引），以及 `apps/fuse` 里的第一期桶挂载程序。

还没有做：分片上传、完整 SigV4、纠删码、流式读写，以及引擎的 uint32 对象大小上限。对象副本补齐的第一期已经有了，但不会退役失效 locator，也救不回已经没有活副本的对象。dleveldb 的加入迁移和 primary 写故障转移也还未实现：新索引节点不会自动拉历史 key；索引主节点不可达时，写入会失败。故障时哪些请求还能继续、哪些不能，见 [docs/design-recovery.md](docs/design-recovery.md)。

## 依赖

当前使用的主要版本：

- 节点运行时：Bun 1.4+
- 安装与编译：Node.js 26、pnpm 9.15
- TypeScript 7.0.2
- NestJS 12.5.0
- Next.js 16.4.6、React 19.3.1
- 对象索引：[dleveldb](https://github.com/zhangxinlong633/dleveldb)
