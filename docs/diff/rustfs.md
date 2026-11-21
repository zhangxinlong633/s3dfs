# 与 RustFS 的功能对照

| | |
| --- | --- |
| 日期 | 2026-11-21 |
| 读者 | 需要逐项确认 S3 与运维能力差异的人 |
| s3dfs | 以当时仓库的 [架构](../architecture.md)、[能力](../capabilities.md)、[网关](../design-s3-gateway.md) 为准 |
| RustFS | 以公开材料为准，功能表会继续变化 |

两边都提供 S3 兼容的对象存储，解决的不是同一件事。RustFS 把纠删码、数据面、控制台和运维放在一个 Rust 进程里。s3dfs 把索引和正文分开扩容，面向大量小对象。Nest API 覆盖 AWS CLI 常用的签名、分片、拷贝、版本、生命周期和单密钥加密；运维面比 RustFS 窄。未关闭事项见 [todo.md](../todo.md)。

## 选型

| 场景 | 更合适的一边 |
| --- | --- |
| 海量小对象，担心本地文件系统 inode 和每对象一个文件 | s3dfs。对象打进大 `.blk`，文件数跟块走，不跟对象数走 |
| 日志、文本，希望写入前就压缩，压不小则原样落盘 | s3dfs。默认 zstd，类型记在 locator 上 |
| 要接到现成 AWS CLI / SDK，并且依赖 IAM、KMS、站点复制、Object Lock、配额 | RustFS。这些在它的数据面上已经标成可用。s3dfs 的 Nest API 能做单对 access/secret 的 SigV4、预签名、分片、Copy、虚拟主机 URL、一份桶策略、单密钥 AES256、版本和删除标记、按前缀过期、一个 webhook |
| 大对象、数据湖、AI 吞吐，希望用纠删码换容量，而不是 3 副本 | RustFS。默认按纠删集做 Reed-Solomon |
| 索引很小、正文机器很多，两边独立加机器 | s3dfs。索引建议 3–5 台 dleveldb，block 可以很多 |
| 单进程就把 S3 和控制台一起跑起来，用 Docker / Helm 当 MinIO 替代 | RustFS。一个 `rustfs` 进程同时听 :9000 和 :9001。s3dfs 单机默认要分别起索引、block、API、控制台 |

没有在同一套机器上对打过。s3dfs 的数字是 2026-11-17 一台 MacBook Pro 上的本机测试，见 [benchmarks.md](../benchmarks.md)。RustFS README 给过一套压测环境（2 核、4 GB、4 块盘），图里的吞吐没有写进本文，也不能和 s3dfs 的 localhost ops/s 相减。

## 架构

