# s3dfs C S3 gateway

A thin HTTP/1.1 S3-compatible frontend written in C. After parsing a request it
talks to the dleveldb index and block nodes the same way `packages/control`
`ObjectCluster` does (HTTP keep-alive). The existing Nest TypeScript API is
unchanged; this binary is an alternative entry point for the hot path.

## Build

```bash
make -C apps/s3-gateway
```

Requires clang (or gcc), zlib, and libzstd. On macOS, libzstd is expected at
`/opt/homebrew` (override with `ZSTD_PREFIX=`).

The binary `apps/s3-gateway/s3dfs-s3-gateway` is a build artifact and is gitignored.

## Run

The process is an HTTP client of the index cluster, not a ring member. Start
dleveldb and at least one block node first, then:

```bash
S3DFS_INDEX_URLS=http://127.0.0.1:39100 \
S3DFS_S3_LISTEN=0.0.0.0:39102 \
S3DFS_BLOCK_NODES=block1=127.0.0.1:39101 \
S3DFS_DATA_REPLICAS=1 \
S3DFS_COMPRESS=none \
./apps/s3-gateway/s3dfs-s3-gateway
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `S3DFS_INDEX_URLS` | required | Comma-separated index base URLs |
| `S3DFS_S3_LISTEN` | `0.0.0.0:19002` | Gateway bind address |
| `S3DFS_BLOCK_NODES` | empty | Optional seeds `id=host:port`, plus nodes loaded from the index registry (`$node/`) |
| `S3DFS_DATA_REPLICAS` | `1` | Replica count, same placement as `ObjectCluster` |
| `S3DFS_COMPRESS` | `zstd` | `none` / `zstd` / `gzip`. Objects smaller than 64 bytes are stored uncompressed |
| `S3DFS_HEALTH_INTERVAL_MS` | `5000` | Registry refresh / block health interval; `0` disables the background thread |
| `S3DFS_S3_WORKERS` | `max(32, 2*ncpu)` | Accept/request worker threads |

`DLEVELDB_SYNC` is not interpreted here; the index process keeps its own default (`true`).

See `docs/design-s3-gateway.md` for the request path, locator format, and what is not implemented.
