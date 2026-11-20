# Design: thin C S3 gateway

## Why

The official 2026-11-17 Mac benchmark calls `ObjectCluster.put/get` in-process.
That still uses HTTP to the dleveldb index and the block nodes, but it does not
go through the Nest S3 API. A short 2026-11-19 probe against the TypeScript
gateway was slower on the same class of 1KiB Put/Get work, mostly because of
that extra hop (Nest routing, S3 parsing, and an extra head after Put to mint
the ETag).

This gateway is a small C HTTP/1.1 frontend that, after parsing the S3 request,
follows the same control-plane path as `packages/control` `ObjectCluster`: HTTP
keep-alive to `/_dleveldb/kv/*` and `/_s3dfs/block/*`. The packed-block engine
and the index cluster are unchanged. The Nest API remains in place.

It is not nginx-s3-gateway (a reverse-proxy config in front of an existing S3
service) and not Ceph radosgw (bound to RADOS).

## Request path

```
S3 client  --HTTP/1.1-->  s3dfs-s3-gateway  --HTTP keep-alive-->  dleveldb index
                                            --HTTP keep-alive-->  block node(s)
```

- Path-style only: `/bucket`, `/bucket/key`. Virtual-hosted buckets stay on the Nest API (`S3DFS_DOMAIN`).
- SigV4 when both `S3DFS_ACCESS_KEY` and `S3DFS_SECRET_KEY` are set: header auth and query presign. Unset means open. Chunk signatures inside `aws-chunked` bodies are not checked. A request that has only `Date` and no `x-amz-date` is rejected when auth is on.
- `aws-chunked` bodies are decoded before they are stored. Multipart create / upload / complete / abort / list parts are kept in process memory (64 uploads, 32 parts) and disappear on restart.
- Locator format is the current `v: 3` document with a stable `recId`. Replica 0 lives at the object key; replica `i` is `{key}:{i}`. This process does not invent a new schema.
- Put compresses with `S3DFS_COMPRESS` (default zstd; values below 64 bytes stay `none`), writes the packed payload to live block nodes chosen like `NodeRegistry.pick` (SHA-1 start, `@zone` spread first), and publishes locators after `S3DFS_WRITE_QUORUM` successes. The default quorum is a majority of the copies selected for that write.
- Get prefers locators whose nodes are not marked down, then tries the next replica on error, missing data, size mismatch, or CRC mismatch. Range is applied after a full Get.
- Block nodes are discovered from the index registry prefix `$node/`, plus optional `S3DFS_BLOCK_NODES` seeds (`id=host:port` or `id=host:port@zone`). A background thread refreshes health. The gateway is not a ring member.
- Workers share a listening socket. Each worker keeps a thread-local pool of keep-alive connections to index and block endpoints, with one automatic reconnect on a stale socket.
- Replica puts run concurrently. Empty-bucket delete returns 204, 404, or 409 when the bucket still has objects.

## Implemented S3 operations

- `GET /` — list buckets
- `PUT /bucket` — create bucket
- `GET|HEAD /bucket` — list objects (`prefix`, `start-after` / `continuation-token`, `max-keys`, `delimiter=/` and other delimiters, matching current API behavior)
- `PUT /bucket/key` — put object (creates the bucket if needed). ETag is the CRC32 of the original bytes; Put does not issue a follow-up Head.
- `GET|HEAD /bucket/key` — get / head, including `Range` (HTTP 206 / 416)
- `DELETE /bucket/key` — always HTTP 204, including when the key is already missing
- `DELETE /bucket` — delete an empty bucket. `BucketNotEmpty` when an object remains
- `POST /bucket?uploads`, `PUT /bucket/key?uploadId&partNumber`, `GET` list parts, `POST` complete, `DELETE` abort — in-memory multipart

Overwrite and delete-then-404 follow the existing API / `ObjectCluster` behavior.

## Not implemented

- Chunk signatures on `aws-chunked` bodies
- Durable multipart (parts live in this process)
- Virtual-hosted–style bucket URLs, Copy, tagging, ACL, versioning, bucket policy, lifecycle, SSE
- Repair / compaction loops (those stay in the TypeScript control plane / block process)
- A console button or admin UI

This document does not record performance numbers. Exploratory measurements belong in a separately labeled unofficial bench file, not in `docs/bench-2026-11-17.json` or the official tables.
