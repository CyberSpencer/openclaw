#!/usr/bin/env bash
# jarvis-driver.sh - One autonomous work driver cycle
#
# Usage:
#   jarvis-driver.sh               - standard cycle
#   jarvis-driver.sh --check-stale - check for timed-out active tasks first
#   jarvis-driver.sh --status-only - just print status JSON, no action
#
# Output: JSON on stdout, one of:
#   {"action": "spawn", "task": {...full task JSON...}}
#   {"action": "idle"}
#   {"action": "complete", "plan_id": "...", "summary": "..."}
#
# Exit codes:
#   0 - always (errors logged to stderr)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
JARVIS_DIR="${JARVIS_DIR:-$REPO_ROOT/.jarvis}"
QUEUE_DIR="$JARVIS_DIR/queue"
PENDING="$QUEUE_DIR/pending"
ACTIVE="$QUEUE_DIR/active"
DONE="$QUEUE_DIR/done"
FAILED="$QUEUE_DIR/failed"
STATUS_FILE="$JARVIS_DIR/status.json"
TASK_SH="${TASK_SH:-$SCRIPT_DIR/jarvis-task.sh}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { echo "[driver] $*" >&2; }

now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

now_epoch() {
  date +%s
}

require_jq() {
  command -v jq &>/dev/null || { echo '{"action":"idle","error":"jq not found"}'; exit 0; }
}

require_task_sh() {
  if [[ ! -x "$TASK_SH" ]]; then
    log "WARNING: $TASK_SH not found or not executable"
    return 1
  fi
  return 0
}

# Count files in a dir, excluding .gitkeep
count_files() {
  local dir="$1"
  find "$dir" -name "*.json" ! -name ".gitkeep" 2>/dev/null | wc -l | tr -d ' '
}

# Update last_activity in status.json
update_last_activity() {
  local now
  now=$(now_iso)
  if [[ -f "$STATUS_FILE" ]]; then
    local tmp
    tmp=$(mktemp)
    jq --arg now "$now" '.last_activity = $now' "$STATUS_FILE" > "$tmp" && mv "$tmp" "$STATUS_FILE"
  fi
}

# Update status.json phase and last_activity
set_status_phase() {
  local phase="$1"
  local now
  now=$(now_iso)
  if [[ -f "$STATUS_FILE" ]]; then
    local tmp
    tmp=$(mktemp)
    jq --arg phase "$phase" --arg now "$now" \
      '.phase = $phase | .last_activity = $now' \
      "$STATUS_FILE" > "$tmp" && mv "$tmp" "$STATUS_FILE"
  fi
}

# Output idle JSON and exit
output_idle() {
  echo '{"action":"idle"}'
  exit 0
}

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------

CHECK_STALE=false
STATUS_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --check-stale) CHECK_STALE=true ;;
    --status-only) STATUS_ONLY=true ;;
    *) log "Unknown flag: $arg" ;;
  esac
done

# ---------------------------------------------------------------------------
# Require tools
# ---------------------------------------------------------------------------

require_jq

# ---------------------------------------------------------------------------
# Status-only mode: just print status and exit
# ---------------------------------------------------------------------------

if [[ "$STATUS_ONLY" == "true" ]]; then
  if [[ -f "$STATUS_FILE" ]]; then
    cat "$STATUS_FILE"
  else
    echo '{"phase":"idle","plan_id":null}'
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1: Check status.json. If idle/no plan: output idle
# ---------------------------------------------------------------------------

if [[ ! -f "$STATUS_FILE" ]]; then
  log "No status.json found — idle"
  output_idle
fi

phase=$(jq -r '.phase // "idle"' "$STATUS_FILE")
plan_id=$(jq -r '.plan_id // "null"' "$STATUS_FILE")

# Auto-recover stranded plan: active.json exists + pending tasks, but status says idle.
# Can happen when jarvis-plan.sh archive fails after writing idle status but before moving
# active.json, or when a prior agent resets status.json without archiving.
PLANS_FILE="$JARVIS_DIR/plans/active.json"
if [[ "$phase" == "idle" ]] && [[ -f "$PLANS_FILE" ]]; then
  n_pending=$(count_files "$PENDING")
  if (( n_pending > 0 )); then
    recovered_plan_id=$(jq -r '.plan_id // empty' "$PLANS_FILE" 2>/dev/null)
    if [[ -n "$recovered_plan_id" ]]; then
      log "Auto-recovering stranded plan: $recovered_plan_id ($n_pending pending tasks)"
      tmp=$(mktemp)
      jq --arg pid "$recovered_plan_id" --arg now "$(now_iso)" \
        '.plan_id = $pid | .phase = "executing" | .started_at = $now | .last_activity = $now' \
        "$STATUS_FILE" > "$tmp" && mv "$tmp" "$STATUS_FILE"
      phase="executing"
      plan_id="$recovered_plan_id"
    fi
  fi
