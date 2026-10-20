#!/usr/bin/env sh
# Aplica supabase/migrations/*.sql una sola vez cada una (tracking en public.schema_migrations).
# Lo corre el servicio `migrator` del compose en cada deploy; web/auth/rest esperan a que termine OK.
# Logging con timestamps: los logs del contenedor son el diagnóstico en Coolify.
set -eu

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

log "migrator inicio host=$PGHOST db=$PGDATABASE user=$PGUSER"

export PGCONNECT_TIMEOUT=10
# Espera a db con LÍMITE: si el nombre no resuelve (red de Coolify), fallar
# rápido con evidencia en vez de girar infinito y clavar el deploy.
tries=0
until pg_isready -h db -U postgres -t 5 >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ $((tries % 10)) -eq 0 ]; then
    log "esperando db... intento $tries"
  fi
  if [ "$tries" -ge 60 ]; then
    log "ERROR: db inaccesible tras 120s"
    getent hosts db || log "(db no resuelve por DNS)"
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
psql -v ON_ERROR_STOP=1 <<'SQL'
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
psql -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"
applied=0
skipped=0
for f in $(ls /migrations/*.sql | sort); do
  name=$(basename "$f")
  done=$(psql -tAc "SELECT 1 FROM public.schema_migrations WHERE filename='$name'")
  if [ "$done" = "1" ]; then skipped=$((skipped + 1)); continue; fi
  log "== $name"
  psql -v ON_ERROR_STOP=1 -f "$f" || exit 1
  psql -v ON_ERROR_STOP=1 -c "INSERT INTO public.schema_migrations (filename) VALUES ('$name')"
  applied=$((applied + 1))
done
log "MIGRATIONS_OK aplicadas=$applied saltadas=$skipped"
