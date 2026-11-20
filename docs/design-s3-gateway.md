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

- Path-style only: `/bucket`, `/bucket/key`.
- No authentication (same as the current TypeScript API). No SigV4.
- No multipart upload. No chunked-encoding request bodies. `Content-Length` is required for Put. `Expect: 100-continue` is accepted.
- Locator format is the current `v: 3` document with a stable `recId`. Replica 0 lives at the object key; replica `i` is `{key}:{i}`. This process does not invent a new schema.
- Put compresses with `S3DFS_COMPRESS` (default zstd; values below 64 bytes stay `none`), writes the packed payload to `N` live block nodes chosen by SHA-1 of the object key (sorted live set, same as `NodeRegistry.pick`), then writes locators to the index.
- Get prefers locators whose nodes are not marked down, then tries the next replica on error, missing data, size mismatch, or CRC mismatch. Range is applied after a full Get, same as the TypeScript control plane.
- Block nodes are discovered from the index registry prefix `$node/`, plus optional `S3DFS_BLOCK_NODES` seeds. A background thread refreshes health. The gateway is not a ring member.
- Workers share a listening socket. Each worker keeps a thread-local pool of keep-alive connections to index and block endpoints, with one automatic reconnect on a stale socket.

## Implemented S3 operations

- `GET /` — list buckets
- `PUT /bucket` — create bucket
- `GET|HEAD /bucket` — list objects (`prefix`, `start-after` / `continuation-token`, `max-keys`, `delimiter=/` and other delimiters, matching current API behavior)
- `PUT /bucket/key` — put object (creates the bucket if needed). ETag is the CRC32 of the original bytes; Put does not issue a follow-up Head.
- `GET|HEAD /bucket/key` — get / head, including `Range` (HTTP 206 / 416)
- `DELETE /bucket/key` — always HTTP 204, including when the key is already missing

Overwrite and delete-then-404 follow the existing API / `ObjectCluster` behavior.

## Not implemented (first cut)

- AWS SigV4 (and any other auth)
- Multipart upload
- Chunked transfer-encoded uploads
- Virtual-hosted–style bucket URLs
- Copy, tagging, ACL, versioning, presigned URLs, and the rest of S3
- Repair / compaction loops (those stay in the TypeScript control plane / block process)
- A console button or admin UI

N>1 replica placement is implemented and uses the same hash start and locator keys as `ObjectCluster`. Concurrent fan-out to replicas is sequential in this cut (N=1 is the measured hot path).

This document does not record performance numbers. Exploratory measurements belong in a separately labeled unofficial bench file, not in `docs/bench-2026-11-17.json` or the official tables.
