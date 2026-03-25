#!/usr/bin/env bash
set -euo pipefail

# openclaw_doctor_run.sh
# Run `openclaw doctor` in a predictable, log-friendly way.
#
# Default mode is safe: `--non-interactive` (safe migrations only).
#
# Usage:
#   scripts/openclaw_doctor_run.sh
#   scripts/openclaw_doctor_run.sh --repair

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mode="safe"
if [[ "${1:-}" == "--repair" ]]; then
  mode="repair"
  shift
fi
if [[ $# -gt 0 ]]; then
  echo "Usage: scripts/openclaw_doctor_run.sh [--repair]" >&2
  exit 2
fi

LOG_DIR="${OPENCLAW_DOCTOR_LOG_DIR:-$ROOT_DIR/logs/doctor}"
mkdir -p "$LOG_DIR"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
log="$LOG_DIR/openclaw-doctor-${mode}-${ts}.log"

echo "Running OpenClaw doctor ($mode)..."
echo "Log: $log"

set +e
if [[ "$mode" == "repair" ]]; then
  "$ROOT_DIR/scripts/openclaw.sh" doctor --repair --yes --no-workspace-suggestions >"$log" 2>&1
  rc=$?
else
  "$ROOT_DIR/scripts/openclaw.sh" doctor --non-interactive --no-workspace-suggestions >"$log" 2>&1
  rc=$?
fi
set -e

if [[ $rc -ne 0 ]]; then
  echo "Doctor exited non-zero: $rc" >&2
  exit "$rc"
fi

echo "Doctor complete."
