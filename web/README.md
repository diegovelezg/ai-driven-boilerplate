# MEOW — web

> **Fase 2 (2026-11-07):** gestión comercial DOOH. Motor de retención
> extirpado (`20261122000000_drop_retention_engine.sql`): sin morning
> pipeline, sin cron (worker no-op), chat en pausa (501) hasta el agente DOOH.

Dashboard merchant multi-tenant (inventario DOOH vía Sheet/CSV) a Supabase.
Las vistas leen desde BD.

## Stack

- Next.js 16 (App Router) + React 19 + TailwindCSS 4 + shadcn/ui
- Supabase local (Postgres + PostgREST) vía CLI + Docker; misma migración corre en cloud
  (93 migraciones en `supabase/migrations/` —incl. `20261208000000_currency_ssot.sql`—, 24 tablas vivas + vista `ai_llm_usage_daily`)
- Ingesta DOOH vía Sheet/CSV (`lib/sheet-import.ts` + `lib/dooh-import.ts`)
- ADK `@google/adk@^2.3.0` (pausado: chat 501 hasta el agente DOOH), modelos en
  `config/llm_models.json`
- Worker `worker.ts`: no-op intencional (sale 0 sin hacer nada); **sin cron**
  (`docs/coolify.md` §3b DESACTIVADO — esta es la fuente vigente; cualquier
  mención a cron `morning` en otro doc es histórica)

## Quickstart

```bash
# 1. Stack local (una vez; deja API :54321 y Studio :54323)
# La CLI de Supabase ya no va en package.json (146MB en cada build Docker):
# una vez por máquina `npm i -g supabase`, luego `supabase` directo.
# (Sin global, `npx -y supabase start` también vale.)
npx -y supabase start        # desde la raíz del repo

# 2. Env (una vez)
# web/.env.local con SUPABASE_URL=http://127.0.0.1:54321,
# SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY (ver `npx supabase status`)

# 3. App
cd web
npm install
npm run dev               # :3000
```

## Ingesta DOOH

- `/screens` → Importar desde Google Sheet URL o CSV (kinds: companies → contacts → venues → screens → slots).
- Prod: **sin cron**. `docs/coolify.md` §3b está DESACTIVADO (worker no-op).

## Modelo de datos (Fase 2 vigente)

Fuente de verdad: `supabase/migrations/*.sql` (92 archivos, 2026-10-16 → 2026-12-07).
24 tablas vivas + vista `ai_llm_usage_daily`:

- `sys_`: `sys_stores`, `sys_memberships`, `sys_store_profiles`,
  `sys_runs` (cinta de import/perfil), `io_counters`
- `io_`: `io_orders` (+`io_lines`), `io_agency_orders`, `io_creatives`,
  `io_photo_checks`, `io_play_logs`, `io_invoices`, `io_campaigns`
- `inv_`: `inv_venues`, `inv_screens`, `inv_screen_embeddings`,
  `inv_loop_templates`, `inv_slots`, `inv_bookings`
- `crm_`: `crm_companies`, `crm_contacts`
- `ai_`: `ai_domain_cache`, `ai_vertical_profiles`, `ai_llm_usage`

Sin `market_regions`; país/moneda del tenant en `sys_stores.shop_country` +
`sys_stores.shop_currency` (single-país).

> **Histórico (extirpado):** `customer_predictions`, `churn_signals`,
> `proposed_actions`, `proposed_leads`, `tenant_model_params`, `opt_outs`,
> `domains`/`enrichment_runs` (motor), ecommerce legacy
> (`customers/orders/channels/products/product_stats`), `brain_json`,
> `conversations/messages`, `import_runs`, `jobs`, `store_secrets`,
> `runMorningPipeline`, `claimRunSlot` programado. Ver `docs/architecture.md`
> § histórico.

Detalle del diseño en `docs/architecture.md` §§2,5.

## Pipeline morning — HISTÓRICO (no ejecutar)

> Extirpado 2026-11-07. `lib/morning-run.ts:runMorningPipeline` ya no existe;
> `worker.ts` es no-op; no hay `scout→strategist→copywriter→prospect`, ni
> `GEN retention:v3 / scout:v2 / copywriter:v16 / prospect:v7`. Se conserva el
> nombre como registro; no programar cron sobre esto.

## Páginas

- `/` Hoy (DOOH operativo).
- `/orders`: órdenes de inserción y flujo orden→cobro.
- `/finance`: KPIs + finanzas.
- `/screens`: inventario + importación Sheet/CSV.
- `/companies`, `/contacts`: base comercial.
- `/brands`: marcas.
- `/settings`, `/help`, `/login`.

## SearXNG local (histórico del prospector extirpado)

> El prospector (`prospect:v7`) se extirpó con el motor. SearXNG queda como
> infra opcional sin consumidor vigente; no es requisito del quickstart.

## Comandos

```bash
npm run dev     # desarrollo
npm run build && npm run start
npm run lint
npm run worker  # no-op Fase 2 (sale 0)
npx supabase stop   # apaga el stack local (desde la raíz)
```
