#!/usr/bin/env bash
set -euo pipefail

# Sourceable keychain env loader for OpenClaw.
# Loads secrets into env without starting the gateway.
#
# Usage (source):
#   source scripts/keychain_env.sh
#
# Controls:
#   OPENCLAW_KEYCHAIN_SERVICE   (default: openclaw)
#   OPENCLAW_KEYCHAIN_REQUIRED  (space/comma-separated env var names)
#   OPENCLAW_KEYCHAIN_OPTIONAL  (space/comma-separated env var names)

KEYCHAIN_SERVICE="${OPENCLAW_KEYCHAIN_SERVICE:-openclaw}"

normalize_list() {
  local raw="${1:-}"
  echo "${raw//,/ }"
}

required_list="${OPENCLAW_KEYCHAIN_REQUIRED:-OPENCLAW_GATEWAY_TOKEN}"
# OPENCLAW_KEYCHAIN_OPTIONAL: defaults to a curated list of service keys; override or extend when adding integrations
optional_list="${OPENCLAW_KEYCHAIN_OPTIONAL:-ELEVENLABS_API_KEY XI_API_KEY BRAVE_API_KEY MOTION_API_KEY BEEPER_API_KEY STRIPE_API_KEY GITHUB_PAT GITHUB_PAT_AII OLLAMA_API_KEY NVIDIA_API_KEY DGX_WAN_TOKEN HF_TOKEN OPENAI_API_KEY}"

get_secret() {
  local name="$1"
  /usr/bin/security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$name" -w 2>/dev/null
}

load_secret() {
  local name="$1"
  local val=""
  if val="$(get_secret "$name")" && [[ -n "${val}" ]]; then
    export "$name"="$val"
    return 0
  fi
  return 1
}

missing_required=0
for name in $(normalize_list "$required_list"); do
  if [[ -z "$name" ]]; then
    continue
  fi
  # If already set (e.g. from config/secrets.env or shell), skip Keychain
  if [[ -n "${!name:-}" ]]; then
    continue
  fi
  if ! load_secret "$name"; then
    echo "[keychain_env] Missing Keychain secret: service=${KEYCHAIN_SERVICE} account=${name}" >&2
    missing_required=1
  fi
done

for name in $(normalize_list "$optional_list"); do
  if [[ -z "$name" ]]; then
    continue
  fi
  # Preserve explicit runtime overrides from caller env.
  if [[ -n "${!name:-}" ]]; then
    continue
  fi
  load_secret "$name" || true
done

if [[ "$missing_required" -ne 0 ]]; then
  if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
    return 1
  fi
  exit 1
fi
