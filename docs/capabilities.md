# s3dfs 能力

产品主路径是 S3 API。能直接用对象接口的应用，应走 Put / Get / Head / Delete / List，这才是存储要发挥的方式。本机目录挂载是兼容层，给只认路径和 `open` / `read` / `write` 的程序用，不能代替协议，也不应当拿挂载速度来代表存储本身的性能。

## 已经可以做的

- S3 风格的 Put / Get / Head / Delete / List，以及创建桶；List 支持 `delimiter` 与 CommonPrefixes；GET / HEAD 支持单个 HTTP `Range`（206）。这是推荐的访问方式
- 对象索引放在独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 集群（建议 3–5 台）；对象正文放在可大量扩展的 block 机器上
- 对象打进追加式 block 文件，而不是一个对象一个目录；inode 和磁盘文件数跟 block 文件走，不跟对象数走
- 对象按 key 哈希分散到多台 block；locator 留在 dleveldb。存储侧的对象规模主要是 KV 里的 key 数，而不是本地文件系统的 inode 数
- 默认 1GB 一块；超过当前块剩余空间或大于一块的对象，切成多段并从后向前记下链接，读取时再从前向后拼回
- 1MB 写缓冲做 group commit，flush 默认 `fsync`
- 批量 `put_batch`（单个 block 引擎内部），避免每个小对象都从 JS 进 C 一次
- block 记录是带校验的 TLV 帧；不认识的字段可以跳过。索引 locator 只记稳定的 `recId`（`v: 3`），物理偏移留在节点内存表里，打开时扫描 `.blk` 重建。索引丢了时可以扫描重建 locator（删除会写墓碑，避免把已删对象救回来）
- 对象数据默认 3 副本，记成 `bucket/key`、`bucket/key:1`、`bucket/key:2`，值里带 block 节点信息；有效副本数是 `min(配置值, 存活的 block 节点数)`
- 定期对 block 节点做健康检查，Get / Put 会跳过已标记为 down 的节点。Get 会在本次请求里依次尝试剩余副本
- 对象副本补齐（第一期）：活副本少于 `min(配置副本数, 存活 block 数)` 时，从一份活副本再写到空闲节点。`POST /_s3dfs/repair` 可手动触发；`S3DFS_REPAIR_INTERVAL_MS` 默认 30 秒，0 关闭后台任务。没有活副本的对象补不回来，也不会退役失效 locator。说明见 [故障与恢复](design-recovery.md)
- 对象正文默认用 zstd 压缩（`S3DFS_COMPRESS=none|zstd|gzip`），每个对象自己的 `compressType` 记在 locator 里；压不小就存原值
- 打开 block 时扫描各文件末尾的完整记录，接着追加。`recId` 映射会写到节点本地的 `recmap.s3m`；重启时优先读快照并补扫新数据，快照不可用则扫描全部 `.blk`。不是再引入一份本地 LevelDB
- 管理接口：`GET /_s3dfs/stats|cluster|buckets`，`POST /_s3dfs/flush|compact|repair`
- 控制台查看统计、桶、block 节点状态，并触发 flush。删除先出票，空闲或手动 compact 再回收空洞（`POST /_s3dfs/flush|compact`，以及 block 上的 `POST /_s3dfs/block/compact`）
- 独立挂载程序 `apps/fuse`（`s3dfs-fuse`）：把一个桶挂成本地目录，给改不了 S3 接口的程序用。路径对应对象 key，内容仍走 S3 API 再进 block；写入是关闭时整文件上传，每个文件一次完整 Put。Linux 走 `/dev/fuse`；本机没有 FUSE 时，macOS 会再经过本机 WebDAV 和 `mount_webdav`，会更慢。挂载尤其是大量小文件时，明显慢于直接调用 S3 API，不要用这些数字代表引擎或集群性能。说明见 [FUSE 方案](design-fuse.md)
- AWS CLI 默认上传：解开 `aws-chunked`（含 chunk signature 和校验和 trailer），按 `x-amz-decoded-content-length` 核对后再落盘
- 分片上传：`POST ?uploads`、`PUT ?partNumber&uploadId`、`POST ?uploadId`、`DELETE ?uploadId`。分片暂存在 API 进程内存里，拼完再写入 block；API 重启后未完成的上传会丢。最终对象的 ETag 仍是整段正文的 CRC32
- 删除空桶（`DELETE /bucket`）。桶里还有对象时返回 `BucketNotEmpty`

