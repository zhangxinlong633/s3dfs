# s3dfs 架构

s3dfs 是 S3 兼容的对象存储。控制面用 TypeScript，数据通路的核心在 C 引擎里，通过 N-API 暴露给 Node。对象索引和对象正文分开扩容：

- **索引**落在独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 集群里，一般 **3–5 台**就够。S3 API 只是这个集群的客户端，自己不加入 dleveldb 的环。
- **正文**落在大量只跑 packed-block 引擎的 **block 机器**上，机器数可以远多于索引节点。block 进程不再维护本地 LevelDB。
- 默认 3 份对象数据副本（受当前存活的 block 节点数限制），在索引里记成 `bucket/key`、`bucket/key:1`、`bucket/key:2`，值里带上对应 block 节点、稳定的 `recId`，以及 `compressType` 等信息。

细节见 [索引与 block 集群](design-replication.md)。

## 分层

- **控制台**（`apps/web`，Next.js，默认 :9001）：看统计、桶、block 节点状态，触发 flush。空间回收走管理接口或 block 上的 compact，见下方。
- **S3 API**（`apps/api`，Nest.js，默认 :9000）：Put / Get / Head / Delete / List（含 `delimiter`）和少量管理接口，GET 支持单个 `Range`。它通过 HTTP 访问 dleveldb 和 block 节点，本进程不再打开本地 store。本机目录挂载由独立的 `apps/fuse`（`s3dfs-fuse`）完成，不进入这条控制面进程。
- **索引集群**（独立的 dleveldb 进程，默认 :9800）：只存很小的 locator JSON 和 `$node/{nodeId}` 注册信息，不存对象正文。
- **block 节点**（`apps/block`，默认 :9100 起）：每台机器跑 C 引擎，对象打进追加式 1GB block 文件。进程按 `recId` 查本地内存表，再读到文件里的物理位置。
- **存储引擎**（`packages/engine`）：C 实现追加式 block 文件。记录是带校验的 TLV 帧，方便以后加字段；也可以扫描全部 `.blk` 重建索引。

对象值写在各 block 节点 `data/blocks/` 下的大文件里，默认每块 1GB（`S3DFS_BLOCK_SIZE`），写满再切新文件。

单机开发时起三个进程即可：一台 dleveldb、一台 block、一台 S3 API。这时有效数据副本是 1。

## 记录格式（TLV）

每条记录是小端 TLV 帧，魔数 `S3R1`：

```
magic u32 | rec_len u32 | tags… | crc32 u32 | rec_len u32 | magic u32
```

每个 tag 是 `type u16 | length u32 | value[length]`。当前用到的类型包括 key、value、kind、mtime、crc、`recId`，以及跨块对象的 prev / seq / generation 等。不认识的 tag 按长度跳过，因此可以加字段而不改旧读取路径。帧头尾的 magic、长度和 CRC 对不上时，视为一次不完整写入，扫描停在上一条完整记录。

`kind` 区分普通对象、跨块中间段、跨块最后一段，以及删除墓碑。删除会在对应的 block 上追加一条墓碑，这样以后扫文件重建索引时不会把已删对象救回来。墓碑不会立刻回收空间；节点会记下待清理的票，等空闲或手动 compact 再合并文件。

写路径先进入约 1MB 的内存缓冲，再批量 `write`；flush 时默认 `fsync`。小对象很多时，inode 和 IOPS 跟 block 文件数走，而不是跟对象数走。

## 定位

对象在哪台机器、对应哪条稳定的 `recId`，全部记在 dleveldb 的 locator 里（`v: 3`），同时带上压缩类型。文件里的 `(blockId, offset, recLen)` 只留在该 block 节点的内存表中，可由扫描 `.blk` 重建。block 进程不再维护 `index/` 目录。

打开 block 存储时，扫描各 `.blk` 找到最后一条完整记录的结尾，接着往后追加，并重建 `recId` 映射。重建时先读节点本地的 `recmap.s3m` 快照，再只扫快照之后的新数据；快照不可用则扫描全部 `.blk`。不需要回放一份本地 LevelDB。如果 dleveldb 里的定位信息丢了，可以对每台 block 调用扫描接口，按记录顺序折叠墓碑，重建 locator（重建结果里仍是 `recId`，不是文件偏移）。

## 压缩

控制面在写入 block 之前压缩对象正文，默认 `zstd`（`S3DFS_COMPRESS` 也可设为 `gzip` 或 `none`）。小于 64 字节，或压缩后没有变小，就原样落盘，并把 `compressType` 记成 `none`。locator 里同时保存未压缩的 `size` / `crc`，以及盘上的 `storedSize`。读取时按 `compressType` 解压。同一份压缩后的字节会写到各数据副本。压缩类型也写进 block 的 TLV，便于重建索引时一并恢复。

## 大文件

