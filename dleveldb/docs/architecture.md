# dleveldb 架构

| | |
| --- | --- |
| 读者 | 把 dleveldb 当作索引或通用 KV 接入的人 |
| 本文回答 | 进程怎么拆，一次读写怎么走，一台机器宕掉之后读写还成立哪些条件 |
| 相关 | 放置公式、目录和 RPC 见 [design.md](design.md) |

## 定位

dleveldb 是一个**分布式的、以 LevelDB 为本地引擎的 KV 服务**。

它的作用是：在多台机器上提供 `Get / Put / Delete / 前缀扫描`，并靠分片、Chord 定位和副本，让一份数据不只落在一台机器上。它不是对象存储，也不负责把很多小文件打包进大 block 文件。应用如果要存大对象或 packed block，应把元数据放到 dleveldb，把对象本体放在自己的存储层。

## 分层

从上到下可以看成四层，仓库里的代码基本按这个边界来放：

```
控制台 / 业务应用
        │
        ▼
   Nest API 进程          apps/api
   （HTTP、CORS、生命周期）
        │
        ▼
   dleveldb 核心库         packages/dleveldb
   ┌─────────────┬──────────────┬──────────────┐
   │  KV 语义    │  Chord 环    │  RPC 传输    │
   │  Put/Get    │  后继/偏好表 │  /_dleveldb/ │
   │  副本法定人数│  stabilize  │              │
   └─────────────┴──────────────┴──────────────┘
        │
        ▼
   本地标准 LevelDB         classic-level
   shards/*  与  replicas/*
```

核心库可以单独用：`DLevelDB.open()` 之后直接在进程里调用，或用自带的 `dleveldb` 命令起一个裸 HTTP 服务。Nest 和 Next 是为了让一个节点更好运维：API 负责进程与路由，控制台负责看环上的成员、做一次读写试试。

## 节点模型

- **物理节点**：一台机器（或一个进程），有唯一的 `nodeId` 和对外地址 `advertiseAddr`。
- **虚拟节点（vnode）**：物理节点内部的分片，id 为 `{nodeId}-{seq}`。一台机器可以有多个 vnode，用来把 key 更均匀地洒在环上。
- **Chord 环**：所有 vnode 按 SHA-1 排成 160 位环。key 的主副本是 `successor(SHA-1(key))`。
- **偏好列表**：从主副本沿环向后，在不同物理机上各选一个 vnode，构成 N 个副本位置。

同一台物理机上的多个 vnode 不会互相复制：副本必须落在不同的 `nodeId` 上。物理机不够 N 台时，有效副本数会下降。只有一台机器时，有效 N 就是 1。

## 读写路径

**写（Put / Delete）**

```
客户端
  │ put(key, value)
  ▼
本机 dleveldb
  │ hash(key) → 偏好列表
  ├─ 主副本在本机：写入本地 shards/{vnode}/ ，再异步/并行复制到跟随者
  └─ 主副本在别人家：把请求转到那个地址，由对方以主身份完成上面的步骤
  │
  ▼
收到 W 个成功确认后返回
主副本不可达时，偏好列表里第一个存活节点在剩余副本仍达到 W 时接受 Put
确认数不足则 QUORUM_FAILED。两个分区不能同时持有多数
```

**读（Get / Head）**

1. 先扫本机所有主分片，再扫 `data/replicas/*`。主节点挂掉后，数据往往还在幸存者的 replica 目录里，这一步能直接命中。
2. 本机没有，再按偏好列表和已知节点逐个问 `get-any` / `head-any`。
3. 都没有才返回空。

这个顺序是刻意的：环在故障后仍把“主”记在原来的 vnode 上（只是标成 down），新晋升的节点自己的 shard 可能是空的，不能把空结果当成权威未命中。

**前缀扫描**

因为放置按 key 的哈希，而不是按 key 的字典序，前缀通常散落在多个 vnode 上。实现是向所有可达物理节点要各自的本地扫描结果，再归并排序。只有“单机、单 vnode、没有对等节点”时，才会退化成一次本地 LevelDB 迭代。

## 故障语义

- 探测失败的 vnode **不会从已知集合里删掉**，只标为 down。这样 key 的所有者不会因为一次掉线就漂移到别的节点。
- Chord 的路由、stabilize、finger 只走仍然活着的节点，避免把请求发到已经死掉的地址上绕圈子。
- 主副本可达时，写入由主副本协调。主副本不可达时，偏好列表里第一个存活节点接受 Put，数据写入该主 vnode 的副本库，确认数仍须达到 W。不允许两个分区同时持有多数。删除仍要求主副本可达。
- 读可以从任何还活着的副本服务。
- 节点加入环之后，以及每个稳定周期，`repairOnJoin` 把本机负责的 key 从其他存活节点的主分片和副本里按较新的 `mtime` 补齐。空节点追平完成之前，不要把全部读流量指到它上面。

## 进程怎么跑

节点进程用 **Bun** 运行。核心库可以直接 `bun src/dleveldb.ts`；Nest API 要先用 tsc 编译（Nest 的装饰器需要 TypeScript 发出的元数据），再用 `bun dist/main.js` 启动。`pnpm dev:api` 会自动编译并 watch。安装依赖仍用 pnpm，测试脚本也用 bun 执行。

一个典型节点是：

- `apps/api` 由 Bun 启动 Nest，监听 `DLEVELDB_PORT`（默认 9000），打开 `DLevelDB`，把 `/_dleveldb/*` 交给核心库的 `dispatchRpc`。
- `apps/web` 默认在 9001，浏览器里看集群、做读写。它只是 API 的客户端，本身仍用 Next.js 的进程。

多节点时，每个进程要有自己的 `DLEVELDB_NODE_ID`、`DLEVELDB_DATA_DIR`、`DLEVELDB_ADVERTISE_ADDR`，并用 `DLEVELDB_PEERS` 指向已经在环上的种子地址。

## 和 s3dfs 的关系

s3dfs 是对象存储，对象本体可以放在 packed block 里。dleveldb 是从那套分布式层里拆出来的**标准 KV 产品**，有意不包含 block 引擎。两者可以组合：s3dfs 用 dleveldb 存索引，自己继续管 block；也可以把 dleveldb 单独当作分布式 LevelDB 来用。
