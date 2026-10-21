#!/usr/bin/env bash
# Gate post-build: el símbolo que reventó el SSR standalone no debe existir
# bundleado (2026-10-21: _getStorageClientFactories → reading 'bind' solo
# en prod; en dev/worker no hay bundle y nunca se veía).
# Uso: npm run build && npm run check:bundle
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ ! -d .next/server ]; then
  echo "check:bundle: no hay .next/server (corre 'npm run build' primero)." >&2
  exit 2
fi
if grep -rq "getStorageClientFactories" .next/server/ 2>/dev/null; then
  echo "check:bundle FAIL: Crawlee bundleado en el SSR (revisa serverExternalPackages en next.config.ts):"
  grep -rl "getStorageClientFactories" .next/server/ | head -5
  exit 1
fi
echo "check:bundle ok: sin símbolos de Crawlee en .next/server."
