#!/usr/bin/env bash
# retain-apply.sh — migraciones a la BD de Coolify (plantilla Supabase one-click).
#
# La plantilla NO corre supabase/migrations/*.sql: este script las aplica por
# stdin contra el contenedor postgres (`docker exec -i -u postgres … psql`,
# peer-auth, sin password y sin copiar archivos al VPS).
#
# Uso (desde la raíz del repo):
#   DB_CONTAINER=supabase-db-<uuid> ./scripts/retain-apply.sh schema [VPS_IP=..] [SSHPASS=..]
#   DB_CONTAINER=supabase-db-<uuid> ./scripts/retain-apply.sh data <public-data.sql> [auth.sql]
#   DB_CONTAINER=supabase-db-<uuid> ./scripts/retain-apply.sh verify
#
# - schema: aplica las migraciones pendientes en orden + tracking en
#   public.schema_migrations (se crea si no existe). Idempotente: las ya
#   aplicadas se omiten, y un fallo hace rollback y se reintenta en la próxima
#   pasada (--single-transaction -v ON_ERROR_STOP=1).
# - status: solo lectura. Compara *.sql locales contra el tracking e imprime
#   las pendientes (exit 1 si hay). Usar en el checklist de release (§8) y
#   como gate antes de desplegar la web.
# - relations: solo lectura. Verifica que existan las tablas/columnas que el
#   código ya asume (products, item_content, metadata_map, brain_json...).
# - verify: comprueba conteos esperados (override con EXPECT_*).
# - data: dumps data-only (generados con pg_dump --exclude-table-data=
#   public.schema_migrations para no pisar el tracking). No toca el tracking.
# - verify: comprueba conteos esperados (override con EXPECT_*).
#
# Sin VPS_IP corre `docker` en local (útil directo en el VPS). Con VPS_IP hace
# ssh como root (SSHPASS opcional, vía sshpass -e).
set -euo pipefail

MODE="${1:-}"
: "${DB_CONTAINER:?DB_CONTAINER requerido (p.ej. supabase-db-<uuid>)}"
VPS_IP="${VPS_IP:-}"
SSHPASS="${SSHPASS:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
  exit 2
}

# psql en el contenedor. Sin args extra lee SQL por stdin; con -c ejecuta.
# OJO ssh: los args se re-ensamblan en un shell remoto, así que se citan
# con %q (sin esto, un `-c "SELECT count(*) ..."` rompe por los paréntesis).
db_exec() {
  if [ -n "$VPS_IP" ]; then
    local remote
    remote="$(printf '%q ' docker exec -i -u postgres "$DB_CONTAINER" psql "$@")"
    if [ -n "$SSHPASS" ] && command -v sshpass >/dev/null 2>&1; then
      export SSHPASS
      # shellcheck disable=SC2086
      sshpass -e ssh -o StrictHostKeyChecking=accept-new "root@$VPS_IP" "$remote"
    else
      # shellcheck disable=SC2086
      ssh -o StrictHostKeyChecking=accept-new "root@$VPS_IP" "$remote"
    fi
  else
    docker exec -i -u postgres "$DB_CONTAINER" psql "$@"
  fi
}

db_query() { db_exec -tA -c "$1"; }

