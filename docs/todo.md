# 待办

| | |
| --- | --- |
| 日期 | 2026-11-21 |
| 读者 | 排期和验收的人 |
| 权威清单 | [上线标准](diff/production.md)。本文只保留还没关闭的事项，并记下标准没单列、但会在声明负载上出错的代码 |
| 结论 | 代码侧八项里能在仓库里补的已经补上。本机按生产布局演练通过，并补了 1 KiB 与 1 MiB 的 3 副本 localhost 数字。还不能让一套部署保管业务数据的唯一副本：目标集群的容量和演练还没做，准备接流量的机器也还没按部署脚本装过 |
| 对照 | 架构判断在 [与主流系统的位置](diff/mainstream.md) |

上线标准的八项里，单次 Put 的内存上限已经按块转发。还要在准备承接流量的集群上测量、做完演练，并按 [部署](deploy.md) 第 8 节的例子把选定的环境装起来。桶列表、版本正文和管理写接口这三项代码已经补上。

可以承接的负载仍是 [上线标准](diff/production.md) 第 1 节：Nest API、至少 2 台 API 加负载均衡、3 台分属不同 `@zone` 的 block、3 副本、dleveldb 至少 3 节点、密钥齐全、大量小对象。本机 localhost 的数字不能用来定容量。

## 尚未关闭

| 事项 | 状态 | 关闭条件 |
| --- | --- | --- |
| 上线容量 | 本机已测，目标集群未测 | 在准备上线的机器和网络上测出 1 KiB 与 1 MiB、3 副本的读写数字，写入 [benchmarks.md](benchmarks.md)。2026-11-21 的三次 localhost 测量只说明形状，不能用来定容量 |
| 目标集群演练 | 本机已演练，目标集群未做 | 在准备承接流量的集群上完成下面五步，把命令、时间和结果写入部署笔记。本机笔记见 [2026-11-21 本机演练](milestones/2026-11-21-local-drill.md)。没有目标集群的笔记，该集群不能当作唯一副本 |
| 生产部署 | 打包、测试、打标签和三种环境的脚本已在仓库。准备接流量的机器还没按它们装过 | 按 [部署](deploy.md) 第 7 节，在准备接流量的环境执行 render 出的 systemd、Docker 或 Kubernetes 安装。索引和 block 的数据目录还在。装完后该环境 `GET /_s3dfs/health` 为 200。只在本机打出 `dist/` 或只跑过测试不算关闭 |

演练步骤与上线标准第 3 节相同：

1. 三个 zone 均在线时，`GET /_s3dfs/health` 为 200，`layout.ok` 为真。
2. 停一个 zone 的 block：新 Put 成功，Get 读到刚写的内容。修复后 locator 只指向仍在线的节点。该节点恢复并再次修复后回到 3 份。再停到只剩 1 台：新 Put 失败，健康检查 503，正文含 `reasons`。
3. 停一个索引节点：Put 仍成功，另一台 API 能 Get 到同一对象。空节点追平后，已有对象仍能 Get 和 List。
4. 带密钥完成建桶、上传、分片上传、Range 读、删除和删除空桶。无密钥请求被拒绝。分片要上传两段、重启 API、完成后再 Get，字节与逐段拼接一致。
5. 删除演练用的桶，确认没有留下 `lost`。健康检查回到 200。

构造一个全部副本不可读的对象并执行修复：健康检查 503，`lost` 至少为 1。这条属于「丢失可见」的验收，放进第 2 步或单独做均可，结果同样写入部署笔记。

## 已经落地、仍须在目标集群复核

仓库内测试覆盖了路径，不能代替上一节的演练。

