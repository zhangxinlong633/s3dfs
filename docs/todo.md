# 待办

| | |
| --- | --- |
| 日期 | 2026-11-21 |
| 读者 | 排期和验收的人 |
| 权威清单 | [上线标准](diff/production.md)。本文只保留还没关闭的事项，并记下标准没单列、但会在声明负载上出错的代码 |
| 结论 | 代码侧八项里能在仓库里补的已经补上。本机按生产布局演练通过，并补了 1 KiB 与 1 MiB 的 3 副本 localhost 数字。还不能让一套部署保管业务数据的唯一副本：这两项都还没在准备承接流量的机器上做 |
| 对照 | 架构判断在 [与主流系统的位置](diff/mainstream.md) |

上线标准的八项里，单次 Put 的内存上限已经按块转发。还要在准备承接流量的集群上测量，并做完演练。桶列表、版本正文和管理写接口这三项代码已经补上。

可以承接的负载仍是 [上线标准](diff/production.md) 第 1 节：Nest API、至少 2 台 API 加负载均衡、3 台分属不同 `@zone` 的 block、3 副本、dleveldb 至少 3 节点、密钥齐全、大量小对象。本机 localhost 的数字不能用来定容量。

## 尚未关闭

| 事项 | 状态 | 关闭条件 |
| --- | --- | --- |
| 上线容量 | 本机已测，目标集群未测 | 在准备上线的机器和网络上测出 1 KiB 与 1 MiB、3 副本的读写数字，写入 [benchmarks.md](benchmarks.md)。2026-11-21 的 localhost 补测只说明形状，不能用来定容量 |
| 目标集群演练 | 本机已演练，目标集群未做 | 在准备承接流量的集群上完成下面五步，把命令、时间和结果写入部署笔记。本机笔记见 [2026-11-21 本机演练](milestones/2026-11-21-local-drill.md)。没有目标集群的笔记，该集群不能当作唯一副本 |

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
| 丢失可见 | 本进程修复记下的 `lost` 使 `GET /_s3dfs/health` 返回 503，JSON 含 `lost`。进程重启后从 0 重新累加 |
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
| 分片完成 | 各段已经在 block 里，完成时仍 `Buffer.concat` 再 Put。上线标准把这一点写成当前实现，验收只要求重启后字节一致 |
| 大对象压缩和加密 | 超过 1 MiB 的流式 Put 按原文写入，不再做 zstd。带 `x-amz-server-side-encryption` 的对象仍要求能放进 1 MiB 缓冲，否则 400。`aws-chunked` 仍整段读入后再解码 |
| 控制台按钮 | Flush、Compact、Repair 改走控制台自己的 `/api/s3dfs/<action>`。令牌放在 Web 进程的 `S3DFS_PATROL_TOKEN`，不进浏览器。API 地址用 `S3DFS_API_BASE_URL`，没有则用 `NEXT_PUBLIC_API_BASE_URL` |
| 管理读接口 | `GET /_s3dfs/stats`、`cluster`、`buckets`、`metrics` 仍不校验身份。健康检查保持开放，给负载均衡探活 |
| 丢失与故障 | `lost` 和未关闭的故障事件在 API 进程内存里。重启后健康检查从 200 计起，已丢失的对象还在 |
| 对象计数 | `stats` 的对象数只数索引扫描的前 10 万条。每台 locator 数扫到 2 万条就停止，之后该台记成 1。巡检快照超过约 8 KB 时从末尾丢掉 block 节点 |
| 扩缩 | 未配置 `S3DFS_SCALE_UP_CMD` 与 `S3DFS_SCALE_DOWN_CMD` 时只判断，不开关机器。加 block 之后旧对象的 locator 留在原节点，新写入才用新节点。MinIO 追加 pool 也不把旧对象搬过去 |
| 持续集成 | 仓库没有工作流。测试靠本机 `bun` 跑 `apps/api/test` 与 `packages/control/test` |
| 恢复时间 | 没有测过停节点之后恢复到健康检查 200 的时间上限 |

## 多对比之后的位置

材料与 [mainstream.md](diff/mainstream.md) 相同，日期 2026-11-21。这一节补上 CubeFS、Ozone，以及上一轮没展开的产品面。JuiceFS 是架在对象存储前面的文件系统，不放进同一张表。AWS S3、GCS、Azure Blob 不由本系统管盘，只在接口兼容那一行当作客户端期望。

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
| 分片完成 | 按段提交，不在一个进程里拼出整个对象 | 段已在 block，完成时 `Buffer.concat` 再 Put | 标准把这写成当前实现，不挡八项 |
| 桶列表 | 桶是独立元数据 | 按页扫描，一页停在同一个桶里就跳过该桶余下的 key | 代码已补 |
| 版本 | 版本号在元数据，正文仍在数据盘 | 清单在索引，正文在 block 的 `$ver/` | 代码已补 |
| 身份 | IAM 或等价的多用户、多策略 | 一对访问密钥。另有一份桶策略、单密钥 AES256 | 不作为上线前提 |
| 管理写操作 | 单独的管理员身份 | 配置了令牌或密钥后，flush、compact、repair 要求其中之一。控制台由自己的服务端路由附上 `S3DFS_PATROL_TOKEN` | 代码已补 |
| 探活与指标 | 健康是集群状态；Prometheus 一类的拉取接口 | `lost` 在本进程内存，重启从 0 再计。`/_s3dfs/metrics` 是进程启动以来的状态码计数，标准输出一行 JSON | 健康计数的重启语义写在上线标准里。指标格式不挡八项 |
| ETag | MD5，或分片的 MD5 再加段数 | 整段 CRC32，响应带 `x-s3dfs-etag-algorithm: crc32`。核对正文用 `Content-MD5` | 对接时讲明。不改成 MD5 也能上线 |
| 压缩 | 多数不在服务端默默压缩 | 默认 zstd，压不小则存原文 | 保持 |
| 对象锁、站点复制、配额、审计、KMS、远程分层 | MinIO、Ceph、Garage、RustFS、Ozone 的程度不一，都已放在数据面或相邻组件上 | 没有 | 不作为上线前提 |
| 小对象的进程上限 | SeaweedFS 内存里约 16 字节一条 | 单进程活记录停在 2^30 − 1。按 1 KiB 算大约 1 TiB 逻辑数据就要拆进程；按 1 MiB 算，一块 1 PB 盘仍在上限以内 | 见 [规模说明](scale.md)。不挡当前八项 |

### 由此不改的判断

默认冗余继续用 3 份整对象，不用纠删替换 `.blk`。部署继续是索引、block、API 三种角色，不做成 MinIO、RustFS 那种每台机器同一个进程。S3 主路径继续是官方 AWS CLI 的路径风格：建桶、上传、分片、Range、拷贝、删除、条件请求、用户元数据、批量删除。

## 不作为上线前提

纠删码、站点复制、远程分层、Object Lock、配额、审计日志、Helm、Swift、SFTP、多用户 IAM、KMS、把 ETag 改成 MD5、Prometheus 拉取格式、加节点后自动搬走旧对象。
