# s3dfs 能力

## 已经可以做的

- S3 风格的 Put / Get / Head / Delete / List，以及创建桶
- 对象索引放在独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 集群（建议 3–5 台）；对象正文放在可大量扩展的 block 机器上
- 对象打进追加式 block 文件，而不是一个对象一个目录
- 默认 1GB 一块；超过当前块剩余空间或大于一块的对象，切成多段并从后向前记下链接，读取时再从前向后拼回
- 1MB 写缓冲做 group commit，flush 默认 `fsync`
- 批量 `put_batch`（单个 block 引擎内部），避免每个小对象都从 JS 进 C 一次
- 每个 block 进程用官方 C API 维护本地 LevelDB 索引，启动不必全量扫描 block
- 对象数据默认 3 副本，记成 `bucket/key`、`bucket/key:1`、`bucket/key:2`，值里带 block 节点信息；有效副本数是 `min(配置值, 存活的 block 节点数)`
- 定期对 block 节点做健康检查，Get / Put 会跳过已标记为 down 的节点
- 打开单个 block 存储时：有有效索引头则只回放尾巴，否则全量回放重建
- 后台 compaction，重写存活对象并删除旧 block；API 上的 flush / compact 转发到存活的 block 节点
- 管理接口：`GET /_s3dfs/stats|cluster|buckets`，`POST /_s3dfs/flush|compact`
- 控制台查看统计、桶、block 节点状态，并触发 flush / compact

## 还不做的

- 完整 AWS SigV4 鉴权（环境变量里的 access/secret 尚未生效）
- 流式上传 / 下载；S3 分片上传（Multipart）
- 纠删码
- 把对象值放进 dleveldb；索引里只有 locator JSON，正文始终在 block 文件里
- 对象数据副本的自动修复 / 迁移（节点宕机后不会把缺失的副本补到别的机器）
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

### block 节点

- `S3DFS_BLOCK_NODE_ID`：本 block 进程的节点名，默认 `block1`；多机时必须互不相同
- `S3DFS_BLOCK_PORT`：block 服务端口，默认 9100
- `S3DFS_ADVERTISE_ADDR`：其它进程访问本 block 用的 `host:port`，默认 `127.0.0.1:${S3DFS_BLOCK_PORT}`
- `S3DFS_DATA_DIR`：本 block 的数据目录，默认 `./data/block`
- `S3DFS_BLOCK_SIZE`：单个 block 大小，默认 1GB（`1073741824`）
- `S3DFS_BUFFER_SIZE`：写缓冲，默认 1MB
- `S3DFS_FLUSH_INTERVAL_MS`：定期 flush 的间隔，默认 50ms
- `S3DFS_INDEX_URLS`：可选；设置后 block 会向索引注册 `$node/{nodeId}`

索引进程本身的端口、目录、副本数请看 dleveldb 的 `DLEVELDB_*` 环境变量。本仓库的 `pnpm dev:index` 默认把索引开在 `127.0.0.1:9800`，数据目录是 `s3dfs/data/index`。

## 列举与副本的注意点

- 列举会跳过 `key:1`、`key:2` 这类副本后缀，以及 `$node/` 下的注册 key。对象 key 不要以 `:数字` 结尾。
- 配置的数据副本数默认是 3，但有效值不会超过当前存活的 block 节点数。只有一台 block 时，行为和单副本一致。
- 多节点语义见 [索引与 block 集群](design-replication.md)。dleveldb 自己的 KV 复制是另一回事，见那个仓库的文档。

## 大文件与内存

引擎已经可以把一个逻辑对象切到多块中，索引只记最后一段，读取时沿链条从前向后拼回。不过 HTTP 层仍会把整个 body 读进 Node 内存，所以特别大的上传还是会先受到 API 进程内存的限制。流式 Put/Get 和分片上传是下一步。详见 [大文件跨 block 存放](design-large-object.md)。