| 事项 | 代码现状 |
| --- | --- |
| 正文副本 | 一台 block 已标为 down、其余仍够法定人数时继续写，修复先去掉已停节点上的 locator，节点回来后再补第 3 份。全部在线但节点或故障域不够配置份数时拒绝写入。`packages/control/test/layout.test.ts`、`put-quorum.test.ts` |
| 索引故障 | 控制面在配置的索引地址之间切换。dleveldb 在主节点不可达且剩余副本达到法定人数时接受写入，节点回来后按较新的 mtime 追平。三进程测试已通过 |
| 索引提交 | 任一条 locator 写入失败，删除本次已写入的 locator，再向客户端返回错误。`packages/control/test/commit.test.ts` |
| 分片 | 清单留在索引，正文进入 block，key 为 `bucket/$upload/<id>/<part>`，列表不可见。新的 `MultipartUploads` 能读到上一个进程留下的段。`apps/api/test/upload-block.test.ts` |
| 丢失可见 | 修复写入 `$lost/`。`GET /_s3dfs/health` 先 `syncLost`，JSON 含 `lost` 和 `lostKeys`。计数不在重启时清零 |
| 入口 | 默认严格布局下，缺访问密钥或秘密密钥时，进程在监听前退出。两个密钥都在时，无签名请求 403。`apps/api/test/auth-gate.test.ts` |
| 单次上传 | 不超过 1 MiB 的正文仍走原来的压缩路径。更大的原始 Put 按最多 1 MiB 一块转发到 block，API 不保留整段。ETag 仍是正文 CRC32。`packages/control/test/put-stream.test.ts` |
| 桶列表 | 扫到一页末尾仍在同一个桶里时，跳到该桶前缀之后继续，直到索引截断标志为假。`packages/control/test/list-buckets.test.ts` |
| 版本正文 | 版本清单留在索引。正文书到 block 的 `bucket/$ver/<key>/<id>`。`apps/api/test/version-block.test.ts` |
| 管理写接口 | `POST /_s3dfs/flush`、`compact`、`repair` 在配置了巡检令牌或访问密钥之后，要求令牌或 SigV4。两者都没配时保持开发端口开放。健康检查仍不鉴权。`apps/api/test/admin-auth.test.ts` |
| 模块巡检 | 规则执行维护，模型写中文结论。2026-11-20 单机自启记录见 [里程碑](milestones/2026-11-20-first-patrol.md) |

C 网关不是默认上线入口。它要接到同一负载均衡后面时，另满足上线标准第 4 节：分片正文在重启后仍在、`aws-chunked` 与 Nest API 同一套校验、第 3 节演练改走网关再做一遍。

## 标准没要求先改、上线后仍会碰到

| 事项 | 现状 |
| --- | --- |
| 分片完成 | 未加密的完成请求按段交给 `putStream`，不再 `Buffer.concat`。带服务端加密时仍拼成一段再封口。验收只要求重启后字节一致 |
| 大对象压缩和加密 | 超过 1 MiB 的流式 Put 按原文写入，不再做 zstd。带 `x-amz-server-side-encryption` 的对象仍要求能放进 1 MiB 缓冲，否则 400。`aws-chunked` 仍整段读入后再解码 |
| 控制台按钮 | Flush、Compact、Repair 改走控制台自己的 `/api/s3dfs/<action>`。令牌放在 Web 进程的 `S3DFS_PATROL_TOKEN`，不进浏览器。API 地址用 `S3DFS_API_BASE_URL`，没有则用 `NEXT_PUBLIC_API_BASE_URL` |
| 管理读接口 | `GET /_s3dfs/stats`、`cluster`、`buckets`、`metrics` 仍不校验身份。健康检查保持开放，给负载均衡探活 |
| 丢失与故障 | 对象丢失写在 `$lost/`，健康检查重启后仍列出这些 key。未关闭的故障事件仍在 API 进程内存里 |
| 对象计数 | `stats` 的对象数只数索引扫描的前 10 万条。每台 locator 数扫到 2 万条就停止，之后该台记成 1。巡检快照超过约 8 KB 时从末尾丢掉 block 节点 |
| 扩缩 | 未配置 `S3DFS_SCALE_UP_CMD` 与 `S3DFS_SCALE_DOWN_CMD` 时只判断，不开关机器。加 block 之后旧对象的 locator 留在原节点，新写入才用新节点。MinIO 追加 pool 也不把旧对象搬过去 |
| 持续集成 | `.github/workflows/test.yml` 在 push 和 pull request 上跑 `bun test packages/control/test apps/api/test` |
| 恢复时间 | 没有测过。做法见下面「成熟度还没到」：停一台 block、停一台索引，记健康检查回到 200 的时间 |

## 多对比之后的位置

材料与 [mainstream.md](diff/mainstream.md) 相同，日期 2026-11-21。这一节补上 CubeFS、Ozone，以及上一轮没展开的产品面。JuiceFS 是架在对象存储前面的文件系统，不放进同一张表。AWS S3、GCS、Azure Blob 不由本系统管盘，只在接口兼容那一行当作客户端期望。GFS、TFS、FastDFS、单机文件系统、CephFS、Ceph Block、Longhorn、NFS 和 SMB 各有一份对照，场景对不上，机制里有可留的。MinIO 的放置和代码量在 [minio.md](diff/minio.md)。摘要在本节末尾。

