# 还没有做的

和 RustFS 的对照在 [diff/rustfs.md](diff/rustfs.md)。下面只记还没做的。

## 还差的 S3 和故障行为

- C S3 网关的 SigV4。`S3DFS_ACCESS_KEY` / `S3DFS_SECRET_KEY` 目前只在 Nest API 上校验请求头签名和预签名 URL。
- 单次 Put 仍会在 API 进程里把 body 攒齐。引擎可以用 `putChunks` 按块追加，对象总长可以超过 `uint32`；分片完成时仍是一次整对象写入。
- dleveldb 的历史追平。控制面发现当前索引地址失败时会改走下一个 `S3DFS_INDEX_URLS`，但新索引节点不会在这个仓库里被灌入历史 key。
- 在多机网络上补一轮和 RustFS 同量级的小对象 / 大对象对照，写进 benchmarks。本机数字不能当选型结论。

## 明确排后

纠删码存储类、站点复制、远程分层、Object Lock、配额、审计日志、Helm、Swift / SFTP。这些不在当前存储路径上。
