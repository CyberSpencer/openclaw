#!/usr/bin/env bash
set -euo pipefail

# LaunchAgent wrapper for daily report.
# Sources keychain env loader before running the cron script.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Ensure log directory exists
mkdir -p "$ROOT_DIR/logs/cron"

# Log start
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting daily report (launchd)"

# Source keychain env loader if it exists (override via OPENCLAW_KEYCHAIN_LOADER)
export OPENCLAW_KEYCHAIN_REQUIRED="${OPENCLAW_KEYCHAIN_REQUIRED:-}"
KEYCHAIN_LOADER="${OPENCLAW_KEYCHAIN_LOADER:-$ROOT_DIR/scripts/keychain_env.sh}"
if [[ ! -f "$KEYCHAIN_LOADER" ]]; then
  KEYCHAIN_LOADER="$HOME/bin/openclaw_keychain_env.sh"
fi
if [[ -f "$KEYCHAIN_LOADER" ]]; then
  # shellcheck disable=SC1090
  source "$KEYCHAIN_LOADER"
fi

# Source workspace contract if it exists
CONTRACT="$ROOT_DIR/config/workspace.env"
if [[ -f "$CONTRACT" ]]; then
  # shellcheck disable=SC1090
  source "$CONTRACT"
fi

# Run the actual cron script
exec "$ROOT_DIR/scripts/cron_daily_exec_report.sh"
