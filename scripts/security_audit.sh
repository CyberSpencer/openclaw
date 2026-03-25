#!/usr/bin/env bash
set -euo pipefail

# Lightweight security audit for the workspace.
# Checks for tracked secrets, risky env files, and permissions.

if [[ "${1:-}" == "--json" ]]; then
  shift
  filtered_args=()
  for arg in "$@"; do
    if [[ "$arg" == "--json" ]]; then
      continue
    fi
    filtered_args+=("$arg")
  done

  tmp_out="$(mktemp)"
  trap 'rm -f "$tmp_out"' EXIT

  set +e
  if (( ${#filtered_args[@]} > 0 )); then
    "$0" "${filtered_args[@]}" >"$tmp_out"
  else
    "$0" >"$tmp_out"
  fi
  rc=$?
  set -e

  python3 - "$tmp_out" "$rc" <<'PY'
import json
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
exit_code = int(sys.argv[2])
lines = path.read_text(encoding="utf-8", errors="replace").splitlines()

passes = []
warns = []
fails = []
for line in lines:
    if line.startswith("OK: "):
        passes.append(line[4:])
    elif line.startswith("WARN: "):
        warns.append(line[6:])
    elif line.startswith("FAIL: "):
        fails.append(line[6:])

summary = {"fail": None, "warn": None}
for line in lines:
    m = re.match(r"^Summary:\s+fail=(\d+)\s+warn=(\d+)$", line.strip())
    if m:
        summary["fail"] = int(m.group(1))
        summary["warn"] = int(m.group(2))
        break

payload = {
    "ok": exit_code == 0,
    "exit_code": exit_code,
    "summary": summary,
    "counts": {
        "ok": len(passes),
        "warn": len(warns),
        "fail": len(fails),
    },
    "checks": {
        "ok": passes,
        "warn": warns,
        "fail": fails,
    },
}
print(json.dumps(payload, indent=2))
PY
  exit "$rc"
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail=0
warn=0

say_fail() { echo "FAIL: $*"; fail=$((fail + 1)); }
say_warn() { echo "WARN: $*"; warn=$((warn + 1)); }
say_ok() { echo "OK: $*"; }

# Load contract when available so loopback checks can account for DGX WAN mode.
if [[ -f "$ROOT_DIR/config/workspace.env" ]]; then
  # shellcheck disable=SC1091,SC1094
  source "$ROOT_DIR/config/workspace.env"
elif [[ -f "$ROOT_DIR/config/workspace.env.example" ]]; then
  # shellcheck disable=SC1091,SC1094
  source "$ROOT_DIR/config/workspace.env.example"
fi

dgx_enabled() {
  local raw="${DGX_ENABLED:-}"
  case "$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    0|false|no|off) return 1 ;;
  esac
  local host="${DGX_HOST:-}"
  [[ -n "$host" && "$host" != "localhost" && ! "$host" =~ ^127\. && "$host" != "::1" ]]
}

echo "=== Security Audit ==="
echo "Workspace: $ROOT_DIR"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

echo "--- Tracked secrets scan (staged + tracked files) ---"
# Note: macOS ships Bash 3.2, which lacks `mapfile`. Keep this script
# compatible by streaming `git ls-files` into ripgrep.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # Use NUL delimiters to handle odd file names and spaces.
  set +e
  # Only flag env-style assignments (optionally `export`) at the start of a line.
  # This avoids false positives from docs/test prompts that contain token-like env assignments.
  secret_hits_raw="$(
    git ls-files -z \
      | xargs -0 rg --no-messages -n '^[[:space:]]*(export[[:space:]]+)?([A-Z0-9_]*API_KEY[A-Z0-9_]*|[A-Z0-9_]*PASSWORD[A-Z0-9_]*|SECRET_[A-Z0-9_]*|[A-Z0-9_]*_SECRET|[A-Z0-9_]*_TOKEN|TOKEN)=' 2>/dev/null \
      || true
  )"

  # Filter obvious placeholders and indirections (we care about committed literal secrets).
  # Keep this conservative, it's a smoke detector, not a linter.
  secret_hits="$(
    printf '%s\n' "$secret_hits_raw" \
      | rg -vi '(example|<|redacted|your-|your_|placeholder|\.\.\.|\$\(|\$\{|=\s*\(|=\s*"?\$)' 2>/dev/null \
      || true
  )"
  set -e

  if [[ -n "${secret_hits//[[:space:]]/}" ]]; then
    # Heuristic: treat short RHS values as warnings (docs/examples), and longer
    # values as a hard failure (more likely to be real secrets).
    classification="$(
      printf '%s\n' "$secret_hits" | awk '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
{
  line=$0
  pos1=index(line, ":")
  if (pos1 == 0) { print "SOFT:" line; next }
  rest=substr(line, pos1 + 1)
  pos2=index(rest, ":")
  if (pos2 == 0) { print "SOFT:" line; next }
  content=substr(rest, pos2 + 1)
  sub(/^[ \t]+/, "", content)
  sub(/^export[ \t]+/, "", content)
  eq=index(content, "=")
  if (eq == 0) { print "SOFT:" line; next }
  rhs=substr(content, eq + 1)
  rhs=trim(rhs)

  # Strip surrounding quotes when the whole RHS is quoted.
  if (rhs ~ /^".*"$/ && length(rhs) >= 2) rhs=substr(rhs, 2, length(rhs) - 2)
  sq=sprintf("%c", 39)
  if (rhs ~ ("^" sq ".*" sq "$") && length(rhs) >= 2) rhs=substr(rhs, 2, length(rhs) - 2)

  # For env-style assignments, ignore any trailing commentary.
  if (rhs ~ /[ \t]/) { split(rhs, a, /[ \t]+/); rhs=a[1] }

  # Known real-world secret prefixes should count as HARD even if short.
  if (rhs ~ /^(sk_|sk-|ghp_|xox[baprs]-|AKIA|ASIA|AIza)/) { print "HARD:" line; next }

  if (length(rhs) >= 20) print "HARD:" line; else print "SOFT:" line
}
' 2>/dev/null || true
    )"

    hard_hits="$(printf '%s\n' "$classification" | rg '^HARD:' || true)"
    soft_hits="$(printf '%s\n' "$classification" | rg '^SOFT:' || true)"

    if [[ -n "${hard_hits//[[:space:]]/}" ]]; then
      say_fail "Potential secrets found in tracked files (values redacted)"
      echo "$hard_hits" | sed -E 's/^HARD://' | sed -E 's/=.*/=<redacted>/'
    fi
    if [[ -n "${soft_hits//[[:space:]]/}" ]]; then
      say_warn "Suspicious secret-like assignments found in tracked files (likely docs/examples)"
      echo "$soft_hits" | sed -E 's/^SOFT://' | sed -E 's/=.*/=<redacted>/'
    fi
  else
    say_ok "No obvious secrets in tracked files"
  fi
