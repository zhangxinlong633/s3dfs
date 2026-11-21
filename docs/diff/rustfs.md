# 与 RustFS 的功能对照

| | |
| --- | --- |
| 日期 | 2026-11-21 |
| 读者 | 需要逐项确认 S3 与运维能力差异的人 |
| s3dfs | 以当时仓库的 [架构](../architecture.md)、[能力](../capabilities.md)、[网关](../design-s3-gateway.md) 为准 |
| RustFS | 对照本机源码：`rustfs/src/server/http.rs` 的配置子资源，`rustfs/src/app` 与 `crates/` 下的实现。README 的功能表会继续变化 |

两边都提供 S3 兼容的对象存储，解决的不是同一件事。RustFS 把纠删码、数据面、控制台和运维放在一个 Rust 进程里。s3dfs 把索引和正文分开扩容，面向大量小对象。Nest API 覆盖 AWS CLI 常用的签名、分片、拷贝、版本、生命周期和单密钥加密；运维面比 RustFS 窄。未关闭事项见 [todo.md](../todo.md)。

## 选型

| 场景 | 更合适的一边 |
| --- | --- |
| 海量小对象，担心本地文件系统 inode 和每对象一个文件 | s3dfs。对象打进大 `.blk`，文件数跟块走，不跟对象数走 |
| 日志、文本，希望写入前就压缩，压不小则原样落盘 | s3dfs。默认 zstd，类型记在 locator 上 |
| 要接到现成 AWS CLI / SDK，并且依赖 IAM、KMS、站点复制、Object Lock、配额 | RustFS。这些在它的数据面上已经标成可用。s3dfs 的 Nest API 能做 SigV4、预签名、分片、Copy、虚拟主机 URL、桶策略、用户和组、默认 AES256 与 SSE-C、版本、对象锁、桶配额、按前缀过期、webhook 和一个队列。没有 KMS，也不补送已有对象 |
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

## 代码分类

`cloc` 数到的 Rust **代码行**是 173 万。下面按 `.rs` 文件的物理行分类，空行和注释都算在内，所以合计更大：`crates/` 与 `rustfs/` 里的 Rust 文件约 207 万行。依赖目录 `target/` 没有算进去。`scripts/` 另有约 7.0 万行 Python 和 5.5 万行 Shell，不在下表里。同一口径下，s3dfs 的 TypeScript、C 和文档不到 3 万行。

这七类互不重叠，加起来就是约 207 万行。

| 类别 | 物理行 | 里面是什么 |
| --- | --- | --- |
| 纠删和保住数据 | 77.8 万 | 磁盘、盘组、放置、池、远程磁盘、Reed-Solomon，再加上修复和后台扫描。编解码本身只有 2.4 万 |
| 对外接口 | 49.8 万 | S3 请求路径 22.2 万，管理接口 14.5 万，表目录 5.9 万，FTPS / WebDAV / Swift / SFTP 4.6 万，S3 Select 2.6 万 |
| 其余库 | 21.8 万 | 工具、管理客户端、协议定义、缓存、配置等没有单列的小库 |
| 测试 | 16.9 万 | `crates/e2e_test` 和 `rustfs/tests`。没有产品实现。各目录里的单元测试还留在上面各类中 |
| 桶上的规则 | 16.0 万 | 生命周期 5.2 万，复制 4.7 万，远程分层 3.4 万，配额与用量 2.5 万，对象锁库 0.2 万 |
| 元数据、锁、通知、观测 | 13.0 万 | 文件元数据 2.8 万，分布式锁 1.8 万，事件通知 3.0 万，指标与审计 5.4 万 |
| 身份与加密 | 11.7 万 | 用户、策略、Keystone、签名 5.8 万，KMS 5.9 万 |

目录对照如下。纠删那一行已经含磁盘、盘组和节点间调用，不再拆开相加。

