#!/usr/bin/env bash
set -euo pipefail

# Keep Mac-local Qdrant (fallback) and Spark Qdrant (primary) converged.
#
# Design:
# - Normal mode (Spark healthy): reconcile LOCAL <- SPARK (local matches Spark exactly).
# - Recovery mode (Spark transitioned from down -> up):
#   1) merge LOCAL <- SPARK (upsert-only; never deletes local offline writes)
#   2) reconcile SPARK <- LOCAL (Spark matches local exactly, propagates offline writes + deletions)
#
# This is single-writer friendly and avoids wiping Spark if it received writes
# immediately on recovery.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

parse_bool() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    1|true|yes|on) echo "1" ;;
    0|false|no|off) echo "0" ;;
    *) echo "" ;;
  esac
}

is_loopback_host() {
  local host="${1:-}"
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  [[ -z "$host" || "$host" == "localhost" || "$host" == "::1" || "$host" =~ ^127\. ]]
}

dgx_enabled() {
  local raw
  raw="$(parse_bool "${DGX_ENABLED:-}")"
  if [[ "$raw" == "1" ]]; then
    return 0
  fi
  if [[ "$raw" == "0" ]]; then
    return 1
  fi
  local host="${DGX_HOST:-}"
  if [[ -z "$host" ]]; then
    return 1
  fi
  if is_loopback_host "$host"; then
    return 1
  fi
  return 0
}

# Load contract (non-secret)
if [[ -f "$ROOT_DIR/config/workspace.env" ]]; then
  set -a
  # shellcheck disable=SC1091,SC1094
  source "$ROOT_DIR/config/workspace.env"
  set +a
elif [[ -f "$ROOT_DIR/config/workspace.env.example" ]]; then
  set -a
  # shellcheck disable=SC1091,SC1094
  source "$ROOT_DIR/config/workspace.env.example"
  set +a
fi

if ! dgx_enabled; then
  echo "[$(ts)] qdrant-sync: DGX not enabled; skipping"
  exit 0
fi

LOCAL_URL="${QDRANT_URL:-http://127.0.0.1:6333}"
SPARK_URL="${DGX_QDRANT_URL:-}"
if [[ -z "$SPARK_URL" ]]; then
  if [[ -n "${DGX_HOST:-}" ]]; then
    SPARK_URL="http://${DGX_HOST}:6333"
  fi
fi
COLLECTION="${QDRANT_COLLECTION:-jarvis_memory_chunks}"

if [[ -z "$SPARK_URL" ]]; then
  echo "[$(ts)] qdrant-sync: missing DGX_QDRANT_URL/DGX_HOST; skipping" >&2
  exit 0
fi

LOCK_DIR="$ROOT_DIR/tmp/qdrant-sync-job.lock"
mkdir -p "$ROOT_DIR/tmp"

LOCK_TTL_SEC="${QDRANT_SYNC_LOCK_TTL_SEC:-1800}" # 30m default

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
    date +%s > "$LOCK_DIR/startedAt" 2>/dev/null || true
    return 0
  fi

  local now mtime age pid
  now="$(date +%s)"
  mtime="$(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)"
  age=$(( now - mtime ))
  pid=""
  if [[ -f "$LOCK_DIR/pid" ]]; then
    pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  fi

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "[$(ts)] qdrant-sync: already running (pid=$pid); exiting"
    return 1
  fi

  if [[ "$age" =~ ^[0-9]+$ ]] && (( age > LOCK_TTL_SEC )); then
    echo "[$(ts)] qdrant-sync: clearing stale lock (age=${age}s ttl=${LOCK_TTL_SEC}s pid=${pid:-unknown})"
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
      date +%s > "$LOCK_DIR/startedAt" 2>/dev/null || true
      return 0
    fi
  fi

  echo "[$(ts)] qdrant-sync: already running (lock age=${age}s); exiting"
  return 1
}

if ! acquire_lock; then
  exit 0
fi

