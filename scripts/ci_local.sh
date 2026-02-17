#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODE="${1:-fast}"
if [[ "$MODE" != "fast" && "$MODE" != "full" ]]; then
  echo "Usage: $0 [fast|full]" >&2
  exit 2
fi

echo "[ci:local] mode=$MODE"

echo "[1/6] lint"
pnpm lint

echo "[2/6] protocol check"
pnpm protocol:check

echo "[3/6] gateway/memory targeted tests"
pnpm test src/gateway/server-methods/dgx-access.test.ts src/gateway/server-methods/spark-voice.test.ts src/memory/manager.qdrant-failover.test.ts

echo "[4/6] ui tests"
pnpm ui:install
pnpm test:ui

echo "[5/6] build"
pnpm build

if [[ "$MODE" == "full" ]]; then
  echo "[6/6] full test suite"
  pnpm test
else
  echo "[6/6] full test suite skipped (use 'full' mode to include)"
fi

echo "[ci:local] complete"
