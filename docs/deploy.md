# 部署

| | |
| --- | --- |
| 读者 | 规划机器和入口的人 |
| 本文回答 | 哪些角色必须分开部署，仓库里现在怎么启动，生产安装还缺什么 |
| 验收 | [上线标准](diff/production.md) |
| 当前规模 | [规模说明](scale.md) |

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
| `GET /_s3dfs/modules` | 七个模块的内部数字。请求头 `x-s3dfs-patrol-token` 必须与 `S3DFS_PATROL_TOKEN` 一致 |
| `GET /_s3dfs/decisions` | 最近一次巡检的发现、决定和中文结论 |
| `POST /_s3dfs/patrol` | 按规则生成决定，并执行有利的维护动作 |

客户端使用官方 AWS CLI，把 `--endpoint-url` 指到负载均衡后面的 API，并设置 `addressing_style = path`。密钥与 API 相同。ETag 是 CRC32，不是 MD5。命令见仓库 README 的「用 AWS CLI 接入」。

## 5. 自动扩缩

容量和延迟由 API 里的评估器判断。真正开机、关机执行 `S3DFS_SCALE_UP_CMD` 和 `S3DFS_SCALE_DOWN_CMD`。脚本未配置时，这一层不运行。阈值和排空条件见 [能力](capabilities.md) 的自动扩缩一节。

C 网关使用同一对密钥和同一套法定人数、故障域规则。它认 `x-amz-date`，不认只有 `Date` 的请求。默认上线入口是 Nest API。AWS CLI 应指向 Nest API。

## 4. 单机

一条索引、一台 block、一台 API 即可运行。数据目录、端口和启动命令以仓库 README 为准。单机布局用于开发和验证，不按第 1 节称为可承接业务的部署。

## 6. 巡检

巡检 AI 随仓库提供，是单独的 TypeScript 进程，用 `pnpm patrol` 启动，不放在写入路径上。规则负责维护动作，模型负责把模块状态写成中文结论。API 和巡检进程配置同一个 `S3DFS_PATROL_TOKEN`。未配置时，模块快照和决定接口返回 401。

