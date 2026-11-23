#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEX_ROOT="$ROOT/dleveldb"
if [[ ! -f "$INDEX_ROOT/packages/dleveldb/src/dleveldb.ts" ]]; then
  echo "s3dfs: 找不到仓库里的 dleveldb（期望 $INDEX_ROOT）。" >&2
  exit 1
fi
export DLEVELDB_PORT="${DLEVELDB_PORT:-9800}"
export DLEVELDB_ADVERTISE_ADDR="${DLEVELDB_ADVERTISE_ADDR:-127.0.0.1:${DLEVELDB_PORT}}"
export DLEVELDB_DATA_DIR="${DLEVELDB_DATA_DIR:-$ROOT/data/index}"
export DLEVELDB_NODE_ID="${DLEVELDB_NODE_ID:-index1}"
export DLEVELDB_VNODES="${DLEVELDB_VNODES:-1}"
export DLEVELDB_REPLICAS="${DLEVELDB_REPLICAS:-1}"
mkdir -p "$DLEVELDB_DATA_DIR"
bun -e "import { writeLayoutFile } from '$ROOT/packages/control/src/layout.ts'; writeLayoutFile(process.argv[1])" "$DLEVELDB_DATA_DIR"
cd "$INDEX_ROOT/packages/dleveldb"
exec bun src/dleveldb.ts
