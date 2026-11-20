# 产品能力

| | |
| --- | --- |
| 读者 | 对接 S3 接口、配置进程的人 |
| 主路径 | S3 API 的 Put / Get / Head / Delete / List |
| 相关 | [部署](deploy.md)、[环境与行为以本文为准](#4-环境变量) |

本机目录挂载是兼容层，给只认路径的程序使用。挂载速度不代表存储性能。

## 1. 数据布局

| 能力 | 说明 |
| --- | --- |
| 索引与正文分离 | 索引在独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 集群，建议 3–5 台。正文在可扩展的 block 机器上 |
| 打包 | 对象追加进大文件，默认 1 GiB 一块。inode 和磁盘文件数跟 block 文件走，不跟对象数走 |
| 定位 | 按 key 哈希分散。locator（`v: 3`）只记节点和稳定的 `recId`。物理偏移留在 block 内存表，打开时可由 `.blk` 重建 |
| 跨块 | 放不进当前块的对象切成多段，后一段记下前一段的 `recId`。索引只保留最后一段 |
| 刷盘 | 1 MiB 写缓冲做组提交，flush 默认 `fsync` |
| 压缩 | 默认 zstd（`none` / `zstd` / `gzip`）。压不小则存原文，locator 记 `compressType=none` |
| 副本 | 默认 3 份。达到多数即写索引，未写上的份由修复补齐 |
| 故障域 | 种子可用 `@zone`。放置先从不同 zone 各取一台 |
| 严格布局 | 默认要求存活节点数和故障域都不少于副本数，不足则拒绝写入 |

## 2. S3 接口

| 能力 | 说明 |
| --- | --- |
| 对象与桶 | Put / Get / Head / Delete / List（含 `delimiter` 与 CommonPrefixes）、建桶、删除空桶。桶非空时返回 `BucketNotEmpty` |
| Range | 单个 HTTP Range，返回 206。未压缩对象按偏移向 block 读取。压缩对象先解开再切 |
| 拷贝与条件 | CopyObject（`x-amz-copy-source`）、`If-Match` / `If-None-Match`、`x-amz-meta-*`、`DeleteObjects` |
| AWS CLI | 官方 CLI 用 `--endpoint-url` 直连 Nest API，寻址为路径风格。配置见 [README](../README.zh-CN.md#用-aws-cli-接入) |
| 签名 | 同时设置访问密钥和秘密密钥后校验 SigV4，含预签名。流式签名会核对每个 chunk signature。未设置则不鉴权 |
| 虚拟主机 | `S3DFS_DOMAIN=localhost` 时，桶名来自 Host |
| 分片 | 创建、上传、ListParts、完成、中止。清单在索引，正文在 block，key 以 `$upload/` 开头，列表不可见。API 重启后分片仍在。完成后拼成正式对象。ETag 为整段 CRC32，响应带 `x-s3dfs-etag-algorithm: crc32`。校验正文请用 `Content-MD5` |
| 桶策略与加密 | JSON 桶策略、单密钥 AES256（`S3DFS_SSE_KEY`）、版本与删除标记、生命周期、webhook |
| 大小上限 | 超过 `S3DFS_MAX_OBJECT_BYTES`（默认 1 GiB，0 为不限制）返回 `EntityTooLarge` |
| 请求追踪 | 每个响应带 `x-amz-request-id`，标准输出打一行 JSON 日志 |

## 3. 运维与兼容

| 能力 | 说明 |
| --- | --- |
| 健康检查 | 定期探测 block。Get / Put 跳过 down 节点。Get 在本次请求内尝试剩余副本 |
| 副本补齐 | 活副本少于 `min(配置副本数, 存活 block 数)` 时，从一份活副本再写到空闲节点，并退役 down 的 locator。`POST /_s3dfs/repair`，后台默认 30 秒。没有任何活副本记为 `lost`，健康检查 503 |
| 自动扩缩 | 配置 `S3DFS_SCALE_UP_CMD` 与 `S3DFS_SCALE_DOWN_CMD` 后，API 按容量和延迟决定增减索引、block 或 API。缩容前先排空。未配置脚本时不动作。变量见 [自动扩缩](#7-自动扩缩) |
| 管理接口 | `GET /_s3dfs/stats\|cluster\|buckets\|health\|metrics`，`POST /_s3dfs/flush\|compact\|repair` |
| 控制台 | 查看统计、桶、节点，并触发 flush |
| 重启 | 优先读 `recmap.s3m`，再补扫新数据。快照不可用则扫描全部 `.blk` |
| 空间回收 | 删除先出票。空闲或手动 compact 回收空洞，保留原 `recId`，不必改索引 |
| 挂载 | `s3dfs-fuse` 把一个桶挂成本地目录。关闭时整文件上传。Linux 走 `/dev/fuse`；没有 FUSE 的 macOS 再经本机 WebDAV。说明见 [FUSE](design-fuse.md) |
| C 网关 | 可选入口，不是默认上线入口。内存分片在重启后丢失，不校验分块签名。说明见 [S3 网关](design-s3-gateway.md) |

## 4. 尚未提供

| 事项 | 现状 |
| --- | --- |
| 单次 Put | HTTP body 仍在 API 进程内收齐再交给 block。引擎另有 `putChunks`，总长度可以超过 `uint32` |
| C 网关签名 | 不校验 aws-chunked 分块签名，也不接受只有 `Date`、没有 `x-amz-date` 的请求 |
| 多机吞吐 | 尚无准备上线的机器和网络上的测量 |
| 产品面以外 | 纠删码、站点复制、远程分层、Object Lock、配额、审计日志、Helm、Swift / SFTP、多用户 IAM、KMS |

索引的故障写入和历史追平由 dleveldb 完成。s3dfs 在配置的索引地址之间切换，不在本仓库内复制历史 key。

## 5. 环境变量

### S3 API 与控制台

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `S3DFS_API_PORT` | `9000` | S3 API 端口 |
| `NEXT_PUBLIC_API_BASE_URL` | — | 控制台访问 API 的地址 |
| `S3DFS_ACCESS_KEY` / `S3DFS_SECRET_KEY` | 未设置 | 两者都设置时校验 SigV4。默认严格布局下缺一则进程不监听 |
| `S3DFS_DOMAIN` | 未设置 | 虚拟主机后缀。`localhost` 时 `bucket.localhost` 为桶名 |
| `S3DFS_SSE_KEY` | 未设置 | `x-amz-server-side-encryption: AES256` 时派生 AES-256-GCM 密钥 |
| `S3DFS_INDEX_URLS` | `http://127.0.0.1:9800` | 索引节点，逗号分隔 |
| `S3DFS_BLOCK_NODES` | `block1=127.0.0.1:9100` | `nodeId=host:port`，可用 `@zone`。逗号分隔 |
| `S3DFS_DATA_REPLICAS` | `3` | 对象正文副本数 |
| `S3DFS_STRICT_LAYOUT` | 开启 | `0` 或 `false` 才允许按存活节点数降级 |
| `S3DFS_WRITE_QUORUM` | 当次副本数的多数 | 至少成功几份才写索引 |
| `S3DFS_MAX_OBJECT_BYTES` | `1073741824` | 单个 Put 或分片上限。`0` 为不限制 |
| `S3DFS_HEALTH_INTERVAL_MS` | `5000` | block 健康检查间隔 |
| `S3DFS_REPAIR_INTERVAL_MS` | `30000` | 副本补齐间隔。`0` 关闭定时任务，仍可手动触发 |

### block 节点

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `S3DFS_BLOCK_NODE_ID` | `block1` | 节点名。多机时必须互不相同 |
| `S3DFS_BLOCK_PORT` | `9100` | 监听端口 |
| `S3DFS_ADVERTISE_ADDR` | `127.0.0.1:${PORT}` | 其他进程访问本节点的 `host:port` |
| `S3DFS_DATA_DIR` | `./data/block` | 数据目录 |
| `S3DFS_BLOCK_SIZE` | `1073741824` | 单个 block 大小 |
| `S3DFS_BUFFER_SIZE` | `1048576` | 写缓冲 |
| `S3DFS_FLUSH_INTERVAL_MS` | `50` | 定期 flush |
| `S3DFS_COMPACT_INTERVAL_MS` | `30000` | 后台 compact。`0` 关闭定时任务 |
| `S3DFS_COMPACT_DEAD_RATIO` | `0.2` | 自动合并的空洞比例 |
| `S3DFS_INDEX_URLS` | 未设置 | 设置后向索引注册 `$node/{nodeId}` |

索引进程的端口、目录和副本数见 dleveldb 的 `DLEVELDB_*`。本仓库 `pnpm dev:index` 默认把索引开在 `127.0.0.1:9800`，数据目录是 `s3dfs/data/index`。

## 6. 列举约定

- 列举跳过 `key:1`、`key:2` 这类副本后缀、`$node/` 注册项，以及路径中含 `/$` 的内部对象。对象 key 不要以 `:数字` 结尾。
- 多节点语义见 [索引与 block 集群](design-replication.md)。dleveldb 自己的 KV 复制见该仓库文档。
- 大文件与 Range 见 [大文件跨 block 存放](design-large-object.md)。HTTP Put 仍把整个 body 读进 API 进程。

## 7. 自动扩缩

评估器在 API 进程内，默认 30 秒一次。只有同时配置了扩容或缩容脚本才会运行。多台 API 通过索引租约保证同一时刻只有一台做决定。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `S3DFS_SCALE_INTERVAL_MS` | `30000` | 评估间隔。`0` 关闭 |
| `S3DFS_SCALE_UP_CMD` | 未设置 | 扩容脚本。环境变量 `S3DFS_SCALE_ROLE`、`S3DFS_SCALE_REASON` |
| `S3DFS_SCALE_DOWN_CMD` | 未设置 | 缩容脚本。另有 `S3DFS_SCALE_NODE_ID`、`S3DFS_SCALE_ADDRESS` |
| `S3DFS_SCALE_HIGH_RATIO` / `S3DFS_SCALE_LOW_RATIO` | `0.80` / `0.40` | 容量高低阈值 |
| `S3DFS_SCALE_HIGH_LATENCY_MS` / `S3DFS_SCALE_LOW_LATENCY_MS` | `200` / `50` | 延迟 p99 高低阈值 |
| `S3DFS_SCALE_HIGH_STREAK` | `3` | 连续超阈值多少个周期才扩容 |
| `S3DFS_SCALE_COOLDOWN_MS` | `300000` | 同一角色两次动作的最短间隔 |
| `S3DFS_BLOCK_CAPACITY_BYTES` | 未设置 | 单台 block 容量。未设置时 block 只按写入延迟扩缩 |
| `S3DFS_INDEX_CAPACITY_BYTES` | 未设置 | 单台索引的容量分母 |
| `S3DFS_INDEX_USED_BYTES` | `0` | 当前索引已用字节。未设置时索引按 key 数量和写入延迟判断 |
| `S3DFS_INDEX_MAX_KEYS` | `100000000` | 索引 key 数量上限 |
| `S3DFS_API_MAX_INFLIGHT` | `128` | API 在途请求上限 |
| `S3DFS_API_NODES` | `1` | 当前 API 进程数，供缩容时保留最后一台 |

脚本退出码非 0 只记日志，不记入冷却时间。block 仍有 locator、故障域不足、索引少于 3 台或达不到法定人数、API 仍有在途请求时，不执行缩容脚本。设计说明见 [自动扩缩容](superpowers/specs/2026-11-20-autoscaling-design.md)。
