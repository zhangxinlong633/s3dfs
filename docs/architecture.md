# s3dfs 架构

s3dfs 是 S3 兼容的对象存储。控制面用 TypeScript，数据通路的核心在 C 引擎里，通过 N-API 暴露给 Node。对象索引和对象正文分开扩容：

- **索引**落在独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 集群里，一般 **3–5 台**就够。S3 API 只是这个集群的客户端，自己不加入 dleveldb 的环。
- **正文**落在大量只跑 packed-block 引擎的 **block 机器**上，机器数可以远多于索引节点。block 进程不再维护本地 LevelDB。
- 默认 3 份对象数据副本（受当前存活的 block 节点数限制），在索引里记成 `bucket/key`、`bucket/key:1`、`bucket/key:2`，值里带上对应 block 节点、block 内偏移，以及 `compressType` 等信息。

细节见 [索引与 block 集群](design-replication.md)。

## 分层

- **控制台**（`apps/web`，Next.js，默认 :9001）：看统计、桶、block 节点状态，触发 flush。compact 接口还在，但目前不会回收空间。
- **S3 API**（`apps/api`，Nest.js，默认 :9000）：Put / Get / Head / Delete / List 和少量管理接口。它通过 HTTP 访问 dleveldb 和 block 节点，本进程不再打开本地 store。
- **索引集群**（独立的 dleveldb 进程，默认 :9800）：只存很小的 locator JSON 和 `$node/{nodeId}` 注册信息，不存对象正文。
- **block 节点**（`apps/block`，默认 :9100 起）：每台机器跑 C 引擎，对象打进追加式 1GB block 文件。进程只做追加和按偏移读取。
- **存储引擎**（`packages/engine`）：C 实现追加式 block 文件。记录是带校验的 TLV 帧，方便以后加字段；也可以扫描全部 `.blk` 重建索引。

对象值写在各 block 节点 `data/blocks/` 下的大文件里，默认每块 1GB（`S3DFS_BLOCK_SIZE`），写满再切新文件。

单机开发时起三个进程即可：一台 dleveldb、一台 block、一台 S3 API。这时有效数据副本是 1。

## 记录格式（TLV）

每条记录是小端 TLV 帧，魔数 `S3R1`：

```
magic u32 | rec_len u32 | tags… | crc32 u32 | rec_len u32 | magic u32
```

每个 tag 是 `type u16 | length u32 | value[length]`。当前用到的类型包括 key、value、kind、mtime、crc，以及跨块对象的 prev / seq / generation 等。不认识的 tag 按长度跳过，因此可以加字段而不改旧读取路径。帧头尾的 magic、长度和 CRC 对不上时，视为一次不完整写入，扫描停在上一条完整记录。

`kind` 区分普通对象、跨块中间段、跨块最后一段，以及删除墓碑。删除会在对应的 block 上追加一条墓碑，这样以后扫文件重建索引时不会把已删对象救回来。墓碑不会立刻回收空间。

写路径先进入约 1MB 的内存缓冲，再批量 `write`；flush 时默认 `fsync`。小对象很多时，inode 和 IOPS 跟 block 文件数走，而不是跟对象数走。

## 定位

对象在哪台机器、在哪个 block 的哪个偏移，全部记在 dleveldb 的 locator 里（`v: 2`），包括 `blockId` / `offset` / `recLen`，以及压缩类型。block 进程不再维护 `index/` 目录。

打开 block 存储时，只扫描各 `.blk` 找到最后一条完整记录的结尾，接着往后追加。不需要回放本地索引。如果 dleveldb 里的定位信息丢了，可以对每台 block 调用扫描接口，按记录顺序折叠墓碑，重建 locator。

## 压缩

控制面在写入 block 之前压缩对象正文，默认 `zstd`（`S3DFS_COMPRESS` 也可设为 `gzip` 或 `none`）。小于 64 字节，或压缩后没有变小，就原样落盘，并把 `compressType` 记成 `none`。locator 里同时保存未压缩的 `size` / `crc`，以及盘上的 `storedSize`。读取时按 `compressType` 解压。同一份压缩后的字节会写到各数据副本。压缩类型也写进 block 的 TLV，便于重建索引时一并恢复。

## 大文件

能放进当前块剩余空间的对象，仍是一条记录。更大的对象会切成多段，后一段用 prev tag 记下前一段的位置，dleveldb 只存最后一段的 locator。读取时从 last 往前走完链条，再从前向后取数。详细说明见 [大文件跨 block 存放](design-large-object.md)。

## Compaction

本轮还没有做按存活 locator 重写 block、回收删除和覆盖留下的空洞。API 上的 compact 目前是空操作。空间回收要等之后补上，并且需要能从索引（或扫描结果）列出仍存活的对象。

## 对象定位与副本

S3 层把对象记成字面量 `bucket/key`。Put 时按 key 的哈希从存活的 block 节点里挑 N 台（N 默认 3，且不超过存活节点数），把同一份（可能已压缩的）正文写到这些机器上，再在 dleveldb 里写下 locator。Get 先读 locator，跳过被健康检查标为 down 的节点，按剩余副本取数并解压。列举时会丢掉 `key:1`、`key:2` 这种副本后缀，避免同一个对象出现多次。

对象 key 本身不要以 `:数字` 结尾，那是副本索引的约定。
