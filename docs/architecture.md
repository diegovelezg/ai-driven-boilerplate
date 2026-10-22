# AI Retention Engine — Blueprint de arquitectura (implementado)

> **Estado:** documento vivo, refleja `main` a 2026-10-22. Ya no es visión: el loop
> scout→strategist→copywriter→dispatcher→analyst corre en prod vía worker + cron Coolify,
> con motor probabilístico `retention:v3:episodes-mixture` y 54 migraciones aplicadas.
> Ver `README.md` raíz para posicionamiento y `web/README.md` para operación diaria.

## 1. High-Level Architecture Diagram (real)

```
+-------------------------------------------------------------------------+
|                          INGESTION LAYER (MODULAR)                      |
|  +--------------------+   +--------------------+   +---------------+    |
|  | Medusa v2 API REAL |   | Shopify STUB       |   | Woo STUB      |    |
|  | login JWT v1/v2    |   | sin backend        |   | sin backend   |    |
+--+---------+----------+---+---------+----------+---+-------+-------+--+
             |                        |                        |
             +------------------------+------------------------+
                                      |
                                      v
+-------------------------------------------------------------------------+
|              SYNC + MORNING PIPELINE (web/worker.ts, sin cola)          |
|  sync (runSyncOnce, slot atómico/store)                                 |
|   → enrichment → brain → regenerate(stale) → [foto si sync cambió]     |
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

## 2. Ingestion Module: ecommerce connectors (Medusa real)

> Implementado en `web/lib/connectors/` (`types.ts` + `medusa.ts` + `index.ts:getConnector`).
> `web/lib/sync.ts` orquesta (`syncStoreFromPlatform`, 6 fases); `syncStoreFromMedusa` wrapper.
> `web/lib/sync-runner.ts:runSyncOnce` con slot atómico; `web/worker.ts` lo corre por tienda.

Medusa (único real): login JWT v1/v2, `regions` → `market_regions`,
`sales_channel` → `channels`, customers/orders/products raw → canónicos, upsert +
tombstones + `product_stats`. Shopify/Woo: `ConnectorNotImplementedError` explícito.

`CanonicalOrderEvent` (vigente, `docs/architecture` original §2 se mantiene):

```ts
interface CanonicalOrderEvent {
  source: 'medusa' | 'shopify' | 'woocommerce';
  sourceOrderId: string; storeId: string;
  channel: { sourceId: string; name: string };
  market: { sourceId: string; name: string; currency: string; countries: string[] };
  customer: { id: string; email: string; firstName?: string; lastName?: string;
              phone?: string; companyName?: string; };
  items: Array<{ sku: string; title: string; quantity: number; unitPrice: number }>;
  totalAmount: number; currency: string; country?: string; createdAt: Date;
}
```

País canónico (`resolveOrderCountry`, medusa v1/v2 + shopify): shipping/billing →
`market.countries` si único → nombre market si ISO2 → `null`. Moda por customer en
`customers.country`; writers desnormalizan en señales/acciones para filtro `?market=` por ISO2.

## 3. Data Classification & Enrichment Pipeline (implementado)

- **B2B vs B2C**: dominio vs lista ~4.500 webmails + `companyName`; `isB2B` por lado
  (issue #21 parcial: display + prospect gate, decisión aún no parte por lado).
- **Enriquecimiento**: `domains` + `enrichment_runs`, `pendingDomains` → `runEnrichment`
  (SearXNG rescue + scrape), industria/escala a `CustomerFirmographic`-like en `domains`;
  brief sectorial cacheado; `vertical_profiles`.
- **Perfilador tenant** (`web/lib/profiling/` + `store_profiles`): investigator/sector/
  synthesizer/critic aislados, taxonomía Shopify, arquetipo
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

### Prospect `prospect:v6:market-scores` (`web/lib/prospect.ts`)

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

> Fuente de verdad: `supabase/migrations/*.sql` (54 archivos). El modelo Prisma de abajo
> es ilustrativo; el DDL real es SQL directo.

Tablas (28): `stores, channels, market_regions, customers, orders, products,
product_stats, item_content, customer_predictions, churn_signals, proposed_actions,
proposed_leads, background_runs, domains, enrichment_runs, customer_aliases,
media_captions, store_profiles, vertical_profiles, profile_snapshots, profile_proposals,
tenant_model_params, opt_outs, llm_usage, conversations, messages, merchant_users,
store_secrets, store_secret_audits, jobs` (+ `start_run_if_free()`).

Claves: `stores(platform,shop_url)` único; `customers(source)` ecommerce-upsert/local-intacto;
`orders` moneda original + `channel/market/country/is_test`; `customer_predictions`
`(store,customer,as_of)` + `model_version`; `churn_signals(status,objective,evidence_json)`;
`proposed_actions(status,evidence_json.generator,approved_by)`; `background_runs(kind,scope)`.

## 6. Technology Stack (real)

- **Runtime:** Node 22 + Next.js 16 (App Router, TS). API routes = proxy fino; inteligencia en
  `lib/` + ADK.
- **UI:** shadcn/ui + TailwindCSS 4 (Hoy, Customers, Review, Finanzas, Products, Settings, Ayuda).
- **DB/Auth:** Supabase (Postgres + Auth + Realtime). RLS por `is_store_member`.
- **Scheduler/Worker:** sin cola: `web/worker.ts` one-shot (`--once --kinds=sync,morning`) +
  Scheduled Task Coolify diario 11:00 UTC + daemon dev `WORKER_SCHEDULE=1`. `jobs` retirada
  (artefacto, no programar sobre ella); slot vía `start_run_if_free`.
- **Scraping/búsqueda:** SearXNG (service Coolify) + Crawlee/cheerio (`procps` en runner).
- **AI:** `@google/adk@^2.3.0` (`LlmAgent` + Zod tools sobre Supabase). Dev/test vía
  `@google/adk-devtools`. Sin Vercel AI SDK. Modelos en `web/config/llm_models.json`.
- **Outbound:** Email Resend/SendGrid real; WhatsApp Meta/Twilio pendiente (#4).

```bash
npm install @google/adk
npm install -D @google/adk-devtools
```

## 7. Chat + Review (ADK, implementado)

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

## 8. Metering LLM por tenant (issue #15, implementado base)

- **Tabla:** `llm_usage` (`20261020000003`), 1 fila/llamada con `store_id` + 
...[truncated 911 chars]
