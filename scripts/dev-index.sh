#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEX_ROOT="$(cd "$ROOT/../dleveldb" 2>/dev/null && pwd || true)"
if [[ -z "${INDEX_ROOT}" ]]; then
  echo "s3dfs: 找不到旁边的 dleveldb 仓库（期望 $ROOT/../dleveldb）。请先克隆 https://github.com/zhangxinlong633/dleveldb" >&2
  exit 1
fi
export DLEVELDB_PORT="${DLEVELDB_PORT:-9800}"
export DLEVELDB_ADVERTISE_ADDR="${DLEVELDB_ADVERTISE_ADDR:-127.0.0.1:${DLEVELDB_PORT}}"
export DLEVELDB_DATA_DIR="${DLEVELDB_DATA_DIR:-$ROOT/data/index}"
export DLEVELDB_NODE_ID="${DLEVELDB_NODE_ID:-index1}"
export DLEVELDB_VNODES="${DLEVELDB_VNODES:-1}"
export DLEVELDB_REPLICAS="${DLEVELDB_REPLICAS:-1}"
mkdir -p "$DLEVELDB_DATA_DIR"
cd "$INDEX_ROOT"
exec pnpm --filter dleveldb start
