#!/usr/bin/env sh
# Aplica supabase/migrations/*.sql una sola vez cada una (tracking en public.schema_migrations).
# Lo corre el servicio `migrator` del compose en cada deploy; web/auth/rest esperan a que termine OK.
# Logging con timestamps: los logs del contenedor son el diagnóstico en Coolify.
#
# REGLA: este script NUNCA debe colgarse. Si algo va mal (db inaccesible,
# lock de otra sesión, sentencia eterna) sale con código != 0 en un tiempo
# acotado y deja el diagnóstico en los logs. Un deploy colgado es peor que
# un deploy fallido.
set -eu

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

# Tope duro por invocación de psql: cubre cuelgues que no son SQL (DNS,
# password prompt, socket trabado). lock/statement_timeout cubren lo demás.
PSQL_TIMEOUT=600
psql_safe() {
  timeout -k 5 "$PSQL_TIMEOUT" psql "$@"
}

# lock_timeout: si otra sesión tiene la tabla bloqueada, fallar en 30s en
#   vez de esperar para siempre (era la causa del deploy pegado en
#   "migrator ... Waiting").
# statement_timeout: ninguna sentencia debe tardar >5 min en este esquema.
# idle_in_transaction_session_timeout: no dejar transacciones abiertas.
PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c lock_timeout=30000 -c statement_timeout=300000 -c idle_in_transaction_session_timeout=60000"
export PGOPTIONS
export PGCONNECT_TIMEOUT=10
export PGAPPNAME=migrator

dump_waiters() {
  # En un fallo, mostrar quién estaba bloqueando (wait_event ~ 'lock').
  psql_safe -X -tA -c "
    SELECT pid, state, coalesce(wait_event_type,'') || '/' || coalesce(wait_event,''),
           coalesce(now() - xact_start, now() - query_start)::text,
           left(regexp_replace(query, '\s+', ' ', 'g'), 160)
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
     ORDER BY xact_start NULLS LAST;" 2>/dev/null || true
}

on_exit() {
  code=$?
  if [ "$code" -ne 0 ]; then
    log "ERROR: migraciones abortadas (exit $code)"
    log "sesiones en la DB (columna 3 = wait_event; 'lock' indica bloqueo):"
    dump_waiters
  fi
}
trap on_exit EXIT

log "migrator inicio host=$PGHOST db=$PGDATABASE user=$PGUSER"

# Espera a db con LÍMITE de reloj: si el nombre no resuelve (red de Coolify),
# fallar rápido con evidencia en vez de girar infinito y clavar el deploy.
tries=0
deadline=$(( $(date +%s) + 180 ))
until pg_isready -h "$PGHOST" -U "$PGUSER" -t 5 >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ $((tries % 10)) -eq 0 ]; then
    log "esperando db... intento $tries"
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "ERROR: db inaccesible tras 180s"
    getent hosts "$PGHOST" || log "($PGHOST no resuelve por DNS)"
    exit 1
  fi
  sleep 2
done
log "db ok tras $tries intentos"

# La imagen supabase/postgres pre-crea auth.uid()/role()/email() como
# superuser postgres en el init; GoTrue (supabase_auth_admin) muere con
# "must be owner of function" al intentar reemplazarlas. Se transfiere el
# ownership aquí (tolerante: si no existen aún, GoTrue las crea como suyas).
log "reparando ownership auth.uid/role/email"
psql_safe -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'auth.uid owner: %', SQLERRM;
END $$;
DO $$
BEGIN
  ALTER FUNCTION auth.role() OWNER TO supabase_auth_admin;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'auth.role owner: %', SQLERRM;
END $$;
DO $$
BEGIN
  ALTER FUNCTION auth.email() OWNER TO supabase_auth_admin;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'auth.email owner: %', SQLERRM;
END $$;
SQL
log "ownership ok"

psql_safe -X -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"

applied=0
skipped=0
for f in $(ls /migrations/*.sql | sort); do
  name=$(basename "$f")
  done=$(psql_safe -X -tAc "SELECT 1 FROM public.schema_migrations WHERE filename='$name'")
  if [ "$done" = "1" ]; then skipped=$((skipped + 1)); continue; fi
  log "== $name"
  # --single-transaction: migración + tracking son atómicos. Si algo falla,
  # rollback completo y el próximo deploy la reintenta desde cero (nada de
  # esquema a medias con "column already exists").
  if ! psql_safe -X -v ON_ERROR_STOP=1 --single-transaction \
       -f "$f" \
       -c "INSERT INTO public.schema_migrations (filename) VALUES ('$name')"; then
    log "ERROR: falló $name (rollback completo)"
    exit 1
  fi
  log "ok $name"
  applied=$((applied + 1))
done
log "MIGRATIONS_OK aplicadas=$applied saltadas=$skipped"