### 冗余、读和扩容

| | 写成功 | 读 | 加机器以后 |
| --- | --- | --- | --- |
| s3dfs | 3 份里 2 份 block 成功即写索引，第 3 份修复补 | 读一份活副本，CRC 不对再换 | 旧 locator 不动 |
| Garage `consistent` | 3 份里读写法定人数都是 2 | 两份元数据一致才回答 | 改布局后重新平衡 |
| SeaweedFS 热数据 | 每一份都要成功；缺卷不自动补，要跑 `volume.fix.replication` | 读一份；master 不在读路径上 | 卷可以在服务器之间搬 |
| MinIO 社区 / RustFS | 纠删集凑够 K 片；校验片占一半时写要 K+1 | 凑够数据片 | 追加 pool 或集，旧对象留在原集。一个 pool 整体失去法定人数时，MinIO 停掉整个部署的 I/O |
| Ceph RGW | 桶索引复制；数据池常用纠删 | 索引走复制，数据凑片 | CRUSH 把新 OSD 算进放置，已有对象靠再平衡搬 |
| CubeFS | Master 管拓扑。数据是副本或纠删 | 副本读一份；纠删凑片 | MetaNode、DataNode 按分区加 |
| Ozone | Ozone Manager 管元数据，容器默认三副本，也可纠删 | 副本读一份；纠删凑片 | DataNode 上的容器可以再复制 |

s3dfs 的写条件已经和 Garage 的多数同类，读条件和 SeaweedFS 热数据、CubeFS/Ozone 的副本读同类。容量仍是裸盘的约三分之一。纠删那一档（MinIO、RustFS、Ceph 数据池、SeaweedFS 温数据 10+4、Ozone 的纠删容器）大约能卖出七成裸盘。这是选择，不因为对照而改默认路径。

索引在每次 Get 上。SeaweedFS 的 master、以及客户端缓存的卷位置，不在读路径上。s3dfs 的小对象延迟底数在 dleveldb 这一跳。

### 产品面

| 能力 | 主流做法 | s3dfs | 排期 |
| --- | --- | --- | --- |
| 单次上传的内存 | 网关流式写到卷、容器或纠删片 | 超过 1 MiB 的原始 Put 按块进入 block。`aws-chunked` 仍整段读入 | 代码已补。容量数字和演练仍开着 |
| 分片完成 | 按段提交，不在一个进程里拼出整个对象 | 未加密的完成走 `putStream`，按段转发。加密仍拼成一段 | 不挡八项 |
| 桶列表 | 桶是独立元数据 | 按页扫描，一页停在同一个桶里就跳过该桶余下的 key | 代码已补 |
| 版本 | 版本号在元数据，正文仍在数据盘 | 清单在索引，正文在 block 的 `$ver/` | 代码已补 |
| 身份 | IAM 或等价的多用户、多策略 | 一对访问密钥。另有一份桶策略、单密钥 AES256 | 不作为上线前提 |
| 管理写操作 | 单独的管理员身份 | 配置了令牌或密钥后，flush、compact、repair 要求其中之一。控制台由自己的服务端路由附上 `S3DFS_PATROL_TOKEN` | 代码已补 |
| 探活与指标 | 健康是集群状态；Prometheus 一类的拉取接口 | `lost` 来自 `$lost/`，健康 JSON 带 `lostKeys`。`/_s3dfs/metrics` 是进程启动以来的状态码计数 | 指标格式不挡八项。不改成 Prometheus |
| ETag | MD5，或分片的 MD5 再加段数 | 整段 CRC32，响应带 `x-s3dfs-etag-algorithm: crc32`。核对正文用 `Content-MD5` | 对接时讲明。不改成 MD5 也能上线 |
| 压缩 | 多数不在服务端默默压缩 | 默认 zstd，压不小则存原文 | 保持 |
| 对象锁、站点复制、配额、审计、KMS、远程分层 | MinIO、Ceph、Garage、RustFS、Ozone 的程度不一，都已放在数据面或相邻组件上 | 对象锁开关、保留期和法律保全已有。配额是管理接口上的 `quotaBytes`。站点复制、KMS 和远程分层还没有 | 值得做，不挡八项。见文末「对照 MinIO 值得做」 |
| 小对象的进程上限 | SeaweedFS 内存里约 16 字节一条 | 单进程活记录停在 2^30 − 1。按 1 KiB 算大约 1 TiB 逻辑数据就要拆进程；按 1 MiB 算，一块 1 PB 盘仍在上限以内 | 见 [规模说明](scale.md)。不挡当前八项 |

