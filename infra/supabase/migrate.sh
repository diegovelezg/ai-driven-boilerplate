#!/usr/bin/env sh
# Aplica supabase/migrations/*.sql una sola vez cada una (tracking en public.schema_migrations).
# Lo corre el servicio `migrator` del compose en cada deploy; web espera a que termine OK.
set -eu

until pg_isready -h db -U postgres >/dev/null 2>&1; do sleep 2; done
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
