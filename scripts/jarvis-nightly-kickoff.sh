#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${JARVIS_WORKSPACE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PLAN_SH="${PLAN_SH:-$ROOT_DIR/scripts/jarvis-plan.sh}"
JARVIS_DIR="${JARVIS_DIR:-$ROOT_DIR/.jarvis}"
QUEUE_DIR="$JARVIS_DIR/queue"
PENDING_DIR="$QUEUE_DIR/pending"
ACTIVE_DIR="$QUEUE_DIR/active"
ACTIVE_PLAN_FILE="$JARVIS_DIR/plans/active.json"
ARCHIVE_DIR="$JARVIS_DIR/plans/archive"
TIMEZONE="${JARVIS_NIGHTLY_TZ:-America/Chicago}"
DATE_VALUE="$(TZ="$TIMEZONE" date +%Y-%m-%d)"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage:
  scripts/jarvis-nightly-kickoff.sh [--date YYYY-MM-DD] [--dry-run]

Behavior:
  - Archives a completed prior active plan if one is still present
  - Refuses to create a new plan if another plan still has pending/active work
  - Creates the nightly plan once per date
EOF
}

count_queue_json_files() {
  local dir="$1"
  find "$dir" -maxdepth 1 -name "*.json" ! -name ".gitkeep" 2>/dev/null | wc -l | tr -d ' '
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date)
      DATE_VALUE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

PLAN_ID="overnight-full-$DATE_VALUE"
ARCHIVE_FILE="$ARCHIVE_DIR/$PLAN_ID.json"

if [[ -f "$ARCHIVE_FILE" ]]; then
  echo "Nightly plan already archived for $DATE_VALUE: $PLAN_ID"
  exit 0
fi

if [[ -f "$ACTIVE_PLAN_FILE" ]]; then
  active_plan_id="$(jq -r '.plan_id // empty' "$ACTIVE_PLAN_FILE" 2>/dev/null || true)"
  pending_count="$(count_queue_json_files "$PENDING_DIR")"
  active_count="$(count_queue_json_files "$ACTIVE_DIR")"

  if (( pending_count > 0 || active_count > 0 )); then
    if [[ "$active_plan_id" == "$PLAN_ID" ]]; then
      echo "Nightly plan already active for $DATE_VALUE: $PLAN_ID"
      exit 0
    fi
    echo "Cannot create $PLAN_ID while $active_plan_id still has pending or active work." >&2
    exit 1
  fi

  "$PLAN_SH" archive >/dev/null

  if [[ "$active_plan_id" == "$PLAN_ID" ]]; then
    echo "Nightly plan already completed for $DATE_VALUE: $PLAN_ID"
    exit 0
  fi
fi

if (( DRY_RUN == 1 )); then
  exec "$PLAN_SH" create overnight-full --date "$DATE_VALUE" --dry-run
fi

exec "$PLAN_SH" create overnight-full --date "$DATE_VALUE"
