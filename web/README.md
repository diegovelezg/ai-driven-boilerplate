# Retain Engine — web

Dashboard merchant + sync multi-tenant de ecommerce (Medusa hoy, Shopify/Woo después) a Supabase. La vista de customers lee desde BD, no del ecommerce en vivo.

## Stack

- Next.js 16 (App Router) + React 19 + TailwindCSS 4 + shadcn/ui
- Supabase local (Postgres + PostgREST) vía CLI + Docker; misma migración corre en cloud
- Medusa v1/v2 en modo **solo lectura** (ver `lib/medusa.ts`)

## Quickstart

```bash
# 1. Stack local (una vez; deja API :54321 y Studio :54323)
npx supabase start        # desde la raíz del repo

# 2. Env (una vez)
# web/.env.local con SUPABASE_URL=http://127.0.0.1:54321,
# SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY (ver `npx supabase status`)

# 3. App
cd web
npm install
npm run dev               # :3000
```

## Conectar tienda y sincronizar

1. `/settings` → login admin de Medusa (**cada auth dispara un sync** a BD).
2. `/customers` → botón **Sincronizar** para re-sync manual, o:
   ```bash
   npx tsx --env-file=.env.local scripts/sync-once.ts
   ```

## Modelo de datos (Fase 1)

Migración fuente de verdad: `supabase/migrations/20261016000000_phase1_multitenant.sql`.

- `stores` = tenant (unique por `platform + shop_url`)
- `channels` (sales_channel/publication) y `market_regions` (region/market + moneda)
- `customers` con `source`: `ecommerce` (upsert en sync) o `local` (intacto, nunca borrado)
- `orders` con moneda **original** + FKs a channel/market + país crudo — nunca se suman monedas distintas

Detalle del diseño en `README.md` (raíz), secciones 2 y 5. Fase 2 (pendiente): `customer_market_stats` + cron RFM + vistas (`churn_risk_view`). Ya existe a nivel lectura: quintiles + ciclo esperado en ficha y set perfilador (`lib/profiling/`).

## SearXNG local (prospector + rescue de enriquecimiento)

```bash
# Una vez (desde la raíz del repo; settings versionado en infra/searxng/):
docker run -d --name searxng --restart unless-stopped -p 8888:8080 \
  -v $PWD/infra/searxng/settings.yml:/etc/searxng/settings.yml:ro \
  searxng/searxng:latest
# SEARXNG_URL=http://localhost:8888 (default en lib/prospect.ts; override en .env.local)
```

No montar desde `/tmp` (tmpfs en Arch: se pierde al reboot aunque el contenedor tenga `--restart`).

## Comandos

```bash
npm run dev     # desarrollo
npm run build && npm run start
npm run lint
npx supabase stop   # apaga el stack local (desde la raíz)
```