### 由此不改的判断

默认冗余继续用 3 份整对象，不用纠删替换 `.blk`。部署继续是索引、block、API 三种角色，不做成 MinIO、RustFS 那种每台机器同一个进程。S3 主路径继续是官方 AWS CLI 的路径风格：建桶、上传、分片、Range、拷贝、删除、条件请求、用户元数据、批量删除。

### 场景对不上、机制可留

GFS、淘宝 TFS、FastDFS 管的是文件，不是带桶和 SigV4 的对象。ZFS、Btrfs、BSD 上的卷和文件系统、NTFS、APFS 都在一台机器的盘上。CephFS 和 NFS、SMB 给的是共享目录，Ceph Block 和 Longhorn 给的是一块盘。每份对照先写原理与细节：分层、磁盘上的单位、名字怎么找到字节、一次写、一次读、校验放在哪、副本是什么形状、规模。然后再用同一张标准表：它解决什么、跑在哪、元数据、正文、名字、冗余、写成功、读和校验、损坏之后、崩溃恢复、扩容、某一刻、压缩与配额、拷贝。后面另有修复与运维：自我修复、自运维、AI 辅助检查、静默损坏巡检、告警与升级。成熟度只分五档：没有、手工、规则自动、闭环、产品。再后面是省心与数据保护：值班可以不碰什么、仍要碰什么，以及写下去、读出来、删错、整机丢失和另一场地各保护到哪。s3dfs 那一列在这些对照里相同。各系统多出来的机制写在该文件的特色里。下面只留判断。默认路径仍是上面那一段。

