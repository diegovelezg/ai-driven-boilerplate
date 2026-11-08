# MEOW — Blueprint de arquitectura (Fase 2 DOOH)

> **Fase 2 (2026-11-07):** se extirpó el motor de retención
> (`retention-model/scout/strategist/copywriter/prospect/dispatcher/analyst/mira`,
> `customer_predictions/churn_signals/proposed_actions/proposed_leads`,
> ecommerce legacy `customers/orders/channels/products`). Migración
> `20261122000000_drop_retention_engine.sql`. Sin morning pipeline (worker no-op,
> cron desactivado), chat en pausa (501) hasta el agente DOOH. Lo que sigue
> describe el sistema DOOH vigente + historia del motor extirpado.

> **Estado:** documento vivo, refleja `main` a 2026-10-22. Ya no es visión: el loop
> scout→strategist→copywriter→dispatcher→analyst corre en prod vía worker + cron Coolify,
> con motor probabilístico `retention:v3:episodes-mixture` y 56 migraciones aplicadas.
> Ver `README.md` raíz para posicionamiento y `web/README.md` para operación diaria.

## 1. High-Level Architecture Diagram (real)

```
+-------------------------------------------------------------------------+
|                          INGESTION LAYER (MODULAR)                      |
|  +--------------------+   +--------------------+   +---------------+    |
|  | Sheet/CSV DOOH     |   | Sheet URL          |   | CSV              |    |
|  | companies/contacts |   | venues/screens     |   | slots            |    |
+--+---------+----------+---+---------+----------+---+-------+-------+--+
             |                        |                        |
             +------------------------+------------------------+
                                      |
                                      v
+-------------------------------------------------------------------------+
|              MORNING PIPELINE (web/worker.ts, sin cola)                    |
|  enrichment → brain → regenerate(stale) → [foto si cambió]              |
|   → scout → strategist → copywriter(10) → prospect(B2B-only)            |
|  background_runs = cinta por paso (claimRunSlot, best-effort)           |
+--------------------------------+----------------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------------+
|              CORE MATEMÁTICO: RETENTION v3 + MIRA + CALIBRACIÓN         |
|  retention-model: LogNormal bayesiano + censura, A renovación / B 2ª    |
|  compra, sessionize<1d → episodeize(tenant) → mezcla K ritmos EM+BIC    |
|  decide v4 → customer_predictions (foto diaria) → scout abre señales    |
|  mira ordena por valor_esperado/score → strategist objetiva             |
|  tune 30d: tenant_model_params (WFO, trust-region, fail-open legacy)    |
+--------------------------------+----------------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------------+
|                   AI AGENT & DECISION GENERATOR                         |
|  TenantBrain diario (store_profiles.brain_json, 1 query/corrida)        |
|  Copywriter v16 + Juez contactabilidad v5 (veto 24h auditado, skip,     |
|  no resucita usos únicos) → proposed_actions PENDING_REVIEW             |
|  Prospect v6 (ICP manual/auto + SearXNG + pool similar + gate contacto) |
|  LLM: RoutedLlm primario→fallback (OpenAI/Anthropic/Gemini),            |
|  metering en llm_usage por store/proceso/modelo                         |
+--------------------------------+----------------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------------+
|                   ACTION REVIEW & DISPATCH ENGINE                       |
|  Review inbox (actions/leads/signals) — HITL obligatorio                |
|  Dispatcher: sello fresco + gate pre-send (opt-out, recompra, juez)     |
|   → email SendGrid REAL; WhatsApp RETENIDO sin proveedor (issue #4)     |
|  Analyst: 1 orden=1 atribución → revenue_attributed → cierra señal      |
|  Chat ADK (22 tools, envelope) + Next.js 16 dashboard                   |
+-------------------------------------------------------------------------+
```

## 2. Ingestion Module: DOOH vía Sheet/CSV

> Implementado en `web/lib/sheet-import.ts` + `web/lib/dooh-import.ts`.
> `web/worker.ts` corre solo `morning` por tienda.

Ingesta: companies → contacts → venues → screens → slots (upsert por external_ref).

Single-país: cada tenant tiene UN solo país/región/moneda
(`stores.shop_country` + `stores.shop_currency`). Sin `market_regions`,
sin `market_id`, sin `?market=`. País canónico de la orden: ISO2 directo,
si no el `shop_country` del tenant.