else
  say_warn "Not a git repository; skipping tracked file scan"
fi

echo ""
echo "--- Env file permissions ---"
for f in "$ROOT_DIR/config/.env" "$ROOT_DIR/config/secrets.env"; do
  if [[ -f "$f" ]]; then
    owner="$(stat -f "%Su" "$f" 2>/dev/null || echo "")"
    perms="$(stat -f "%Lp" "$f" 2>/dev/null || echo "")"
    if [[ "$owner" != "$(id -un)" ]]; then
      say_fail "$f not owned by current user"
    elif [[ "$perms" != "600" && "$perms" != "400" ]]; then
      say_warn "$f permissions $perms too open (expected 600/400)"
    else
      say_ok "$f permissions OK ($perms)"
    fi
  else
    say_ok "$f not present"
  fi
done

echo ""
echo "--- Stray env backups ---"
# Ignore the tracked example file.
backups="$(find "$ROOT_DIR/config" -maxdepth 1 -name 'secrets.env.*' -print 2>/dev/null | rg -vF 'secrets.env.example' || true)"
if [[ -n "$backups" ]]; then
  say_warn "Found secrets.env.* backups (should be removed or stored outside repo)"
  echo "$backups"
else
  say_ok "No secrets.env.* backups found"
fi

echo ""
echo "--- Qdrant loopback ---"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
qdrant_url="$(python3 - "$OPENCLAW_CONFIG_PATH" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1]).expanduser()
if not path.exists():
    print("")
    raise SystemExit
try:
    raw = path.read_text(encoding="utf-8")
    obj = json.loads(raw)
except Exception:
    try:
        import json5  # type: ignore
        obj = json5.loads(raw)
    except Exception:
        print("__PARSE_ERROR__")
        raise SystemExit
