# C S3 网关

| | |
| --- | --- |
| 读者 | 评估是否把 C 网关接到与 Nest API 相同的索引和 block 上 |
| 定位 | 可选入口。默认上线入口是 Nest API，见 [上线标准](diff/production.md) |

2026-11-17 的本机基准调用的是进程内 `ObjectCluster`，请求仍经 HTTP 到达索引和 block，但不经过 Nest。2026-11-19 对 TypeScript 网关的短探针在同类 1 KiB Put / Get 上更慢，主要开销在 Nest 路由、S3 解析，以及 Put 之后为生成 ETag 多做的一次 Head。

本网关是一个小型 C HTTP/1.1 前端。解析 S3 请求之后，走与 `packages/control` 中 `ObjectCluster` 相同的路径：用 HTTP keep-alive 访问 `/_dleveldb/kv/*` 和 `/_s3dfs/block/*`。packed-block 引擎和索引集群不变。Nest API 保留。

它不是 nginx-s3-gateway（已有 S3 服务前的反向代理配置），也不是绑定 RADOS 的 Ceph radosgw。

## 请求路径

```
S3 client  --HTTP/1.1-->  s3dfs-s3-gateway  --HTTP keep-alive-->  dleveldb index
                                            --HTTP keep-alive-->  block node(s)
```

- 只做路径风格：`/bucket`、`/bucket/key`。虚拟主机风格的桶留在 Nest API（`S3DFS_DOMAIN`）。
- `S3DFS_ACCESS_KEY` 和 `S3DFS_SECRET_KEY` 都设置时校验 SigV4：请求头签名和查询预签名。两个都没设则端口开放。`aws-chunked` 正文里的分块签名不校验。打开鉴权后，只有 `Date`、没有 `x-amz-date` 的请求会被拒绝。
- `aws-chunked` 正文先解码再存储。分片的创建、上传、完成、放弃和列出分段都留在进程内存里（64 个上传、32 个分段），重启后消失。
- Locator 用当前的 `v: 3` 文档，带稳定的 `recId`。第 0 份在对象 key 上，第 `i` 份在 `{key}:{i}`。这个进程不另发明一套格式。
- Put 按 `S3DFS_COMPRESS` 压缩（默认 zstd；小于 64 字节保持 `none`），把打包后的正文写到活着的 block。选节点的方式和 `NodeRegistry.pick` 相同：从 SHA-1 起步，优先散到不同的 `@zone`。达到 `S3DFS_WRITE_QUORUM` 次成功后发布 locator。默认法定人数是这次选中的副本数的多数。
- Get 先用没有标成 down 的 locator，出错、缺数据、大小不符或 CRC 不符时再试下一份。Range 在一次完整 Get 之后截取。
- block 节点从索引里的 `$node/` 前缀发现，也可以用 `S3DFS_BLOCK_NODES` 种子（`id=host:port` 或 `id=host:port@zone`）。后台线程刷新健康状态。网关不是环上的成员。
- 多个 worker 共用一个监听套接字。每个 worker 对自己线程里的索引和 block 连接做 keep-alive 池，套接字失效时自动重连一次。
- 副本 Put 并发执行。删空桶返回 204；桶不存在返回 404；桶里还有对象返回 409。

## 已实现的 S3 操作

- `GET /`：列出桶
- `PUT /bucket`：建桶
- `GET|HEAD /bucket`：列出对象（`prefix`、`start-after` / `continuation-token`、`max-keys`、`delimiter=/` 以及其他分隔符，与当前 API 一致）
- `PUT /bucket/key`：上传对象（需要时建桶）。ETag 是原始字节的 CRC32；Put 之后不再补一次 Head
- `GET|HEAD /bucket/key`：读取或查看元数据，包括 `Range`（HTTP 206 / 416）
- `DELETE /bucket/key`：总是 HTTP 204，key 已经不在也一样
- `DELETE /bucket`：删除空桶。仍有对象时返回 `BucketNotEmpty`
- `POST /bucket?uploads`、`PUT /bucket/key?uploadId&partNumber`、`GET` 列出分段、`POST` 完成、`DELETE` 放弃：内存中的分片上传

覆盖写入，以及删除之后再读得到 404，都跟随现有 API 和 `ObjectCluster`。

## 还没有做的

- `aws-chunked` 正文上的分块签名
- 持久的分片（分段活在这个进程里）
- 虚拟主机风格的桶 URL、Copy、标签、ACL、版本、桶策略、生命周期、服务端加密
- 修复和 compact 循环（这两件事留在 TypeScript 控制面和 block 进程）
- 控制台按钮或管理界面

本文不记录性能数字。探路用的测量单独放在标明非正式的基准文件里，不放进 `docs/benchmarks/bench-2026-11-17.json`，也不放进正式表格。