## 3. Data Classification & Enrichment Pipeline (implementado)

- **B2B-only**: `customers.customer_type` siempre `B2B` (CHECK `customers_customer_type_b2b`,
  `20261107000000_b2b_only.sql`); `classify` normaliza legacy a B2B; `store_profiles`
  (`business_model=b2b`, arquetipos `b2b_recurrente/b2b_proyecto`, `company_required=true`);
  prospector sin gate (solo exige base enriquecible); UI y ADK hablan de empresas.
- **Enriquecimiento**: `domains` + `enrichment_runs`, `pendingDomains` → `runEnrichment`
  (SearXNG rescue + scrape), industria/escala a `CustomerFirmographic`-like en `domains`;
  brief sectorial cacheado; `vertical_profiles`.
- **Perfilador tenant** (`web/lib/profiling/` + `store_profiles`): investigator/sector/
  synthesizer/critic aislados, taxonomía estándar, arquetipo
  (`ARCHETYPE_RULE_VERSION=v1:…`), vigilante mensual + recalibración HITL (#6),
  `brain_json` mínimo diario (#25 Hito 1).

## 4. Core Mathematical Engines (implementado, no RFM)

RFM por quintiles quedó como lectura legacy en ficha; el motor vigente es probabilístico.

### Retention v3 `retention:v3:episodes-mixture` (`web/lib/retention-model.ts`, `web/lib/retention.ts`)

- `sessionize()`: órdenes <1d = 1 intención de pago (no 1 compra).
- `episodeize()`: ventana `episodeGapDays` aprendida por tenant (issue #27, ya en `main`).
- Grilla bayesiana LogNormal + censura; Modelo A `renovacion` (F≥2) / B `segunda_compra` (F=1).
- Mezcla K ritmos EM+BIC (`mix1:lognormal-em`, K≤4, pertenencia blanda, censura).
- `decideFromAxes()` `v4:nodormido-exception`: `elegibilidad > dormido > actuar/vigilar`
  (+ `revision_humana` → `vip_care` en scout).
- Salida: upsert `customer_predictions` (`store,customer,as_of` día,
  `p_recompra_h, decision, ticket, valor_esperado, bandas, decil`).
- Calibración: `tenant_model_params` (WFO 3 orígenes, horizonte 3×H≤180d, Brier+logLoss,
  margen 2·SE, trust-region Δμ≤0.5/Δσ≤0.2), `band-calibrate` + `close-watch-calibrate`
  cada 30d; lector fail-open a legacy.

### Scout `scout:v2:retention` (`web/lib/scout.ts`)

Solo `actuar|revision_humana` abren señal (`vip_care` si revision_humana);
`score=p_recompra_h`; reason `sin comprar hace {t}d (ciclo ~{c}d, p25–p75)` parseable;
dedup 1 cliente=1 viva; `prioritized` no se pisa; `actioned` sin borrador se reabre.

### Mira (SSOT lectura, `web/lib/mira.ts:getRankedMira`)

Join `signals(open|prioritized)` + customers + última acción + última predicción.
Orden `valor_esperado desc → score → p`; separa `rows` (moneda tienda) / `foreign`.
Veto juez TTL 24h. Consumida por strategist/copywriter/Hoy/Review.

### Strategist `strategist:v2:retention` (`web/lib/strategist.ts`)

`objective()`: `≥3 órdenes + ≥p80 + top-activo → vip_care`; `segunda_compra|≤1 → winback`;
resto `nurture`. p80 intra-moneda; `evidence_json` preserva scout.

### Copywriter `copywriter:v16:identidad-estructural` + Juez `contactability:v5` (`web/lib/copywriter.ts`, `contactability.ts`, `judge-brief.ts`)

Por `prioritized` top-mira sin `busySignal/busyCustomer`: historial 5 órdenes +
`item-context/metadata-map`, juez (veto=skip auditado), brief `continuidad|identidad`,
`proposer_draft` primario→fallback, controles (banned-phrases, ancla identidad,
wa≤450/body≤800, email 400–750). Inserta `pending_review` + señal→`actioned`. Nunca envía.
`runStaleRefresh(limit 10)`: re-redacta stale a GEN vigente (#26 implementado).

### Prospect `prospect:v7:single-country` (`web/lib/prospect.ts`)

Gate B2B-only; ICP manual o auto (top-20 + brain + feedback); queries LLM →
SearXNG → scrape → score vs ICP + pool similar + retrieval top-3 + gate contacto +
`SCORE_MIN=0.5` + tope 2/industria → dedupe → `proposed_leads pending_review`.

### Dispatcher + Analyst (`web/lib/dispatcher.ts`, `analyst.ts`, `pre-send.ts`)

Dispatcher: sello fresco (`generator==COPYWRITER_GEN`), 1/cliente/corrida,
`checkPreSendGate` (opt-out, recompra, duplicado, dismissed, no-enviable → `skipped/held`);
email SendGrid real; WhatsApp retenido; stub marca dispatched sin proveedor.
Analyst: sesioniza post-envío (moneda tienda), 1 sesión→1ª acción vigente, escribe
`revenue_attributed` solo con conversión o ventana cerrada, cierra señal;
`attributionBySlice()` 90d por canal/objetivo/decisión.

## 5. Database Schema (PostgreSQL, Supabase — fuente real)

> Fuente de verdad: `supabase/migrations/*.sql`. El modelo Prisma de abajo
> es ilustrativo; el DDL real es SQL directo. Pivote DOOH 20261122 + higiene
> 20261124: se extirpó el motor ecommerce/retención. Nomenclatura con prefijo
> por dominio (20261125): `sys_` sistema/tenant, `io_` flujo orden→cobro,
> `inv_` inventario, `crm_` base comercial, `ai_` IA/metering.

Tablas (25):
- `sys_`: `sys_stores, sys_memberships (rol owner|admin|seller|viewer),
  sys_store_profiles, sys_secrets, sys_secret_audits, sys_runs, io_counters`
- `io_`: `io_orders (+io_lines por pantalla/slot/periodo/tarifa),
  io_agency_orders (OM/OC), io_creatives (QC+legal), io_photo_checks,
  io_play_logs (PoP CMS, scaffold), io_invoices (A/R), io_campaigns`
- `inv_`: `inv_venues, inv_screens, inv_loop_templates, inv_slots, inv_bookings`
  (hard hold con anti-sobreventa `io_check_hold_overlap`)
- `crm_`: `crm_companies, crm_contacts` (`contacts.company_id` nullable,
  `SET NULL` al borrar; dedupe por email/phone + `external_ref` único por
  tenant; `kind` agencia|anunciante|proveedor; `agency_commission_pct`)
- `ai_`: `ai_domain_cache` (caché global de firmografía por dominio, sin
  `store_id`), `ai_vertical_profiles` (caché del perfilador),
  `ai_llm_usage` (+view `ai_llm_usage_daily`, metering write-only)
- Sin `market_regions`; país/moneda del tenant en
  `sys_stores.shop_country` + `sys_stores.shop_currency` (single-país).
- Sin `conversations/messages` (memoria de chat del motor viejo, 0 usos;
  recrear claveada a empresa si el chat de fichas la necesita) ni
  `import_runs` (unificado en `sys_runs kind='import'`).

Claves: `sys_stores(platform,shop_url)` único; `io_orders(store,io_number)`
único con autonumeración `io_mint_number()` (Año Lima + `io_counters`);
`io_agency_orders(store,kind,code)` único; `io_invoices(store,number)` único;
`sys_runs` slot atómico `sys_run_start()` (advisory lock, solo service_role).
RLS `tenant_isolation` por tabla vía `is_store_member()` (+`my_store_role()`
para jerarquía en `lib/roles.ts`); `ai_domain_cache` global con lectura
authenticated. `sys_store_profiles`: config de negocio (arquetipo, ciclo,
industry); sin columnas del motor (`brain_json, metadata_map, p_band_*`
extirpadas). Puentes: `io_campaigns.advertiser_company_id +
primary_contact_id → crm_contacts`, `io_lines.screen_id → inv_screens`,
`inv_slots.screen_id → inv_screens`, `inv_bookings` cuelga de slot + IO.

## 6. Technology Stack (real)

- **Runtime:** Node 22 + Next.js 16 (App Router, TS). API routes = proxy fino; inteligencia en
  `lib/` + ADK.
- **UI:** shadcn/ui + TailwindCSS 4 (Hoy, Órdenes, Finanzas, Inventario, Empresas, Contactos, Marcas, Settings, Ayuda).
- **DB/Auth:** Supabase (Postgres + Auth + Realtime). RLS por `is_store_member`.
- **Scheduler/Worker:** sin cola: `web/worker.ts` one-shot (`--once --kinds=morning`) +
  Scheduled Task Coolify diario 11:00 UTC + daemon dev `WORKER_SCHEDULE=1`. `jobs` retirada
  (artefacto, no programar sobre ella); slot vía `sys_run_start`.
- **Scraping/búsqueda:** SearXNG (service Coolify) + Crawlee/cheerio (`procps` en runner).
- **AI:** `@google/adk@^2.3.0` (`LlmAgent` + Zod tools sobre Supabase). Dev/test vía
  `@google/adk-devtools`. Sin Vercel AI SDK. Modelos en `web/config/llm_models.json`.
- **Outbound:** Email Resend/SendGrid real; WhatsApp Meta/Twilio pendiente (#4).

```bash
npm install @google/adk
npm install -D @google/adk-devtools
```

## 7. Chat (ADK, implementado)

> Nota Fase 2 (20261122): el motor de retención quedó retirado —
> `lib/adk/tools/retain-tools.ts`, `review/`, `customers/`, `products/` y
> `conversations/messages` se extirparon. El agente generalista vive en
> `lib/adk/agents/customer-agent.ts`. Rutas: `app/api/chat`,
> `companies/[id]/chat`, `orders/[id]/chat`, `contacts/[id]/chat`.

- **Chat:** `lib/adk/agents/customer-agent.ts` (`customer_chat`), instrucción ES
  (tienda/ficha/producto, recupero≠ventas, envelope `{items,total_count,returned,truncated}`,
  approve solo con confirmación). Rutas `app/api/chat`, `products/[id]/chat`, `customers/[id]/chat`.
- **Tools (22, `lib/adk/tools/retain-tools.ts`):** `get_store_summary, get_recovery_stats,
  list_signals, list_actions, approve_actions, reject_actions, find_customer,
  filter_customers, get_customer_profile, get_customer_orders, get_customer_firmographics,
  list_leads, start_prospect_run, get_top_products, start_scout_run, start_strategist_run,
  start_copywriter_run, start_dispatcher_run, start_analyst_run, get_product_summary,
  get_product_movements, get_product_buyers` (con `limit/offset`, `total=distincts`,
  `truncated` honesto tras fix #28 parcial + #17).
- **Review (no canvas):** inbox 3 tabs actions/leads/signals (`app/(dashboard)/review`),
  con sustento predicción+última orden, wa.me, cambio canal, veto visible.
  Persistencia: `conversations` + `messages`; borradores = `proposed_actions PENDING_REVIEW`.

## 9. Reactividad UI (polling hoy; Realtime como mejora futura)

- **Hoy (2026-11-03):** las vistas son server render por request (`await connection()`),
  así que un tab abierto es una foto fija. Reactividad vía polling, sin realtime:
  `<AutoRefresh/>` (`web/components/auto-refresh.tsx`: `router.refresh()` cada 60s +
  al volver al tab, sin solapar, conservando estado cliente) en Hoy, Review, Customers,
  Finanzas y Products. `HealthSection` ya polleaba `/api/health` cada 15s y
  `BackgroundStatus` refresca al aquietarse una corrida (falla con tab oculto:
  el navegador estrangula los intervalos — por eso existe `AutoRefresh`).
  Settings/Duplicados/Ayuda quedan fuera: solo cambian por acción del usuario
  (ya revalidan con `revalidatePath`).
- **Mejora futura (solo si el polling duele: muchos usuarios concurrentes o
  necesidad de frescura de segundos):** migrar a Supabase Realtime
  (`postgres_changes` → `router.refresh()`). Tablas candidatas, solo las que
  cambian fuera de la sesión (pipeline/cron): `proposed_actions`,
  `proposed_leads`, `churn_signals`, `customer_predictions`, `background_runs`
  (progreso en vivo), `customers`, `orders`, `products`. Requisitos previos:
  (1) añadirlas a la publicación `supabase_realtime` (+ `REPLICA IDENTITY FULL`
  donde importe update/delete); (2) verificar RLS `SELECT` para `authenticated`
  canal por canal (Realtime la respeta); (3) un hook cliente único con
  reconexión. Regla: polling hasta que duela.

## 8. Metering LLM por tenant (issue #15, implementado base)

- **Tabla:** `llm_usage` (`20261020000003`), 1 fila/llamada con `store_id` + 
...[truncated 911 chars]
