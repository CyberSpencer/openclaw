#!/usr/bin/env bash
set -euo pipefail

# Stack supervisor: starts Qdrant, waits for health, then keeps gateway running.
# Gateway restarts are handled in-process so Qdrant stays warm across gateway churn.
# Used by LaunchAgent ai.openclaw.stack.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

STACK_RUNTIME_DIR="$HOME/.openclaw/run"
STACK_LOCK_DIR="$STACK_RUNTIME_DIR/stack-supervisor.lock"
STACK_LOCK_PID_FILE="$STACK_LOCK_DIR/pid"
STACK_LOCK_HELD=0

is_stack_supervisor_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -Fq "stack_supervisor.sh"
}

lock_dir_mtime_epoch() {
  stat -f "%m" "$STACK_LOCK_DIR" 2>/dev/null || echo 0
}

acquire_stack_lock() {
  mkdir -p "$STACK_RUNTIME_DIR"
  chmod 700 "$STACK_RUNTIME_DIR" 2>/dev/null || true

  if [[ -L "$STACK_LOCK_DIR" ]]; then
    echo "stack_supervisor: ERROR lock path is a symlink, refusing to proceed: $STACK_LOCK_DIR" >&2
    return 1
  fi

  if mkdir "$STACK_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$STACK_LOCK_PID_FILE"
    STACK_LOCK_HELD=1
    return 0
  fi

  local existing_pid=""
  if [[ -f "$STACK_LOCK_PID_FILE" ]]; then
    existing_pid="$(tr -dc '0-9' < "$STACK_LOCK_PID_FILE" | head -c 32)"
  fi

  # Another instance may have created the lock dir and not written pid yet.
  # Wait briefly to avoid split-brain stale-lock reclaim during startup races.
  if [[ -z "$existing_pid" ]]; then
    for _ in {1..10}; do
      sleep 0.1
      if [[ -f "$STACK_LOCK_PID_FILE" ]]; then
        existing_pid="$(tr -dc '0-9' < "$STACK_LOCK_PID_FILE" | head -c 32)"
        [[ -n "$existing_pid" ]] && break
      fi
    done
  fi

  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    if is_stack_supervisor_pid "$existing_pid"; then
      echo "stack_supervisor: WARN already running (pid=$existing_pid), skipping duplicate launch" >&2
      return 2
    fi
    echo "stack_supervisor: WARN lock pid $existing_pid is active but not stack_supervisor, treating as stale lock metadata" >&2
  elif [[ -z "$existing_pid" ]]; then
    local lock_mtime now_epoch lock_age
    lock_mtime="$(lock_dir_mtime_epoch)"
    now_epoch="$(date +%s)"
    lock_age=0
    if [[ "$lock_mtime" =~ ^[0-9]+$ ]] && [[ "$now_epoch" =~ ^[0-9]+$ ]] && (( now_epoch >= lock_mtime )); then
      lock_age=$(( now_epoch - lock_mtime ))
    fi
    if (( lock_age < 5 )); then
      echo "stack_supervisor: WARN lock exists without pid file (age=${lock_age}s), assuming concurrent startup; skipping duplicate launch" >&2
      return 2
    fi
  fi

  # Recover stale lock from a prior unclean shutdown.
  rm -f "$STACK_LOCK_PID_FILE" 2>/dev/null || true
  if rmdir "$STACK_LOCK_DIR" 2>/dev/null && mkdir "$STACK_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$STACK_LOCK_PID_FILE"
    STACK_LOCK_HELD=1
    echo "stack_supervisor: WARN recovered stale lock at $STACK_LOCK_DIR" >&2
    return 0
  fi

  echo "stack_supervisor: ERROR failed to acquire lock at $STACK_LOCK_DIR" >&2
  return 1
}

