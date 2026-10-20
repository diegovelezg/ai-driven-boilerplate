# migrator — cliente psql + script y migraciones dentro de la imagen.
# Evita bind mounts; el contexto de build es la raíz del repo.
FROM postgres:17-alpine
COPY infra/supabase/migrate.sh /scripts/migrate.sh
COPY supabase/migrations /migrations
