#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="$ROOT_DIR/artifacts/spark-nightly/$STAMP"
LATEST_DIR="$ROOT_DIR/artifacts/spark-nightly/latest"
LOG_DIR="$ROOT_DIR/logs/cron"
mkdir -p "$OUT_DIR" "$LOG_DIR"

PREV_DIR="$(
  find "$ROOT_DIR/artifacts/spark-nightly" -maxdepth 1 -mindepth 1 -type d -name '20*' ! -path "$OUT_DIR" -print 2>/dev/null \
    | LC_ALL=C sort -r \
    | head -n1 \
    || true
)"

"$ROOT_DIR/scripts/spark_maint.sh" report "$OUT_DIR"
python3 "$ROOT_DIR/scripts/spark_delta_report.py" "$OUT_DIR" "${PREV_DIR:-/nonexistent}" > "$OUT_DIR/DELTA.md" || true

rm -rf "$LATEST_DIR"
mkdir -p "$LATEST_DIR"
cp -a "$OUT_DIR"/SUMMARY.md "$LATEST_DIR/"
cp -a "$OUT_DIR"/DELTA.md "$LATEST_DIR/" 2>/dev/null || true
cp -a "$OUT_DIR"/access.txt "$LATEST_DIR/" 2>/dev/null || true
cp -a "$OUT_DIR"/system.txt "$LATEST_DIR/" 2>/dev/null || true
cp -a "$OUT_DIR"/openclaw-units.txt "$LATEST_DIR/" 2>/dev/null || true
cp -a "$OUT_DIR"/docker-ps-a.txt "$LATEST_DIR/" 2>/dev/null || true
cp -a "$OUT_DIR"/listeners.txt "$LATEST_DIR/" 2>/dev/null || true
cp -a "$OUT_DIR"/firewall-docker-user.txt "$LATEST_DIR/" 2>/dev/null || true

echo "[$(date +"%Y-%m-%dT%H:%M:%S%z")] Spark nightly report complete: $OUT_DIR" | tee -a "$LOG_DIR/spark-nightly-report.out.log"