能放进当前块剩余空间的对象，仍是一条记录。更大的对象会切成多段，后一段用 prev tag 记下前一段的 `recId`，dleveldb 只存最后一段的 locator。读取时从 last 往前走完链条，再从前向后取数。详细说明见 [大文件跨 block 存放](design-large-object.md)。

## Compaction

删除和覆盖会立刻对用户不可见，但 `.blk` 里的空洞不在当时重写。节点先出一张清理票；空闲时、按空洞比例，或手动调用 `POST /_s3dfs/block/compact` / 控制面 `compact()` 时，把还活着的记录（保留原来的 `recId`）写到新文件，更新内存映射，再删除旧文件，这一步不写 dleveldb。后台周期由 `S3DFS_COMPACT_INTERVAL_MS`（默认 30 秒，0 表示关闭）和 `S3DFS_COMPACT_DEAD_RATIO`（默认 0.2）控制。说明见 [删除空洞与 compact（虚拟记录 ID）](design-compaction.md)。

## 对象定位与副本

S3 层把对象记成字面量 `bucket/key`。Put 时按 key 的哈希从存活的 block 节点里挑 N 台（N 默认 3，且不超过存活节点数；标了 `@zone` 时先避开同一故障域），把同一份（可能已压缩的）正文写到这些机器上。达到写法定人数后，再在 dleveldb 里写下已经成功的 locator。Get 先读 locator，跳过被健康检查标为 down 的节点，按剩余副本取数并解压。列举时会丢掉 `key:1`、`key:2` 这种副本后缀，避免同一个对象出现多次。

对象 key 本身不要以 `:数字` 结尾，那是副本索引的约定。

## 故障与恢复

不是任何情况下都能秒级恢复，也没有测过确定的恢复时间上限。已经有的是健康检查、避让，以及对象副本补齐：Get 会在本次请求里尝试剩余的数据副本，新的 Put 会躲开已标记为 down 的 block；后台或 `POST /_s3dfs/repair` 会把活副本不足的对象再写到空闲的存活节点，并退役 down 的 locator。没有活副本的对象记为 `lost`，补不回来；索引主节点不可达时写入仍会失败；block 重启优先读 `recmap.s3m` 并补扫尾巴，快照不可用才全量扫描。完整说明见 [故障与恢复](design-recovery.md)。部署是否算高可用，见 [部署](deploy.md)。

## 对象规模与分布

普通本地文件系统往往一个文件一个 inode，目录里有千万文件时，inode 表和目录项会先成为问题。s3dfs 把对象正文打进少量大的 `.blk` 文件，inode 和磁盘文件数跟 block 文件走，不跟对象数走。一千万个对象，在存储侧主要是 dleveldb 里一千万条 locator（有副本时再加上 `key:1`、`key:2` 等），以及若干 1GB 的 `.blk`。对分布式 KV 来说，这个量级是常规负担，一亿条 key 也还在可预期范围里；这不是已经实测过的数字。

对象按 key 哈希分散到存活的 block 节点，不是整棵目录树绑在一台机器上。每台 block 只扛自己那一份 `.blk` 和对应的 `recId` 内存表；索引仍由单独那一小摊机器（通常 3–5 台）保存 locator。落点还受副本数影响：默认会在多台 block 上各写一份，所以是按哈希打散后再按副本数重复存放，不是严格的一人一份均分。

这不是完全没有上限。某一台机器用 FUSE 把整个桶挂成本地目录时，内核仍可能按目录项 / inode 来看这份树，列举和元数据缓存也会随文件数变重；block 节点还要在内存里维持 `recId` 映射。对象存储和索引这一层不会像普通本地文件系统那样先被 inode 撑爆，真正把含千万文件的树挂到一台客户端上时，瓶颈更可能出现在挂载进程，而不是 `.blk` 的文件个数。

## 目录挂载（FUSE）

能直接访问对象时，应使用 S3 API。本机目录挂载由独立的 `apps/fuse`（`s3dfs-fuse`）完成，只是兼容层：把路径映射成对象 key，存储仍走上面的 S3 API，不改 packed-block 或 dleveldb。它不是更快的写入路径。

挂载点对应的是整个桶，不是桶里的一条空 key。根目录通常也不单独存记录。文件 `dir1/a.txt` 就是对象 `bucket/dir1/a.txt`，正文作为 TLV 记录追加进 `.blk`；多个文件叠在同一个或几个 block 文件里。目录是 key 前缀，加上可选的空标记对象 `dir1/`。

应用侧是 `open` / `read` / `write` / `close`。写先落到客户端临时文件，`close` 时才整文件 Put，不是每次 `write()` 都追加一条记录。修改会再写一条新记录，旧记录变成空洞；删除打墓碑。改名是按新路径再写一份，再删旧 key。空洞留给 compact 清理。每个文件都是一次完整对象上传，再叠加 FUSE 或 WebDAV 的额外请求，所以小文件会明显慢于直接 Put；没有 macFUSE 的 macOS 还要多一层本机 WebDAV。完整说明见 [在对象存储上加一层可远程挂载的 FUSE](design-fuse.md)。
