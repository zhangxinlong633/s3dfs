#!/usr/bin/env bash
set -euo pipefail

for p in 39100 39101 39102; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $p already in use, abort"
    lsof -nP -iTCP:$p -sTCP:LISTEN
    exit 1
  fi
done
echo "ports 39100-39102 are free"

PROBE=/tmp/s3dfs-c-gw-probe
rm -rf "$PROBE"
mkdir -p "$PROBE/index" "$PROBE/block1" "$PROBE/logs"
ROOT=/Users/bruce/git/s3dfs
INDEX_CLI=/Users/bruce/git/dleveldb/packages/dleveldb/src/dleveldb.ts
PIDS=()

cleanup() {
  set +e
  echo "---- cleanup ----"
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  sleep 0.5
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  if [[ -d "$PROBE/logs" ]]; then
    mkdir -p /tmp/s3dfs-c-gw-logs-keep
    cp -R "$PROBE/logs/." /tmp/s3dfs-c-gw-logs-keep/ 2>/dev/null || true
  fi
  rm -rf "$PROBE"
  echo "probe dir removed"
  for p in 39100 39101 39102; do
    if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
      echo "WARN: port $p still listening"
      lsof -nP -iTCP:$p -sTCP:LISTEN
    else
      echo "port $p free"
    fi
  done
  if lsof -nP -iTCP:9001 -sTCP:LISTEN >/dev/null 2>&1; then
    echo ":9001 still listening (left alone)"
  fi
}

trap cleanup EXIT

wait_port() {
  local port="$1" name="$2" timeout="${3:-20}"
  local start
  start=$(date +%s)
  while true; do
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then
      echo "$name on :$port is up"
      return 0
    fi
    if (( $(date +%s) - start >= timeout )); then
      echo "timeout waiting for $name :$port"
      if [[ -f "$PROBE/logs/${name}.log" ]]; then
        echo "----- $name log -----"
        cat "$PROBE/logs/${name}.log"
      fi
      return 1
    fi
    sleep 0.1
  done
}

DLEVELDB_PORT=39100 \
DLEVELDB_ADVERTISE_ADDR=127.0.0.1:39100 \
DLEVELDB_DATA_DIR="$PROBE/index" \
DLEVELDB_NODE_ID=index-c-gw \
DLEVELDB_VNODES=1 \
DLEVELDB_REPLICAS=1 \
bun "$INDEX_CLI" >"$PROBE/logs/index.log" 2>&1 &
PIDS+=($!)
echo "index pid ${PIDS[0]}"
wait_port 39100 index 20

S3DFS_BLOCK_NODE_ID=block1 \
S3DFS_BLOCK_PORT=39101 \
S3DFS_ADVERTISE_ADDR=127.0.0.1:39101 \
S3DFS_DATA_DIR="$PROBE/block1" \
S3DFS_INDEX_URLS=http://127.0.0.1:39100 \
S3DFS_FLUSH_INTERVAL_MS=20 \
S3DFS_COMPACT_INTERVAL_MS=0 \
S3DFS_REPAIR_INTERVAL_MS=0 \
bun "$ROOT/apps/block/src/block.ts" >"$PROBE/logs/block.log" 2>&1 &
PIDS+=($!)
echo "block pid ${PIDS[1]}"
wait_port 39101 block 20

for i in $(seq 1 50); do
  if curl -sf http://127.0.0.1:39101/health >/dev/null 2>&1; then
    echo "block health ok"
    break
  fi
  sleep 0.1
done

S3DFS_INDEX_URLS=http://127.0.0.1:39100 \
S3DFS_S3_LISTEN=0.0.0.0:39102 \
S3DFS_BLOCK_NODES=block1=127.0.0.1:39101 \
S3DFS_DATA_REPLICAS=1 \
S3DFS_COMPRESS=none \
S3DFS_HEALTH_INTERVAL_MS=2000 \
S3DFS_S3_WORKERS=32 \
"$ROOT/apps/s3-gateway/s3dfs-s3-gateway" >"$PROBE/logs/gateway.log" 2>&1 &
PIDS+=($!)
echo "gateway pid ${PIDS[2]}"
wait_port 39102 gateway 10
sleep 0.3
echo "----- gateway log -----"
cat "$PROBE/logs/gateway.log"
echo "----- starting probe -----"

S3DFS_PROBE_S3=http://127.0.0.1:39102 \
S3DFS_INDEX_URLS=http://127.0.0.1:39100 \
S3DFS_PROBE_BLOCK=127.0.0.1:39101 \
S3DFS_BENCH_OPS=5000 \
S3DFS_BENCH_WARMUP=500 \
S3DFS_BENCH_OUT=/tmp/s3dfs-bench-c-gateway-2026-11-19.json \
bun "$ROOT/apps/s3-gateway/scripts/unofficial-probe.mjs"
PROBE_RC=$?

if [[ -f /tmp/s3dfs-bench-c-gateway-2026-11-19.json ]]; then
  cp /tmp/s3dfs-bench-c-gateway-2026-11-19.json "$ROOT/docs/bench-2026-11-19-c-gateway.json"
  echo "copied unofficial bench json into docs/"
fi

echo "probe exit $PROBE_RC"
exit $PROBE_RC
