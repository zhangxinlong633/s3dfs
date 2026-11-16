# s3dfs

S3 兼容的对象存储。S3 API 和管控台用 TypeScript（Nest.js / Next.js），落盘引擎用 C。

对象索引和正文分开扩容：

- 分布式的对象 key / locator 放在独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 集群里，一般 **3–5 台**就够
- 对象正文放在大量只跑 packed-block 引擎的 **block 机器**上，机器可以很多
- 默认 3 份数据副本，在索引里记成 `bucket/key`、`bucket/key:1`、`bucket/key:2`，值里带上节点信息；API 会定期检查这些节点是否还活着

设计上针对小文件：不会一个对象一个目录，而是把对象打进大的 block 文件，在内存里攒批后再 `write` + `fsync`。inode 和 IOPS 跟数据文件数走，而不是跟对象数走。引擎只调用官方 C API `leveldb/c.h`。

落盘方式：

- 对象追加进大文件（默认 1GB 一块，可配）；超过一块的对象切成多段，后一段记下前一段的位置，写满再切新文件
- 记录带 header / tail 魔数（`^` / `$`）和长度，便于回放与校验
- 1MB 写缓冲做 group commit，一批对象一次刷盘；flush 时默认 `fsync`
- 用 LevelDB 记住 key 到 `(block_id, offset, size)` 的位置，以及面向 S3 key 的批量 `put_batch`，避免每个小对象都从 JS 进 C 一次
- 后台 compaction 把仍存活的对象重写成新的 block，回收删除留下的空洞

## 仓库结构

```
apps/api              Nest.js 12，S3 兼容 HTTP 网关（默认 :9000），是 dleveldb 和 block 的客户端
apps/web              Next.js 16 控制台（默认 :9001）
apps/block            packed-block 存储节点（默认 :9100 起）
packages/engine       C 存储引擎 + N-API 绑定（单个 s3dfs_store = 一份 LevelDB + packed block）
packages/control      索引客户端、locator、节点注册、放置与健康检查
```

对象索引请运行旁边的 [dleveldb](https://github.com/zhangxinlong633/dleveldb)（`pnpm dev:index` 默认 :9800）。本仓库里的 `packages/dleveldb` 只是历史对照，不再参与构建。

版本按当前最新对齐：Node 26、Bun 1.4+、Next.js 16.4.6、Nest.js 12.5、React 19.3。包管理和 monorepo 布局参考 Vastship（pnpm workspace）。

## 运行

需要本机有 Node 26、pnpm 9、Bun 1.4+、Python 3 和 C/C++ 编译器（macOS 上是 Xcode Command Line Tools），以及旁边的 dleveldb 仓库（默认 `../dleveldb`）。

```bash
cd /Users/bruce/git/s3dfs
pnpm install
pnpm build:engine
pnpm build:control
pnpm dev:index    # dleveldb 索引，http://127.0.0.1:9800
pnpm dev:block    # block 节点，http://127.0.0.1:9100
pnpm dev:api      # S3 API，http://127.0.0.1:9000
pnpm dev:web      # 控制台，http://127.0.0.1:9001
```

单机时有效数据副本是 1。要看多副本，再起几台 block（不同的 `S3DFS_BLOCK_NODE_ID`、`S3DFS_BLOCK_PORT`、`S3DFS_DATA_DIR`），并在 API 的 `S3DFS_BLOCK_NODES` 里加上它们。索引集群若要 3 副本，按 dleveldb 的文档再起两台索引节点，把 `S3DFS_INDEX_URLS` 指过去即可；存储容量仍只靠加 block 机器。

数据目录已 gitignore。环境变量见 [能力说明](docs/capabilities.md)，放置与健康检查见 [索引与 block 集群](docs/design-replication.md)。

```bash
# 例：用 AWS CLI 指向本地
aws --endpoint-url http://127.0.0.1:9000 s3 mb s3://logs
aws --endpoint-url http://127.0.0.1:9000 s3 cp ./a.log s3://logs/a.log
```

性能测试数据见 [性能测试](docs/benchmarks.md)。复现：

```bash
bun scripts/bench-split.mjs
```

```bash
# 测试（原生插件需在能编译 C++ 的机器上先 build）
pnpm --filter @s3dfs/engine build
pnpm --filter @s3dfs/control build
node packages/engine/scripts/test-span.mjs
bun scripts/test-split.mjs
```

已支持 Put/Get/Head/Delete/List、创建桶、把索引和 block 分开部署，以及在一份 block 副本宕机后从剩余副本读取。分片上传、完整 SigV4、纠删码，以及对象副本的自动修复、dleveldb 的加入迁移和 primary 写故障转移，还不在本轮。