release_stack_lock() {
  [[ "$STACK_LOCK_HELD" == "1" ]] || return 0

  if [[ "$STACK_LOCK_DIR" != "$STACK_RUNTIME_DIR"/* ]]; then
    echo "stack_supervisor: ERROR refusing to release lock outside runtime dir: $STACK_LOCK_DIR" >&2
    STACK_LOCK_HELD=0
    return 1
  fi

  if [[ -L "$STACK_LOCK_DIR" ]]; then
    echo "stack_supervisor: ERROR refusing to release symlink lock path: $STACK_LOCK_DIR" >&2
    STACK_LOCK_HELD=0
    return 1
  fi

  rm -f "$STACK_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STACK_LOCK_DIR" 2>/dev/null || true
  STACK_LOCK_HELD=0
}

# Preserve OPENCLAW_BIN from plist/env so workspace.env cannot override when running from repo.
SAVED_OPENCLAW_BIN_FROM_ENV="${OPENCLAW_BIN:-}"

# Load contract for OPENCLAW_BIN, OPENCLAW_CONFIG, QDRANT_*, etc.
if [[ -f "$REPO_ROOT/config/workspace.env" ]]; then
  # shellcheck disable=SC1091,SC1094
  source "$REPO_ROOT/config/workspace.env"
elif [[ -f "$REPO_ROOT/config/workspace.env.example" ]]; then
  # shellcheck disable=SC1091,SC1094
  source "$REPO_ROOT/config/workspace.env.example"
fi

# Optional local env (e.g. OPENCLAW_GATEWAY_TOKEN); keychain_env skips vars already set
# Load local env files with ownership/permission checks.
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/load_env.sh"
load_env_files "$REPO_ROOT"

# Export so gateway child process sees them (LaunchAgent does not inherit shell env from .env)
for var in OPENCLAW_GATEWAY_TOKEN ELEVENLABS_API_KEY BRAVE_API_KEY MOTION_API_KEY BEEPER_API_KEY STRIPE_API_KEY GITHUB_PAT GITHUB_PAT_AII OLLAMA_API_KEY NVIDIA_API_KEY HF_TOKEN DGX_HOST DGX_ENABLED DGX_OLLAMA_URL DGX_ACCESS_MODE DGX_WAN_BASE_URL DGX_WAN_TOKEN DGX_STT_PORT DGX_TTS_PORT OPENCLAW_NVIDIA_ROUTER_URL DGX_ROUTER_URL; do
  # shellcheck disable=SC2163
  [[ -n "${!var:-}" ]] && export "$var"
done

# Load keychain env (required for gateway token, optional for other services)
KEYCHAIN_LOADER="${OPENCLAW_KEYCHAIN_LOADER:-$REPO_ROOT/scripts/keychain_env.sh}"
if [[ ! -f "$KEYCHAIN_LOADER" ]]; then
  KEYCHAIN_LOADER="$HOME/bin/openclaw_keychain_env.sh"
fi
if [[ -f "$KEYCHAIN_LOADER" ]]; then
  # shellcheck disable=SC1090
  source "$KEYCHAIN_LOADER"
fi

# Prefer workspace wrapper when running from repo so custom config (dgx, routing, secretsLocalModel) is accepted.
# Use wrapper (does not re-source env) over run_gateway_from_repo.sh (sources workspace.env and can clear keychain vars).
# Restore plist-set OPENCLAW_BIN when it pointed at the workspace wrapper (workspace.env must not override it).
if [[ -n "$SAVED_OPENCLAW_BIN_FROM_ENV" ]] && [[ -x "$SAVED_OPENCLAW_BIN_FROM_ENV" ]]; then
  OPENCLAW_BIN="$SAVED_OPENCLAW_BIN_FROM_ENV"
elif [[ -n "${OPENCLAW_BIN:-}" ]] && [[ -x "$OPENCLAW_BIN" ]]; then
  :
elif [[ -x "$REPO_ROOT/scripts/run_openclaw_workspace.sh" ]] && [[ -f "$REPO_ROOT/core/openclaw.mjs" ]]; then
  OPENCLAW_BIN="$REPO_ROOT/scripts/run_openclaw_workspace.sh"
elif [[ -z "${OPENCLAW_BIN:-}" ]]; then
  OPENCLAW_BIN="$HOME/.openclaw/bin/openclaw"
fi
OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/.openclaw/bin/openclaw}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

CONFIG_PREFLIGHT_CMD=()
select_config_preflight_cmd() {
  # Prefer dedicated config validation commands when available.
  if "$OPENCLAW_BIN" config --help 2>/dev/null | grep -qE '^\s*validate\b'; then
    CONFIG_PREFLIGHT_CMD=("$OPENCLAW_BIN" config validate)
    return 0
  fi
  if "$OPENCLAW_BIN" config --help 2>/dev/null | grep -qE '^\s*effective\b'; then
    CONFIG_PREFLIGHT_CMD=("$OPENCLAW_BIN" config effective)
    return 0
  fi

  # Fallback: read a core non-optional config subtree to force config load/parse.
  CONFIG_PREFLIGHT_CMD=("$OPENCLAW_BIN" config get models.providers)
  return 0
}

# Optional: open the OpenClaw Mac app when the stack starts so the desktop agent is present.
# This app is a menu bar agent (LSUIElement=true), so it won't show in Dock/Cmd+Tab.
open_mac_app() {
  [[ "${OPENCLAW_OPEN_APP_ON_STACK_START:-1}" == "0" ]] && return 0

  local app_path="${OPENCLAW_APP_PATH:-}"
  if [[ -n "$app_path" ]] && [[ -d "$app_path" ]]; then
    if open -g "$app_path" 2>/dev/null; then
      return 0
    fi
  fi

  # Try by bundle name (finds /Applications/OpenClaw.app or similar).
  if open -g -a OpenClaw 2>/dev/null; then
    return 0
  fi

  # Fallback: workspace-local app.
  if [[ -d "$REPO_ROOT/OpenClaw.app" ]]; then
    if open -g "$REPO_ROOT/OpenClaw.app" 2>/dev/null; then
      return 0
    fi
  fi

  return 1
}

maybe_open_mac_app() {
  [[ "${OPENCLAW_OPEN_APP_ON_STACK_START:-1}" == "0" ]] && return 0
  if pgrep -x OpenClaw >/dev/null 2>&1; then
    return 0
  fi
  open_mac_app || true
  return 0
}

# STACK_QDRANT_MODE: off | optional | required
# - off: do not start local Qdrant; gateway uses Spark/remote only
# - optional: start local Qdrant; if it fails or dies, gateway stays up (Spark fallback)
# - required: current behavior; Qdrant is anchor (default when DGX not enabled)
parse_qdrant_mode() {
  local raw="${STACK_QDRANT_MODE:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"

  dgx_enabled() {
    local dgx="${DGX_ENABLED:-}"
    dgx="$(printf '%s' "$dgx" | tr '[:upper:]' '[:lower:]')"
    case "$dgx" in
      1|true|yes|on) return 0 ;;
      0|false|no|off) return 1 ;;
    esac
    [[ -n "${DGX_HOST:-}" ]] && [[ "${DGX_HOST:-}" != "localhost" ]] && [[ "${DGX_HOST:-}" != "127.0.0.1" ]] && return 0
    return 1
  }

  case "$raw" in
    off) echo "off" ; return ;;
    optional) echo "optional" ; return ;;
    required) echo "required" ; return ;;
  esac
  # Default: optional when DGX/Spark available, else required
  if dgx_enabled; then
    echo "optional"
  else
    echo "required"
  fi
}
QDRANT_MODE="$(parse_qdrant_mode)"

# Prefer an explicit QDRANT_BIN, otherwise prefer PATH, otherwise fall back to ~/bin.
if [[ -z "${QDRANT_BIN:-}" ]]; then
  if command -v qdrant >/dev/null 2>&1; then
    QDRANT_BIN="$(command -v qdrant)"
  else
    QDRANT_BIN="$HOME/bin/qdrant"
  fi
fi

QDRANT_CONFIG="${QDRANT_CONFIG:-$HOME/.openclaw/qdrant/config.yaml}"
QDRANT_HEALTH_URL="${QDRANT_URL:-http://127.0.0.1:6333}/healthz"

QDRANT_PID=""
GATEWAY_PID=""
GATEWAY_STARTED_AT=0
GATEWAY_RESTART_INITIAL_SEC="${STACK_GATEWAY_RESTART_BACKOFF_SEC:-2}"
GATEWAY_RESTART_BACKOFF_SEC="$GATEWAY_RESTART_INITIAL_SEC"
GATEWAY_RESTART_BACKOFF_MAX_SEC="${STACK_GATEWAY_RESTART_BACKOFF_MAX_SEC:-30}"
GATEWAY_STABLE_UPTIME_SEC="${STACK_GATEWAY_STABLE_UPTIME_SEC:-20}"
GATEWAY_INVALID_CONFIG_RETRY_SEC="${STACK_GATEWAY_INVALID_CONFIG_RETRY_SEC:-60}"
GATEWAY_MAX_FAST_CRASHES="${STACK_GATEWAY_MAX_FAST_CRASHES:-10}"
GATEWAY_CONSECUTIVE_FAST_CRASHES=0

cleanup() {
  if [[ -n "${GATEWAY_PID:-}" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [[ -n "${QDRANT_PID:-}" ]] && kill -0 "$QDRANT_PID" 2>/dev/null; then
    kill "$QDRANT_PID" 2>/dev/null || true
    wait "$QDRANT_PID" 2>/dev/null || true
  fi
  release_stack_lock
}
trap cleanup EXIT SIGTERM SIGINT

if acquire_stack_lock; then
  :
else
  lock_rc=$?
  if [[ $lock_rc -eq 2 ]]; then
    exit 0
  fi
  exit 1
fi

# 1. Start Qdrant in background (skip when mode=off)
if [[ "$QDRANT_MODE" != "off" ]]; then
  start_local_qdrant=1

  if [[ ! -x "$QDRANT_BIN" ]]; then
    if [[ "$QDRANT_MODE" == "required" ]]; then
      echo "stack_supervisor: ERROR qdrant binary not found or not executable: $QDRANT_BIN" >&2
      exit 1
    fi
    echo "stack_supervisor: WARN qdrant binary not found ($QDRANT_BIN); continuing without local qdrant (mode=$QDRANT_MODE)" >&2
    start_local_qdrant=0
  fi

  if [[ "$start_local_qdrant" == "1" ]] && [[ ! -f "$QDRANT_CONFIG" ]]; then
    if [[ "$QDRANT_MODE" == "required" ]]; then
      echo "stack_supervisor: ERROR qdrant config not found: $QDRANT_CONFIG" >&2
      exit 1
    fi
    echo "stack_supervisor: WARN qdrant config not found ($QDRANT_CONFIG); continuing without local qdrant (mode=$QDRANT_MODE)" >&2
    start_local_qdrant=0
  fi

  if [[ "$start_local_qdrant" == "1" ]]; then
    # Redirect Qdrant stdout/stderr so gateway output is not intermingled.
    QDRANT_LOG="${QDRANT_LOG:-$HOME/Library/Logs/qdrant-supervisor.log}"
    "$QDRANT_BIN" --config-path "$QDRANT_CONFIG" >> "$QDRANT_LOG" 2>&1 &
    QDRANT_PID=$!

    # 2. Wait for Qdrant health (retries + backoff, max ~30s)
    QDRANT_RETRIES=15
    QDRANT_DELAY=2
    for ((i=1; i<=QDRANT_RETRIES; i++)); do
      if curl -fsS --max-time 5 "$QDRANT_HEALTH_URL" >/dev/null 2>&1; then
        break
      fi
      if [[ $i -eq QDRANT_RETRIES ]]; then
        if [[ "$QDRANT_MODE" == "required" ]]; then
          echo "stack_supervisor: ERROR Qdrant did not become healthy at $QDRANT_HEALTH_URL after ${QDRANT_RETRIES} attempts" >&2
          exit 1
        fi
        echo "stack_supervisor: WARN local Qdrant did not become healthy at $QDRANT_HEALTH_URL; starting gateway anyway (mode=$QDRANT_MODE)" >&2
        break
      fi
      sleep "$QDRANT_DELAY"
    done
  fi
else
  echo "stack_supervisor: local Qdrant disabled (STACK_QDRANT_MODE=off); gateway will use Spark/remote only" >&2
fi

# Ensure Control UI is built when running from workspace (gateway never starts without it).
ensure_control_ui_build() {
  local core_pkg="$REPO_ROOT/core/package.json"
  local ui_index="$REPO_ROOT/core/dist/control-ui/index.html"
  if [[ -f "$core_pkg" ]] && [[ ! -f "$ui_index" ]]; then
    if ! command -v pnpm >/dev/null 2>&1; then
      echo "stack_supervisor: ERROR pnpm is required to build the Control UI; install pnpm then run: pnpm -C core ui:build" >&2
      exit 1
    fi
    echo "stack_supervisor: building Control UI (required for gateway)..." >&2
    local ui_log="${OPENCLAW_UI_BUILD_LOG:-$HOME/Library/Logs/openclaw-control-ui-build.log}"
    if ! pnpm -C "$REPO_ROOT/core" ui:build >>"$ui_log" 2>&1; then
      echo "stack_supervisor: ERROR Control UI build failed; see $ui_log" >&2
      exit 1
    fi
  fi
}
ensure_control_ui_build

# 3. Run gateway (supervise Qdrant too)
if [[ ! -x "$OPENCLAW_BIN" ]]; then
  echo "stack_supervisor: ERROR openclaw binary not found or not executable: $OPENCLAW_BIN" >&2
  exit 1
fi

export PATH="${HOME}/.openclaw/bin:${HOME}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="${HOME}"
export OPENCLAW_CONFIG
# Core resolves config via OPENCLAW_CONFIG_PATH; plist/supervisor set both for launchd compatibility.
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_CONFIG}"
# Export workspace root so memory search can resolve workspace paths
export CLW_WORKSPACE="${CLW_WORKSPACE:-$REPO_ROOT}"
# Re-export DGX + router URL so gateway/dashboard and router children see DGX Spark (spark_reachable, health checks)
[[ -n "${DGX_ENABLED:-}" ]] && export DGX_ENABLED
[[ -n "${DGX_HOST:-}" ]] && export DGX_HOST
[[ -n "${DGX_OLLAMA_URL:-}" ]] && export DGX_OLLAMA_URL
[[ -n "${DGX_ACCESS_MODE:-}" ]] && export DGX_ACCESS_MODE
[[ -n "${DGX_WAN_BASE_URL:-}" ]] && export DGX_WAN_BASE_URL
[[ -n "${DGX_WAN_TOKEN:-}" ]] && export DGX_WAN_TOKEN
[[ -n "${OPENCLAW_NVIDIA_ROUTER_URL:-}" ]] && export OPENCLAW_NVIDIA_ROUTER_URL
[[ -n "${DGX_ROUTER_URL:-}" ]] && export DGX_ROUTER_URL

select_config_preflight_cmd

validate_config_once() {
  local output=""
  local rc=0

  set +e
  output="$("${CONFIG_PREFLIGHT_CMD[@]}" 2>&1)"
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    return 0
  fi

  echo "stack_supervisor: ERROR config pre-flight validation failed (rc=$rc)" >&2
  if [[ -n "$output" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      echo "stack_supervisor:   $line" >&2
    done <<< "$output"
  fi
  return 1
}

wait_for_valid_config() {
  local skip_first_validation="${1:-0}"

  while true; do
    if [[ "$skip_first_validation" == "1" ]]; then
      echo "stack_supervisor: config invalid (pre-checked), retrying validation in ${GATEWAY_INVALID_CONFIG_RETRY_SEC}s" >&2
      skip_first_validation=0
    else
      if validate_config_once; then
        return 0
      fi
      echo "stack_supervisor: config invalid, retrying validation in ${GATEWAY_INVALID_CONFIG_RETRY_SEC}s" >&2
    fi

    sleep "$GATEWAY_INVALID_CONFIG_RETRY_SEC"

    if [[ -n "${QDRANT_PID:-}" ]] && ! kill -0 "$QDRANT_PID" 2>/dev/null; then
      if [[ "$QDRANT_MODE" == "required" ]]; then
        echo "stack_supervisor: ERROR qdrant exited while waiting for config to become valid" >&2
        return 1
      fi
      # optional/off: clear PID and continue (config validation is the gate)
      QDRANT_PID=""
    fi
  done
}

start_gateway() {
  "$OPENCLAW_BIN" gateway &
  GATEWAY_PID=$!
  GATEWAY_STARTED_AT="$(date +%s)"
}

if ! wait_for_valid_config; then
  exit 1
fi
start_gateway

# Start the desktop agent app (non-fatal) once the gateway is ready so it can connect immediately.
# Waits up to 20s for gateway; LaunchServices needs a beat at login so we add 2s after ready.
(
  gw_url="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-32555}}"
  for i in $(seq 1 20); do
    if curl -fsS --max-time 2 "${gw_url%/}/" >/dev/null 2>&1; then
      break
    fi
    [[ $i -eq 20 ]] && exit 0
    sleep 1
  done
  sleep 2
  maybe_open_mac_app
) >/dev/null 2>&1 &

# 4. Supervision loop
# When QDRANT_MODE=required, Qdrant is the anchor; when optional/off, gateway is the anchor.
while true; do
  if [[ -n "${QDRANT_PID:-}" ]] && ! kill -0 "$QDRANT_PID" 2>/dev/null; then
    if [[ "$QDRANT_MODE" == "required" ]]; then
      echo "stack_supervisor: ERROR qdrant exited; shutting down gateway" >&2
      if [[ -n "${GATEWAY_PID:-}" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
        kill "$GATEWAY_PID" 2>/dev/null || true
        wait "$GATEWAY_PID" 2>/dev/null || true
      fi
      exit 1
    fi
    # optional/off: Qdrant died; log and continue; gateway stays up
    echo "stack_supervisor: WARN local Qdrant exited (mode=$QDRANT_MODE); gateway stays up" >&2
    QDRANT_PID=""
  fi

  if [[ -n "${GATEWAY_PID:-}" ]] && ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    rc=0
    wait "$GATEWAY_PID" 2>/dev/null || rc=$?
    rc=${rc:-0}

    now="$(date +%s)"
    uptime=0
    if [[ -n "${GATEWAY_STARTED_AT:-}" ]] && [[ "$GATEWAY_STARTED_AT" =~ ^[0-9]+$ ]] && [[ "$now" =~ ^[0-9]+$ ]]; then
      uptime=$(( now - GATEWAY_STARTED_AT ))
    fi

    if [[ "$uptime" =~ ^[0-9]+$ ]] && (( uptime >= GATEWAY_STABLE_UPTIME_SEC )); then
      GATEWAY_RESTART_BACKOFF_SEC="$GATEWAY_RESTART_INITIAL_SEC"
      GATEWAY_CONSECUTIVE_FAST_CRASHES=0
    else
      GATEWAY_CONSECUTIVE_FAST_CRASHES=$((GATEWAY_CONSECUTIVE_FAST_CRASHES + 1))
      if (( GATEWAY_CONSECUTIVE_FAST_CRASHES >= GATEWAY_MAX_FAST_CRASHES )); then
        echo "stack_supervisor: ERROR gateway crashed quickly ${GATEWAY_CONSECUTIVE_FAST_CRASHES} consecutive times (threshold=${GATEWAY_MAX_FAST_CRASHES}, stable_uptime=${GATEWAY_STABLE_UPTIME_SEC}s); exiting for launchd throttle" >&2
        exit 1
      fi

      next_backoff=$(( GATEWAY_RESTART_BACKOFF_SEC * 2 ))
      if (( next_backoff > GATEWAY_RESTART_BACKOFF_MAX_SEC )); then
        next_backoff=$GATEWAY_RESTART_BACKOFF_MAX_SEC
      fi
      GATEWAY_RESTART_BACKOFF_SEC="$next_backoff"
    fi

    if ! validate_config_once; then
      echo "stack_supervisor: gateway exited (rc=$rc, uptime=${uptime}s); config invalid, waiting for valid config before restart" >&2
      if ! wait_for_valid_config 1; then
        exit 1
      fi
      start_gateway
      (sleep 5; maybe_open_mac_app) >/dev/null 2>&1 &
      continue
    fi

    echo "stack_supervisor: gateway exited (rc=$rc, uptime=${uptime}s, fast_crashes=${GATEWAY_CONSECUTIVE_FAST_CRASHES}); restarting in ${GATEWAY_RESTART_BACKOFF_SEC}s (qdrant stays running)" >&2
    sleep "$GATEWAY_RESTART_BACKOFF_SEC"
    start_gateway
    (sleep 5; maybe_open_mac_app) >/dev/null 2>&1 &
    continue
  fi

  sleep 2
done
