# Coolify — backup reproducible (2026-10-20)

Fuente: Service Supabase one-click de Coolify (export manual desde el panel).
Este archivo es BACKUP, no se usa directo en prod. Prod usa servicios
independientes slim (ver `supabase.slim.compose.yml`).

## Reconstruir

1. Coolify → New Project `retention-ai-engine` → New → Service → `Supabase`
   con este compose como base, o `docker compose -f supabase.slim.compose.yml up -d`
   en VPS con Docker.
2. Rellenar env desde vault (ver `supabase.env.example`). Nunca commitear valores.
3. Aplicar esquema: `DB_CONTAINER=supabase-db-<id> ./scripts/db-apply.sh schema`
   luego `data` y `verify` (ver `docs/coolify.md` paso 4).
4. Alta web + SearXNG como Applications/Services independientes (ver `docs/coolify.md`).

## Slim vs full

* Full (`supabase.compose.backup.yml`): 15 servicios tal cual Coolify.
* Slim (`supabase.slim.compose.yml`): solo `db,kong,rest,auth,supavisor(+studio/meta solo dev)`.
  Ahorro ~1GB RAM en piloto. La web solo usa Postgres+PostgREST+Auth.

## Reglas

* Pinear imágenes (no `latest`). Ver `versions.lock`.
* Secretos solo en Coolify Environment + vault externo.
* Todo cambio al compose pasa por PR a esta carpeta.
