# S3DFS

**English** | [中文](README.zh-CN.md)

<img src="docs/assets/s3dfs-logo.jpg" alt="S3DFS" width="480">

S3DFS is S3-compatible object storage. The control plane is TypeScript (Nest.js / Next.js). The on-disk engine is C. The index and the object body scale separately. The layout is aimed at large numbers of small objects. The repository path, commands, and `/_s3dfs/` URLs stay lowercase.

The index is a standalone [dleveldb](https://github.com/zhangxinlong633/dleveldb) cluster, usually 3–5 machines. Object bytes live on block machines that only run the packed-block engine, and those machines are added as capacity grows. The default is 3 copies. A majority is enough to acknowledge the write, and repair fills the copy that did not land. The everyday entry is the S3 API. Mounting a bucket as a directory is a compatibility layer, and mount speed is not storage performance.

Objects are packed into ~1 GiB `.blk` files, batched in memory, then written with a group `write` + `fsync`. Inode and IOPS cost follow the number of data files. Placement lives in dleveldb locators. The control plane compresses with zstd by default and stores the original bytes, with `compressType=none`, when compression does not shrink the value.

S3DFS ships with a patrol AI, `apps/patrol`. It is not on the write path. Once a day it reads the index, block nodes, layout, repair, API, scaling, and alerts. Rules repair short replicas, compact a hole-heavy node, flush a dirty buffer, and scale up when load stays high and a script is configured. The model turns those numbers and the actions already taken into a conclusion for the operator. It does not read object bytes, and it does not delete data, restart processes, or scale down. The default model is Gemma 4 26B in local LM Studio. `S3DFS_PATROL_MODEL=off` keeps the rule patrol. The conclusion is `GET /_s3dfs/decisions`, and the same round is written as HTML under `reports/`.

## Features

Behavior and environment variables are in [Capabilities](docs/capabilities.md).

| Feature | What it does today |
| --- | --- |
| Separate index and body | Locators live in dleveldb. Object bytes live on block machines that can be added |
| Packing and compression | Objects append into ~1 GiB `.blk` files. zstd by default; the original bytes are stored when compression does not shrink them |
| Replicas and failure domains | 3 copies by default. A majority is enough to commit. `@zone` spreads copies. A write is refused when live nodes or zones are short |
| Index commit | Locators are written one by one. Any failure deletes the locators already written for that object |
| Object API | Put / Get / Head / Delete / List, one Range, copy, presign, conditional requests, user metadata, multi-object delete |
| Buckets | Create, delete when empty, one JSON policy, one-key AES256, versioning and delete markers, lifecycle, webhooks |
| Multipart | The manifest stays in the index and part bytes stay in the block store across an API restart. The ETag is CRC32 |
| Signing and the CLI | SigV4 when both keys are set. The official AWS CLI connects with path-style addressing and `--endpoint-url` |
| Health and repair | Short replica sets are repaired. An object with no live copy is `lost`, and health returns 503 |
| Space and scale | Compaction reclaims space after deletes. With operator scripts, index, block, and API scale on capacity and latency |
| Console and mount | The console shows stats, buckets, and nodes. `s3dfs-fuse` mounts one bucket as a directory |
| Built-in patrol AI | Rules run repair, compact, flush, and a configured scale-up. The brief covers the current state, the change since last time, actions taken, and what to check next, and is written as HTML. The model writes from that brief |

Not provided yet: a bounded buffer on a single Put, capacity numbers from the target cluster, erasure coding, site replication, Object Lock, quotas, audit logs, multi-user IAM, and KMS. See [Todo](docs/todo.md).

## Documents

Design documents are in Chinese.

| Document | Reader | Question |
| --- | --- | --- |
| [Architecture](docs/architecture.md) | Someone tracing process boundaries | What the console, API, index, block nodes, and engine each own |
| [Capabilities](docs/capabilities.md) | Someone integrating or configuring | S3 operations and environment variables |
| [Deploy](docs/deploy.md) | Someone planning machines | Roles, replicas, and the public entry |
| [Launch criteria](docs/diff/production.md) | Someone deciding whether a cluster may hold the only copy | Acceptance tests and the on-cluster drill |
| [Scale](docs/scale.md) | Someone sizing capacity | How 100 EB of business data becomes block and index machines, plus a 50 PB disk case |
| [Recovery](docs/design-recovery.md) | Someone judging failure impact | Which requests continue |
| [Benchmarks](docs/benchmarks.md) | Someone citing numbers | Full tables from the 2026-11-17 single-host run |
| [Todo](docs/todo.md) | Someone scheduling work | Items that are still open |
| [First patrol](docs/milestones/2026-11-20-first-patrol.md) | Someone looking for the first end-to-end run | 2026-11-20, from process start to the local model's conclusion |

## One write

```mermaid
flowchart LR
  Client["S3 client"] --> API["API :9000"]
  API --> Index["dleveldb index"]
  API --> Block["block :9100"]
```

1. The control plane compresses the body according to `S3DFS_COMPRESS`.
2. The stored bytes are written to the selected live block nodes. The default is 3 copies, and a majority is enough to continue.
3. Each successful block write returns a `recId`. The API publishes locators at `bucket/key`, `bucket/key:1`, and so on. If any index write fails, the locators published for that object are removed.
4. A read loads the locators, skips down nodes, fetches by `recId`, and decompresses with the type stored on the locator.

## Repository

Install and compile with pnpm 9+ and Node.js 26+. Node processes run on Bun 1.4+. The Nest API is compiled with `tsc`, then started with bun.

```text
apps/api         Nest.js 12 S3 API, default :9000
apps/web         Next.js 16 console, default :9001
apps/block       packed-block node, default :9100
apps/patrol      patrol process, Deep Agents in TypeScript
packages/engine  C engine and N-API binding
packages/control index client, placement, health checks
docs/            product and design documents
```

The in-tree `packages/dleveldb` directory is historical and is not part of the build. Run the sibling dleveldb repository as the index.

## Start

Requires Node 26, pnpm 9, Bun 1.4+, a C/C++ compiler, and a dleveldb checkout at `../dleveldb`. Product code is TypeScript and C. node-gyp may call a local Python while compiling the engine; that Python is not a product language. The constraint is in [Architecture](docs/architecture.md).

```bash
git clone https://github.com/zhangxinlong633/dleveldb.git
git clone https://github.com/zhangxinlong633/s3dfs.git
cd s3dfs
pnpm install
pnpm build:engine
pnpm build:control
pnpm dev:index
pnpm dev:block
pnpm dev:api
pnpm dev:web
S3DFS_PATROL_TOKEN=local-token S3DFS_PATROL_INTERVAL_MS=0 pnpm patrol
```

`pnpm dev:api` sets one replica and turns strict layout off, for a single machine. The patrol process and the API share `S3DFS_PATROL_TOKEN`. Production layout is in [Deploy](docs/deploy.md). The first boot-to-conclusion run is in [First patrol](docs/milestones/2026-11-20-first-patrol.md).

## Connect with the AWS CLI

Point the official AWS CLI at the Nest API (`:9000`) with `--endpoint-url`. No custom client is required. Use path-style addressing: `http://host:port/bucket/key`.

Local `pnpm dev:api` leaves the port open. A production process requires the same access key and secret on the API and on the CLI.

```bash
aws configure set default.s3.addressing_style path
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_DEFAULT_REGION=us-east-1

aws --endpoint-url http://127.0.0.1:9000 s3 mb s3://logs
aws --endpoint-url http://127.0.0.1:9000 s3 cp ./a.log s3://logs/a.log
aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://logs
aws --endpoint-url http://127.0.0.1:9000 s3 cp s3://logs/a.log ./a.log
```

| Topic | Contract |
| --- | --- |
| Signature | SigV4. With both keys set, an unsigned request is 403 |
| Large objects | The CLI uses multipart or `aws-chunked`. The Nest API checks chunk signatures. Part bytes live in the block store and survive an API restart |
| ETag | CRC32, advertised as `x-s3dfs-etag-algorithm: crc32`. Do not treat the ETag as MD5. Use `Content-MD5` to check the body |
| Virtual host | With `S3DFS_DOMAIN`, the bucket is read from `bucket.domain`. DNS must point that name at the API |
| TLS | Terminate TLS at the reverse proxy and point `--endpoint-url` at the `https://` address |
| C gateway | The same path style and keys work. It is not the default entry: its multipart state is in memory and is lost on restart |

`aws s3api` and `aws s3` share this API, including create-bucket, upload, download, Range, copy, delete, and delete of an empty bucket.

## Single-host reference

Measured on 17 Nov 2026 on one MacBook Pro (Apple M5 Pro, 48 GB), over localhost. These figures describe the shape of the system. They are not a capacity commitment. Full tables are in [Benchmarks](docs/benchmarks.md).

| Planning case | Write | Read |
| --- | ---: | ---: |
| 1 KiB, N=1, sequential | 6,937 ops/s | 8,869 ops/s |
| 1 KiB, N=1, 32 in flight | 31,119 ops/s | 51,859 ops/s |
| 1 KiB, N=3, sequential | 2,785 ops/s | 4,151 ops/s |
| 1 MiB, N=1, incompressible | 208 ops/s | 409 ops/s |

That N=3 run had all three block processes up, so all three copies were written. Current code publishes after a majority and does not wait for the slowest copy.

## Runtime

Bun 1.4+, Node.js 26, pnpm 9.15, TypeScript 7.0.2, NestJS 12.5.0, Next.js 16.4.6, React 19.3.1. The object index is [dleveldb](https://github.com/zhangxinlong633/dleveldb).
