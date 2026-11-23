# Benchmarks

Measured on 16 Nov 2026, 11:01 (Asia/Shanghai), with Bun 1.4.2, on a MacBook Pro (Mac17,9): Apple M5 Pro, 15 cores (5 Super and 10 Performance), 48 GB RAM, Apple SSD AP1024Z, macOS arm64.

These are single-host results. The three-node case is three processes on the same machine, talking over HTTP on localhost, not a multi-machine network. Default `DLEVELDB_SYNC` is `true`; the faster `sync=off` numbers can lose recent writes if the process crashes.

Reproduce:

```bash
pnpm --filter dleveldb bench
# or: bun packages/dleveldb/scripts/bench.mjs
```

The script opens a fresh temporary data directory for each case, warms up, then measures sequential operations (latency percentiles from those sequential runs). The "32 in flight" row pipelines 32 concurrent puts and reports throughput only.

## In-process library

One machine, effective replica count N=1, unless noted.

| Workload | Operations | Throughput | p50 | p99 |
| --- | ---: | ---: | ---: | ---: |
| put 100 B, `sync=off` | 50,000 | 39,200 ops/s | 24 µs | 37 µs |
| get 100 B, `sync=off` | 50,000 | 92,510 ops/s | 10 µs | 18 µs |
| put 1 KiB, `sync=off` | 50,000 | 36,745 ops/s | 26 µs | 38 µs |
| get 1 KiB, `sync=off` | 50,000 | 85,459 ops/s | 12 µs | 18 µs |
| put 16 KiB, `sync=off` | 20,000 | 19,434 ops/s | 46 µs | 191 µs |
| get 16 KiB, `sync=off` | 20,000 | 60,736 ops/s | 15 µs | 24 µs |
| put 1 KiB, `sync=on` (default) | 2,000 | 17,400 ops/s | 48 µs | 212 µs |
| get 1 KiB, `sync=on` | 20,000 | 88,810 ops/s | 11 µs | 18 µs |
| put 1 KiB, `sync=off`, 32 in flight | 50,000 | 99,002 ops/s | — | — |
| put 1 KiB, `sync=off`, 4 vnodes | 50,000 | 35,771 ops/s | 27 µs | 40 µs |
| get 1 KiB, `sync=off`, 4 vnodes | 50,000 | 41,845 ops/s | 22 µs | 51 µs |
| scan 10,000 keys by prefix, 1 vnode | 20 scans | 196 scans/s | 4.98 ms | 5.83 ms |

Gets in a 4-vnode process are slower than a single vnode because a lookup may search more than one local shard.

## Three processes on localhost

N=3, W=2, HTTP RPC (`/_dleveldb/kv/put` and `/_dleveldb/kv/get`), `sync=off`, 5,000 operations each.

| Workload | Throughput | p50 | p99 |
| --- | ---: | ---: | ---: |
| HTTP put 1 KiB | 2,835 ops/s | 334 µs | 961 µs |
| HTTP get 1 KiB | 11,592 ops/s | 82 µs | 231 µs |

Each put waits for a majority of the three processes. Reads often hit the local process first, then go over HTTP only if needed; this run issued gets through the same HTTP API on the first process.
