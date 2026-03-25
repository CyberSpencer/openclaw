#!/usr/bin/env bash
set -euo pipefail

# Daily research digest runner:
# - Generates a daily research brief (agentic coding + AI for business)
# - On Mondays (America/Chicago), also generates a weekly brief + trend diff
# - Writes artifacts under artifacts/research/ and archives to Apple Notes (Jarvis/<week range>/...)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load contract if available
if [[ -f "$ROOT_DIR/config/workspace.env" ]]; then
  # shellcheck disable=SC1091,SC1094
  source "$ROOT_DIR/config/workspace.env"
elif [[ -f "$ROOT_DIR/config/workspace.env.example" ]]; then
  # shellcheck disable=SC1091,SC1094
  source "$ROOT_DIR/config/workspace.env.example"
fi

# Load local env + Keychain secrets
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_env.sh"
load_env_files "$ROOT_DIR"
if [[ -f "$ROOT_DIR/scripts/keychain_env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/keychain_env.sh" >/dev/null 2>&1 || true
fi

ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT_DIR/artifacts}"
STATE_DIR="$ARTIFACT_DIR/state"
LOCK_DIR="$ARTIFACT_DIR/locks"
LOG_DIR="${CRON_LOG_DIR:-$ROOT_DIR/logs/cron}"

mkdir -p "$ARTIFACT_DIR" "$STATE_DIR" "$LOCK_DIR" "$LOG_DIR" "$ARTIFACT_DIR/research"

TODAY="$(TZ=America/Chicago date +%F)"
DOW="$(TZ=America/Chicago date +%u)" # 1=Mon .. 7=Sun
WEEK_START="$(TZ=America/Chicago date -v -$((DOW-1))d +%F)"
WEEK_END="$(TZ=America/Chicago date -v +$((7-DOW))d +%F)"
WEEK_RANGE="$WEEK_START to $WEEK_END"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="$(date +%s)"

LOCK_PATH="$LOCK_DIR/research_digest.lock"
STATE_FILE="$STATE_DIR/research_digest_$TODAY.json"
LOG_FILE="$LOG_DIR/research-digest-$RUN_ID.log"

PARENT_FOLDER="${RESEARCH_NOTES_PARENT_FOLDER:-Jarvis}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG_FILE"; }

cleanup() { rmdir "$LOCK_PATH" 2>/dev/null || true; }
trap cleanup EXIT

if ! mkdir "$LOCK_PATH" 2>/dev/null; then
  log "LOCKED: Another instance is running"
  exit 75
fi
log "Lock acquired: $LOCK_PATH"

if [[ -f "$STATE_FILE" ]]; then
  prev_status=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('status',''))" 2>/dev/null || echo "")
  if [[ "$prev_status" == "published" ]]; then
    log "SKIP: Already published today"
    exit 0
  fi
fi

brief_script="$ROOT_DIR/skills/research-brief/scripts/generate_brief.sh"
note_writer="$ROOT_DIR/skills/daily-exec-note-report/scripts/write_note.sh"

if [[ ! -x "$brief_script" ]]; then
  log "ERROR: missing research brief generator: $brief_script"
  exit 1
fi
if [[ ! -x "$note_writer" ]]; then
  log "ERROR: missing Apple Notes writer: $note_writer"
  exit 1
fi

daily_out="$ARTIFACT_DIR/research/research-brief-$TODAY.md"
weekly_out="$ARTIFACT_DIR/research/research-brief-weekly-$WEEK_START.md"
diff_out="$ARTIFACT_DIR/research/research-trend-diff-$WEEK_START.md"

log "Generating daily brief: $daily_out"
if "$brief_script" --daily "$daily_out" >>"$LOG_FILE" 2>&1; then
  log "Daily brief generated"
else
  log "ERROR: daily brief generation failed"
  echo "{\"date\":\"$TODAY\",\"status\":\"failed\",\"ts\":\"$TIMESTAMP\",\"error\":\"daily brief failed\"}" > "$STATE_FILE"
  exit 1
