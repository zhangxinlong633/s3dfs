# 索引与 block 集群

s3dfs 把「对象在哪」和「对象正文」分成两套集群。

- **对象索引**放在独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 里。这是一个标准的分布式 LevelDB（Get / Put / Delete / 前缀扫描），**不包含** packed-block 引擎。索引集群通常只需 **3–5 台**：locator 很小，不必和存储容量一起扩。dleveldb 自己的 KV 副本（默认 3，写法定人数 W）由那套产品负责，和对象正文副本不是一回事。
- **对象正文**放在大量 **block 节点**上（`apps/block`）。每台机器只跑 C 引擎，把对象打进默认 1GB 的追加式 block 文件。block 机器可以很多，按容量加机器即可。
- **S3 API**（`apps/api`）和管控台不加入 dleveldb 的环，也不在本进程打开 store。它们是索引集群和 block 集群的 HTTP 客户端。

仓库里曾经内嵌的 `@s3dfs/dleveldb` 已从 workspace 拿掉，源码目录只作历史对照，请改用独立产品。

## 分层

```
S3 API / 控制台
  └── ObjectCluster（桶语义、放置、健康检查）
        ├── dleveldb 客户端（小规模索引集群，约 3–5 台）
        │     ├── locator：bucket/key、bucket/key:1、bucket/key:2
        │     └── 节点注册：$node/{nodeId}
        └── 大量 block 节点（packed-block C 引擎）
              └── packed block 文件（TLV 记录，按偏移读写）
```

对象正文**不会**写进 dleveldb 的 value。索引里只有很小的 JSON。

## 对象数据副本

配置项 `S3DFS_DATA_REPLICAS` 默认是 3。有效副本数是 `min(配置值, 当前存活的 block 节点数)`。单机开发只有一台 block 时，有效副本就是 1，写入不会因为默认 3 而失败。

Put 按 `SHA-1(utf8(objectKey))` 在当前存活的 block 节点列表上选起点，再顺时针取 N 台不同节点，把同一份正文写过去。成功后在 dleveldb 写入：

| 索引 key | 含义 |
| --- | --- |
| `bucket/key` | 第 0 份副本的 locator（主记录，含 `replicaCount`） |
| `bucket/key:1` | 第 1 份副本 |
| `bucket/key:2` | 第 2 份副本 |

locator JSON 形如：

```json
{
  "v": 2,
  "replica": 0,
  "replicaCount": 3,
  "nodeId": "block1",
  "address": "10.0.0.11:9100",
  "blockId": 1,
  "offset": 4096,
  "recLen": 180,
  "chained": false,
  "generation": 0,
  "extentCount": 1,
  "size": 123,
  "storedSize": 80,
  "compressType": "zstd",
  "crc": 42,
  "mtimeMs": 1760000000000
}
```

`size` / `crc` 是未压缩正文的长度和校验；`storedSize` 是写进 block 的字节数；`compressType` 为 `none`、`zstd` 或 `gzip`。block 记录本身也是 TLV，同样带上压缩类型，索引丢了时可以扫 `.blk` 重建这些字段。

约定：

- 第 0 份就叫对象自己的 key，从 `:1` 开始才加后缀。
- 列举、统计对象数时会跳过匹配 `:[1-9]\d*$` 的索引 key，以及 `$node/` 下的注册信息。
- 因此对象 key 本身不要以 `:数字` 结尾。
- 桶标记仍是 `bucket/`。

Get / Head 先读这些 locator，跳过健康检查为 down 的节点，按剩余副本依次尝试并按 `compressType` 解压。Head 在副本机器暂时不可达时，可以用索引里记下的 size / crc / mtime。Delete 会先在已知副本的 block 上 best-effort 追加墓碑，再删掉对应的索引 key；盘上空间要等以后的 compaction 才会回收。

## 节点注册与健康检查

block 进程启动后（以及定期）会向 dleveldb 写入 `$node/{nodeId}`，内容包括 `address`、`status`、`lastSeenMs`。S3 API 也按 `S3DFS_HEALTH_INTERVAL_MS`（默认 5 秒）对这些节点做 `/health` 探测，并把 up / down 写回索引。

- Put 只在探测为存活（或尚未探测过）的节点里挑选。
- Get 跳过已标记为 down 的节点。
- 本轮**还没有**做副本修复或把 down 节点上的数据迁走。节点恢复后，只要磁盘上的对象还在，原 locator 可以继续用；节点彻底丢失时，对应副本不会自动补齐。

API 侧仍可用 `S3DFS_BLOCK_NODES=block1=127.0.0.1:9100,block2=127.0.0.1:9101` 作为种子列表，即使索引里还没有注册信息。

## 端口与进程

| 角色 | 默认端口 | 环境变量 |
| --- | --- | --- |
| S3 API | 9000 | `S3DFS_API_PORT` |
| 控制台 | 9001 | Next 默认 |
| block 节点 | 9100 起 | `S3DFS_BLOCK_PORT` |
| dleveldb 索引 | 9800 | `DLEVELDB_PORT`（经 `S3DFS_INDEX_URLS` 指向） |

单机开发：

```bash
pnpm dev:index    # dleveldb，:9800
pnpm dev:block    # block，:9100
pnpm dev:api      # S3 API，:9000
pnpm dev:web      # 控制台，:9001
```

多机时，索引集群按 dleveldb 自己的文档组成 3–5 个节点；block 机器各自启动 `apps/block`，用不同的 `S3DFS_BLOCK_NODE_ID`、`S3DFS_ADVERTISE_ADDR` 和数据目录。S3 API 可以有多份，它们都指向同一组 `S3DFS_INDEX_URLS`。

## dleveldb 本身还没做的

dleveldb 里，加入节点后的范围迁移 / catch-up repair，以及 primary 不可达时的安全写故障转移，都还没实现。读可以走剩余 KV 副本；若索引的 primary 不可达，写索引会失败。这些限制对 s3dfs 的 locator 更新同样适用，需要按独立产品的文档理解，不要假定这里已经做了修复。

## 和旧设计的差别

以前每个 s3dfs 节点同时带一个分布式 LevelDB vnode 和一份 packed-block store，对象正文随着 KV 分片走。那样每加一台存储机，索引环也会变大。现在索引和容量解耦：索引保持很小，block 机器按需增加。
