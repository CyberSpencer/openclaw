#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(pwd)"
retention_days=7
apply=false
include_defaults=true

declare -a explicit_candidates=()
declare -a candidates=()

usage() {
  cat <<'EOF'
Usage: scripts/workspace-cleanup.sh [options]

Safe workspace cleanup helper for transient directories.
Defaults to dry-run mode.

Options:
  --workspace-root <path>   Root workspace directory to scan (default: current dir)
  --retention-days <days>   Minimum age in days for default transient directories (default: 7)
  --candidate <path>        Explicit directory to include (repeatable)
  --no-defaults             Disable default transient directory discovery
  --apply                   Delete discovered candidates (default is dry-run)
  -h, --help                Show this help text

Default discovery targets (under --workspace-root):
  - tmp/openclaw-core
  - .tmp/openclaw-core
  - _merge_review/*/openclaw-core

Examples:
  scripts/workspace-cleanup.sh --workspace-root ~/clawd
  scripts/workspace-cleanup.sh --workspace-root ~/clawd --apply
  scripts/workspace-cleanup.sh --candidate ~/clawd/core-wt-agent-zero-live-ui/node_modules --apply
EOF
}

stat_mtime() {
  stat -f %m "$1"
}

bytes_to_human() {
  local bytes="$1"
  local units=(B KiB MiB GiB TiB)
  local idx=0
  local value="$bytes"
  while [ "$value" -ge 1024 ] && [ "$idx" -lt 4 ]; do
    value=$((value / 1024))
    idx=$((idx + 1))
  done
  printf "%s %s" "$value" "${units[$idx]}"
}

is_older_than_retention() {
  local path="$1"
  local now
  now=$(date +%s)
  local mtime
  mtime=$(stat_mtime "$path")
  local age_days
  age_days=$(((now - mtime) / 86400))
  [ "$age_days" -ge "$retention_days" ]
}

add_candidate() {
  local raw_path="$1"
  [ -d "$raw_path" ] || return 0

  local resolved
  resolved=$(cd "$raw_path" && pwd -P)

  case "$resolved" in
    "/"|""|"."|"..")
      echo "Skipping unsafe candidate path: $resolved" >&2
      return 0
      ;;
  esac

  local existing
  for existing in "${candidates[@]:-}"; do
    if [ "$existing" = "$resolved" ]; then
      return 0
    fi
  done

  candidates+=("$resolved")
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace-root)
      workspace_root="$2"
      shift 2
      ;;
    --retention-days)
      retention_days="$2"
      shift 2
      ;;
    --candidate)
      explicit_candidates+=("$2")
      shift 2
      ;;
    --no-defaults)
      include_defaults=false
      shift 1
      ;;
    --apply)
      apply=true
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

workspace_root=$(cd "$workspace_root" && pwd -P)

if [ "$include_defaults" = true ]; then
  declare -a default_paths=(
    "$workspace_root/tmp/openclaw-core"
    "$workspace_root/.tmp/openclaw-core"
  )

  for path in "${default_paths[@]}"; do
    if [ -d "$path" ] && is_older_than_retention "$path"; then
      add_candidate "$path"
    fi
  done

  for path in "$workspace_root"/_merge_review/*/openclaw-core; do
    [ -d "$path" ] || continue
    if is_older_than_retention "$path"; then
      add_candidate "$path"
    fi
  done
fi

if [ "${#explicit_candidates[@]}" -gt 0 ]; then
  for path in "${explicit_candidates[@]}"; do
    add_candidate "$path"
  done
fi

if [ "${#candidates[@]}" -eq 0 ]; then
  echo "No cleanup candidates found."
  exit 0
fi

echo "Workspace cleanup candidates:"
total_kb=0
for path in "${candidates[@]}"; do
  size_kb=$(du -sk "$path" 2>/dev/null | awk '{print $1}')
  size_kb=${size_kb:-0}
  total_kb=$((total_kb + size_kb))
  size_bytes=$((size_kb * 1024))
  printf "  - %s (%s)\n" "$path" "$(bytes_to_human "$size_bytes")"
done

total_bytes=$((total_kb * 1024))
echo "Estimated reclaimable size: $(bytes_to_human "$total_bytes")"

if [ "$apply" = false ]; then
  echo
  echo "Dry run only. Re-run with --apply to delete these paths."
  exit 0
fi

echo
echo "Applying cleanup..."
for path in "${candidates[@]}"; do
  rm -rf -- "$path"
  echo "  deleted: $path"
done

echo "Cleanup complete."