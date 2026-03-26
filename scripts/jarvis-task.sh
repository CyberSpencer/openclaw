#!/usr/bin/env bash
# jarvis-task.sh — Jarvis disk-based task queue CLI
# Usage: jarvis-task.sh <command> [args...]
# Commands: add, next, start, done, fail, verify, status, list, stale, reset, clear-done

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
JARVIS_DIR="${JARVIS_DIR:-${REPO_ROOT}/.jarvis}"
QUEUE_DIR="${JARVIS_DIR}/queue"
PENDING_DIR="${QUEUE_DIR}/pending"
ACTIVE_DIR="${QUEUE_DIR}/active"
DONE_DIR="${QUEUE_DIR}/done"
FAILED_DIR="${QUEUE_DIR}/failed"
STATUS_FILE="${JARVIS_DIR}/status.json"
CONFIG_FILE="${JARVIS_DIR}/config.json"

# ── helpers ─────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

require_jq() {
  command -v jq &>/dev/null || die "jq is required but not found in PATH"
}

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

epoch_now() {
  date +%s
}

# Find a task file across all queue dirs; prints path or exits 1
find_task() {
  local id="$1"
  for dir in "$ACTIVE_DIR" "$PENDING_DIR" "$DONE_DIR" "$FAILED_DIR"; do
    local f="${dir}/${id}.json"
    if [[ -f "$f" ]]; then
      echo "$f"
      return 0
    fi
  done
  return 1
}

# Read config value with a default
config_get() {
  local key="$1" default="$2"
  if [[ -f "$CONFIG_FILE" ]]; then
    local val
    val=$(jq -r --arg k "$key" '.[$k] // empty' "$CONFIG_FILE" 2>/dev/null)
    echo "${val:-$default}"
  else
    echo "$default"
  fi
}

# Update status.json by applying a jq expression
update_status_expr() {
  local expr="$1"
  if [[ ! -f "$STATUS_FILE" ]]; then
    echo '{"plan_id":null,"phase":"idle","started_at":null,"last_activity":null,"tasks_total":0,"tasks_pending":0,"tasks_active":0,"tasks_done":0,"tasks_failed":0,"current_wave":null,"active_task_ids":[],"errors":[]}' > "$STATUS_FILE"
  fi
  local now tmp
  now=$(iso_now)
  tmp=$(mktemp)
  jq --arg now "$now" "${expr} | .last_activity = \$now" "$STATUS_FILE" > "$tmp"
  mv "$tmp" "$STATUS_FILE"
}

