# 部署

| | |
| --- | --- |
| 读者 | 规划机器和入口的人 |
| 本文回答 | 哪些角色必须分开部署，怎样才把一套部署视为可承接业务 |
| 验收 | [上线标准](diff/production.md) |

API 不保存对象正文，可以水平扩展，前面用负载均衡接入客户端。索引和 block 有状态，不能当成无状态进程更换磁盘。

## 1. 角色

| 角色 | 数量 | 状态 | 说明 |
| --- | --- | --- | --- |
| S3 API | 生产至少 2 | 无状态 | 默认 `:9000`。任一进程退出后，客户端重试另一台 |
| 索引 | 至少 3 | 有状态 | 按 dleveldb 组成集群。`S3DFS_INDEX_URLS` 逗号分隔。当前地址失败时，控制面改写下一条。历史 key 的追平由 dleveldb 在节点加入环之后完成 |
| block | 不少于 `S3DFS_DATA_REPLICAS`（默认 3） | 有状态 | 用 `@zone` 分到不同机架或可用区 |

种子示例：

```text
b1=10.0.0.1:9100@rack-a,b2=10.0.0.2:9100@rack-b,b3=10.0.0.3:9100@rack-c
```

## 2. 写入与布局

| 规则 | 行为 |
| --- | --- |
| 写法定人数 | 默认是当次选出副本数的多数。3 副本要 2 份 block 成功，然后才写索引。未写上的一份由后台修复补齐。更严的条件用 `S3DFS_WRITE_QUORUM` |
| 严格布局 | `S3DFS_STRICT_LAYOUT` 默认开启。存活 block 少于配置副本数，或副本数大于 1 但 `@zone` 不足时，写入失败，`GET /_s3dfs/health` 返回 503，响应含 `reasons` |
| 单机开发 | 只有一台 block 时把 `S3DFS_DATA_REPLICAS` 设为 1。`pnpm dev:api` 会把副本设为 1 并关闭布局检查。显式 `S3DFS_STRICT_LAYOUT=0` 才按存活节点数降级 |

## 3. 入口与探活

两个变量都设置后才校验 SigV4：

```bash
S3DFS_ACCESS_KEY=...
S3DFS_SECRET_KEY=...
```

| 条件 | 结果 |
| --- | --- |
| 默认严格布局，任一密钥缺失 | 进程在开始监听之前退出 |
| `S3DFS_STRICT_LAYOUT=0` | 未配置密钥的端口开放。`pnpm dev:api` 会设置该值 |
| TLS | 在反向代理上终止。API 进程不提供证书 |

每个响应带 `x-amz-request-id`。进程向标准输出打一行 JSON，包含该 id、方法、路径、状态码和耗时。

| 接口 | 用途 |
| --- | --- |
| `GET /_s3dfs/health` | 索引不可达、严格布局不成立，或本进程修复记过 `lost` 时返回 503，响应含 `lost`。进程重启后该计数从 0 重新累加 |
| `GET /_s3dfs/metrics` | 自进程启动以来的状态码计数，不经过控制台 |

客户端使用官方 AWS CLI，把 `--endpoint-url` 指到负载均衡后面的 API，并设置 `addressing_style = path`。密钥与 API 相同。ETag 是 CRC32，不是 MD5。命令见仓库 README 的「用 AWS CLI 接入」。

C 网关使用同一对密钥和同一套法定人数、故障域规则。它认 `x-amz-date`，不认只有 `Date` 的请求。默认上线入口是 Nest API。AWS CLI 应指向 Nest API。

## 4. 单机

一条索引、一台 block、一台 API 即可运行。数据目录、端口和启动命令以仓库 README 为准。单机布局用于开发和验证，不按第 1 节称为可承接业务的部署。