| | s3dfs | RustFS |
| --- | --- | --- |
| 实现 | 控制面 TypeScript（Nest / Next，节点进程用 Bun），落盘引擎 C；另有一条薄的 C S3 网关。挂载程序 `s3dfs-fuse` 也是 C | 主体 Rust，Apache 2.0 |
| 进程 | API、控制台、block、独立的 dleveldb 索引，要一起起 | 一个 `rustfs` 进程同时做 S3（:9000）和控制台（:9001） |
| 元数据 | locator JSON 在 dleveldb：`bucket/key`、`bucket/key:1`、`bucket/key:2`。只记节点和稳定 `recId`，不记文件偏移 | 每对象（或每个版本）一份 `xl.meta`，几何、校验写在元数据里 |
| 正文 | 追加进默认 1 GiB 的 `.blk`。记录是带 CRC 的 TLV（魔数 `S3R1`）。写缓冲约 1 MiB，flush 默认 `fsync` | 大对象按纠删集切成数据片和校验片，1 MiB 一块做 Reed-Solomon，再写到各盘。文档写明每个对象（或版本）是独立文件 |
| 小对象 | 几千个 1 KiB 对象进同一个 `.blk`，不按对象建目录，block 上没有本地 LevelDB | 分片不超过预算时内联进该盘自己的 `xl.meta`。默认每片预算 `256 KiB / K`，上限 128 KiB；版本桶再除以 8。超过则仍是独立文件。官方建议数据盘用 XFS，inode 512 字节 |
| 放置 | 按 key 哈希从存活 block 里挑 N 台，同一份字节写 N 份。默认 N=3，不超过存活节点数 | 对象哈希到某个纠删集，片在集内轮转。集之间不共享故障预算 |
| 读 | 跳过健康检查标 down 的节点，按 `recId` 取，按 locator 上的 `compressType` 解压 | 读 quorum 选定元数据，校验 bitrot，至少 K 个片才能解出；缺片但读成功会排队 read-repair |
| 写成功条件 | 默认 3 副本里 2 份 block 成功即写索引，未写上的一份由修复补。任一条 locator 失败则删掉本次已写入的 locator。索引地址失败时改写下一条；节点回来后由 dleveldb 按较新的 mtime 追平 | 达到写 quorum 才对外成功；低于 quorum 不报成功 |
| 扩容 | 加 block 机器扩正文；索引集群另算。新索引节点加入环后，由 dleveldb 按较新的 mtime 追平本机负责的 key | 多盘池只能在后面追加新 Pool，不能改已有池的端点和纠删集宽度。单盘部署不能原地扩成多盘，要新建集群再经 S3 迁数据 |
| 挂载 | 自带 `s3dfs-fuse`（C）。Linux 没有 libfuse 时直接对 `/dev/fuse`；有 macFUSE / libfuse 时用 libfuse。没有 FUSE 时 macOS 走本机 WebDAV。关文件时整对象 Put，只是兼容层 | 不带 FUSE。用 s3fs、rclone mount 对 S3 端点挂 |

s3dfs 把「对象很多」变成「KV 里很多 locator + 少量大文件」。RustFS 把「盘坏几块还能读」变成「一个纠删集上的 Reed-Solomon」，小对象再靠内联减轻独立文件的代价，但数据盘仍然要扛大量文件和目录项。这是两边最硬的差别，不要用同一套「小文件 IOPS」去理解两边。

容量算法也不同。s3dfs 默认 3 副本，有效容量大约是裸容量的 1/3（只有一台 block 时有效副本是 1）。RustFS 在 8–16 盘的纠删集上默认 4 个校验片，16 盘大约是 75%（12 数据 + 4 校验），还要再扣文件系统、元数据、版本和 healing 的余量。`EC:4` 表示一个集里能缺 4 个片，不等于能扛 4 台整机故障，要看这些盘落在哪些机器上。

## S3 与产品面

RustFS 文档列出的数据面包括：桶的创建、删除、列举和 location；对象的 Put / Get / Head / Copy / Delete / 批量删除、Range、条件请求和用户元数据；ListObjects 与 ListObjectsV2；分片上传的创建、上传、拷贝、列举、完成和中止；版本、生命周期、标签、校验和、Object Lock；IAM、桶策略、阻止公共访问、预签名 GET/PUT；CORS、桶通知、复制配置和服务端加密。SigV4 可用。README 另标可用：Swift（可选 feature）、Keystone、FTPS / WebDAV、SFTP（可选）、事件通知、审计、配额、多租户、KMS（生产可用 Vault 与 AWS KMS）、站点复制、远程 S3 分层、S3 Select、Helm。S3 Tables（Iceberg REST）和 MinIO 盘格式兼容是预览，默认构建不含后者。

已知和 AWS / MinIO 不完全一样的地方（RustFS 自己写的）：桶访问日志和所有权控制还在计划中；ACL 授权故意不做，XML grant 返回 `NotImplemented`；POST Object 的校验和还不完整；S3 Select 目前只收未压缩输入；Access Point / Outposts 形式的 copy-source 没有。

s3dfs 的 Nest API（默认 :9000）现在能做：

