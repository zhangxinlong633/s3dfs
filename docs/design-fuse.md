# 目录挂载

| | |
| --- | --- |
| 读者 | 只能使用本地路径、不能改成 S3 客户端的应用 |
| 定位 | 兼容层。产品主路径仍是 S3 API。挂载速度不代表存储性能 |

独立进程 `apps/fuse`（`s3dfs-fuse`）把一个桶映射成本地目录。不改 packed-block 引擎，也不把 POSIX 语义写进 `.blk` 或 dleveldb。

已经做的：S3 List 支持 `delimiter=/` 和 CommonPrefixes；GET/HEAD 支持单个 `Range`（HTTP 206）。挂载层采用关闭时整文件上传，目录是对象前缀。Linux 上没有 libfuse 时直接对 `/dev/fuse` 说话；装了 libfuse 或 macFUSE 时走 libfuse。本机没有 FUSE 内核接口时（例如未安装 macFUSE 的 macOS），同一进程会在本机开一个 WebDAV，再用系统的 `mount_webdav` 挂上，会多一层协议，通常更慢。挂载进程自己仍是 Get 再 Put，不走服务端 Copy。流式传输和 FUSE-T 仍属于后续阶段。

FUSE 本身不是网络文件系统协议。远程访问靠客户端本机跑一个挂载进程，再通过 HTTP 访问集群的 S3 API。看起来像本地目录，底下仍是对象的 Put / Get。每个文件在关闭时都是一次完整对象上传，再叠加 FUSE 或 WebDAV 的元数据请求，所以大量小文件会明显慢于直接调用 S3 API。不要用挂载目录上测到的文件数/秒去代表引擎或集群性能。Linux 上上传发生在 FUSE 的 `Release` 里，`Flush` 目前是空操作，应用侧的 `close` 可能在对象对 API 可见之前就返回；这和「关闭成功后应当能马上读到自己写的内容」还有差距。

## 要解决的问题

块存储和 NFS/Gluster 解决的是「盘或目录挂到机器上」。s3dfs 现在解决的是 S3 对象存取。有些应用不会改成 S3 SDK，只认路径和 `open` / `read` / `write`。需要一层适配，而不是把对象存储改造成 CephFS 或 Gluster。

这一层必须接受对象语义的限制：整对象更新、没有分布式锁、没有真正的硬链接，改名通常是复制再删除。它适合读多写少、整文件更新、把桶当目录浏览；不适合数据库、频繁随机写、依赖 POSIX 锁的程序。那些场景仍应使用 NFS、Gluster 或 RBD。

## 分层

```
应用 / Pod
  └── FUSE 挂载（客户端本机的 s3dfs-fuse）
        └── HTTP（现有 S3 API，默认 :9000）
              ├── dleveldb 索引（对象在哪）
              └── packed-block（`.blk` + recId）
```

- 独立进程、独立目录（建议 `apps/fuse`），客户端不必链入 C 引擎，也不必直接访问 block 节点或索引。
- 集群侧继续只提供对象接口。挂载进程是普通 S3 客户端，外加目录列举、本地暂存这些文件系统需要的逻辑。
- 不要为了 FUSE 去改 `recId`、compact、副本或压缩。这些仍然只服务对象存储。

可选的后路是：S3 再补齐后，也可以直接用 s3fs、goofys 去挂。先自研一层，是因为当时 API 还缺 delimiter 列举和 Range；这两项现在已经有了，但还没有 Multipart、流式读写和完整签名，现成工具仍不一定好用。等 S3 更完整之后，也可以把自研 FUSE 换成这些工具，集群不用再改。产品主路径仍然是把 S3 协议做好。

语言上是一个 C 程序，而不是 Go，也不是在 Nest/TypeScript 里做 FUSE。Linux 没装 libfuse 时直接对接 `/dev/fuse`；有 libfuse 或 macFUSE 时用 libfuse 的高层接口。macOS 若没有 macFUSE，则走本机 WebDAV。

## 路径怎么对应

默认一次只挂一个桶：

```
/mnt/s3dfs/a/b.txt    →    桶里的对象 key `a/b.txt`
/mnt/s3dfs/a/          →    前缀 `a/`（逻辑目录，不必先有真实 inode）
```

目录是前缀，不是引擎里的目录项。某个路径算目录，当且仅当存在目录标记对象 `a/`，或存在以 `a/` 开头的对象。`mkdir a` 可以写一个空的 `a/` 标记，方便空目录也能列出来；`rmdir` 仅在没有子对象时删除该标记。

以后可以再提供「挂根路径、第一层是各个桶」的模式，第一期不必做。Kubernetes 的 CSI 也放后期：有了本机 FUSE 之后，再考虑用它做卷的挂载。

