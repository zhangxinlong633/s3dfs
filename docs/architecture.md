# S3DFS 架构

| | |
| --- | --- |
| 读者 | 需要理解进程边界和数据落点的人 |
| 本文回答 | 控制台、API、索引、block、引擎各管什么，一次对象如何被定位 |

S3DFS 是 S3 兼容的对象存储。控制面用 TypeScript，数据通路的核心在 C 引擎里，通过 N-API 暴露给 Node。对象索引和对象正文分开扩容：

- **索引**落在 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 上，源码在仓库根的 `dleveldb/`，一般 **3–5 台**就够。设置 `DLEVELDB_DATA_DIR` 时，索引跑在对应的 API 进程里，并仍对外提供索引端口。没设时，API 用 HTTP 访问单独的索引进程。没有 API 的机器跑单独的索引进程。
- **正文**落在每台存储机的 API 进程里。这个进程用 C 引擎把对象打进 `.blk`，并在 :9100 上给其他节点写。机器数可以远多于索引节点。本进程不再维护本地 LevelDB。
- 默认 3 份对象数据副本（受当前存活的 block 节点数限制），在索引里记成 `bucket/key`、`bucket/key:1`、`bucket/key:2`。这条记录叫做数据位置：值里是 block 节点和稳定的 `recId`，以及 `compressType` 等信息，不记盘上偏移。

一次写入经过哪些进程，见 [写入路径](write-path.html)。索引和副本的细节见 [索引与 block 集群](design-replication.md)。确认路径上还在每次对象上发生的步骤见 [写入热点](hotspots.md)。

## 语言

产品代码只有 TypeScript 和 C。控制台、S3 API、控制库和巡检进程用 TypeScript。落盘引擎和 `s3dfs-fuse` 用 C。入盘在 API 进程里调用这份引擎。不把 Python、Go 或其他语言加进产品进程。编译 `packages/engine` 时 node-gyp 可能调用本机 Python，那只属于编译工具链。

## 分层

