# 与 GFS 的对照

| | |
| --- | --- |
| 日期 | 2026-11-21 |
| 读者 | 要从 Google 文件系统论文里挑机制、又不想换成那套架构的人 |
| s3dfs | 以当时仓库的 [架构](../architecture.md)、[能力](../capabilities.md) 为准 |
| GFS | 以 2003 年 SOSP 论文为准。后继系统是 Colossus，不在本文里 |
| 怎么读 | 标准对照的项目和 s3dfs 列，与本目录其他文件系统对照相同。特色只写 GFS 多出来的部分 |

GFS 给大文件的顺序读和末尾追加用。一个 master 记命名空间和 chunk 位置，chunkserver 存 64 MiB 的 chunk。s3dfs 给大量小对象用。两边都把元数据和正文拆开，对象大小和写成功条件不是一回事。

## 标准对照

| 项 | s3dfs | GFS |
| --- | --- | --- |
| 它解决什么 | 大量小对象的 S3。key 由调用方指定 | 大文件的顺序读，以及在文件末尾追加 |
| 跑在哪 | 多台机器。API、dleveldb 索引、block 三种进程。故障域是 block 上的 `@zone` | 一个 master，多台 chunkserver。master 是命名空间的单点 |
| 元数据 | 每个对象一条 locator JSON（v:3），在 dleveldb。Get 先问索引 | master 内存里有命名空间和文件到 chunk 的映射。chunk 在哪些 chunkserver 上，由心跳报上来，master 不把位置当持久化的唯一来源 |
| 正文 | 追加进约 1 GiB 的 `.blk`。记录是 `S3R1` TLV。locator 记节点和 `recId`，不记偏移 | 文件切成 64 MiB 的 chunk。chunk 里再按 64 KiB 做校验和 |
| 名字 | `bucket/key`。第 i 份（i≥1）在 `bucket/key:i` | 目录路径。文件切成编号的 chunk，名字本身不编码位置 |
| 冗余 | 默认同一份对象 3 份，落在不同 zone | 默认每个 chunk 3 份 |
| 写成功 | 3 份里 2 份 block 成功即写索引。第 3 份由修复补。任一条 locator 失败则删掉本次已写的 locator | 主副本定序。每一份都确认之后，客户端才收到成功 |
| 读和校验 | 读一份活副本。记录 CRC 和 locator 上的正文 CRC 对不上就换下一份 | 读一份副本。64 KiB 校验和失败就换另一份 |
| 损坏之后 | 健康检查跳过 down 节点。`repair` 把不足的份数补到仍在线的节点，并去掉 down 的 locator。一份都不活记 `lost` | master 发现副本数下降后再复制一份 |
| 崩溃恢复 | `.blk` 里只承认完整记录。索引按法定人数写入。`recmap.s3m` 只是重启缓存，坏了就重扫 `.blk` | chunkserver 重启后用心跳把本机 chunk 报回 master。操作日志用来恢复 master 的命名空间 |
| 扩容 | 新 block 只接新写入。旧 locator 留在原节点 | 新 chunkserver 用心跳加入。已有 chunk 靠再复制和再平衡搬走 |
| 某一刻 | 版本清单在索引，正文在 block 的 `$ver/` | 论文里的快照靠 copy-on-write 把目录树留住。不是 S3 版本号 |
| 压缩与配额 | 默认 zstd，压不小则存原文。没有桶配额 | 论文不把压缩和配额当文件系统的一部分 |
| 拷贝 | CopyObject 读出再写入 | 按 chunk 复制。没有对象存储那种服务端 Copy |

## 特色

| 只在 GFS 里的做法 | 它怎么做 | s3dfs 现在 |
| --- | --- | --- |
| 主副本租约 | 一个 chunk 在租约期内只有一台主副本给写操作定序。租约过期后别人才能当主 | 三份对等。没有主副本，法定人数提交 |
| 位置不落成唯一事实 | chunk 在哪由 chunkserver 报上来。master 重启后靠心跳重建位置 | locator 是持久的。节点和 `recId` 写在索引里，不靠 block 心跳重建对象位置 |
| record append | 在文件末尾追加。各副本上的填充可能不完全对齐，读的时候靠校验和选一份能用的 | 对象按整段替换。覆盖是新的 locator，不是在旧记录末尾追加 |
| 64 KiB 校验块 | 坏掉的是这一段，不必把整个 chunk 判废 | CRC 覆盖这一条记录里的键和正文。一条记录坏了就换整份对象副本 |
| master 不在数据路径上 | 客户端拿到 chunk 位置之后，字节直接和 chunkserver 来往 | 数据路径上是 API 和 block。索引只在取 locator 和提交 locator 时出现 |

## 留下的

元数据服务确认位置之后，不再站在每一次字节传输上。校验按比整段对象更小的单位做，读到坏数据就换副本。副本少了由控制面再复制，而不是等下次写入碰巧写满。

## 不照搬的部分

每个文件的元数据都放在一台 master 的内存里。对象数量上去之后，这台机器先满。写成功要等齐全部副本，比法定人数更严，一台 chunkserver 慢就会拖住写入。64 MiB chunk 和 record append 是为大文件末尾追加准备的，不替换 `.blk` 里的小对象记录。