cfg = obj.get("agents", {}).get("defaults", {}).get("memorySearch", {}) or {}
qdrant = cfg.get("store", {}).get("qdrant", {}) if isinstance(cfg, dict) else {}
url = qdrant.get("url", "") if isinstance(qdrant, dict) else ""
print(url)
PY
)" || true

if [[ ! -f "$OPENCLAW_CONFIG_PATH" ]]; then
  say_warn "OpenClaw config not found: $OPENCLAW_CONFIG_PATH"
elif [[ "$qdrant_url" == "__PARSE_ERROR__" ]]; then
  say_warn "OpenClaw config unreadable/corrupt; skipped Qdrant loopback check"
elif [[ -z "$qdrant_url" ]]; then
  say_warn "Qdrant URL not found in $OPENCLAW_CONFIG_PATH"
else
  host="$(python3 - <<'PY' "$qdrant_url"
import sys
from urllib.parse import urlparse

url = sys.argv[1]
try:
    host = urlparse(url).hostname or ""
except Exception:
    host = ""
print(host)
PY
)"
  if [[ "$host" == "localhost" || "$host" == "::1" || "$host" =~ ^127\. ]]; then
    say_ok "Qdrant bound to loopback ($host)"
  elif dgx_enabled; then
    say_ok "Qdrant host is non-loopback ($host) with DGX mode enabled"
  else
    say_warn "Qdrant URL is not loopback ($host)"
  fi
fi

echo ""
echo "--- Runtime config secret hygiene ---"
config_secret_report="$(python3 - "$OPENCLAW_CONFIG_PATH" <<'PY'
import json
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1]).expanduser()
if not path.exists():
    print("missing")
    raise SystemExit(0)

try:
    raw = path.read_text(encoding="utf-8")
    obj = json.loads(raw)
except Exception:
    try:
        import json5  # type: ignore
        obj = json5.loads(raw)
    except Exception:
        print("unreadable")
        raise SystemExit(0)

suspicious_paths = []
secret_key_names = {"apiKey", "token", "authToken", "X-OpenClaw-Token"}
known_non_secret_values = {"ollama", "ollama-local", "local", "spark", "none"}
secret_prefixes = (
    "sk_",
    "sk-",
    "nvapi-",
    "ghp_",
    "xox",
)
hex_re = re.compile(r"^[a-f0-9]{32,}$", re.IGNORECASE)


def is_env_placeholder(value: str) -> bool:
    val = (value or "").strip()
    return bool(val.startswith("${") and val.endswith("}"))


def looks_literal_secret(value: str) -> bool:
    val = (value or "").strip()
    if not val or is_env_placeholder(val):
        return False
    if any(val.startswith(prefix) for prefix in secret_prefixes):
        return True
    if hex_re.match(val):
        return True
    return False


def walk(node, path_parts):
    if isinstance(node, dict):
        for k, v in node.items():
            child_path = path_parts + [str(k)]
            if isinstance(v, (dict, list)):
                walk(v, child_path)
                continue
            if not isinstance(v, str):
                continue
            val = v.strip()
            if not val:
                continue
            if k in secret_key_names:
                if not is_env_placeholder(val) and val.lower() not in known_non_secret_values:
                    suspicious_paths.append(".".join(child_path))
                continue
            if looks_literal_secret(val):
                suspicious_paths.append(".".join(child_path))
    elif isinstance(node, list):
        for idx, item in enumerate(node):
            walk(item, path_parts + [f"[{idx}]"])

walk(obj, [])
if not suspicious_paths:
    print("clean")
else:
    print("count=" + str(len(suspicious_paths)))
    for p in suspicious_paths[:20]:
        print(p)
PY
)" || true

if [[ "$config_secret_report" == "missing" ]]; then
  say_warn "OpenClaw config missing; skipped runtime secret hygiene check"
elif [[ "$config_secret_report" == "unreadable" ]]; then
  say_warn "OpenClaw config unreadable; skipped runtime secret hygiene check"
elif [[ "$config_secret_report" == "clean" ]]; then
  say_ok "No obvious literal secrets found in runtime config"
else
  say_fail "Runtime config contains literal secret values (strict zero-literal policy)"
  printf '%s\n' "$config_secret_report" | sed -n '1,21p'
fi

echo ""
echo "Summary: fail=$fail warn=$warn"
if [[ $fail -gt 0 ]]; then
  exit 1
fi
exit 0