# Recount files and sync status.json counters
recount_status() {
  local n_pending n_active n_done n_failed total active_ids_json
  n_pending=$(find "$PENDING_DIR" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  n_active=$(find "$ACTIVE_DIR"   -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  n_done=$(find "$DONE_DIR"       -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  n_failed=$(find "$FAILED_DIR"   -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  total=$(( n_pending + n_active + n_done + n_failed ))

  active_ids_json=$(find "$ACTIVE_DIR" -maxdepth 1 -name "*.json" 2>/dev/null \
    | while IFS= read -r f; do basename "$f" .json; done \
    | jq -R . | jq -s . 2>/dev/null || echo "[]")

  if [[ ! -f "$STATUS_FILE" ]]; then
    echo '{"plan_id":null,"phase":"idle","started_at":null,"last_activity":null,"tasks_total":0,"tasks_pending":0,"tasks_active":0,"tasks_done":0,"tasks_failed":0,"current_wave":null,"active_task_ids":[],"errors":[]}' > "$STATUS_FILE"
  fi

  local now tmp
  now=$(iso_now)
  tmp=$(mktemp)
  jq \
    --arg now "$now" \
    --argjson np "$n_pending" \
    --argjson na "$n_active" \
    --argjson nd "$n_done" \
    --argjson nf "$n_failed" \
    --argjson total "$total" \
    --argjson aids "$active_ids_json" \
    '.last_activity = $now |
     .tasks_pending = $np |
     .tasks_active  = $na |
     .tasks_done    = $nd |
     .tasks_failed  = $nf |
     .tasks_total   = $total |
     .active_task_ids = $aids' \
    "$STATUS_FILE" > "$tmp" && mv "$tmp" "$STATUS_FILE"
}

# ── commands ─────────────────────────────────────────────────────────────────

cmd_add() {
  require_jq
  local arg="${1:-}"
  [[ -z "$arg" ]] && die "Usage: jarvis-task.sh add <json_file_or_inline_json>"

  local json
  if [[ -f "$arg" ]]; then
    json=$(cat "$arg")
  else
    json="$arg"
  fi

  # Validate required fields
  for field in id name instructions verify; do
    local val
    val=$(echo "$json" | jq -r --arg f "$field" '.[$f] // empty' 2>/dev/null)
    [[ -z "$val" ]] && die "Task JSON missing required field: ${field}"
  done

  local id name
  id=$(echo "$json" | jq -r '.id')
  name=$(echo "$json" | jq -r '.name')

  local dest="${PENDING_DIR}/${id}.json"
  [[ -f "$dest" ]] && die "Task ${id} already exists in pending"

  # Normalize with defaults
  local now
  now=$(iso_now)
  json=$(echo "$json" | jq \
    --arg now "$now" \
    '.status       = (.status       // "pending") |
     .attempts     = (.attempts     // 0) |
     .created_at   = (.created_at   // $now) |
     .started_at   = (.started_at   // null) |
     .completed_at = (.completed_at // null) |
     .subagent_key = (.subagent_key // null) |
     .result_summary  = (.result_summary  // null) |
     .failure_reason  = (.failure_reason  // null) |
     .retry_note      = (.retry_note      // null)')

  echo "$json" > "$dest"
  recount_status
  echo "Added task ${id}: ${name}"
}

cmd_next() {
  require_jq

  # Collect pending task files
  local pending_files=()
  while IFS= read -r f; do
    [[ -f "$f" ]] && pending_files+=("$f")
  done < <(find "$PENDING_DIR" -maxdepth 1 -name "*.json" | sort)

  if [[ ${#pending_files[@]} -eq 0 ]]; then
    exit 1
  fi

  # Collect done IDs
  local done_ids_json
  done_ids_json=$(find "$DONE_DIR" -maxdepth 1 -name "*.json" 2>/dev/null \
    | while IFS= read -r f; do basename "$f" .json; done \
    | jq -R . | jq -s . 2>/dev/null || echo "[]")

  # Sort all eligible tasks: phase ASC, wave ASC, priority DESC
  local tmp_sort
  tmp_sort=$(mktemp)

  for f in "${pending_files[@]}"; do
    local t_json t_phase t_wave t_priority t_deps_met
    t_json=$(cat "$f")
    t_phase=$(echo "$t_json" | jq -r '.phase // 99')
    t_wave=$(echo "$t_json"  | jq -r '.wave  // 99')
    t_priority=$(echo "$t_json" | jq -r '.priority // 0')

    # Check all dependencies are in done
    t_deps_met=$(echo "$t_json" | jq \
      --argjson done "$done_ids_json" \
      '([.dependencies[]?] | length == 0) or
       ([.dependencies[]?] | all(. as $dep | ($done | index($dep)) != null))' \
      2>/dev/null || echo "false")

    [[ "$t_deps_met" == "true" ]] || continue

    local neg_priority=$(( -t_priority ))
    printf '%05d\t%05d\t%05d\t%s\n' "$t_phase" "$t_wave" $(( neg_priority + 99999 )) "$f"
  done | sort -k1,1n -k2,2n -k3,3n > "$tmp_sort"

  local best_file
  best_file=$(head -1 "$tmp_sort" | cut -f4)
  rm -f "$tmp_sort"

  if [[ -z "$best_file" || ! -f "$best_file" ]]; then
    exit 1
  fi

  cat "$best_file"
}

cmd_start() {
  require_jq
  local id="${1:-}" subagent_key="${2:-}"
  [[ -z "$id" ]]           && die "Usage: jarvis-task.sh start <id> <subagent_key>"
  [[ -z "$subagent_key" ]] && die "Usage: jarvis-task.sh start <id> <subagent_key>"

  local src="${PENDING_DIR}/${id}.json"
  [[ -f "$src" ]] || die "Task not in pending: ${id}"

  local now tmp
  now=$(iso_now)
  tmp=$(mktemp)
  jq --arg now "$now" --arg key "$subagent_key" \
    '.status = "active" | .started_at = $now | .subagent_key = $key' \
    "$src" > "$tmp"
  mv "$tmp" "${ACTIVE_DIR}/${id}.json"
  rm -f "$src"

  recount_status
  echo "Started task ${id}"
}

cmd_done() {
  require_jq
  local id="${1:-}" summary="${2:-}"
  [[ -z "$id" ]] && die "Usage: jarvis-task.sh done <id> [summary]"

  local src="${ACTIVE_DIR}/${id}.json"
  [[ -f "$src" ]] || die "Task not in active: ${id}"

  local now tmp
  now=$(iso_now)
  tmp=$(mktemp)
  jq --arg now "$now" --arg sum "$summary" \
    '.status = "done" | .completed_at = $now | .result_summary = $sum' \
    "$src" > "$tmp"
  mv "$tmp" "${DONE_DIR}/${id}.json"
  rm -f "$src"

  recount_status
  echo "Done task ${id}"
}

cmd_fail() {
  require_jq
  local id="${1:-}" error="${2:-}"
  [[ -z "$id" ]]    && die "Usage: jarvis-task.sh fail <id> <error>"
  [[ -z "$error" ]] && die "Usage: jarvis-task.sh fail <id> <error>"

  local src=""
  if [[ -f "${ACTIVE_DIR}/${id}.json" ]]; then
    src="${ACTIVE_DIR}/${id}.json"
  elif [[ -f "${PENDING_DIR}/${id}.json" ]]; then
    src="${PENDING_DIR}/${id}.json"
  else
    die "Task not found in active or pending: ${id}"
  fi

  local attempts max_attempts new_attempts tmp
  attempts=$(jq -r '.attempts // 0' "$src")
  max_attempts=$(jq -r '.max_attempts // 2' "$src")
  new_attempts=$(( attempts + 1 ))

  tmp=$(mktemp)

  if (( new_attempts < max_attempts )); then
    # Retry: move back to pending
    jq --argjson att "$new_attempts" --arg note "$error" \
      '.attempts = $att | .retry_note = $note | .status = "pending" | .started_at = null | .subagent_key = null' \
      "$src" > "$tmp"
    mv "$tmp" "${PENDING_DIR}/${id}.json"
    rm -f "$src"
    recount_status
    echo "Retrying task ${id} (attempt ${new_attempts}/${max_attempts})"
  else
    # Max attempts exceeded → failed
    jq --argjson att "$new_attempts" --arg reason "$error" \
      '.attempts = $att | .status = "failed" | .failure_reason = $reason' \
      "$src" > "$tmp"
    mv "$tmp" "${FAILED_DIR}/${id}.json"
    rm -f "$src"
    # Append error to status.json
    local err_msg="${id} failed after ${new_attempts} attempts: ${error}"
    if [[ -f "$STATUS_FILE" ]]; then
      local stmp
      stmp=$(mktemp)
      local now
      now=$(iso_now)
      jq --arg err "$err_msg" --arg now "$now" \
        '.errors += [$err] | .last_activity = $now' \
        "$STATUS_FILE" > "$stmp" && mv "$stmp" "$STATUS_FILE"
    fi
    recount_status
    echo "Failed task ${id} (max attempts)"
  fi
}

cmd_verify() {
  require_jq
  local id="${1:-}"
  [[ -z "$id" ]] && die "Usage: jarvis-task.sh verify <id>"

  local task_file
  task_file=$(find_task "$id") || die "Task not found in any queue dir: ${id}"

  local verify_cmd
  verify_cmd=$(jq -r '.verify // empty' "$task_file")
  [[ -z "$verify_cmd" ]] && { echo "PASS: ${id} (no verify command)"; exit 0; }

  local err_out
  err_out=$(mktemp)

  if bash -c "$verify_cmd" > /dev/null 2>"$err_out"; then
    rm -f "$err_out"
    echo "PASS: ${id}"
    exit 0
  else
    local err_text
    err_text=$(cat "$err_out" | head -3 | tr '\n' ' ')
    rm -f "$err_out"
    echo "FAIL: ${id} — ${err_text}"
    exit 1
  fi
}

cmd_status() {
  require_jq
  recount_status

  local plan_id phase last_activity
  plan_id=$(jq -r '.plan_id // "none"' "$STATUS_FILE")
  phase=$(jq -r '.phase // "idle"' "$STATUS_FILE")
  last_activity=$(jq -r '.last_activity // "never"' "$STATUS_FILE")

  local n_pending n_active n_done n_failed
  n_pending=$(find "$PENDING_DIR" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  n_active=$(find "$ACTIVE_DIR"   -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  n_done=$(find "$DONE_DIR"       -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  n_failed=$(find "$FAILED_DIR"   -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')

  # Format last_activity as CT
  local last_ct="$last_activity"
  if [[ "$last_activity" != "never" ]] && [[ "$last_activity" =~ ^[0-9]{4} ]]; then
    last_ct=$(TZ="America/Chicago" date -j -f "%Y-%m-%dT%H:%M:%SZ" "$last_activity" \
      "+%Y-%m-%d %H:%M CT" 2>/dev/null || echo "$last_activity")
  fi

  echo "Plan: ${plan_id} [${phase}]"
  echo "Pending: ${n_pending}  Active: ${n_active}  Done: ${n_done}  Failed: ${n_failed}"
  echo "Last activity: ${last_ct}"

  local errors_raw
  errors_raw=$(jq -r '.errors[]? // empty' "$STATUS_FILE" 2>/dev/null || true)
  if [[ -n "$errors_raw" ]]; then
    echo "Errors:"
    while IFS= read -r e; do
      echo "  ${e}"
    done <<< "$errors_raw"
  else
    echo "Errors: none"
  fi
}

cmd_list() {
  require_jq
  local filter="${1:-all}"

  list_dir() {
    local dir="$1"
    while IFS= read -r f; do
      [[ -f "$f" ]] || continue
      local id name status wave phase
      id=$(jq -r '.id // "unknown"' "$f")
      name=$(jq -r '.name // "unknown"' "$f")
      status=$(jq -r '.status // "unknown"' "$f")
      wave=$(jq -r '.wave // "?"' "$f")
      phase=$(jq -r '.phase // "?"' "$f")
      printf '%-25s  %-10s  %-40s  (wave %s, phase %s)\n' "$id" "$status" "$name" "$wave" "$phase"
    done < <(find "$dir" -maxdepth 1 -name "*.json" | sort)
  }

  case "$filter" in
    pending) list_dir "$PENDING_DIR" ;;
    active)  list_dir "$ACTIVE_DIR"  ;;
    done)    list_dir "$DONE_DIR"    ;;
    failed)  list_dir "$FAILED_DIR"  ;;
    all)
      echo "=== PENDING ==="; list_dir "$PENDING_DIR"
      echo "=== ACTIVE ===";  list_dir "$ACTIVE_DIR"
      echo "=== DONE ===";    list_dir "$DONE_DIR"
      echo "=== FAILED ===";  list_dir "$FAILED_DIR"
      ;;
    *) die "Unknown filter: ${filter}. Use: pending|active|done|failed|all" ;;
  esac
}

cmd_stale() {
  require_jq
  local timeout_min
  timeout_min=$(config_get "stale_task_timeout_min" "45")
  local now_ep
  now_ep=$(epoch_now)
  local found=0

  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    local id started_at task_timeout
    id=$(jq -r '.id // "unknown"' "$f")
    started_at=$(jq -r '.started_at // empty' "$f")
    task_timeout=$(jq -r '.timeout_min // empty' "$f")

    [[ -z "$started_at" ]] && continue

    # Use task-specific timeout if set, else global; always +5 grace
    local effective_timeout
    if [[ -n "$task_timeout" ]]; then
      effective_timeout=$(( task_timeout + 5 ))
    else
      effective_timeout=$(( timeout_min + 5 ))
    fi

    local started_ep
    # macOS: date -j treats input as local time; use TZ=UTC + strip Z for correct UTC parsing
    # Linux: TZ=UTC date -d handles Z suffix correctly
    started_ep=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${started_at%Z}" +%s 2>/dev/null \
              || TZ=UTC date -d "$started_at" +%s 2>/dev/null \
              || echo "0")

    local elapsed_min=$(( (now_ep - started_ep) / 60 ))

    if (( elapsed_min > effective_timeout )); then
      echo "STALE: ${id}  running ${elapsed_min}min (limit ${effective_timeout}min)"
      found=$(( found + 1 ))
    fi
  done < <(find "$ACTIVE_DIR" -maxdepth 1 -name "*.json" | sort)

  if (( found == 0 )); then
    echo "No stale tasks."
  fi
}

cmd_reset() {
  require_jq
  local id="${1:-}"
  [[ -z "$id" ]] && die "Usage: jarvis-task.sh reset <id>"

  local src=""
  if [[ -f "${FAILED_DIR}/${id}.json" ]]; then
    src="${FAILED_DIR}/${id}.json"
  elif [[ -f "${DONE_DIR}/${id}.json" ]]; then
    src="${DONE_DIR}/${id}.json"
  else
    die "Task not found in failed or done: ${id}"
  fi

  local tmp
  tmp=$(mktemp)
  jq '.status = "pending" | .started_at = null | .completed_at = null |
      .subagent_key = null | .failure_reason = null | .result_summary = null |
      .retry_note = null' \
    "$src" > "$tmp"
  mv "$tmp" "${PENDING_DIR}/${id}.json"
  rm -f "$src"

  recount_status
  echo "Reset task ${id} → pending"
}

cmd_clear_done() {
  require_jq
  local cutoff_days=7
  local count=0

  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    # Check mtime > 7 days
    if find "$f" -mtime "+${cutoff_days}" -print 2>/dev/null | grep -q .; then
      rm -f "$f"
      count=$(( count + 1 ))
    fi
  done < <(find "$DONE_DIR" -maxdepth 1 -name "*.json")

  recount_status
  echo "Removed ${count} done task(s) older than ${cutoff_days} days."
}

# ── dispatch ──────────────────────────────────────────────────────────────────

COMMAND="${1:-}"
shift || true

case "$COMMAND" in
  add)        cmd_add "$@" ;;
  next)       cmd_next "$@" ;;
  start)      cmd_start "$@" ;;
  done)       cmd_done "$@" ;;
  fail)       cmd_fail "$@" ;;
  verify)     cmd_verify "$@" ;;
  status)     cmd_status "$@" ;;
  list)       cmd_list "$@" ;;
  stale)      cmd_stale "$@" ;;
  reset)      cmd_reset "$@" ;;
  clear-done) cmd_clear_done "$@" ;;
  "")  die "No command. Use: add next start done fail verify status list stale reset clear-done" ;;
  *)   die "Unknown command: ${COMMAND}. Use: add next start done fail verify status list stale reset clear-done" ;;
esac