## 在 S3 和 block 里怎么存

挂载点对应的是整个桶，不是桶里的一条空 key。根目录本身通常也不单独存记录。FUSE 不另存一份数据，也不在引擎里做目录 inode。

路径变成该桶下的对象 key 后，文件内容走普通 Put，和直接调用 S3 API 是同一条存储路径：

- 索引里的对象 key 是字面量 `桶名/对象路径`
- 正文作为 TLV 记录追加进 block 节点的 `.blk` 文件
- 多个文件叠在同一个或几个 block 文件里，不是每个文件单独一个 `.blk`
- 目录只是 key 前缀，加上可选的空标记对象 `dir/`

例如把桶 `fusebench` 挂到 `/mnt/s3dfs` 后：

```
/mnt/s3dfs/dir1/a.txt   →  S3 对象 key `dir1/a.txt`
                        →  索引字面量 `fusebench/dir1/a.txt`
                        →  block 里一条（大文件时可能多条）TLV 记录
/mnt/s3dfs/dir1/        →  可选的空标记对象 `dir1/`
                        →  索引字面量 `fusebench/dir1/`
```

挂载目录里有 10 个文件，就是 10 个对象 key；如果建过子目录，还可能多几条空的 `dir/` 标记。这 10 份内容作为记录依次追加进 `.blk`。定位信息仍在 dleveldb，正文仍在 packed-block，和不用 FUSE 时一样。

## 规模与分布

存储这一侧避开了「一个文件一个 inode」。对象数主要变成 dleveldb 里的数据位置条数，正文合并进少量 `.blk`，并按 key 哈希分散到多台 block 机器。对分布式 KV 来说，千万到一亿量级的 key 是可预期负担，不是已经用这个规模测过的结果。

