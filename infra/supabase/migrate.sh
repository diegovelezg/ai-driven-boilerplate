#!/usr/bin/env sh
# Aplica supabase/migrations/*.sql una sola vez cada una (tracking en public.schema_migrations).
# Lo corre el servicio `migrator` del compose en cada deploy; web espera a que termine OK.
set -eu

until pg_isready -h db -U postgres >/dev/null 2>&1; do sleep 2; done
# Roles internos de supabase/postgres nacen SIN password si el volumen se
# inicializó sin roles.sql (deploys anteriores al fix). Sin esto, postgrest y
# gotrue mueren con "password authentication failed". Idempotente: en cada
# deploy asegura los passwords con el POSTGRES_PASSWORD vigente.
ESCAPED_PW=$(printf '%s' "$PGPASSWORD" | sed "s/'/''/g")
psql -v ON_ERROR_STOP=1 -tAc "SELECT rolname FROM pg_roles WHERE rolname IN ('authenticator','supabase_auth_admin','supabase_functions_admin','pgbouncer')" | while read -r r; do
  [ -n "$r" ] && psql -v ON_ERROR_STOP=1 -c "ALTER ROLE \"$r\" WITH PASSWORD '$ESCAPED_PW'"
done
# La imagen supabase/postgres pre-crea auth.uid()/role()/email() como
# superuser postgres en el init; GoTrue (supabase_auth_admin) muere con
# "must be owner of function" al intentar reemplazarlas. Se transfiere el
# ownership aquí (tolerante: si no existen aún, GoTrue las crea como suyas).
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
psql -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"
for f in $(ls /migrations/*.sql | sort); do
  name=$(basename "$f")
  done=$(psql -tAc "SELECT 1 FROM public.schema_migrations WHERE filename='$name'")
  if [ "$done" = "1" ]; then echo "skip $name"; continue; fi
  echo "== $name"
  psql -v ON_ERROR_STOP=1 -f "$f"
  psql -v ON_ERROR_STOP=1 -c "INSERT INTO public.schema_migrations (filename) VALUES ('$name')"
done
echo MIGRATIONS_OK