| 系统 | 它怎么放数据 | 可留下的一点 | 不搬的原因 |
| --- | --- | --- | --- |
| [GFS](diff/gfs.md)（2003） | 一个 master 记命名空间和 64 MiB chunk 的位置，位置由 chunkserver 心跳报上来。客户端拿到位置后直接读写 chunkserver。默认 3 副本，写成功要每一份都确认。chunk 内按 64 KiB 做校验和 | 元数据服务不在数据路径上。校验和比整段对象小。副本少了由 master 再复制一份 | 每个文件的元数据都在 master 内存里，海量小对象会把 master 撑满。写要等齐全部副本，比法定人数更严。chunk 是大文件顺序追加的单位 |
| [TFS](diff/tfs.md) | 两个 NameServer 一主一备。小文件并进块，块大小常见 64 MiB，块在集群里有唯一编号。NameServer 只记块在哪些 DataServer 上。文件名由客户端编进块号和文件号，最长约 18 字节。DataServer 上另有该块的索引。公开材料里一块常见 3 份，并且要每一份都写完才算成功。一份损坏时按 CRC 换另一份。空闲时按块做均衡和复制 | 块是复制、均衡和修复的单位，小文件只是块里的一条记录。一级索引按块，不按文件。返回名里带位置，读的时候可以先用缓存的块位置 | S3 的 key 由调用方指定，不能把块号编进 key，所以每次 Get 仍要问索引。写成功条件保持法定人数，不等齐 3 份。不另做主辅机房重放 |
| [FastDFS](diff/fastdfs.md) | Tracker 只知道组和 storage，不存每个文件的索引。同组 storage 互为镜像，容量按组内最小的那台算。上传在一台落盘后就返回，file id 里带有源 storage、时间、大小和 CRC32。同组其他机器靠 binlog 异步推送。源操作用大写字母，副本用小写，避免来回推 | 组可以当成一个故障域。file id 自带 CRC32，读的时候能核对。Tracker 保持得很小 | 上传返回时往往只有一份在盘上，源机器在同步完成前坏了，这份就没了。这和「2 份成功才写索引」相反，不拿来当写成功条件 |
| [MinIO](diff/minio.md) | 一个 Go 进程上的纠删 S3。对象切成数据片和校验片，元数据是盘上的 `xl.meta`。写到 quorum 才成功。后台修复用剩余片补缺片。全部 Go 约 34.5 万行，纠删和 xl 大约 4 万行，池文件 3005 行 | 同一条盘格式可以写得很短。修复会再看结果，片不够就不编造正文 | 不改成纠删，也不改成一对象一份 `xl.meta`。IAM、站点和对象锁不作为上线前提 |
| [ZFS](diff/zfs.md) / OpenZFS | 一台机器上的池。镜像或 RAID-Z。写时复制：新块写完再改指针。块的校验和记在父指针里，不记在块自己身上。读到校验失败就用冗余副本修好。scrub 把整池走一遍。快照、克隆、`zfs send`/`recv`。数据集上有压缩、配额和预留 | 校验和和正文分开存，静默损坏盖不过父指针。scrub 是全量巡检，和「缺了副本再补一份」是两件事。快照加 send/recv 是整池备份的形状。压缩按数据集开 | 池在一台机器上，没有跨 zone 的 3 副本。RAID-Z 是纠删，不替换 `.blk` 的 3 副本。不把快照做成在线的 S3 版本 |
| [Btrfs](diff/btrfs.md) | 单机、写时复制。元数据里带 crc32c。子卷、快照、send/receive、zstd。加盘之后用 balance 把已有数据搬匀。RAID 0/1/10 能用 | 子卷是配额和快照的边界。balance 说明「加盘以后可以搬旧数据」，以及这件事要单独做 | RAID 5/6 长期不能当唯一副本。balance 会搬旧数据，s3dfs 加 block 之后旧 locator 仍留在原节点 |
| [FFS](diff/ffs.md)、[HAMMER2](diff/hammer2.md) | FFS 用软更新记下元数据依赖，崩溃后按依赖恢复，不必为每步元数据都等一次日志提交。UFS2 有快照。FreeBSD 的 GEOM 在文件系统下面叠镜像、条带、日志和加密，文件系统看不见这些层。DragonFly 的 HAMMER2 在卷上做写时复制、快照、CRC、压缩，以及卷一级的主从复制 | 镜像、校验、加密可以叠在对象接口下面，和现在的 API、索引、block 分层同一类。卷一级复制可以整目录拷走，不必按 key 扫一遍 | 软更新不放进 dleveldb。GEOM 和 HAMMER2 仍是一台或少数几台机器上的盘，不提供 S3 |
| [NTFS](diff/ntfs.md) | `$LogFile` 记元数据日志，崩溃后重放日志，不扫全盘。很小的文件可以住在 MFT 记录里。USN 变更日志按顺序记下命名空间的变化，供增量备份和审计。另有压缩、稀疏文件和 EFS | 变更日志是审计和增量复制的形状：记「哪个 key 变了」，不记正文。元数据日志让重启不必把所有对象再读一遍 | 小文件住进索引这条不学。版本正文刚从索引挪到 block，避免索引被正文撑大 |
| [APFS](diff/apfs.md) | 一个容器里多个卷共享剩余空间。元数据对象带 Fletcher-64 校验和，用户数据块不校验，靠盘自己的 ECC。克隆在同卷里拷贝文件时只改元数据，两边改写才分配新空间。快照按写时复制留住某一刻。加密按卷，系统卷和数据卷分开 | 同池拷贝可以先共享底层块，调用方改一边再写新块。多个卷共享空间，再按卷给快照和加密。元数据校验和用户数据校验是两件分开的事 | 用户数据没有 ZFS 那种放在父指针里的校验和，静默损坏靠盘。克隆和共享空间都在一台机器的容器里。S3 的 Copy 仍是读出再写入 |
| [CephFS](diff/cephfs.md) | MDS 管目录，文件切成 RADOS 对象，客户端直接读写 OSD。元数据池通常是副本，数据池可以是纠删。多个 active MDS 按目录分子树 | 元数据确认之后正文不经它转发。副本不够由 backfill 补。目录是配额和快照的边界 | 不做 POSIX、硬链接和客户端能力缓存。纠删数据池不替换 3 副本。旧 locator 不按 CRUSH 搬走。RGW 才是这套集群上的 S3 |
| [Ceph Block](diff/ceph-block.md) | RBD 镜像切成 RADOS 对象。常见复制池 3 份、写到 `min_size` 2 份即成功。快照克隆共享未改的对象。同一张镜像用 exclusive-lock 限制一个写入者 | 写成功可以是多数副本，不必等齐。克隆和「哪些块写过」的位图让差量不必扫完整张盘 | 不做块设备和偏移读写。单写入者锁不放进 S3。克隆不在上线八项里 |
| [Longhorn](diff/longhorn.md) | Kubernetes 里的卷。副本是节点盘上的快照链，常见 3 份且不同节点。一个引擎对 Pod 提供这块盘。副本丢失后从健康副本整卷重建。快照可备份到 S3 或 NFS | 份数不够就换一台机器再做一份。全部副本都没了要明确标丢失 | 修复单位仍是对象，不按整卷重建，也不把快照链当成副本格式 |
| [NFS](diff/nfs.md) | 服务器导出目录树。`UNSTABLE` 写可以先留在服务器内存，再由 `COMMIT` 落盘。NFSv4 用委派把缓存交给一个客户端。pNFS 把布局发给客户端，字节直接去数据服务器 | 把「已经收下」和「已经落盘」分开写清楚。元数据确认后正文可以不经元数据服务转发 | 写成功仍是法定人数落盘后再写索引。不做挂载、文件句柄和委派。导出目录不等于已经有 3 份 |
| [SMB](diff/smb.md) | 文件共享。SMB3 有会话加密、多通道、租约和变更通知。集群切换时见证协议通知客户端，持久句柄尽量接上已打开的文件。文件副本不在协议里 | 冲突时收回客户端缓存。变更按名字推送，不把正文再送一遍。切换时由集群通知，而不是只靠客户端超时 | 不做共享、打开句柄和租约。会话加密不代替对象副本。变更通知不在上线八项里 |