进程默认每天跑一次。`S3DFS_PATROL_INTERVAL_MS=0` 只跑一轮。模型默认是本机 LM Studio 的 Gemma 4 26B。`S3DFS_PATROL_MODEL=off` 时只留下规则结论。每轮在 `S3DFS_PATROL_REPORT_DIR`（默认 `reports/`）写一份 HTML，标准输出里的 `reportPath` 是绝对路径。变量、动作边界和 2026-11-20 的第一次运行见 [能力](capabilities.md#9-模块巡检) 与 [从自启到巡检结论](milestones/2026-11-20-first-patrol.md)。

## 7. 仓库里现在有的启动方式

第 1 节是生产要摆成的角色。仓库里能执行的启动还停在本机和发版目录，没有把这些角色装到准备接流量的机器上的步骤。

| 用途 | 现在有的 |
| --- | --- |
| 开发 | README 的 `pnpm dev:index`、`dev:block`、`dev:api`、`dev:web` 和 `pnpm patrol`。单机。`pnpm dev:api` 把副本设为 1 并关闭严格布局 |
| 发版目录 | `bun scripts/release.mjs 0.1.1` 先跑测试，通过后才编译进 `dist/`，再打成 `release/s3dfs-0.1.1-<系统>-<架构>.tar.gz`。`--tag` 把这个压缩包挂到同名 GitHub Release。测试失败不打包、不打标签 |
| 变量例子 | 仓库根 `.env.example`。按环境摆机器用 `deploy/envs/prod.env` 和 `deploy/envs/local.env` |
| 本机演练 | `scripts/drill-local.mjs`，笔记在 [2026-11-21 本机演练](milestones/2026-11-21-local-drill.md) |
| 安装脚本 | `bun scripts/deploy.mjs render --env deploy/envs/prod.env --out deploy/out/prod` 按副本数、索引台数、API 台数和 zone 写出 systemd、Docker Compose 和 Kubernetes 清单 |

`S3DFS_SCALE_UP_CMD` 和 `S3DFS_SCALE_DOWN_CMD` 不配时，加机器和减机器不执行。告警还没有送到外部值班，索引、block、API 的升级和回退顺序也还没有写成步骤。这两项的关闭条件在 [待办](todo.md)。证书仍在入口的反向代理上终止，清单里没有写证书。

下面这张表是同一条发布在三种环境里怎么接上。环境文件写副本数、索引台数、API 台数和 zone。生产用第 1 节的数量，`deploy/envs/local.env` 是 1 份。

| 步骤 | 现在有的 | 还要连上 |
| --- | --- | --- |
| 打包 | `release/s3dfs-<版本>-<系统>-<架构>.tar.gz`。里面是接口、block、巡检、控制台、引擎和依赖 | 在目标机器解压到 `/opt/s3dfs`。压缩包按本机系统命名，Linux 机器用 linux 那一个 |
| 自动测试 | 发版命令和 GitHub 都会跑 `packages/control/test`、`apps/api/test`、`scripts/deploy.test.mjs` | 失败就不打包，也不打标签 |
| 发版本 | `bun scripts/release.mjs <版本> --tag` 推送标签，并把 tar.gz 挂到该标签的 GitHub Release | 标签页上能下载到和 `dist/VERSION` 相同版本的压缩包 |
| 发到环境 | `deploy.mjs render` 按 `deploy/envs/*.env` 写出该环境的 systemd、Compose 和 Kubernetes 文件 | 在准备接流量的机器上执行安装，并确认健康检查 |
| 副本和角色 | 环境文件里的 `replicas`、`indexes`、`apis`、`zones` 和三组机器地址 | 生产用 `deploy/envs/prod.env`，本机用 `deploy/envs/local.env` |
| 运行环境 | systemd 单元、`deploy/docker/Dockerfile`、`deploy/docker/index.Dockerfile`、Kubernetes 清单都由同一次 render 写出 | 索引和 block 使用 `/var/lib/s3dfs` 下的固定目录或卷。换版本不删这些目录。API 前面是 Kubernetes Service（LoadBalancer）。Helm 不是前提 |

目标机器使用 Release 上的 tar.gz，解压到 `/opt/s3dfs`。Docker 镜像用解压后的目录构建：`docker build -f deploy/docker/runtime.Dockerfile -t s3dfs /opt/s3dfs`。索引镜像的上下文仍是旁边的 dleveldb：`docker build -f deploy/docker/index.Dockerfile -t dleveldb ../dleveldb`。`bun` 要在 `/usr/bin/bun`。密钥从 `secret.env.example` 复制出来再填，不写进仓库。安装脚本不删除 `/var/lib/s3dfs`。

待办里的「生产部署」关闭时，准备接流量的那一种装完后，该环境的 `GET /_s3dfs/health` 为 200。只在本机打出 `dist/`、或只跑过测试，不算关闭。

## 8. 用压缩包

值班从 GitHub Release 下载与机器一致的 `s3dfs-<版本>-<系统>-<架构>.tar.gz`。同一份用法写在包内的 `使用说明.md`，源码里的副本是 [deploy/使用说明.md](../deploy/使用说明.md)。程序解压到 `/opt/s3dfs`。索引仍是旁边的 dleveldb，不在这个包里。

一台机器、一份副本：

```bash
sudo mkdir -p /opt/s3dfs /var/lib/s3dfs/block/block1
sudo tar -C /opt/s3dfs -xzf s3dfs-0.1.1-linux-x64.tar.gz
cd /opt/s3dfs
export S3DFS_INDEX_URLS=http://127.0.0.1:9800 S3DFS_DATA_REPLICAS=1 S3DFS_STRICT_LAYOUT=0
S3DFS_BLOCK_NODE_ID=block1 S3DFS_DATA_DIR=/var/lib/s3dfs/block/block1 S3DFS_ADVERTISE_ADDR=127.0.0.1:9100 bun block/main.js
```

接口在另一个终端：

```bash
cd /opt/s3dfs
export S3DFS_INDEX_URLS=http://127.0.0.1:9800
export S3DFS_BLOCK_NODES=block1=127.0.0.1:9100
export S3DFS_DATA_REPLICAS=1 S3DFS_STRICT_LAYOUT=0
bun api/main.js
curl -fsS http://127.0.0.1:9000/_s3dfs/health
```

正式环境保持 `S3DFS_STRICT_LAYOUT=1`，并设置两个密钥。巡检是 `bun patrol/main.js`，控制台是 `npm run start:web`。

多台机器先改 `deploy/envs/prod.env` 里的地址，再生成单元或清单。生成结果只负责拉起进程，程序本身用上面的压缩包。

```bash
bun scripts/deploy.mjs render --env deploy/envs/prod.env --out deploy/out/prod
sudo tar -C /opt/s3dfs -xzf s3dfs-0.1.1-linux-x64.tar.gz
sudo deploy/out/prod/systemd/install.sh
sudo systemctl enable --now s3dfs-index@index1 s3dfs-block@block1 s3dfs-api@api1 s3dfs-patrol
```

第二台 block 用 `s3dfs-block@block2`，第二台索引用 `s3dfs-index@index2`，第二台 API 用 `s3dfs-api@api2`。`install.sh` 不删除 `/var/lib/s3dfs`。索引程序仍放在 `/opt/dleveldb`。

Docker 用解压后的目录做镜像，不用 git 源码重新编译 s3dfs。索引镜像仍从 dleveldb 仓库构建。

```bash
docker build -f deploy/docker/runtime.Dockerfile -t s3dfs /opt/s3dfs
docker build -f deploy/docker/index.Dockerfile -t dleveldb ../dleveldb
cp deploy/out/prod/docker/secret.env.example deploy/out/prod/docker/secret.env
docker compose -f deploy/out/prod/docker/compose.yaml up -d
```

换版本时不要给 `docker compose up` 加 `-v`。卷名不带版本号。

Kubernetes 同样使用名为 `s3dfs` 的镜像，镜像内容来自压缩包。API 前面是 LoadBalancer。Secret 样例要先填密钥。

```bash
kubectl apply -f deploy/out/prod/k8s/secret.env.example
kubectl apply -f deploy/out/prod/k8s/s3dfs.yaml
kubectl -n s3dfs rollout status statefulset/s3dfs-block
```

索引和 block 的卷来自 `volumeClaimTemplates`。删掉 Pod 再拉起，卷还在。