- **控制台**（`apps/web`，Next.js，默认 :9001）：看统计、桶、block 节点状态，触发 flush。空间回收走管理接口或 block 上的 compact，见下方。
- **S3 API**（`apps/api`，Nest.js，默认 :9000）：一台机器上的那个进程，也是唯一对外的接口。Put / Get / Head / Delete / List（含 `delimiter`）和少量管理接口，GET 支持单个 `Range`。设置 `S3DFS_DATA_DIR` 时，这个进程打开本机的 C 引擎，本机副本直接追加，并在 :9100 上给其他节点写这份磁盘。设置 `DLEVELDB_DATA_DIR` 时，索引也跑在这个进程里。本机目录挂载由独立的 `apps/fuse`（`s3dfs-fuse`）完成，关闭文件时整文件交给这台 API。
- **索引**（默认 :9800）：只存很小的数据位置 JSON 和 `$node/{nodeId}` 注册信息，不存对象正文。可以嵌在 API 进程里，没有这份目录时再单独起索引进程。
- **本机磁盘**（同一 API 进程里的 C 引擎，数据端口 :9100）：对象打进追加式 1GB block 文件。一块盘默认同时开 8 个 `.blk`，最多 32 个（`S3DFS_WRITE_BLOCKS`）。每个写入线程只打开自己的一个文件。按 `recId` 在这个文件的页里读一格，得到偏移后再读对象。见 [recId 页](design-recid-page.md)。
- **存储引擎**（`packages/engine`）：C 实现追加式 block 文件。记录是带校验的 TLV 帧，方便以后加字段；也可以扫描全部 `.blk` 重建索引。
- **巡检 AI**（`apps/patrol`，TypeScript，随仓库提供）：不在写入路径上。规则根据模块快照执行修复、compact、flush 或扩容。Deep Agents 把发现和已执行的动作写成中文结论，不读对象正文，不删除、不重启、不缩容。说明见 [能力](capabilities.md#9-模块巡检)。

对象值写在各 block 节点 `data/blocks/` 下的大文件里，默认每块 1GB（`S3DFS_BLOCK_SIZE`），写满再切新文件。

单机开发时起三个进程即可：一台 dleveldb、一台 block、一台 S3 API。这时有效数据副本是 1。巡检进程可以之后再起，不参与写入路径。

## 记录格式（TLV）

每条记录是小端 TLV 帧，魔数 `S3R1`：

```
magic u32 | rec_len u32 | tags… | crc32 u32 | rec_len u32 | magic u32
```

每个 tag 是 `type u16 | length u32 | value[length]`。当前用到的类型包括 key、value、kind、mtime、crc、`recId`，以及跨块对象的 prev / seq / generation 等。不认识的 tag 按长度跳过，因此可以加字段而不改旧读取路径。帧头尾的 magic、长度和 CRC 对不上时，视为一次不完整写入，扫描停在上一条完整记录。

`kind` 区分普通对象、跨块中间段、跨块最后一段，以及删除墓碑。删除会在对应的 block 上追加一条墓碑，这样以后扫文件重建索引时不会把已删对象救回来。墓碑不会立刻回收空间；节点会记下待清理的票，等空闲或手动 compact 再合并文件。

对象 key 用 FNV 分到一条块线程。放得进这条线程写缓冲的对象先留在缓冲里。发布槽之前，正文要 `pwrite` 到它自己的 `.blk`，再定位写这一格的 4 字节。页头里留着的 4 字节不再当作这 80 KiB 槽的 CRC，写入时填 0，打开时也不核对。新开一页才把整页写一次。接入线程（`S3DFS_BLOCK_WRITE_THREADS`，默认 32）接住本机写入和对端 :9100，再把请求交给对应的块线程。同时在追加的文件数等于块线程数。fsync 默认约每 30 秒一次，不在每次对象上。小对象很多时，inode 和 IOPS 跟正在写的 `.blk` 数走，而不是跟对象数走。

## 定位

对象在哪台机器、对应哪条稳定的 `recId`，全部记在 dleveldb 的数据位置里（`v: 3`），同时带上压缩类型。盘上偏移写在 `.blk` 的 `recId` 页里：每页 80 KiB、20480 格，每格是本文件内的偏移。下一页的位置在页头。内存里只留每页的起点。空着的格留在本文件，不进入下一个 `.blk`。见 [recId 页](design-recid-page.md)。API 进程不再维护 `index/` 目录。

打开目录时读每一页的头和 80 KiB 槽，填页表，不读对象正文。按 key 找记录的内存表不在打开时重建。重启之后，按数据位置里的 `recId` 仍能读到对象。同一进程里按 key 覆盖、打墓碑和 compact，看不到重启前才存在的那张 key 表。如果 dleveldb 里的数据位置丢了，可以对每台存储机调用扫描接口，按记录顺序折叠墓碑，重建数据位置（重建结果里仍是 `recId`，不是文件偏移）。

## 压缩

控制面在写入 block 之前压缩对象正文，默认 `zstd`（`S3DFS_COMPRESS` 也可设为 `gzip` 或 `none`）。小于 64 字节，或压缩后没有变小，就原样落盘，并把 `compressType` 记成 `none`。数据位置里同时保存未压缩的 `size` / `crc`，以及盘上的 `storedSize`。读取时按 `compressType` 解压。同一份压缩后的字节会写到各数据副本。压缩类型也写进 block 的 TLV，便于重建索引时一并恢复。

## 大文件

能放进当前块剩余空间的对象，仍是一条记录。更大的对象会切成多段，后一段用 prev tag 记下前一段的 `recId`，dleveldb 只存最后一段的数据位置。读取时从 last 往前走完链条，再从前向后取数。详细说明见 [大文件跨 block 存放](design-large-object.md)。

## 压缩整理

删除和覆盖会立刻对用户不可见，但 `.blk` 里的空洞不在当时重写。节点先出一张清理票；空闲时、按空洞比例，或手动调用 `POST /_s3dfs/block/compact` / 控制面 `compact()` 时，把还活着的记录（保留原来的 `recId`）写到新文件，更新内存映射，再删除旧文件，这一步不写 dleveldb。后台周期由 `S3DFS_COMPACT_INTERVAL_MS`（默认 30 秒，0 表示关闭）和 `S3DFS_COMPACT_DEAD_RATIO`（默认 0.2）控制。说明见 [删除空洞与 compact（虚拟记录 ID）](design-compaction.md)。

## 对象定位与副本

S3 层把对象记成字面量 `bucket/key`。Put 时按 key 的哈希从存活的 block 节点里挑 N 台（N 默认 3，且不超过存活节点数；标了 `@zone` 时先避开同一故障域），把同一份（可能已压缩的）正文写到这些机器上。默认要达到当次选出副本数的多数，再在 dleveldb 里写下已经成功的数据位置，然后返回。其余副本在返回之后继续写。`S3DFS_WRITE_QUORUM=1` 时只等一份：先写这台 API 自己的磁盘，本机盘不能写时再试下一台。这份正文和它的数据位置写完就返回。Get 先读数据位置，跳过被健康检查标为 down 的节点，按剩余副本取数并解压。列举时会丢掉 `key:1`、`key:2` 这种副本后缀，避免同一个对象出现多次。

对象 key 本身不要以 `:数字` 结尾，那是副本索引的约定。

## 故障与恢复

没有测过确定的恢复时间上限。Get 会在本次请求里尝试剩余的数据副本，新的 Put 会躲开已标记为 down 的 block。后台或 `POST /_s3dfs/repair` 会把活副本不足的对象再写到空闲的存活节点，并退役 down 的数据位置。没有活副本的对象记为 `lost`，补不回来，本进程的健康检查随之返回 503。索引在剩余副本达到法定人数时仍可写入，节点回来后由 dleveldb 按较新的 mtime 追平。磁盘进程重新打开目录时读 `RECID_v1` 页，不靠 `recmap.s3m`。完整说明见 [故障与恢复](design-recovery.md)。一套部署是否可以承接业务，见 [部署](deploy.md) 和 [上线标准](diff/production.md)。从压缩包启动的步骤在 [部署](deploy.md) 第 8 节，压缩包里也有一份 `使用说明.md`。

## 对象规模与分布

普通本地文件系统往往一个文件一个 inode，目录里有千万文件时，inode 表和目录项会先成为问题。s3dfs 把对象正文打进少量大的 `.blk` 文件，inode 和磁盘文件数跟 block 文件走，不跟对象数走。一千万个对象，在存储侧主要是 dleveldb 里一千万条数据位置（有副本时再加上 `key:1`、`key:2` 等），以及若干 1GB 的 `.blk`。对分布式 KV 来说，这个量级是常规负担，一亿条 key 也还在可预期范围里；这不是已经实测过的数字。

对象按 key 哈希分散到存活的 block 节点，不是整棵目录树绑在一台机器上。每台存储机扛自己的 `.blk`。`recId` 页的起点留在内存里，每一条对象的偏移留在页上。索引仍由通常 3–5 台机器保存数据位置。落点还受副本数影响：默认会在多台 block 上各写一份，所以是按哈希打散后再按副本数重复存放，不是严格的一人一份均分。

这不是完全没有上限。某一台机器用 FUSE 把整个桶挂成本地目录时，内核仍可能按目录项 / inode 来看这份树，列举和元数据缓存也会随文件数变重；存储机在内存里留的是每页起点，不是每一条 `recId`。对象存储和索引这一层不会像普通本地文件系统那样先被 inode 撑爆，真正把含千万文件的树挂到一台客户端上时，瓶颈更可能出现在挂载进程，而不是 `.blk` 的文件个数。

## 目录挂载（FUSE）

能直接访问对象时，应使用 S3 API。本机目录挂载由独立的 `apps/fuse`（`s3dfs-fuse`）完成，只是兼容层：把路径映射成对象 key，存储仍走上面的 S3 API，不改 packed-block 或 dleveldb。它不是更快的写入路径。

挂载点对应的是整个桶，不是桶里的一条空 key。根目录通常也不单独存记录。文件 `dir1/a.txt` 就是对象 `bucket/dir1/a.txt`，正文作为 TLV 记录追加进 `.blk`；多个文件叠在同一个或几个 block 文件里。目录是 key 前缀，加上可选的空标记对象 `dir1/`。

应用侧是 `open` / `read` / `write` / `close`。写先落到客户端临时文件，`close` 时才整文件 Put，不是每次 `write()` 都追加一条记录。修改会再写一条新记录，旧记录变成空洞；删除打墓碑。改名是按新路径再写一份，再删旧 key。空洞留给 compact 清理。每个文件都是一次完整对象上传，再叠加 FUSE 或 WebDAV 的额外请求，所以小文件会明显慢于直接 Put；没有 macFUSE 的 macOS 还要多一层本机 WebDAV。完整说明见 [在对象存储上加一层可远程挂载的 FUSE](design-fuse.md)。