下面把对照里值得收到这条代码路径上的设计列成待办。写成功仍是 3 份里的 2 份，默认冗余仍是整对象 3 副本，S3 key 仍由调用方指定。这些都不挡上面的八项。

### 已经是同样的原理，不再排期

法定人数写成功，对应 Ceph 复制池的 `min_size`，不退回 GFS、TFS 的全部副本确认，也不退回 FastDFS 的单台落盘就返回。索引只在取 locator 和提交 locator 时出现，字节在 API 和 block 之间走，这是 GFS、TFS、pNFS 的分层，不做成客户端直连 block。校验和已经记在记录帧和 locator 里，不记成正文的自述。删除用墓碑挡住扫描救回。

### 要收进来的设计

| 设计 | 从哪来 | 在 s3dfs 里做成什么 | 不一起搬 | 关闭条件 |
| --- | --- | --- | --- | --- |
| 全量巡检和补副本分开 | [ZFS](diff/zfs.md) 的 scrub 对 resilver，[CephFS](diff/cephfs.md) 的 deep-scrub | 代码已补：`scrub` 按 locator 核对正文 CRC，坏的那一份用活副本重写。`repair` 仍只补缺少的份数 | 不改成 RAID-Z 或纠删。巡检不承诺恢复时间 | `packages/control/test/rest.test.ts`：注入 CRC 不对的副本后 Get 恢复；两份都坏时记 `lost` |
| 补副本不经 API 拼整段 | [TFS](diff/tfs.md)、[GFS](diff/gfs.md) 以块为复制单位 | 代码已补：大于 1 MiB 的对象，`repair` 按 1 MiB 范围从源 block 读到目标 block 的 write 流。小对象仍读出再写入 | 不把块号编进 key。写成功仍是法定人数 | `packages/control/test/rest.test.ts`：补副本走 `start=` 和 write 流，不走整段 Put |
| 丢失跨重启还在 | [Longhorn](diff/longhorn.md) 把救不回写清楚 | 代码已补：修复写入 `$lost/`，`syncLost` 再数一遍。健康 JSON 带 `lostKeys` | 不在重启时把计数清零假装恢复 | 新的 `ObjectCluster` 调用 `syncLost` 之后，先前的 `$lost/` 仍在，健康响应里有这些 key |
| 变更只记名字 | [NTFS](diff/ntfs.md) 的 USN，[SMB](diff/smb.md) 的变更通知 | 追加一条日志：操作、bucket、key、时间。不写正文。增量备份和审计从这个日志读，而不是扫全部 key。代码已补：Put 和 Delete 写 `$chg/` | 小文件不因此写进索引。不替代对象正文的 3 副本 | 连续 Put、覆盖、Delete 之后，日志顺序与操作一致，条目里没有正文 |
| 坏段不要整对象重读 | [GFS](diff/gfs.md) 的 64 KiB 校验和 | 代码已补：Put 在 locator 上记下每 64 KiB 的 CRC。Get 对不上时只向下一份重取那一段 | 不引入主副本租约，写不等齐 3 份 | `packages/control/test/rest.test.ts`：坏段重取两次，好段只取一次 |
| 同集群 Copy 先共享记录 | [APFS](diff/apfs.md) 克隆，[Ceph Block](diff/ceph-block.md) 从快照克隆 | 代码已补：`shareCopy` 让目标 locator 指向已有记录并记 `$ref/`。覆盖改走新的 `dataKey`，不退役仍被引用的记录。引用归零才墓碑 | 不代替跨 zone 的 3 副本。共享只发生在已经写成功的记录上 | `packages/control/test/rest.test.ts`：Copy 不再 Put；改一边之后另一边字节不变 |
| 桶是配额和压缩的边界 | [ZFS](diff/zfs.md) 数据集，[Btrfs](diff/btrfs.md) 子卷 | 桶上可以关掉压缩，并设逻辑字节上限。超过上限的 Put 失败，其他桶不受影响。代码已补：`setBucketLimits`。没设配额时不写 `$usage/`，设上之后按 locator 合计已有字节再往下记 | 不做目录配额，不做子卷和 POSIX | 一个桶达到上限后继续 Put 得到明确错误，另一个桶仍可写 |
| 故障域按最紧的盘记账 | [FastDFS](diff/fastdfs.md) 的组容量 | 健康检查按 zone 给出可写字节，并标出同 zone 里明显更小的盘。加一块大盘不把这个数抬高。代码已补：block 报 `freeBytes`，健康检查带 `zones` | 不改成单台落盘就返回 | 同 zone 两块盘容量差一倍时，健康输出里的可写字节等于较小的那块 |
| 搬旧数据是单独任务，默认关闭 | [Btrfs](diff/btrfs.md) 的 balance | 代码已补：`POST /_s3dfs/rebalance?nodeId=` 把还没在该节点上的对象复制过去，并去掉一份旧 locator。加节点不会自动调用 | 不在加节点时自动 balance。不做 RAID 5/6 | `packages/control/test/rest.test.ts`：不调用时新节点没有 locator；调用后报告字节数，份数不变 |
| 另一场地要送出去 | [ZFS](diff/zfs.md) 的 send/recv，[Longhorn](diff/longhorn.md) 的备份目标 | 代码已补：`sendChanges` 按 `$chg/` 把 Put 送到另一套集群的 `put`。之后的 Delete 不删目标。默认不调用 | 不默认开启，不把本集群的 3 副本叫作异地备份 | `packages/control/test/rest.test.ts`：源 Delete 之后，已经送出的对象仍留在目标 |
| 坏 locator 换下一份 | [ZFS](diff/zfs.md)、[APFS](diff/apfs.md) 把元数据校验和用户数据分开 | 某一份 locator JSON 解析失败或字段对不上时，Get 改试 `:1`、`:2`。不要把坏 JSON 当成对象不存在。代码已补 | 不因此减弱用户数据的 CRC。不把小文件正文放进索引 | 写坏第 0 份 locator 之后，Get 仍从其余份读到正文 |

