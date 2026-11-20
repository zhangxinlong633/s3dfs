# S3DFS C S3 gateway

| | |
| --- | --- |
| Role | Optional HTTP/1.1 entry in front of the same index and block nodes |
| Default launch entry | The Nest API. See `docs/diff/production.md` before placing this binary on a load balancer |

After parsing a request, the process talks to dleveldb and the block nodes the same way `packages/control` `ObjectCluster` does (HTTP keep-alive). The Nest API is unchanged.

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
| `S3DFS_BLOCK_NODES` | empty | Optional seeds `id=host:port` or `id=host:port@zone`, plus nodes loaded from the index registry (`$node/`) |
| `S3DFS_DATA_REPLICAS` | `1` | Replica count, same placement as `ObjectCluster` |
| `S3DFS_WRITE_QUORUM` | majority | Successes required before locators are published. Clamped to the copies selected for that write |
| `S3DFS_ACCESS_KEY` / `S3DFS_SECRET_KEY` | unset | Both set: check SigV4 header auth and presign. Either missing: open |
| `S3DFS_COMPRESS` | `zstd` | `none` / `zstd` / `gzip`. Objects smaller than 64 bytes are stored uncompressed |
| `S3DFS_HEALTH_INTERVAL_MS` | `5000` | Registry refresh / block health interval; `0` disables the background thread |
| `S3DFS_S3_WORKERS` | `max(32, 2*ncpu)` | Accept/request worker threads |

`DLEVELDB_SYNC` is not interpreted here; the index process keeps its own default (`true`).

See `docs/design-s3-gateway.md` for the request path, locator format, and what is not implemented.
