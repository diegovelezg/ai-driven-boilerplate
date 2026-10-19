#!/usr/bin/env bash
# Migra los DATOS del Supabase local (CLI) al Postgres de Coolify.
# El esquema lo crea el servicio `migrator` del compose; esto solo mueve datos.
# Uso:
#   ./infra/supabase/migrate-data.sh '<TARGET_URL>'
#   ./infra/supabase/migrate-data.sh '<SOURCE_URL>' '<TARGET_URL>'
# SOURCE por defecto: postgresql://postgres:postgres@127.0.0.1:54322/postgres
# TARGET: la connection string del Postgres de Coolify (psql directo o vía túnel).
set -euo pipefail

SOURCE="${1:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
TARGET="${2:-${1:-}}"
if [ $# -eq 1 ]; then
  TARGET="$1"
  SOURCE="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
fi
if [ -z "${TARGET:-}" ]; then
  echo "Uso: $0 '<TARGET_URL>' [o: $0 '<SOURCE_URL>' '<TARGET_URL>']" >&2
  exit 1
fi
command -v pg_dump >/dev/null || { echo "falta pg_dump (apt: postgresql-client)" >&2; exit 1; }
command -v psql >/dev/null || { echo "falta psql (apt: postgresql-client)" >&2; exit 1; }

# El target debe tener el esquema ya creado por `migrator` (deploy previo en Coolify).
if ! psql "$TARGET" -tAc "SELECT 1 FROM public.schema_migrations LIMIT 1" >/dev/null 2>&1; then
  echo "ERROR: el target no tiene esquema (public.schema_migrations no existe)." >&2
  echo "Haz el primer deploy en Coolify antes de migrar datos." >&2
  exit 1
fi

TMP="$(mktemp /tmp/opencode/retain-datos-XXXXXX.sql 2>/dev/null || mktemp /tmp/retain-datos-XXXXXX.sql)"
trap 'rm -f "$TMP"' EXIT

echo "== dump (solo datos, esquema public, sin tracking de migraciones)"
pg_dump "$SOURCE" \
  --data-only \
  --schema=public \
  --exclude-table-data=public.schema_migrations \
  -f "$TMP"
echo "   $(wc -c <"$TMP") bytes -> $TMP"

echo "== restore a target"
psql "$TARGET" -v ON_ERROR_STOP=1 -f "$TMP" >/dev/null
echo "   OK"

echo "== conteos (source vs target)"
for t in stores customers orders merchant_users; do
  s=$(psql "$SOURCE" -tAc "SELECT count(*) FROM public.$t")
  d=$(psql "$TARGET" -tAc "SELECT count(*) FROM public.$t")
  mark="OK"; [ "$s" = "$d" ] || mark="DIFIERE";
  printf "   %-14s source=%s target=%s %s\n" "$t" "$s" "$d" "$mark"
done
echo "== listo. Siguiente: recrea tu usuario login en Studio de Coolify y linkéalo (docs/coolify.md §6)."