## 还不做的

- 完整 AWS SigV4 鉴权（环境变量里的 access/secret 尚未生效）
- 流式上传 / 下载。HTTP 层仍会把整个 body 读进进程内存；分片完成时也是一次整对象写入
- C S3 网关上的 `aws-chunked`、分片上传和删桶。上面三条目前只在 Nest S3 API（默认 :9000）
- 纠删码
- 把对象值放进 dleveldb；索引里只有 locator JSON，正文始终在 block 文件里
- 退役失效的数据 locator，以及在没有活副本时把对象救回来；故障时哪些还能继续，见 [故障与恢复](design-recovery.md)
- dleveldb 侧：节点加入后的范围迁移 / catch-up repair，以及 primary 不可达时的安全写故障转移（读可以走剩余 KV 副本；写索引会失败，避免脑裂）
- 单对象超过约 4GB − 1（引擎对外 API 仍是 `uint32` 长度）

## 环境变量

### S3 API / 控制台

- `S3DFS_API_PORT`：S3 API 端口，默认 9000
- `NEXT_PUBLIC_API_BASE_URL`：控制台访问 API 的地址
- `S3DFS_ACCESS_KEY` / `S3DFS_SECRET_KEY`：预留，当前未做签名校验
- `S3DFS_INDEX_URLS`：dleveldb 索引节点，逗号分隔，默认 `http://127.0.0.1:9800`
- `S3DFS_BLOCK_NODES`：block 节点种子列表，`nodeId=host:port`，逗号分隔，默认 `block1=127.0.0.1:9100`
- `S3DFS_DATA_REPLICAS`：对象正文副本数，默认 3。有效值不超过当前存活的 block 节点数
- `S3DFS_HEALTH_INTERVAL_MS`：对 block 节点做健康检查的间隔，默认 5000
- `S3DFS_REPAIR_INTERVAL_MS`：后台补齐对象副本的间隔，默认 30000；设为 0 则关闭定时任务，仍可 `POST /_s3dfs/repair`

### block 节点

- `S3DFS_BLOCK_NODE_ID`：本 block 进程的节点名，默认 `block1`；多机时必须互不相同
- `S3DFS_BLOCK_PORT`：block 服务端口，默认 9100
- `S3DFS_ADVERTISE_ADDR`：其它进程访问本 block 用的 `host:port`，默认 `127.0.0.1:${S3DFS_BLOCK_PORT}`
- `S3DFS_DATA_DIR`：本 block 的数据目录，默认 `./data/block`
- `S3DFS_BLOCK_SIZE`：单个 block 大小，默认 1GB（`1073741824`）
- `S3DFS_BUFFER_SIZE`：写缓冲，默认 1MB
- `S3DFS_FLUSH_INTERVAL_MS`：定期 flush 的间隔，默认 50ms
- `S3DFS_COMPACT_INTERVAL_MS`：后台 compact 间隔，默认 30000；设为 0 则关闭定时任务，仍可手动触发
- `S3DFS_COMPACT_DEAD_RATIO`：自动合并的空洞比例阈值，默认 0.2（`deadBytes / bytesOnDisk`）
- `S3DFS_INDEX_URLS`：可选；设置后 block 会向索引注册 `$node/{nodeId}`

索引进程本身的端口、目录、副本数请看 dleveldb 的 `DLEVELDB_*` 环境变量。本仓库的 `pnpm dev:index` 默认把索引开在 `127.0.0.1:9800`，数据目录是 `s3dfs/data/index`。

## 列举与副本的注意点

- 列举会跳过 `key:1`、`key:2` 这类副本后缀，以及 `$node/` 下的注册 key。对象 key 不要以 `:数字` 结尾。
- 配置的数据副本数默认是 3，但有效值不会超过当前存活的 block 节点数。只有一台 block 时，行为和单副本一致。
- 多节点语义见 [索引与 block 集群](design-replication.md)。dleveldb 自己的 KV 复制是另一回事，见那个仓库的文档。

## 大文件与内存

引擎已经可以把一个逻辑对象切到多块中，dleveldb 只记最后一段的 locator，读取时沿链条从前向后拼回。不过 HTTP 层仍会把整个 body 读进 Node 内存，Range 目前也是先取完整对象再切片，所以特别大的上传或按偏移读取还是会先受到 API 进程内存的限制。流式 Put/Get 和分片上传是下一步。详见 [大文件跨 block 存放](design-large-object.md)。