自我修复停在规则自动：有活副本就补，没有就不编造。AI 停在手工：模型只写结论，不决定修不修。值班可以不改客户端就躲开一台 down 的 block。换盘和确认 `lost` 仍要人做。

### 成熟度还没到，对照里可以参考

上面「要收进来的设计」里已经标成代码已补的，不再列。容量数字和五步演练在「尚未关闭」。这里只留对照里还有做法、仓库里还没做的。写成功仍是 3 份里的 2 份，默认冗余仍是整对象 3 副本。这些都不挡那八项。

| 还缺的 | 从哪来 | 做成什么 | 不一起搬 | 关闭条件 |
| --- | --- | --- | --- | --- |
| 把 `.blk` 再读一遍并留下计数 | [ZFS](diff/zfs.md) 的 scrub 与池上的错误计数。现有 `scrub` 按 locator 核对，当次返回数字，不把上一轮记在索引里 | 按块把记录再读一遍。CRC 不对的用活副本重写，没有活副本就记 `$lost/`。检查数、修好数、仍丢失的数写入索引，新进程不跑巡检也能读到 | 不改成 RAID-Z。计数不是容量承诺，也不和 `repair` 合成一步 | 一条没有被 Get 过的坏记录被巡检修好或进入 `$lost/`。新的 `ObjectCluster` 读到同一组数字 |
| 恢复要多久 | [ZFS](diff/zfs.md) 的 resilver 有进度 | 部署笔记记下停一台 block、停一台索引，到 `GET /_s3dfs/health` 回到 200 的时间。本机可以先记一笔 | 不把本机的秒数写成上线容量 | 目标集群的笔记里有这两次时间和当时的健康 JSON |
| 告警送到值班 | [ZFS](diff/zfs.md) 把盘故障和校验错误发到本机事件 | 配置了接收地址时，`lost`、布局不 ok、副本不足各送一条。没配置就不发 | 不自动升级。模型仍不决定修不修 | 配上地址后制造一条 `$lost/`，地址收到含这个 key 的消息。不配时与现在相同 |
| 升级顺序写给值班 | [CephFS](diff/cephfs.md) 的升级是写下来的步骤，不是自动跳版本 | 写出索引、block、API 的停止、替换、拉起顺序和回退 | 不自动跳版本 | 按文档在本机走完一遍，健康检查回到 200 |

