#!/usr/bin/env bash
# Wrapper: carrega .env do dash antes de rodar o hook (Cursor não herda ~/.zshrc).
set -euo pipefail
DASH_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$DASH_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
exec node "$DASH_ROOT/hooks/cursor-hook.mjs"
