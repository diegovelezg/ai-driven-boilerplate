# MEOW — web

Dashboard merchant multi-tenant (inventario DOOH vía Sheet/CSV) a Supabase
+ loop de retención completo (scout → analyst). Las vistas leen desde BD.

## Stack

- Next.js 16 (App Router) + React 19 + TailwindCSS 4 + shadcn/ui
- Supabase local (Postgres + PostgREST) vía CLI + Docker; misma migración corre en cloud
  (56 migraciones en `supabase/migrations/`, ~28 tablas)
- Ingesta DOOH vía Sheet/CSV (`lib/sheet-import.ts` + `lib/dooh-import.ts`)
- ADK `@google/adk@^2.3.0` (`LlmAgent` + 22 tools en `lib/adk/`), modelos en
  `config/llm_models.json` (primario + fallback, OpenAI/Anthropic/Gemini vía `RoutedLlm`)
- Worker `worker.ts` (one-shot prod + daemon dev), cron Coolify `morning`

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
# + SEARXNG_URL + DEEPSEEK/OPENAI/ANTHROPIC/GEMINI keys opcionales

# 3. App
cd web
npm install
npm run dev               # :3000

# 4. Worker local (otra terminal, con web/.env.local)
npm run worker -- --once --kinds=morning
```

## Ingesta DOOH

- `/inventario` → Importar desde Google Sheet URL o CSV (kinds: companies → contacts → venues → screens → slots).
- Prod: el cron Coolify corre `morning` diario 11:00 UTC (ver `docs/coolify.md` §3b).

## Modelo de datos (implementado, no solo Fase 1)

Fuente de verdad: `supabase/migrations/*.sql` (56 archivos, 2026-10-16 → 2026-11-01).
Tablas clave:

- Tenant: `stores`, `companies`, `contacts`, `venues`, `screens`, `inventory_slots`,
  `customers` (legacy), `orders` (legacy), `products` (legacy), `product_stats`, `metadata_map`.
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

`lib/morning-run.ts:runMorningPipeline`:

1. `enrichment` — pendientes de dominios, cada login si hay.
2. `brain` — `computeTenantBrain` si no fresco <24h (`top activos, ventana mediana,
   ticket p50/p80, voz cliente`).
3. `regenerate` — `runStaleRefresh(limit 10)`: pendientes con sello viejo → fresco.
   Nunca toca `approved/dispatched`.
4. `foto` — solo si `opts.refreshFoto`: `runRetentionModel`.
5. Gate `morningAlreadyDone` (scout+strategist+copywriter+prospect done hoy → stop).
6. `scout` → `strategist` → `copywriter(limit 10)` → `prospect` (B2B-only, tope 10 pendientes).

Versiones GEN vigentes: `retention:v3:episodes-mixture`, `scout:v2:retention`,
`strategist:v2:retention`, `copywriter:v16:identidad-estructural`,
`contactability:v5:sin-continuidad`, `prospect:v7:single-country`,
`decision v4:nodormido-exception`.

## Páginas

- `/` Hoy: actuar/vigilar, embudo, por revisar, recuperado, feed enviados.
- `/customers`: cartera + `customer_predictions`, drawer, chat ADK, duplicados.
- `/review`: inbox actions/leads/signals (approve/reject, wa.me, cambio canal).
- `/finanzas`: KPIs 12m + en juego probabilístico.
- `/products`: catálogo + `product_stats` por moneda.
- `/settings`: negocio (perfil, arquetipo,
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
npm run worker -- --once --kinds=morning  # pipeline sin login
npx supabase stop   # apaga el stack local (desde la raíz)
```
