# 性能测试

测量时间：2026-11-16 11:46（Asia/Shanghai）。机器是 MacBook Pro，Apple M5 Pro（15 核）、48 GB 内存、macOS arm64，Bun 1.4.2（node-compat v26.3.0）。

这是单机、本机 HTTP 的结果，不是多机网络环境。16 KiB 那两组各跑 2,000 次，其余每组 5,000 次，预热 500 次。延迟百分位来自同一次顺序（或标明并发）运行。N 是对象正文副本数；N=1 时是一台 dleveldb 索引加一台 block，N=3 时是一台索引加三台 block。`direct block` 不经过索引，只打 block 的 HTTP 接口。

复现：

```bash
pnpm --filter @s3dfs/control build
bun scripts/bench-split.mjs
```

脚本会为每组用例起一套临时的索引和 block 进程。

## 吞吐量

| 用例 | 次数 | 吞吐 | p50 | p99 |
| --- | ---: | ---: | ---: | ---: |
| direct block put 1 KiB（不经索引） | 5,000 | 15,967 ops/s | 48 µs | 92 µs |
| direct block get 1 KiB（不经索引） | 5,000 | 22,297 ops/s | 44 µs | 67 µs |
| cluster put 100 B，N=1 | 5,000 | 5,722 ops/s | 138 µs | 670 µs |
| cluster get 100 B，N=1 | 5,000 | 9,322 ops/s | 104 µs | 169 µs |
| cluster put 1 KiB，N=1 | 5,000 | 5,710 ops/s | 136 µs | 796 µs |
| cluster get 1 KiB，N=1 | 5,000 | 9,421 ops/s | 103 µs | 164 µs |
| cluster put 16 KiB，N=1 | 2,000 | 3,817 ops/s | 167 µs | 3,493 µs |
| cluster get 16 KiB，N=1 | 2,000 | 8,789 ops/s | 106 µs | 399 µs |
| cluster put 1 KiB，N=1，32 in-flight | 5,000 | 27,596 ops/s | 900 µs | 4,953 µs |
| cluster get 1 KiB，N=1，32 in-flight | 5,000 | 53,618 ops/s | 521 µs | 1,781 µs |
| cluster put 1 KiB，N=3 | 5,000 | 1,414 ops/s | 358 µs | 3,939 µs |
| cluster get 1 KiB，N=3 | 5,000 | 4,377 ops/s | 220 µs | 367 µs |
| cluster put 1 KiB，N=3，32 in-flight | 5,000 | 6,301 ops/s | 5,261 µs | 10,397 µs |

走索引的 put 会先写 block，再把 locator 写入 dleveldb。N=3 时 put 要在三台 block 上都写成功，所以比 N=1 慢。这些数字不要和 dleveldb 仓库里的进程内基准混比：那是纯 KV，这条路径是对象存储的 HTTP 索引 + block。

原始结果在 [bench-2026-11-16.json](bench-2026-11-16.json)。

## 落盘布局（对照小对象 inode / IOPS）

同一台机器上，另外对一台 block 顺序写入 5,000 个 1 KiB 对象并 `flush`。数据目录里一共只有 6 个文件：

- 1 个打包 block：`blocks/00000000000000000001.blk`，5,323,890 字节
- 5 个 LevelDB 文件（记录 key 到 block 内偏移）

逻辑负载是 5,120,000 字节（5,000 × 1 KiB），block 文件略大，因为记录带有 header / tail。这次 5,000 次 put 只 `flush` / `fsync` 了 7 次，大约 700 个对象共用一次刷盘。inode 和文件数跟 block / LevelDB 文件走，而不是跟对象数走。

当前还没有对象压缩，所以盘上占用会略大于逻辑大小。这次也没有和 RustFS 在同一份数据上对打 IOPS。对象副本的自动修复和迁移也还未实现。