用 FUSE 在某一台机器上挂出整棵目录树时，内核和挂载进程仍会随文件数变重，瓶颈更可能在客户端，而不是 block 的文件个数。说明见 [架构文档里的对象规模与分布](architecture.md#对象规模与分布)。

## POSIX 操作怎么落到对象上

第一期采用常见的「关闭时整文件上传」（write-on-close），和 s3fs 一类工具同一类模型。应用侧看到的是 `open` / `read` / `write` / `close`，落到我们这边是对象的 Head / Get / Put / Delete：

- `open` 写文件时，先在客户端本地建一个临时文件；若对象已存在，会先取回再改
- `read` / `write` 都对着这个本地文件进行（读已经关闭过的文件，则按 Range GET 取内容）
- `close` 时如果文件脏了，才把整份内容 Put 到 S3，再追加进 block。不是每次 `write()` 都立刻写一条记录

| 操作 | 行为 |
| --- | --- |
| `getattr` / `stat` | 文件走 Head；目录看前缀或目录标记。权限可固定为 `0644` / `0755`，不实现完整 Unix 权限。 |
| `readdir` | 按前缀列举，并用 `/` 做 delimiter，只返回这一层的对象和子目录。 |
| `read` | 第一期可以把整个对象取回，再按偏移切给读请求；大文件必须改成 Range Get，避免整对象进内存。 |
| `create` / `write` / `close` | 写入先落到客户端本地临时文件，`close` 或约定的 `fsync` 再一次性 Put。打开期间别的客户端看不到未提交的内容。 |
| `unlink` | Delete 对象。 |
| `mkdir` / `rmdir` | 写或删目录标记；目录非空则 `rmdir` 失败。 |
| `rename` | 复制后删除。第一期没有服务端 Copy 时，客户端 Get 再 Put，再 Delete。不是原子的，目录改名会碰到很多对象。 |
| `truncate`、文件中间改写 | 读出、修改、整对象再写回。小文件可以接受，大文件随机写会很差。 |
| 锁、硬链接、chmod/chown | 第一期不做分布式锁和硬链接；时间戳以外的属性可以忽略或以后再放到对象元数据里。 |

修改不是改原来那条记录：再 Put 一次会在 block 里追加新的 TLV，索引改指向新记录，旧记录变成死空间。删除是给这条 key 打墓碑、从索引里拿掉；block 里的旧数据当时也不立刻搬走。改名是按新路径再写一份，再按上面的方式删掉旧 key。空洞都留给空闲或手动 compact 清理，见 [删除空洞与 compact](design-compaction.md)。

同一对象被两个挂载点同时写时，后完成 Put 的覆盖先完成的，没有 POSIX 那种共享写一致性。同一挂载点内，文件关闭成功后应当能马上读到自己写的内容。

## 当前 API 还缺什么

FUSE 进程可以先对接现有的 Put / Get / Head / Delete / List（已有 prefix 和分页），但要成为一个能列目录、能读大文件的挂载，集群还需要补几项。这些都加在 S3 API / 控制面，不进 block 引擎。

**第一期建议一并做（已落地）：**

1. **列举支持 `delimiter=/` 和 CommonPrefixes。** List 可以只返回这一层的对象和子目录。没有 delimiter 时行为与原来相同。
2. **Get 支持 HTTP `Range`。** 单个 `bytes=` 范围返回 206。当前实现仍先把完整对象取回再切片，语义正确，但大文件还是会占 API 内存；沿 extent 链只读所需段是下一步。

**挂大文件之前还应该做，但可以放在第一期可运行之后：**

3. **流式 Put / Get**，避免 API 和 FUSE 都把整个对象放进内存。
4. **分片上传（Multipart）**，让 write-on-close 能传超过内存和 `uint32` 限制附近的大文件。引擎现在对外仍是 `uint32` 长度，单对象大约 4GB − 1 的上限仍然在。
5. **服务端 Copy**，让改名不必把数据拉回客户端。
6. **完整 SigV4 或至少可用的访问密钥校验。** 现在预留的 access/secret 尚未生效，挂载只适合信任网络。

没有这些之前，第一期应明确限制：适合中小文件、读多写少、单客户端写入；不宣传可替代 NFS/Gluster。

## 缓存与一致性

FUSE 非常碎（大量 `getattr`、`lookup`）。挂载进程需要：

- 短 TTL 的元数据缓存（Head / 列举结果），避免每个 `stat` 都打一次索引。
- 读可以走内核页缓存；写的脏数据只在本地临时文件，直到 close 才 Put。
- 第一期不做跨客户端的缓存作废。其它机器上的挂载，最多等 TTL 过期后看到更新。

文档和挂载参数里要把 TTL 写清楚，避免把它理解成强一致的网络盘。

## 部署形态

```
s3dfs-fuse --endpoint http://127.0.0.1:9000 --bucket mybucket /mnt/s3dfs
```

客户端只依赖 API 地址和桶名。集群扩容、副本、compact 对挂载透明。

## 分阶段

1. **方案（本文）**：已按此实现第一期。
2. **API**：已做 `delimiter` 列举和 Range Get。未压缩对象沿记录按偏移读取；压缩对象先解开再切。挂载进程读文件时仍可能把对象取回再切。
3. **挂载第一期**：`apps/fuse` 已实现单桶挂载，`stat` / `ls` / 读、write-on-close 写、删除、mkdir/rmdir、文件改名（复制再删除）。小文件为主。Linux 走 `/dev/fuse`；没有 macFUSE 时走本机 WebDAV。这只是兼容，不是性能路径。
4. **大文件**：流式和分片上传就绪后，再让大文件读写走 Range / multipart，而不是整对象进内存。
5. **可选**：服务端 Copy、鉴权、多桶根挂载、macFUSE / FUSE-T，以及 Kubernetes CSI。CSI 只是把本机挂载或同样的对象访问接到卷生命周期上，不是另一套存储。

## 先不做的

- 把就地覆盖、空洞分配或 POSIX inode 做进 C 引擎。
- 分布式文件锁、硬链接、完整权限和 ACL。
- 用 FUSE 去模拟 RBD 块设备。
- 跨节点的缓存一致性协议。
- 在第一期用本机对象性能数字去对比 Gluster、NFS 或 CephFS。


## 怎么用

先启动 s3dfs 的索引、block 和 API，再编译挂载程序：

```
cd apps/fuse
make
mkdir -p /mnt/s3dfs
./s3dfs-fuse --endpoint http://127.0.0.1:9000 --bucket mybucket /mnt/s3dfs
```

需要 C 编译器。`make test` 用内置的假 S3 服务检查关闭时上传、列目录、改名和 Range。二进制 `apps/fuse/s3dfs-fuse` 已加入 gitignore。这台机器如果装了 macFUSE（`/usr/local/include/fuse`），会链 libfuse；否则 macOS 打印正在改用本机 WebDAV，然后调用 `mount_webdav`。Linux 上若没有 libfuse 开发包，则直接对 `/dev/fuse`。结束时 Ctrl-C 会卸载。

## 成功标准（第一期）

在已启动的 s3dfs API 上，把一个桶挂到本地目录后：能创建子目录、写入中小文件、关闭后再读回内容一致，能删除和列举；同一文件用对象接口 Get 也能读到。大文件随机写、多客户端同时改同一文件、以及与 Gluster 接近的体验，不作为第一期目标。