# status: solo lectura. Compara supabase/migrations/*.sql (fuente de verdad
# local) contra public.schema_migrations del contenedor e imprime las
# pendientes. Pensado para el checklist de release y como gate de deploy:
# si imprime algo, la DB está detrás (ver docs/coolify.md §8).
cmd_status() {
  local applied
  applied="$(db_query "SELECT filename FROM public.schema_migrations;" 2>/dev/null)" || {
    echo "status: sin tracking (public.schema_migrations no existe o no legible)."
    echo "status: DB vacía o anterior al versionado → todo pendiente."
    exit 2
  }
  shopt -s nullglob
  local n_pending=0
  local f name
  for f in "$MIGRATIONS_DIR"/*.sql; do
    name="$(basename "$f")"
    if printf '%s\n' "$applied" | grep -qxF "$name"; then
      echo "ok    $name"
    else
      echo "PEND  $name"
      n_pending=$((n_pending + 1))
    fi
  done
  if [ "$n_pending" -eq 0 ]; then
    echo "status: al día."
  else
    echo "status: $n_pending pendiente(s) → correr: DB_CONTAINER=$DB_CONTAINER ./scripts/retain-apply.sh schema"
    exit 1
  fi
}

cmd_schema() {
  db_exec --single-transaction -v ON_ERROR_STOP=1 -c \
    "CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"
  shopt -s nullglob
  local f name applied n_applied=0 n_skipped=0
  for f in "$MIGRATIONS_DIR"/*.sql; do
    name="$(basename "$f")"
    applied="$(db_query "SELECT 1 FROM public.schema_migrations WHERE filename = '$name';")"
    if [ "$applied" = "1" ]; then
      echo "skip  $name (ya aplicada)"
      n_skipped=$((n_skipped + 1))
      continue
    fi
    echo "apply $name"
    # pgcrypto vive en `extensions`: search_path antepuesto (ver docs/coolify.md).
    { echo "SET search_path = public, extensions;"; cat "$f"; } \
      | db_exec --single-transaction -v ON_ERROR_STOP=1 -f -
    db_query "INSERT INTO public.schema_migrations (filename) VALUES ('$name');"
    n_applied=$((n_applied + 1))
  done
  echo "schema: $n_applied aplicadas, $n_skipped omitidas."
}

cmd_data() {
  [ $# -ge 1 ] || { echo "data requiere <public-data.sql> [auth.sql]" >&2; exit 2; }
  echo "apply data: $1 (public, sin tracking)"
  db_exec --single-transaction -v ON_ERROR_STOP=1 -f - <"$1"
  if [ $# -ge 2 ]; then
    echo "apply data: $2 (auth.users + auth.identities, sin sesiones)"
    db_exec --single-transaction -v ON_ERROR_STOP=1 -f - <"$2"
  fi
  echo "data: ok."
}

cmd_verify() {
  local fail=0
  check() { # check <sql> <esperado> <etiqueta>
    local got
    got="$(db_query "$1")"
    if [ "$got" = "$2" ]; then
      echo "ok    $3 = $got"
    else
      echo "FAIL  $3 = $got (esperado $2)"
      fail=1
    fi
  }
  check "SELECT count(*) FROM public.stores;"            "${EXPECT_STORES:-1}"            "stores"
  check "SELECT count(*) FROM public.customers;"         "${EXPECT_CUSTOMERS:-953}"       "customers"
  check "SELECT count(*) FROM public.orders;"            "${EXPECT_ORDERS:-699}"          "orders"
  check "SELECT count(*) FROM public.merchant_users;"    "${EXPECT_MERCHANT_USERS:-1}"    "merchant_users"
  check "SELECT count(*) FROM auth.users;"               "${EXPECT_AUTH_USERS:-1}"        "auth.users"
  check "SELECT count(*) FROM auth.identities;"          "${EXPECT_AUTH_IDENTITIES:-1}"   "auth.identities"
  [ "$fail" -eq 0 ] && echo "verify: ok." || { echo "verify: FAIL."; exit 1; }
}

# Requiere tablas/columnas que el código ya asume (fail-closed): si falta
# alguna, la app y el worker fallan con "Could not find the table..." en vez
# de degradar en silencio. Ver lib/schema-guard.ts (gate en runtime).
cmd_relations() {
  local fail=0
  rel() {
    local got
    got="$(db_query "SELECT to_regclass('public.$1');")"
    if [ "$got" = "$1" ]; then
      echo "ok    public.$1"
    else
      echo "FALTA public.$1"
      fail=1
    fi
  }
  rel products
  rel product_stats
  rel item_content
  rel customer_predictions
  rel background_runs
  for col in metadata_map brain_json; do
    local got
    got="$(db_query "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='store_profiles' AND column_name='$col';")"
    if [ "$got" = "$col" ]; then
      echo "ok    store_profiles.$col"
    else
      echo "FALTA store_profiles.$col"
      fail=1
    fi
  done
  [ "$fail" -eq 0 ] && echo "relations: ok." || { echo "relations: FAIL."; exit 1; }
}

case "$MODE" in
  schema) cmd_schema ;;
  status) cmd_status ;;
  relations) cmd_relations ;;
  data) shift; cmd_data "$@" ;;
  verify) cmd_verify ;;
  *) usage ;;
esac
