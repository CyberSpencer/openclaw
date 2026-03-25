#!/usr/bin/env bash
# Run the workspace core openclaw build (for stack_supervisor when custom config is used).
# Usage: run_openclaw_workspace.sh [args...]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_DIR="$REPO_ROOT/core"

if [[ ! -f "$CORE_DIR/openclaw.mjs" ]]; then
  echo "run_openclaw_workspace: openclaw.mjs not found in $CORE_DIR" >&2
  exit 1
fi

cd "$CORE_DIR" || exit 1
exec node openclaw.mjs "$@"
