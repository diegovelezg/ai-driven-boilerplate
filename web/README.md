# AI Retention Engine — web

Dashboard merchant + sync multi-tenant de ecommerce (Medusa hoy, Shopify/Woo stubs) a Supabase
+ loop de retención completo (scout → analyst). Las vistas leen desde BD, no del ecommerce en vivo.

## Stack

- Next.js 16 (App Router) + React 19 + TailwindCSS 4 + shadcn/ui
- Supabase local (Postgres + PostgREST) vía CLI + Docker; misma migración corre en cloud
  (54 migraciones en `supabase/migrations/`, ~28 tablas)
- Medusa v1/v2 en modo **solo lectura** (ver `lib/connectors/medusa.ts`, detalle en `lib/medusa.ts`)
- Conectores centralizados en `lib/connectors/` (ver `## Conectores ecommerce`)
- ADK `@google/adk@^2.3.0` (`LlmAgent` + 22 tools en `lib/adk/`), modelos en
  `config/llm_models.json` (primario + fallback, OpenAI/Anthropic/Gemini vía `RoutedLlm`)
- Worker `worker.ts` (one-shot prod + daemon dev), cron Coolify `sync,morning`

## Quickstart

```bash
# 1. Stack local (una vez; deja API :54321 y Studio :54323)
npx supabase start        # desde la raíz del repo

# 2. Env (una vez)
# web/.env.local con SUPABASE_URL=http://127.0.0.1:54321,
# SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY (ver `npx supabase status`)
# + SEARXNG_URL + DEEPSEEK/OPENAI/ANTHROPIC/GEMINI keys opcionales

# 3. App
cd web
npm install
npm run dev               # :3000

# 4. Worker local (otra terminal, con web/.env.local)
npm run worker -- --once --kinds=sync,morning
```

## Conectores ecommerce (Medusa real, Shopify/Woo stubs)

Punto centralizado `lib/connectors/`:

- `lib/connectors/types.ts` — interfaz `EcommerceConnector` + `ConnectorPlatform`
  (`medusa|shopify|woocommerce`).
- `lib/connectors/medusa.ts` — único conector real (adapta `lib/medusa.ts`: API v1/v2 + tipos
  canónicos `Canonical*`, `channelSource=medusa_sales_channel`,
  `marketSource=medusa_region`, `productSource=medusa_product`).
- `lib/connectors/index.ts:getConnector(platform)` — registro; `shopify`/`woocommerce`
  lanzan "sin backend" hasta implementarse (agregarlos = nuevo archivo + 1 línea).
- `lib/sync.ts:syncStoreFromPlatform()` — 6 fases (tienda+markets, fetch paralelo, channels,
  agregado real por moneda, upsert customers/orders/products + tombstones + `product_stats`);
  `syncStoreFromMedusa()` wrapper compat.
- `lib/sync-runner.ts:runSyncOnce(..., { platform })` — default `medusa`, reclama slot
  atómico por tienda (si el cron lo corre, el login lo omite).
- `lib/store.ts:Platform` — `medusa|shopify|woocommerce`; Shopify guarda preset pero no
  sincroniza (`shopify-sin-backend` en `lib/login-sync.ts`).

## Conectar tienda y sincronizar

1. `/settings` → login admin de Medusa (**cada auth dispara un sync** a BD).
2. `/customers` → botón **Sincronizar** para re-sync manual, o:
   ```bash
   npx tsx --env-file=.env.local scripts/sync-once.ts
   ```
3. Prod: el cron Coolify corre `sync` diario 11:00 UTC; el login solo corre `morning`
   (ver `docs/coolify.md` §3b).

## Modelo de datos (implementado, no solo Fase 1)

Fuente de verdad: `supabase/migrations/*.sql` (54 archivos, 2026-10-16 → 2026-11-01).
Tablas clave:

- Tenant/sync: `stores` (unique `platform+shop_url`), `channels`, `market_regions`,
  `customers` (`source` ecommerce/local), `orders` (moneda original + `channel/market/country`),
  `products`, `product_stats`, `item_content`, `metadata_map`.
- Motor/loop: `customer_predictions` (foto diaria `store,customer,as_of`,
  `model_version=retention:v3`), `churn_signals` (`open/prioritized/actioned/closed` +
  `objective`), `proposed_actions` (`pending_review/approved/dispatched` + `evidence_json`
  con `generator/decision/p_recompra_h`), `background_runs` (cinta + scopes), `opt_outs`,
  `tenant_model_params`, `store_profiles` (`brain_json`), `vertical_profiles`.
- Prospect/enrich: `proposed_leads`, `domains`, `enrichment_runs`, `customer_aliases`.
- Chat/auth/ops: `conversations`, `messages`, `merchant_users`, `store_secrets`,
  `llm_usage`, `jobs` (artefacto) + `start_run_if_free` (slot atómico).

Detalle del diseño en `docs/architecture.md` §§2,5.

## Pipeline morning (código)

`lib/morning-run.ts:runMorningPipeline` (tras `sync`):

1. `enrichment` — pendientes de dominios, cada login si hay.
2. `brain` — `computeTenantBrain` si no fresco <24h (`top activos, ventana mediana,
   ticket p50/p80, voz cliente`).
3. `regenerate` — `runStaleRefresh(limit 10)`: pendientes con sello viejo → fresco.
   Nunca toca `approved/dispatched`.
4. `foto` — solo si `opts.refreshFoto` (sync trajo órdenes nuevas): `runRetentionModel`.
5. Gate `morningAlreadyDone` (scout+strategist+copywriter+prospect done hoy → stop).
6. `scout` → `strategist` → `copywriter(limit 10)` → `prospect` (B2B-only, tope 10 pendientes).

Versiones GEN vigentes: `retention:v3:episodes-mixture`, `scout:v2:retention`,
`strategist:v2:retention`, `copywriter:v16:identidad-estructural`,
`contactability:v5:sin-continuidad`, `prospect:v6:market-scores`,
`decision v4:nodormido-exception`.

## Páginas

- `/` Hoy: actuar/vigilar, embudo, por revisar, recuperado, feed enviados. Filtro `?market=`.
- `/customers`: cartera + `customer_predictions`, drawer, chat ADK, duplicados, sync.
- `/review`: inbox actions/leads/signals (approve/reject, wa.me, cambio canal).
- `/finanzas`: KPIs 12m + en juego probabilístico.
- `/products`: catálogo + `product_stats` por market/moneda.
- `/settings`: tienda (login Medusa + `store_secrets`) / negocio (perfil, arquetipo,
  recalibración) / motor (ciclo, H, bandas) / email.
- `/ayuda`, `/login`.

## SearXNG local (prospector + rescue de enriquecimiento)

```bash
# Una vez (desde la raíz del repo; settings versionado en infra/searxng/):
docker run -d --name searxng --restart unless-stopped -p 8888:8080 \
  -v $PWD/infra/searxng/settings.yml:/etc/searxng/settings.yml:ro \
  searxng/searxng:latest
# SEARXNG_URL=http://localhost:8888 (default en lib/prospect.ts; override en .env.local)
```

Prod: service SearXNG en Coolify, `SEARXNG_URL=https://<id>.papelitosdecolor.com`
(+ `SEARXNG_BASIC_AUTH` si compartido). No montar desde `/tmp` (tmpfs en Arch: se pierde
al reboot aunque el contenedor tenga `--restart`).

## Comandos

```bash
npm run dev     # desarrollo
npm run build && npm run start
npm run lint
npm run worker -- --once --kinds=sync,morning  # pipeline sin login
npx supabase stop   # apaga el stack local (desde la raíz)
```