| 功能 | 物理行 | 目录 |
| --- | --- | --- |
| 纠删存储 | 56.5 万 | `crates/ecstore` 里的磁盘、盘组读写、放置、池、远程磁盘和 Reed-Solomon。编解码目录 `erasure` 只有 2.4 万，其余是围绕纠删集的磁盘和放置 |
| 远程分层 | 3.4 万 | `crates/ecstore/src/services/tier`。把对象转到远端，不是纠删本身 |
| 生命周期 | 5.2 万 | `crates/ecstore/src/bucket/lifecycle` 4.4 万，`crates/lifecycle` 0.7 万 |
| 桶复制与站点复制 | 4.7 万 | `crates/ecstore/src/bucket/replication` 2.4 万，`crates/replication` 1.2 万，`rustfs/src/site_replication` 1.1 万 |
| 配额与用量 | 2.5 万 | `crates/ecstore` 里的 quota 与 data_usage，加上 `crates/data-usage`、`crates/object-capacity` |
| 对象锁目录 | 0.2 万 | `crates/ecstore/src/bucket/object_lock`。请求处理还在 `rustfs/src/app` |
| 修复 | 9.0 万 | `crates/heal`。其中约 3.9 万在测试文件 |
| 后台扫描 | 12.3 万 | `crates/scanner` 11.6 万（约一半在测试文件），`crates/scanner-metrics` 0.7 万 |
| S3 请求路径 | 22.2 万 | `rustfs/src/app` 10.1 万，`rustfs/src/storage` 7.3 万，`rustfs/src/server` 4.9 万 |
| 管理接口 | 14.5 万 | `rustfs/src/admin`。其中约 2.4 万在测试文件 |
| 表目录 | 5.9 万 | `rustfs/src/table_catalog`。约 2.6 万在测试文件 |
| 身份与策略 | 5.8 万 | `crates/iam`、`crates/policy`、`crates/keystone`、`crates/signer`、`crates/credentials`，以及 `rustfs/src/auth.rs` |
| 加密 | 5.9 万 | `crates/kms` 5.7 万，`crates/crypto` 0.2 万。对象 SSE 接线在 `rustfs/src/storage`，已算进 S3 请求路径 |
| 协议 | 4.6 万 | `crates/protocols` 3.8 万，`rustfs/src/protocols` 0.8 万。含 FTPS、WebDAV，以及可选的 Swift、SFTP |
| 可观测与审计 | 5.4 万 | `crates/obs` 3.3 万，`crates/io-metrics` 1.6 万，`crates/audit` 0.4 万 |
| 事件通知 | 3.0 万 | `crates/notify` 1.1 万，`crates/targets` 1.9 万 |
| 文件元数据 | 2.8 万 | `crates/filemeta` |
| S3 Select | 2.6 万 | `crates/s3select-api`、`crates/s3select-query` |
| 分布式锁 | 1.8 万 | `crates/lock` |
| 端到端测试 | 16.9 万 | `crates/e2e_test` 13.4 万，`rustfs/tests` 3.5 万。没有产品实现 |

单个文件仍可以到 3 万至 4 万行，例如 `crates/ecstore/src/core/pools.rs` 和 `crates/ecstore/src/disk/local.rs`。和 MinIO 同一套纠删盘格式的行数对照在 [minio.md](minio.md)。

## S3 与产品面

RustFS 文档列出的数据面包括：桶的创建、删除、列举和 location；对象的 Put / Get / Head / Copy / Delete / 批量删除、Range、条件请求和用户元数据；ListObjects 与 ListObjectsV2；分片上传的创建、上传、拷贝、列举、完成和中止；版本、生命周期、标签、校验和、Object Lock；IAM、桶策略、阻止公共访问、预签名 GET/PUT；CORS、桶通知、复制配置和服务端加密。SigV4 可用。README 另标可用：Swift（可选 feature）、Keystone、FTPS / WebDAV、SFTP（可选）、事件通知、审计、配额、多租户、KMS（生产可用 Vault 与 AWS KMS）、站点复制、远程 S3 分层、S3 Select、Helm。S3 Tables（Iceberg REST）和 MinIO 盘格式兼容是预览，默认构建不含后者。

已知和 AWS / MinIO 不完全一样的地方（RustFS 自己写的）：桶访问日志和所有权控制还在计划中；ACL 授权故意不做，XML grant 返回 `NotImplemented`；POST Object 的校验和还不完整；S3 Select 目前只收未压缩输入；Access Point / Outposts 形式的 copy-source 没有。

s3dfs 的 Nest API（默认 :9000）现在能做：

