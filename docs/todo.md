# 还没有做的

和 RustFS 的对照在 [diff/rustfs.md](diff/rustfs.md)。下面只记还没做的，按「现有客户端能不能当 S3 用」排序。

## P0：S3 主路径

- SigV4。让已有的 access/secret 真正校验；C 网关与 Nest API 同一套规则。没有这一项，就不能放到非信任网络，FUSE 也只能在信任网络里用。
- 流式 Put / Get。Range 按偏移读，不要先取完整对象。同时去掉或放宽引擎 `uint32` 长度上限。分片完成时仍是一次整对象写入。
- 虚拟主机风格的 bucket URL，以及 CopyObject。ETag / Content-MD5 与现在的 CRC32 ETag 要对一下客户端预期。
- C S3 网关上的 `aws-chunked`、分片上传和删桶。这三项目前只在 Nest API（默认 :9000）。
- ListParts，以及把未完成的分片放到索引里。现在分片在 API 进程内存中，重启会丢。

## P1：故障时还能写、还能补

- 索引主不可达时的安全写切换，以及新索引节点追平历史 key。现在写索引会直接失败。
- 副本修复第二期：退役已经 down 的 locator；约定「没有任何活副本」时的失败，而不是留下永远补不回的 key。
- C 网关与 TypeScript 控制面的副本扇出改为并发。网关第一刀是串行写 N 份。
- 在多机网络上补一轮和 RustFS 同量级的小对象 / 大对象对照，写进 benchmarks。本机数字不能当选型结论。

## P2：对象存储产品面

- 桶策略与预签名 URL。ACL 可以继续不做，和 RustFS 一样引导到策略。
- 服务端加密。先单密钥，KMS 以后再说。
- 版本与删除标记。会改变 locator 和墓碑的形状，要单独设计，不能在 compact 上打补丁。
- 生命周期：按前缀过期、中止未完成的分片上传。
- 事件通知（至少 webhook）和基础指标。控制台保持薄，不要先做一套 MinIO 控制台。

## 明确排后

纠删码存储类、站点复制、远程分层、Object Lock、配额、审计日志、Helm、Swift / SFTP。这些 RustFS 已经有，P0 和 P1 完成前不做。