cleanup() { rm -rf "$LOCK_DIR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

STATE_FILE="$ROOT_DIR/tmp/qdrant-sync-state.json"
LAST_SPARK_OK="0"
http_ok() {
  local url="$1"
  curl -fsS --max-time 3 "$url" >/dev/null 2>&1
}

LOCAL_OK="0"
SPARK_OK="0"
if http_ok "${LOCAL_URL%/}/collections"; then
  LOCAL_OK="1"
fi
if http_ok "${SPARK_URL%/}/collections"; then
  SPARK_OK="1"
fi

PY="$ROOT_DIR/skills/qdrant-memory/.venv/bin/python"
IDX="$ROOT_DIR/skills/qdrant-memory/scripts/index_memory.py"
if [[ ! -x "$PY" ]]; then
  echo "[$(ts)] qdrant-sync: missing python venv at $PY" >&2
  exit 1
fi
if [[ ! -f "$IDX" ]]; then
  echo "[$(ts)] qdrant-sync: missing indexer at $IDX" >&2
  exit 1
fi

if [[ -f "$STATE_FILE" ]]; then
  LAST_SPARK_OK="$("$PY" - "$STATE_FILE" <<'PY' 2>/dev/null || echo "0"
import json, sys
path = sys.argv[1]
try:
    d = json.load(open(path))
    print("1" if d.get("sparkOk") else "0")
except Exception:
    print("0")
PY
)"
fi

if [[ "$LOCAL_OK" != "1" ]]; then
  echo "[$(ts)] qdrant-sync: local Qdrant not reachable at $LOCAL_URL" >&2
fi
if [[ "$SPARK_OK" != "1" ]]; then
  echo "[$(ts)] qdrant-sync: Spark Qdrant not reachable at $SPARK_URL" >&2
fi

WAL_PATH="${QDRANT_SYNC_WAL:-${CLW_WORKSPACE:-$ROOT_DIR}/tmp/qdrant-sync-wal.jsonl}"
WAL_PENDING="0"
if [[ -f "$WAL_PATH" ]]; then
  WAL_PENDING="$(wc -l < "$WAL_PATH" | tr -d ' ' 2>/dev/null || echo 0)"
fi

MODE="skipped"
if [[ "$LOCAL_OK" == "1" && "$SPARK_OK" == "1" ]]; then
  recovery_reason=""
  if [[ "$LAST_SPARK_OK" != "1" ]]; then
    recovery_reason="spark_reappeared"
  elif [[ "$WAL_PENDING" =~ ^[0-9]+$ ]] && (( WAL_PENDING > 0 )); then
    recovery_reason="wal_pending"
  fi

  if [[ -n "$recovery_reason" ]]; then
    MODE="recovery"
    echo "[$(ts)] qdrant-sync: recovery mode ($recovery_reason)."
    echo "[$(ts)] qdrant-sync: step 1/2 merge local <- spark (upsert-only)"
    QDRANT_COLLECTION="$COLLECTION" \
      QDRANT_URL="$LOCAL_URL" \
      QDRANT_SYNC_ENABLED="1" \
      QDRANT_SYNC_PRIMARY_URL="$LOCAL_URL" \
      QDRANT_SYNC_FALLBACK_URL="$SPARK_URL" \
      "$PY" "$IDX" --sync-merge

    echo "[$(ts)] qdrant-sync: step 2/2 reconcile spark <- local (exact match)"
    QDRANT_COLLECTION="$COLLECTION" \
      QDRANT_URL="$LOCAL_URL" \
      QDRANT_SYNC_ENABLED="1" \
      QDRANT_SYNC_PRIMARY_URL="$SPARK_URL" \
      QDRANT_SYNC_FALLBACK_URL="$LOCAL_URL" \
      "$PY" "$IDX" --sync-reconcile
  else
    MODE="normal"
    echo "[$(ts)] qdrant-sync: normal mode reconcile local <- spark"
    QDRANT_COLLECTION="$COLLECTION" \
      QDRANT_URL="$LOCAL_URL" \
      QDRANT_SYNC_ENABLED="1" \
      QDRANT_SYNC_PRIMARY_URL="$LOCAL_URL" \
      QDRANT_SYNC_FALLBACK_URL="$SPARK_URL" \
      "$PY" "$IDX" --sync-reconcile
  fi
fi

"$PY" - "$STATE_FILE" "$LOCAL_OK" "$SPARK_OK" "$MODE" "$WAL_PENDING" <<'PY'
import json, sys, time
path = sys.argv[1]
local_ok = sys.argv[2] == "1"
spark_ok = sys.argv[3] == "1"
mode = sys.argv[4]
try:
    wal_pending = int(sys.argv[5])
except Exception:
    wal_pending = 0

data = {
    "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "localOk": local_ok,
    "sparkOk": spark_ok,
    "mode": mode,
    "walPending": wal_pending,
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

echo "[$(ts)] qdrant-sync: done (mode=$MODE localOk=$LOCAL_OK sparkOk=$SPARK_OK walPending=$WAL_PENDING)"