- Put / Get / Head / Delete / List（含 delimiter）、单个 Range、建桶、删空桶、CopyObject、虚拟主机风格 URL
- 两个环境变量都设置时的 SigV4，以及预签名 URL。不设置则不鉴权。ETag 是整段正文的 CRC32，另有 `x-s3dfs-etag-algorithm: crc32`；`Content-MD5` 按 MD5 核对
- `aws-chunked`（含 chunk signature）先解开再落盘。分片有创建、上传、ListParts、完成、中止；清单在索引里，分片正文在 block，重启还在。未加密的完成按段转发，带服务端加密时仍拼成一段再封口
- 桶策略（Allow / Deny）、用户和组、默认 AES256 与 SSE-C、版本和删除标记、对象锁、桶配额、按前缀的天数过期、webhook 和一个队列
- 按对象压缩、3 副本、宕机节点避让、活副本不足时补齐并退役 down 的 locator、没有活副本时记为 `lost`、墓碑、扫描重建 locator、空闲或手动 compact

控制台仍是看统计、桶和 block 状态，并触发 flush。C S3 网关能解开 `aws-chunked`、做内存中的分片和删空桶；配了同一对密钥时校验请求头签名和预签名，不校验分块签名。未压缩对象的 Range 按偏移向 block 要那一段；压缩对象仍先整段解开。超过 1 MiB 的原始 Put 按块进入 block。多数副本写成功就提交索引，种子上的 `@zone` 用来避开同一故障域。每个响应带 `x-amz-request-id`。

这些和 RustFS 同名的能力，深度不一样。RustFS 的签名背后还能接 LDAP 和外部 KMS，复制会补送已有对象。s3dfs 的身份、加密、对象锁、配额和桶复制是第一版：没有 LDAP 和 KMS，复制默认关闭，也不补送盘上的旧对象。Nest API 已有条件请求、用户元数据和批量删除。

还没做的部分见 [todo.md](../todo.md)，以及下一节按源码逐项列出的缺口。s3dfs 自己的写入路径上仍开着：带服务端加密的分片完成仍拼成一段、`aws-chunked` 仍整段缓冲、C 网关不校验分块签名。

## 源码里有、s3dfs 还没有

下面按 `rustfs/src/server/http.rs` 里的配置查询对照。访问日志和所有权控制，RustFS 自己写明还在计划中；ACL 的 XML grant 返回 `NotImplemented`。其余几项在 `rustfs/src/app` 或 `crates/` 里有对应模块。

| 查询名 | RustFS 源码 | s3dfs |
| --- | --- | --- |
| tagging | `rustfs/src/app/object_meta/tagging.rs`，桶和对象标签 | `?tagging` 读写桶标签和对象标签。对象标签存在索引 `$tags/`，不进 `.blk` |
| cors | `rustfs/src/server/cors.rs`，`rustfs/src/app/bucket_usecase.rs` 的 cors 模块 | `?cors` 保存规则。`OPTIONS` 按来源和方法回预检头 |
| website | `rustfs/src/app/website.rs` | `?website` 保存索引、错误页和按前缀重定向。目录请求返回索引。对象不存在时返回错误页，状态仍是 404。命中前缀时返回配置的跳转状态和 `Location` |
| replication | `crates/replication`，桶复制配置 | `?replication` 打开后，之后的 Put 和 Delete 才送到 `S3DFS_REPLICA_URL`。默认关闭。不补送已有对象。`replicationProgress` 只给已送和未送两个数 |
| object-lock、retention、legal-hold | `rustfs/src/app/bucket_usecase.rs` 的 object_lock，`crates/lifecycle/src/object_lock.rs` | `?object-lock` 打开后才能设保留期和法律保全，打开后不能关掉。可以给新对象一个默认天数。GOVERNANCE 可用绕过头，法律保全不能 |
| encryption | `crates/kms`：SSE-S3、SSE-KMS、SSE-C，后端可以是本地、Vault KV2、Vault Transit | 默认 AES256 和请求上的 AES256 共用 `S3DFS_SSE_KEY`。超过 1 MiB 按块封存。上一把密钥留着时旧对象仍能打开。SSE-C 用调用方的密钥。没有 KMS |
| inventory | `rustfs/src/connect/inventory` | `?inventory` 保存一份 CSV 配置。`POST` 立刻把当前对象写成 `前缀/id.csv`。没有按天调度 |
| requestPayment、accelerate、intelligent-tiering、analytics、metrics | 路由接了这些查询名 | 没有 |
| publicAccessBlock | 路由接了这个查询名 | `?publicAccessBlock` 打开后，拒绝资源为 `*` 或 `/*` 的 Allow 策略 |
| logging、ownershipControls | 路由接了；README 写明还在计划中 | 没有 |
| acl | 路由接了；授权故意不做，XML grant 返回 `NotImplemented` | 没有 |

