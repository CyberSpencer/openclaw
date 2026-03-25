#!/usr/bin/env bash
set -euo pipefail

# Safe .env loader with ownership and permission checks.
# Usage: source scripts/load_env.sh && load_env_files "$ROOT_DIR"

load_env_files() {
  local root_dir="${1:?root dir required}"
  local files=("$root_dir/config/.env" "$root_dir/config/secrets.env")

  for f in "${files[@]}"; do
    if [[ -f "$f" ]]; then
      local owner perms
      owner="$(stat -f "%Su" "$f" 2>/dev/null || echo "")"
      perms="$(stat -f "%Lp" "$f" 2>/dev/null || echo "")"
      if [[ "$owner" != "$(id -un)" ]]; then
        echo "WARN: Skipping $f (not owned by current user)" >&2
        continue
      fi
      # Env files may contain secrets, require owner-only readability.
      if [[ "$perms" != "600" && "$perms" != "400" ]]; then
        if [[ "$(basename "$f")" == "secrets.env" ]]; then
          if chmod 600 "$f" 2>/dev/null; then
            perms="$(stat -f "%Lp" "$f" 2>/dev/null || echo "")"
          fi
        fi

        if [[ "$perms" != "600" && "$perms" != "400" ]]; then
          echo "WARN: Skipping $f (permissions $perms too open, expected 600/400)" >&2
          continue
        fi
      fi
      set +u
      set -a
      # shellcheck disable=SC1090
      source "$f"
      set +a
      set -u
    fi
  done
}