fi

log "Publishing daily brief to Apple Notes"
published_daily=false
if "$note_writer" "$PARENT_FOLDER" "$WEEK_RANGE" "Research Brief — $TODAY" "$daily_out" >/dev/null 2>&1; then
  published_daily=true
  log "Published daily brief"
else
  log "WARN: failed to publish daily brief to Notes (artifact preserved)"
fi

published_weekly=false
published_diff=false

if [[ "$DOW" == "1" ]]; then
  log "Monday CT detected, generating weekly brief: $weekly_out"
  if "$brief_script" --weekly "$weekly_out" >>"$LOG_FILE" 2>&1; then
    log "Weekly brief generated"
  else
    log "WARN: weekly brief generation failed (continuing)"
  fi

  if [[ -f "$weekly_out" ]]; then
    log "Publishing weekly brief to Apple Notes"
    if "$note_writer" "$PARENT_FOLDER" "$WEEK_RANGE" "Research Brief (Weekly) — $WEEK_RANGE" "$weekly_out" >/dev/null 2>&1; then
      published_weekly=true
      log "Published weekly brief"
    else
      log "WARN: failed to publish weekly brief to Notes"
    fi
  fi

  # Trend diff: compare previous week's sources if available.
  prev_week_start="$(TZ=America/Chicago date -v -7d -v -$((DOW-1))d +%F)"
  prev_sources="$ARTIFACT_DIR/research/research-brief-weekly-$prev_week_start.sources.json"
  cur_sources="$ARTIFACT_DIR/research/research-brief-weekly-$WEEK_START.sources.json"
  diff_py="$ROOT_DIR/skills/research-brief/scripts/trend_diff.py"

  if [[ -f "$prev_sources" && -f "$cur_sources" && -x "$diff_py" ]]; then
    log "Generating trend diff: $diff_out"
    if python3 "$diff_py" --prev "$prev_sources" --current "$cur_sources" --out "$diff_out" >>"$LOG_FILE" 2>&1; then
      log "Trend diff generated"
      log "Publishing trend diff to Apple Notes"
      if "$note_writer" "$PARENT_FOLDER" "$WEEK_RANGE" "Research Trend Diff — $WEEK_RANGE" "$diff_out" >/dev/null 2>&1; then
        published_diff=true
        log "Published trend diff"
      else
        log "WARN: failed to publish trend diff to Notes"
      fi
    else
      log "WARN: trend diff generation failed"
    fi
  else
    log "INFO: trend diff skipped (missing prev/current sources)"
  fi
fi

# Local notification (no external sends)
summary_line="$(grep -m1 '^## Executive Summary' -n "$daily_out" 2>/dev/null | cut -d: -f1 || true)"
notify_body="Research brief ready: $TODAY"
if [[ -n "$summary_line" ]]; then
  first_bullet="$(tail -n +$((summary_line+1)) "$daily_out" 2>/dev/null | sed -n 's/^- //p' | head -n 1 || true)"
  [[ -n "$first_bullet" ]] && notify_body+="\n- $first_bullet"
fi
/usr/bin/osascript \
  -e 'on run argv' \
  -e 'display notification (item 1 of argv) with title (item 2 of argv)' \
  -e 'end run' \
  "$notify_body" "Research Brief" >/dev/null 2>&1 || true

if $published_daily; then
  echo "{\"date\":\"$TODAY\",\"status\":\"published\",\"ts\":\"$TIMESTAMP\",\"artifact\":\"$daily_out\",\"weekly\":$published_weekly,\"trendDiff\":$published_diff}" > "$STATE_FILE"
else
  echo "{\"date\":\"$TODAY\",\"status\":\"artifact_only\",\"ts\":\"$TIMESTAMP\",\"artifact\":\"$daily_out\",\"weekly\":$published_weekly,\"trendDiff\":$published_diff}" > "$STATE_FILE"
fi

log "OK: research digest complete (published_daily=$published_daily weekly=$published_weekly trend_diff=$published_diff)"