身份、分层和旁边的协议不在这四个查询里，源码是独立 crate：

| 能力 | RustFS 源码 | s3dfs |
| --- | --- | --- |
| IAM | `crates/iam`：用户、组、服务账号、策略、LDAP、多因素 | 索引里有用户、组、策略、服务账号和 `assumeRole`。根密钥和 `S3DFS_ACCOUNTS` 仍可用。没有 LDAP 和多因素 |
| OIDC | README 标可用，认证走 IAM 旁边的登录 | 没有 |
| Keystone | `crates/keystone` | 没有 |
| 桶配额 | README 标可用；用量在 `crates/data-usage`、`crates/object-capacity` | 管理接口可以设 `quotaBytes`。没有 S3 的桶配额查询 |
| 生命周期分层 | `crates/lifecycle` 含转移到远端 S3 的准入；scanner 负责到期和转移 | 按前缀和标签过期删除，按 `NoncurrentDays` 删掉非当前版本，并在删除标记成为唯一版本后清掉它。不把对象转到远端。`GET ?usage` 返回对象个数和字节 |
| 站点复制 | `crates/replication` 与 `.docker/test/site-replication` | 桶复制开关只送之后的 Put 和 Delete。不补送已有对象，也不做整集群对写 |
| S3 Select | `crates/s3select-api`、`crates/s3select-query`。README 写明只收未压缩输入 | 没有 |
| 审计 | `crates/audit` | 没有。访问日志是每个响应一行 JSON |
| 可观测性 | `crates/obs`、`crates/io-metrics` | `GET /_s3dfs/metrics` 只计本进程状态码 |
| 事件通知 | `crates/notify` | `targets` 里可以有多个 webhook，每个地址用自己的 `events`。也可以交给一个队列。事件里是 bucket 和 key |
| 多租户 | README 标可用 | 没有 |
| Swift | `crates/protocols` 的 swift，编译 feature，默认不进 | 没有 |
| FTPS、WebDAV | 默认 feature：`ftps`、`webdav` | 没有。挂载是自带的 `s3dfs-fuse` |
| SFTP | 可选 feature | 没有 |
| Helm | `helm/` | 没有。部署脚本会生成 Kubernetes 清单 |
| S3 Tables | README 标为预览 | 没有 |
| TLS | `crates/tls-runtime`，进程自己可以终止 TLS | 证书在反向代理上 |

数据放置是另一条路线，不把缺的接口补上就能对齐：

| 能力 | RustFS 源码 | s3dfs |
| --- | --- | --- |
| 冗余 | `crates/ecstore`、`crates/ecstore/src/erasure`，Reed-Solomon | 默认 3 份整对象副本。纠删不替换 `.blk` |
| 没人读过的数据 | `crates/scanner` 后台扫用量、生命周期、复制和 bitrot，并排队 `crates/heal` | `scrub` 按 locator 重写坏副本并把检查数留在索引里。不扫没有索引的字节。Get 时仍会换一份好副本 |
| 扩容 | 存储池在后面追加，已有纠删集宽度不能改 | 加 block 机器。旧对象不自动搬到新机器。`drain(nodeId)` 要人调用，才把这一台上面的份写到别的活节点 |

## 可靠性对照

| | s3dfs | RustFS |
| --- | --- | --- |
| 静默损坏 | 记录带 CRC-32；Get 对副本做大小和 CRC 校验，不匹配就试下一份 | bitrot 保护；读时校验，缺片则在 K 个片够用时解码，并排队修复 |
| 盘或节点挂了 | 健康检查后读写跳过 down 节点。后台或 `POST /_s3dfs/repair` 把不足的副本再写到空闲节点，并去掉已经 down 的 locator。没有任何活副本时记为 `lost`，补不回来 | healing / scanner。写、读都看 quorum |
| 删和覆盖 | 立刻对用户不可见。盘上先留洞，墓碑防止扫描把已删对象救回来。compact 重写活记录并保留原 `recId`，不改索引 | 版本、Object Lock、生命周期是产品功能；对象文件由 scanner 和 ILM 管 |
| 索引挂了 | 可以扫 `.blk` 重建 locator。多个索引地址时，当前地址失败会改写下一条。剩余副本达到法定人数时 dleveldb 继续写入，节点回来后按较新的 mtime 追平 | 元数据和数据片在同一套盘上，没有单独的小索引集群 |

