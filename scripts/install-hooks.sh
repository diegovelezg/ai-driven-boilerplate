#!/usr/bin/env bash
# install-hooks.sh — una vez por clon: activa los hooks versionados.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ln -sf "$ROOT/scripts/hooks/pre-push" "$ROOT/.git/hooks/pre-push"
echo "hooks instalados: pre-push (migraciones al VPS antes del push)."