- Put / Get / Head / Delete / List（含 delimiter）、单个 Range、建桶、删空桶、CopyObject、虚拟主机风格 URL
- 两个环境变量都设置时的 SigV4，以及预签名 URL。不设置则不鉴权。ETag 是整段正文的 CRC32，另有 `x-s3dfs-etag-algorithm: crc32`；`Content-MD5` 按 MD5 核对
- `aws-chunked`（含 chunk signature）先解开再落盘。分片有创建、上传、ListParts、完成、中止；清单在索引里，分片正文在 block，重启还在，完成时拼成一个对象再写入正式 key
- 一份桶策略（Allow / Deny）、单密钥 AES-256-GCM、版本和删除标记、按前缀的天数过期、一个 webhook URL
- 按对象压缩、3 副本、宕机节点避让、活副本不足时补齐并退役 down 的 locator、没有活副本时记为 `lost`、墓碑、扫描重建 locator、空闲或手动 compact

控制台仍是看统计、桶和 block 状态，并触发 flush。C S3 网关能解开 `aws-chunked`、做内存中的分片和删空桶；配了同一对密钥时校验请求头签名和预签名，不校验分块签名。未压缩对象的 Range 按偏移向 block 要那一段；压缩对象仍先整段解开。超过 1 MiB 的原始 Put 按块进入 block。多数副本写成功就提交索引，种子上的 `@zone` 用来避开同一故障域。每个响应带 `x-amz-request-id`。

这些和 RustFS 同名的能力，深度不一样。RustFS 的签名背后是 IAM，加密可以接到 Vault / AWS KMS，版本和生命周期是产品功能，通知、复制、配额、审计都在数据面上。s3dfs 这边是一条主路径加一组最小实现：一把密钥、一条策略、一个 webhook。Nest API 已有条件请求、用户元数据和批量删除。

还没做的部分见 [todo.md](../todo.md)。和这次对照直接相关的缺口是：分片完成仍在 API 里拼成一段、`aws-chunked` 仍整段缓冲、C 网关的分块签名、dleveldb 在目标集群上的演练、多机吞吐对照，以及纠删码、站点复制、远程分层、Object Lock、配额、审计、Helm、Swift / SFTP。

## 可靠性对照

| | s3dfs | RustFS |
| --- | --- | --- |
| 静默损坏 | 记录带 CRC-32；Get 对副本做大小和 CRC 校验，不匹配就试下一份 | bitrot 保护；读时校验，缺片则在 K 个片够用时解码，并排队修复 |
| 盘或节点挂了 | 健康检查后读写跳过 down 节点。后台或 `POST /_s3dfs/repair` 把不足的副本再写到空闲节点，并去掉已经 down 的 locator。没有任何活副本时记为 `lost`，补不回来 | healing / scanner。写、读都看 quorum |
| 删和覆盖 | 立刻对用户不可见。盘上先留洞，墓碑防止扫描把已删对象救回来。compact 重写活记录并保留原 `recId`，不改索引 | 版本、Object Lock、生命周期是产品功能；对象文件由 scanner 和 ILM 管 |
| 索引挂了 | 可以扫 `.blk` 重建 locator。多个索引地址时，当前地址失败会改写下一条。剩余副本达到法定人数时 dleveldb 继续写入，节点回来后按较新的 mtime 追平 | 元数据和数据片在同一套盘上，没有单独的小索引集群 |

## 不照搬的部分

- 不要把默认冗余改成纠删码来对齐 RustFS。3 副本和打包块是小对象路径的选择；纠删码适合大对象和容量效率，编码、修复和读放大都另一套。若要做，应是另一种存储类，而不是替换 `.blk`。
- 不要改成一对象一文件。那是 s3dfs 故意避开的本地文件系统上限。RustFS 用内联和 XFS inode 尺寸缓解，s3dfs 用大块文件去掉这个问题。
- Swift、Keystone、SFTP、Iceberg REST、MinIO 盘兼容、多租户，仍然不在当前缺口里。AWS CLI 主路径上还缺的是单次 Put 的有界缓冲，以及在目标集群上做索引演练。
- RustFS README 里「Rust 更安全、别的语言有 GC / 泄漏」一类对比，不拿来当 s3dfs 的结论。s3dfs 热路径在 C 引擎里，控制面在 TypeScript。