fi

if [[ "$phase" == "idle" ]] || [[ "$plan_id" == "null" ]]; then
  update_last_activity
  output_idle
fi

# ---------------------------------------------------------------------------
# Step 2: Check for stale active tasks (if --check-stale flag)
# ---------------------------------------------------------------------------

if [[ "$CHECK_STALE" == "true" ]]; then
  if require_task_sh; then
    while IFS= read -r -d '' f; do
      task_id=$(jq -r '.id // empty' "$f" 2>/dev/null)
      started_at=$(jq -r '.started_at // empty' "$f" 2>/dev/null)
      timeout_min=$(jq -r '.timeout_min // 45' "$f" 2>/dev/null)

      [[ -n "$task_id" ]] || continue
      [[ -n "$started_at" ]] || continue

      # Parse started_at epoch (macOS + Linux compatible)
      # macOS: date -j interprets input as local time; must use TZ=UTC + strip Z
      # Linux: TZ=UTC date -d handles Z suffix correctly
      started_ep=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${started_at%Z}" +%s 2>/dev/null || \
                   TZ=UTC date -d "$started_at" +%s 2>/dev/null || echo "0")

      if [[ "$started_ep" -eq 0 ]]; then
        # Fail safe: unparseable timestamp → treat as epoch 1 so elapsed_min is enormous
        # and stale detection fires rather than silently skipping the task.
        log "Could not parse started_at for $task_id: $started_at — treating as stale"
        started_ep=1
      fi

      now_ep=$(now_epoch)
      elapsed_min=$(( (now_ep - started_ep) / 60 ))
      threshold=$(( timeout_min + 5 ))

      if (( elapsed_min > threshold )); then
        stale_msg="Stale: running ${elapsed_min}min, timeout was ${timeout_min}min"
        log "Marked stale: $task_id ($stale_msg)"
        "$TASK_SH" fail "$task_id" "$stale_msg" 2>&1 | while IFS= read -r line; do
          log "$line"
        done || true
      fi
    done < <(find "$ACTIVE" -name "*.json" ! -name ".gitkeep" -print0 2>/dev/null)
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: Get next eligible task
# ---------------------------------------------------------------------------

next_task=""
next_exit=0

if require_task_sh; then
  next_task=$("$TASK_SH" next 2>/dev/null) || next_exit=$?
else
  # Fallback: no jarvis-task.sh — stay idle
  log "jarvis-task.sh not available, cannot determine next task"
  update_last_activity
  output_idle
fi

# ---------------------------------------------------------------------------
# Step 3a: Handle no eligible task
# ---------------------------------------------------------------------------

if [[ $next_exit -ne 0 ]] || [[ -z "$next_task" ]]; then
  n_pending=$(count_files "$PENDING")
  n_active=$(count_files "$ACTIVE")
  n_done=$(count_files "$DONE")
  n_failed=$(count_files "$FAILED")

  if (( n_pending == 0 && n_active == 0 )); then
    # All done — mark plan complete
    set_status_phase "complete"

    # Update counts one more time
    if require_task_sh; then
      "$TASK_SH" status >/dev/null 2>&1 || true
    fi

    plan_id=$(jq -r '.plan_id // "unknown"' "$STATUS_FILE")
    done_count=$n_done
    failed_count=$n_failed

    jq -n \
      --arg pid "$plan_id" \
      --arg summary "All tasks done. Done: ${done_count}, Failed: ${failed_count}" \
      '{"action":"complete","plan_id":$pid,"summary":$summary}'
    exit 0

  elif (( n_active > 0 && n_pending == 0 )); then
    # Active tasks running, nothing new to spawn — wait
    log "Active tasks running ($n_active), no new pending tasks — waiting"
    update_last_activity
    output_idle

  else
    # Pending tasks exist but all have unmet dependencies (or concurrency limit)
    log "Pending tasks ($n_pending) blocked by dependencies or concurrency — waiting"
    update_last_activity
    output_idle
  fi
fi

# ---------------------------------------------------------------------------
# Step 4: Task found — output spawn action
# ---------------------------------------------------------------------------

update_last_activity

jq -n --argjson task "$next_task" '{"action":"spawn","task":$task}'
exit 0