## 文件系统放在一起

成熟度只使用这五档：没有、手工、规则自动、闭环、产品。闭环指发现之后会处理，并再看结果。产品指边界和运行记录已经交给值班使用，不依赖读源码。下面只比本目录里的单机文件系统。s3dfs 这一行在各篇里相同。NFS、SMB、Ceph、Longhorn、GFS、TFS、FastDFS 和 RustFS 不在这张表里，各自的档仍写在该篇里。

| 系统 | 自我修复 | 静默损坏巡检 | 自运维 | 告警与升级 | 停在哪 |
| --- | --- | --- | --- | --- | --- |
| s3dfs | 规则自动 | 规则自动 | 规则自动 | 手工 | 副本不够会再写一份，Get 时 CRC 不对就换一份。scrub 按 locator 留下计数，但没有把没有索引的 `.blk` 再读一遍。告警要配置地址才送出 |
| ZFS | 闭环 | 闭环 | 规则自动 | 规则自动 | 读到坏块当场修，scrub 把没人读的块也走一遍，结果留在池的错误计数里。池在一台机器上 |
| Btrfs | 规则自动 | 规则自动 | 手工 | 手工 | RAID 1/10 的 scrub 可以用另一份修。scrub 和 balance 要人安排。RAID 5/6 不能当唯一副本 |
| HAMMER2 | 规则自动 | 规则自动 | 手工 | 手工 | 读时用 CRC，从卷可以恢复这一卷。没有默认定时把整卷读完并修好 |
| APFS | 手工 | 规则自动 | 手工 | 手工 | 元数据核对 Fletcher-64。用户数据没有第二份，静默损坏靠盘 |
| NTFS | 规则自动 | 没有 | 手工 | 手工 | 在线修复和日志重放管元数据。用户数据没有端到端校验，也没有第二份副本 |
| FFS | 手工 | 没有 | 手工 | 手工 | fsck 由人发起。数据块没有端到端校验。GEOM 镜像不自动跨机器补一份 |

s3dfs 和 ZFS 的差距在闭环：ZFS 的 scrub 覆盖没人读过的块。s3dfs 的 `scrub` 按 locator 修并留下计数，不扫没有索引的字节。s3dfs 与 Btrfs、HAMMER2 同在规则自动，还没有到 ZFS 那一档。APFS 的用户数据没有可以换上的第二份。NTFS 和 FFS 的用户数据没有端到端校验。这些文件系统都不提供跨 zone 的 S3。

s3dfs 现在停在规则自动。下面两档还没有。纠删、KMS 和整集群的站点同步不在这张差距表里。身份账本、对象锁和桶复制开关已经有第一版。

| 还差的档 | 还缺什么 |
| --- | --- |
| 闭环 | 把没有索引的 `.blk` 再读一遍。按 locator 的巡检已经会修并留下计数。停一台 block 或一台索引之后，健康检查回到 200 要多久，还没有在目标集群测过 |
| 产品 | 准备接流量的集群上还没有容量数字，也没有五步演练的部署笔记。告警只在配置了地址时送出，升级顺序已经写给值班，目标集群还没按这个顺序走过。本机 localhost 的通过不能当作唯一副本 |

## 不照搬的部分

- 不要把默认冗余改成纠删码来对齐 RustFS。3 副本和打包块是小对象路径的选择；纠删码适合大对象和容量效率，编码、修复和读放大都另一套。若要做，应是另一种存储类，而不是替换 `.blk`。
- 不要改成一对象一文件。那是 s3dfs 故意避开的本地文件系统上限。RustFS 用内联和 XFS inode 尺寸缓解，s3dfs 用大块文件去掉这个问题。
- 上一节列出的 Swift、Keystone、SFTP、Iceberg REST、多租户和纠删，是对照里还没有的能力，不因此改默认路径，也不挡上线八项。AWS CLI 主路径上还缺的是单次 Put 的有界缓冲，以及在目标集群上做索引演练。
- RustFS README 里「Rust 更安全、别的语言有 GC / 泄漏」一类对比，不拿来当 s3dfs 的结论。s3dfs 热路径在 C 引擎里，控制面在 TypeScript。
