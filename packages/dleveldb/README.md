# 已拆到独立仓库

这一层不再是 s3dfs 的内嵌包。分布式 LevelDB 已经作为独立产品发布：

- 仓库：https://github.com/zhangxinlong633/dleveldb
- 本地开发时常和本仓库并列放在 `../dleveldb`

s3dfs 只通过 HTTP 客户端把对象索引（locator）写进那个小规模集群（大约 3–5 台就够），对象正文在大量独立的 block 机器上。本目录保留是为了对照历史实现，当前 workspace 已不再包含它，S3 API 也不会再依赖 `@s3dfs/dleveldb`。
