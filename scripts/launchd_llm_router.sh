#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$HOME/.openclaw/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting NVIDIA LLM Router (launchd)"

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

# Source workspace contract if it exists (override via OPENCLAW_CONTRACT)
CONTRACT="${OPENCLAW_CONTRACT:-$ROOT_DIR/config/workspace.env}"
if [[ -f "$CONTRACT" ]]; then
  # shellcheck disable=SC1090
  source "$CONTRACT"
fi

ROUTER_DIR="${ROOT_DIR}/codebase/nvidia-llm-router"
VENV="${ROUTER_DIR}/.venv"

if [[ ! -x "${VENV}/bin/nat" ]]; then
  echo "ERROR: NVIDIA LLM Router venv missing. Run setup before starting." >&2
  exit 1
fi

CONFIG_PATH="${ROUTER_DIR}/src/nat_sfc_router/configs/openclaw.yml"
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "ERROR: Router config not found: $CONFIG_PATH" >&2
  exit 1
fi

export PATH="${VENV}/bin:${PATH}"
export PYTHONPATH="${ROUTER_DIR}/src"

export ROUTER_MODEL_URL="${OPENCLAW_LLM_ROUTER_MODEL_URL:-http://127.0.0.1:11434}"
export ROUTER_MODEL_NAME="${OPENCLAW_LLM_ROUTER_MODEL_NAME:-Qwen/Qwen3-1.7B-GGUF}"
export ROUTER_TOKENIZER_NAME="${OPENCLAW_LLM_ROUTER_TOKENIZER_NAME:-$ROUTER_MODEL_NAME}"
export ROUTER_MODEL_HEALTH_URL="${OPENCLAW_LLM_ROUTER_MODEL_HEALTH_URL:-http://127.0.0.1:11434/api/tags}"
export HF_HOME="${OPENCLAW_LLM_ROUTER_HF_HOME:-$HOME/.cache/huggingface}"
export ROUTER_SKIP_NETCHECK="${ROUTER_SKIP_NETCHECK:-1}"

HOST="${OPENCLAW_LLM_ROUTER_HOST:-127.0.0.1}"
PORT="${OPENCLAW_LLM_ROUTER_PORT:-8001}"

exec "${VENV}/bin/nat" serve --config_file "$CONFIG_PATH" --host "$HOST" --port "$PORT"
