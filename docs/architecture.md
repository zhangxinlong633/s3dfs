# s3dfs 架构

s3dfs 是 S3 兼容的对象存储。控制面用 TypeScript，数据通路的核心在 C 引擎里，通过 N-API 暴露给 Node。对象索引和对象正文分开扩容：

- **索引**落在独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 集群里，一般 **3–5 台**就够。S3 API 只是这个集群的客户端，自己不加入 dleveldb 的环。
- **正文**落在大量只跑 packed-block 引擎的 **block 机器**上，机器数可以远多于索引节点。
- 默认 3 份对象数据副本（受当前存活的 block 节点数限制），在索引里记成 `bucket/key`、`bucket/key:1`、`bucket/key:2`，值里带上对应 block 节点的信息。

细节见 [索引与 block 集群](design-replication.md)。

## 分层

- **控制台**（`apps/web`，Next.js，默认 :9001）：看统计、桶、block 节点状态，触发 flush / compact。
- **S3 API**（`apps/api`，Nest.js，默认 :9000）：Put / Get / Head / Delete / List 和少量管理接口。它通过 HTTP 访问 dleveldb 和 block 节点，本进程不再打开本地 store。
- **索引集群**（独立的 dleveldb 进程，默认 :9800）：只存很小的 locator JSON 和 `$node/{nodeId}` 注册信息，不存对象正文。
- **block 节点**（`apps/block`，默认 :9100 起）：每台机器跑 C 引擎，对象打进追加式 1GB block 文件。
- **存储引擎**（`packages/engine`）：C 实现追加式 block 文件，以及用官方 C API（`leveldb/c.h`）访问的 LevelDB 索引。这份 LevelDB 只属于单个 block 进程，用来从 key 找到 block 内偏移。

对象值写在各 block 节点 `data/blocks/` 下的大文件里，默认每块 1GB（`S3DFS_BLOCK_SIZE`），写满再切新文件。

单机开发时起三个进程即可：一台 dleveldb、一台 block、一台 S3 API。这时有效数据副本是 1。

## 记录格式

每条记录是：`^` 头（flags、key 长度、value 长度、CRC、mtime）+ key + value + 尾（整条长度、`$`）。删除是带 `S3DFS_FLAG_TOMBSTONE` 的墓碑。

写路径先进入约 1MB 的内存缓冲，再批量 `write`；flush 时默认 `fsync`。小对象很多时，inode 和 IOPS 跟 block 文件数走，而不是跟对象数走。

## 索引（单个 block 进程内部）

每个 block 进程自己的 LevelDB 在该进程数据目录的 `index/` 下。对象 key 前面加 `\x01`，元数据头在 `\x00head`（魔数 `S3IX`），记下已提交的写位置和统计。写入先进入内存 pending，block 写完并 fsync 后，用 WriteBatch 一次性提交索引和头。

打开存储时，如果头有效，只回放已提交偏移之后的尾巴；否则全量回放 block 来重建索引。

不要把这份本地 LevelDB 和集群级的 dleveldb 索引搞混：前者是「这个 node 上的 key 在哪个 block 文件里」，后者是「这个对象的第几份副本在哪台 block 机器上」。

## 大文件

能放进当前块剩余空间的对象，仍是一条记录、一处索引。更大的对象会切成多段，后一段记下前一段的位置，LevelDB 只存最后一段。读取时从 last 往前走完链条，再从前向后取数。详细说明见 [大文件跨 block 存放](design-large-object.md)。

## Compaction

`compact` 把仍存活的对象读出并写到新的 block 里，然后删除不再被引用的旧文件，用来回收删除和覆盖留下的空洞。跨块对象会按同样规则重新切段。S3 API 上的 compact / flush 会转发到当前存活的 block 节点。

## 对象定位

S3 层把对象记成字面量 `bucket/key`。Put 时按 key 的哈希从存活的 block 节点里挑 N 台（N 默认 3，且不超过存活节点数），把同一份正文写到这些机器上，再在 dleveldb 里写下 locator。Get 先读 locator，跳过被健康检查标为 down 的节点，按剩余副本取数。列举时会丢掉 `key:1`、`key:2` 这种副本后缀，避免同一个对象出现多次。

对象 key 本身不要以 `:数字` 结尾，那是副本索引的约定。
