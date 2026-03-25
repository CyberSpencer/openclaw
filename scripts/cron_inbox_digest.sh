#!/usr/bin/env bash
set -euo pipefail

# Inbox digest runner (read-only):
# - Generates a digest from Gmail via gog
# - Writes artifacts under artifacts/inbox/
# - Optionally archives to Apple Notes (Jarvis/<week range>/...)

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

# Load local env + Keychain secrets (gog uses local OAuth; this is mainly for Notes writer + consistency)
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_env.sh"
load_env_files "$ROOT_DIR"
if [[ -f "$ROOT_DIR/scripts/keychain_env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/keychain_env.sh" >/dev/null 2>&1 || true
fi

ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT_DIR/artifacts}"
LOCK_DIR="$ARTIFACT_DIR/locks"
LOG_DIR="${CRON_LOG_DIR:-$ROOT_DIR/logs/cron}"

mkdir -p "$ARTIFACT_DIR/inbox" "$LOCK_DIR" "$LOG_DIR"

TODAY="$(TZ=America/Chicago date +%F)"
NOW_CT="$(TZ=America/Chicago date +%H%M)"
DOW="$(TZ=America/Chicago date +%u)"
WEEK_START="$(TZ=America/Chicago date -v -$((DOW-1))d +%F)"
WEEK_END="$(TZ=America/Chicago date -v +$((7-DOW))d +%F)"
WEEK_RANGE="$WEEK_START to $WEEK_END"
RUN_ID="$(date +%s)"

LOCK_PATH="$LOCK_DIR/inbox_digest.lock"
LOG_FILE="$LOG_DIR/inbox-digest-$RUN_ID.log"

PARENT_FOLDER="${INBOX_NOTES_PARENT_FOLDER:-Jarvis}"
RUN_TAG="${1:-}"
if [[ -z "$RUN_TAG" ]]; then
  # If launched by different plists, we pass "AM"/"PM". Otherwise label as MANUAL.
  RUN_TAG="MANUAL"
fi

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG_FILE"; }

cleanup() { rmdir "$LOCK_PATH" 2>/dev/null || true; }
trap cleanup EXIT

if ! mkdir "$LOCK_PATH" 2>/dev/null; then
  log "LOCKED: Another instance is running"
  exit 75
fi
log "Lock acquired: $LOCK_PATH"

gen="$ROOT_DIR/skills/inbox-triage/scripts/generate_digest.sh"
note_writer="$ROOT_DIR/skills/daily-exec-note-report/scripts/write_note.sh"

if [[ ! -x "$gen" ]]; then
  log "ERROR: missing inbox digest generator: $gen"
  exit 1
fi

out="$ARTIFACT_DIR/inbox/inbox-digest-$TODAY-$RUN_TAG-$NOW_CT.md"
log "Generating inbox digest: $out"
if "$gen" "$out" >>"$LOG_FILE" 2>&1; then
  log "Digest generated"
else
  log "ERROR: digest generation failed"
  exit 1
fi

if [[ -x "$note_writer" ]]; then
  log "Publishing digest to Apple Notes"
  if "$note_writer" "$PARENT_FOLDER" "$WEEK_RANGE" "Inbox Digest ($RUN_TAG) — $TODAY" "$out" >/dev/null 2>&1; then
    log "Published to Notes"
  else
    log "WARN: failed to publish to Notes (artifact preserved)"
  fi
fi

# Local notification (no external sends)
counts="$(
  python3 - "$out" <<'PY'
import sys
p=sys.argv[1]
txt=open(p,'r',encoding='utf-8',errors='replace').read().splitlines()
act=next((l for l in txt if l.startswith('- Actionable queue: ')), '')
unr=next((l for l in txt if l.startswith('- Unread (excluding actionable): ')), '')
print(f"{act} | {unr}".strip(' |'))
PY
)"
/usr/bin/osascript \
  -e 'on run argv' \
  -e 'display notification (item 1 of argv) with title (item 2 of argv)' \
  -e 'end run' \
  "${counts:-Inbox digest ready}" "Inbox Digest ($RUN_TAG)" >/dev/null 2>&1 || true

log "OK: inbox digest complete"