## 对照 MinIO 值得做

来自 [minio.md](diff/minio.md)。日常的 Put、Get、分片、拷贝、版本、生命周期、标签、CORS、网站、校验和已经有了。对象锁的开关、保留期和法律保全也有。下面这些值得做。写成功仍是 3 份里的 2 份，默认冗余仍是整对象 3 副本，不改成纠删，也不改成每对象一份 `xl.meta`。都不挡上面的八项。没人读过的坏记录已经列在「把 `.blk` 再读一遍并留下计数」，这里不重复。

| 还缺的 | MinIO 里是什么 | 在 s3dfs 里做成什么 | 不一起搬 | 关闭条件 |
| --- | --- | --- | --- | --- |
| 多用户身份 | 用户、组、服务账号、STS，以及多条策略。另有 LDAP | 代码已补：`accounts` 里每把密钥限定桶，`expiresAtMs` 过期后拒绝。环境变量 `S3DFS_ACCOUNTS` 可传入同一份 JSON | 第一版不接 LDAP、OIDC。不把策略引擎做成 IAM 的全部动作 | `apps/api/test/s3-rest.test.ts`：两把密钥各写各的桶，过期凭证 403 |
| 加密接到密钥 | 桶默认加密，以及 SSE-S3、SSE-KMS、SSE-C。密钥可以接到 KMS | 代码已补：`?encryption` 的 AES256 用 `S3DFS_SSE_KEY` 封存。SSE-C 用调用方的密钥，对不上则 Get 失败 | 不替换未标明加密的对象。不把 Vault 当成上线依赖。外部 KMS 仍是这把测试密钥 | `apps/api/test/s3-rest.test.ts`：默认加密的 Put 不带加密头也能读出原文。错的 SSE-C 密钥 Get 为 403 |
| 桶复制和站点复制 | 桶上的复制配置，以及另一套集群的站点复制。删除和覆盖会送到对端 | 代码已补：`?replication` 打开后，Delete 调 `replica.delete`。`sendChanges(..., { deletes: true })` 才把删除送到目标 | 不把本集群的 3 副本叫作第二站点。不改成纠删后再复制。默认不调用 | `apps/api/test/s3-rest.test.ts`：没配规则时目标收不到删除。配上之后收得到。`packages/control/test/rest.test.ts` 覆盖 `deletes: true` |
| 通知的目的地 | Webhook 之外还有 Kafka、AMQP、Redis、NATS | 代码已补：通知配置里的 `queue` 把事件交给一个队列。webhook 仍可用 | 只做一种队列接口，不接四种中间件。事件里没有对象正文 | `apps/api/test/s3-rest.test.ts`：队列收到 bucket 和 key |
| 对象锁的默认保留期 | 桶配置里写默认模式和天数，新建对象不用再逐个 Put retention | 代码已补：`?object-lock` 接受 `DefaultRetention` 的模式和天数。新 Put 写入保留期 | 不锁未打开对象锁的桶。法律保全仍按对象打开 | `apps/api/test/s3-rest.test.ts`：默认 1 天的对象 Delete 为 403。另一个桶 Put 后仍可删 |

## 不作为上线前提

纠删码、远程分层、审计日志、Helm、Swift、SFTP、把 ETag 改成 MD5、Prometheus 拉取格式、加节点后自动搬走旧对象。LDAP 和 OIDC 不在身份那一条的第一版里。单机文件系统上的快照、RAID-Z、USN 变更日志和同池克隆也不在这八项里。POSIX 共享、块设备、NFS 和 SMB 导出同样不在这八项里。上一节收进来的巡检、按块补副本、持久的 `lost`、变更日志、段校验、共享 Copy、桶配额、按盘记账、显式搬迁、送到另一套集群、坏 locator 换份，以及再后面的全量巡检计数、恢复时间、外部告警和升级顺序，也不挡这八项。上面「对照 MinIO 值得做」里的身份、加密、复制、通知目的地和默认保留期同样不挡这八项。
