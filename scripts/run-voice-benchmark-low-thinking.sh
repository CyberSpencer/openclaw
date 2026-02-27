#!/usr/bin/env bash
# Run voice short-turn benchmark with low-thinking path (--allow-tools false).
# Use when gateway auth is aligned (device identity / OPENCLAW_GATEWAY_TOKEN).
# Compare output CSV to previous runs (e.g. voice_short_turn_nonstream_post_patch2_*.csv) to see latency impact.

set -e
ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
CORE_DIR="${CORE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

if [[ -f "$ROOT_DIR/config/workspace.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT_DIR/config/workspace.env"
  set +a
fi

# WebSocket URL (benchmark expects ws://)
GATEWAY_WS="${OPENCLAW_GATEWAY_URL}"
if [[ -n "$GATEWAY_WS" && "$GATEWAY_WS" == http://* ]]; then
  export OPENCLAW_GATEWAY_URL="ws://${GATEWAY_WS#http://}"
fi

RUNS="${RUNS:-30}"
OUT_CSV="${OUT_CSV:-$CORE_DIR/benchmarks/voice_short_turn_low_thinking_$(date +%Y-%m-%d-%H%M).csv}"

echo "Running voice short-turn benchmark (low thinking, allow-tools=false) runs=$RUNS out=$OUT_CSV"
cd "$CORE_DIR"
pnpm benchmark:voice:short-turn -- --runs "$RUNS" --allow-tools false --out-csv "$OUT_CSV" "$@"
echo "Done. CSV: $OUT_CSV"
echo "Compare llm_first_semantic_text_ms and llm_full_completion_ms p50/p95 to previous runs to see latency change."
