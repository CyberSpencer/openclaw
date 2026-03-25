#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPARK_SSH="$ROOT_DIR/scripts/spark_ssh.sh"
LOCAL_REPOS_ROOT="${AII_LOCAL_REPOS_ROOT:-/Users/spencerthomson/Documents/AII-Dev/GitHub}"
REMOTE_ROOT="${AII_SPARK_PREFLIGHT_ROOT:-/home/dgx-aii/aii-preflight/repos}"
MODE="${SPARK_PREFLIGHT_MODE:-quick}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="${1:-$ROOT_DIR/artifacts/spark-aii-preflight/$STAMP}"
SPARK_HOST="${SPARK_HOST:-192.168.1.93}"
SPARK_USER="${SPARK_USER:-dgx-aii}"
SPARK_KEY="${SPARK_KEY_PATH:-$HOME/.ssh/jarvis_full_host_ed25519}"
SPARK_KNOWN_HOSTS="${SPARK_KNOWN_HOSTS:-$HOME/.ssh/known_hosts_dgx_spark_tool}"

DEFAULT_REPOS=(
  aiva-api
  AII-Dashboard
  AII-Chatbot
  Autobuild
  aii-scraper
  aii-packages
  openclaw-core
  spark-openclaw-deploy
)

if [[ -n "${SPARK_PREFLIGHT_REPOS:-}" ]]; then
  IFS=',' read -r -a REPOS <<< "${SPARK_PREFLIGHT_REPOS}"
else
  REPOS=("${DEFAULT_REPOS[@]}")
fi

if [[ "$MODE" != "quick" && "$MODE" != "full" ]]; then
  echo "Invalid SPARK_PREFLIGHT_MODE: $MODE (expected quick|full)" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"

EXCLUDES_FILE="$(mktemp)"
cat > "$EXCLUDES_FILE" <<'EOF'
.git/
**/.git/
node_modules/
**/node_modules/
.venv/
**/.venv/
venv/
**/venv/
__pycache__/
**/__pycache__/
.next/
dist/
build/
coverage/
*.log
EOF

"$SPARK_SSH" -- "mkdir -p '$REMOTE_ROOT'"

{
  echo "# Spark AII Preflight"
  echo
  echo "Mode: $MODE"
  echo "Remote root: $REMOTE_ROOT"
  echo "Repos: ${REPOS[*]}"
  echo
} > "$OUT_DIR/SUMMARY.md"

for repo in "${REPOS[@]}"; do
  repo="$(echo "$repo" | xargs)"
  [[ -n "$repo" ]] || continue
  repo_local="$LOCAL_REPOS_ROOT/$repo"
  log_file="$OUT_DIR/${repo}.log"

  if [[ ! -d "$repo_local" ]]; then
    {
      echo "[MISS] local repo not found: $repo_local"
      echo "__FAIL_COUNT__=1"
    } > "$log_file"
    echo "- $repo: missing local repo" >> "$OUT_DIR/SUMMARY.md"
    continue
  fi

  rsync -az --delete --exclude-from="$EXCLUDES_FILE" \
    -e "ssh -i $SPARK_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$SPARK_KNOWN_HOSTS" \
    "$repo_local/" "$SPARK_USER@$SPARK_HOST:$REMOTE_ROOT/$repo/"

  "$SPARK_SSH" -- "bash -s -- '$repo' '$MODE' '$REMOTE_ROOT/$repo'" > "$log_file" 2>&1 <<'EOF' || true
set -euo pipefail
repo="$1"
mode="$2"
repo_dir="$3"
cd "$repo_dir"
fails=0
pass(){ echo "[PASS] $1"; }
warn(){ echo "[WARN] $1"; }
fail(){ echo "[FAIL] $1"; fails=$((fails+1)); }

echo "repo=$repo"
echo "pwd=$(pwd)"
echo "ts=$(date +"%Y-%m-%dT%H:%M:%S%z")"

if [ -f package.json ]; then
  if command -v node >/dev/null 2>&1; then
    if node -e 'JSON.parse(require("fs").readFileSync("package.json","utf8"));'; then
      pass 'package.json parses'
    else
      fail 'package.json invalid'
    fi
  else
    fail 'node missing'
  fi
else
  warn 'package.json absent'
fi

if find . -type f -name '*.py' | grep -q .; then
  if python3 -m compileall -q .; then
    pass 'python compileall'
  else
    fail 'python compileall failed'
  fi
else
  warn 'no python files'
fi

sh_files=$(find . -type f -name '*.sh' | wc -l | tr -d ' ')
if [ "$sh_files" != "0" ]; then
  bad=0
  while IFS= read -r f; do
    if ! bash -n "$f"; then
      echo "[FAIL] bash syntax: $f"
      bad=$((bad+1))
    fi
  done < <(find . -type f -name '*.sh')
  if [ "$bad" = "0" ]; then
    pass 'bash syntax checks'
  else
    fail "bash syntax failures=$bad"
  fi
else
  warn 'no shell scripts'
fi

if grep -RIn --exclude-dir=.git --exclude-dir=node_modules -E '^(<<<<<<< .+|=======$|>>>>>>> .+)$' . >/tmp/spark-preflight-conflicts.txt 2>/dev/null; then
  fail 'merge conflict markers present'
  sed -n '1,20p' /tmp/spark-preflight-conflicts.txt
else
  pass 'no merge conflict markers'
fi

if [ "$mode" = "full" ] && [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    if pnpm install --frozen-lockfile >/tmp/spark-preflight-install.log 2>&1; then
      pass 'pnpm install --frozen-lockfile'
    else
      fail 'pnpm install failed'
      sed -n '1,120p' /tmp/spark-preflight-install.log
    fi
    if pnpm run --if-present check >/tmp/spark-preflight-check.log 2>&1; then
      pass 'pnpm check'
    else
      fail 'pnpm check failed'
      sed -n '1,120p' /tmp/spark-preflight-check.log
    fi
  elif [ -f package-lock.json ] && command -v npm >/dev/null 2>&1; then
    if npm ci >/tmp/spark-preflight-install.log 2>&1; then
      pass 'npm ci'
    else
      fail 'npm ci failed'
      sed -n '1,120p' /tmp/spark-preflight-install.log
    fi
    if npm run --if-present check >/tmp/spark-preflight-check.log 2>&1; then
      pass 'npm check'
    else
      fail 'npm check failed'
      sed -n '1,120p' /tmp/spark-preflight-check.log
    fi
  else
    warn 'full mode requested but package manager/lockfile missing'
  fi
fi

echo "__FAIL_COUNT__=$fails"
EOF

  fail_count="$(rg '^__FAIL_COUNT__=' "$log_file" | tail -n1 | cut -d= -f2 || echo 1)"
  if [[ "$fail_count" =~ ^[0-9]+$ ]] && [[ "$fail_count" -eq 0 ]]; then
    echo "- $repo: pass" >> "$OUT_DIR/SUMMARY.md"
  else
    echo "- $repo: fail_count=$fail_count" >> "$OUT_DIR/SUMMARY.md"
  fi
done

rm -f "$EXCLUDES_FILE"

echo >> "$OUT_DIR/SUMMARY.md"
echo "Artifacts: $OUT_DIR" >> "$OUT_DIR/SUMMARY.md"
echo "Spark AII preflight written to: $OUT_DIR"
