# AI Retention Engine — Blueprint de arquitectura (referencia)

> **Estado:** documento de referencia/visión, no contrato de implementación.
> La parte de ecommerce (Medusa) corresponde a la **Fase 1 ya implementada**; el RFM
> existe a nivel lectura (quintiles + ciclo esperado en ficha, `web/lib/customer-data.ts`)
> y el perfilado del tenant tiene set propio (`web/lib/profiling/`); **aún no existe**
> la mitad escritura (cron RFM, `CustomerMarketStats`, `churn_risk_view`,
> clasificación B2B/B2C total, acciones propuestas, ADK, canvas).
> Ver el `README.md` raíz para el posicionamiento y el MVP actual.

## 1. High-Level Architecture Diagram

```
+-------------------------------------------------------------------------+
|                          INGESTION LAYER (MODULAR)                      |
|                                                                         |
|  +--------------------+    +--------------------+    +---------------+  |
|  |   Medusa v2 API    |    |  Shopify Webhook   |    |  WooCommerce  |  |
|  | (Subscriber Module)|    |     (Future)       |    |   (Future)    |  |
+--+---------+----------+----+---------+----------+----+-------+-------+--+
             |                         |                       |
             +-------------------------+-----------------------+
                                       |
                                       v
+-------------------------------------------------------------------------+
|                  CORE BACKEND & PIPELINE (Node.js/NestJS)               |
|                                                                         |
|  [ Event Bus / Ingestion Queue ] (Redis + BullMQ)                       |
|         |                                                               |
|         v                                                               |
|  [ Domain & Archetype Classifier ]                                      |
|    - Checks domain against free email list (RFC/Disposable/Webmail)     |
|    - Tags account: IS_B2C (False) or IS_B2B (True)                      |
|         |                                                               |
|         +----------------------------------+                            |
|         |                                  |                            |
|         v (If B2C)                         v (If B2B)                   |
|  [ RFM & Predictive Engine ]        [ Firecrawl Deep Scraper ]          |
|    - Recency/Frequency/Monetary       - Fetches company home & about    |
|    - Repurchase cycle intervals       - Extracts industry & scale       |
|    - LTV projection                   - Stores in Firmographic Record   |
|         |                                  |                            |
|         +-----------------+----------------+                            |
|                           |                                             |
|                           v                                             |
|             [ PostgreSQL + Prisma ORM ]                                 |
+---------------------------+---------------------------------------------+
                            |
                            v
+-------------------------------------------------------------------------+
|                    AI AGENT & DECISION GENERATOR                        |
|                                                                         |
|  - Daily Cron Job / Triggered Events                                    |
|  - Context Builder: Assembles Customer Stats + Store Catalog            |
|  - LLM Inference (Claude 3.5 Sonnet / OpenAI GPT-4o)                    |
|  - Generates Pending Action Objects (Stored in DB as `PENDING_REVIEW`)  |
+---------------------------+---------------------------------------------+
                            |
                            v
+-------------------------------------------------------------------------+
|                   ACTION REVIEW & DISPATCH ENGINE                       |
|                                                                         |
|  - Merchant Dashboard (Next.js 14 App Router + TailwindCSS)             |
|  - On Approval:                                                         |
|      * WhatsApp -> Meta Cloud API / Twilio                              |
|      * Email    -> Resend API / SendGrid                                |
+-------------------------------------------------------------------------+
```

## 2. Ingestion Module: ecommerce connectors (Medusa hoy)

> **Estado implementado:** punto centralizado en `web/lib/connectors/`
> (`types.ts` + `medusa.ts` + `index.ts:getConnector(platform)`). `web/lib/sync.ts`
> orquesta contra esa interfaz (`syncStoreFromPlatform(platform, …)`; `syncStoreFromMedusa`
> queda como wrapper compat). `web/lib/medusa.ts` conserva la API v1/v2 + tipos
> canónicos; futuros conectores (Shopify/Woo/tupantalla) agregan
> `web/lib/connectors/<platform>.ts` + 1 línea en el registro, sin tocar el sync.
> Visión multi-plataforma abajo; Medusa como primera fuente.

### Medusa Subscribers

We register subscribers listening to key Medusa events:

- `order.placed`: Ingests cart items, customer email, billing/shipping address, total amount.
- `customer.created`: Ingests contact information and company name fields.
- `order.updated`: Tracks returns, cancellations, and fulfillment status.

### Event Payload Normalization

All incoming payloads from Medusa, Shopify, or WooCommerce are normalized into an internal canonical event:

```ts
interface CanonicalOrderEvent {
  source: 'medusa' | 'shopify' | 'woocommerce';
  sourceOrderId: string;
  storeId: string; // canonical Store id (tenant)
  channel: { sourceId: string; name: string }; // sales_channel / publication
  market: { sourceId: string; name: string; currency: string; countries: string[] };
  customer: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    companyName?: string;
  };
  items: Array<{
    sku: string;
    title: string;
    quantity: number;
    unitPrice: number;
  }>;
  totalAmount: number; // minor units, original currency
  currency: string; // original currency (never mixed across currencies)
  country?: string; // ISO2 from shipping/billing, best-effort (often null on digital goods)
  createdAt: Date;
}
```

Mapping:

- Medusa `order.region` → `market` (`source='medusa_region'`), `order.sales_channel` → `channel`. `countries` comes from `/admin/regions` (often `[]` — currency is the reliable axis).
- Shopify `presentmentCurrency + country` → `market` (`source='shopify_market'`, `market_id` inferred via `country → Market` when absent), `order.sourceName/app` → `channel`.
- País canónico por orden (`resolveOrderCountry` en `web/lib/medusa.ts`, general
  medusa v1/v2 + shopify): `shipping/billing country_code` → `market.countries`
  si es único → nombre del market si es ISO2 (`"PE"`, `"MX"`) → `null`.
  El sync guarda la moda por customer (`customers.country`) y los writers la
  desnormalizan en `churn_signals`/`proposed_actions` para el filtro global
  `?market=` (siempre por ISO2, nunca por miles de IDs).

## 3. Data Classification & Enrichment Pipeline

### Step 1: B2B vs. B2C Classification

- **Domain Extraction:** Extract root domain from `customer.email`.
- **Free-Provider Match:** Cross-reference against an offline lookup of ~4,500 free webmail domains (gmail.com, yahoo.com, outlook.com, regional domains like uol.com.br, etc.).
- **Classification Rule:**
  - If domain in webmail list AND companyName is blank → Tag: B2C.
  - If custom domain OR explicit tax/company ID exists → Tag: B2B.

### Step 2: B2B Enrichment (Firecrawl Worker)

If tagged as B2B, a job is pushed to the BullMQ enrichment queue:

- Firecrawl scrapes `https://{customer_domain}` (extracting markdown of Homepage and About Us).
- Mini-LLM prompt extracts:
  - Company vertical/industry.
  - Business type (e.g., distributor, retail shop, corporate end-user).
  - Estimated scale.
- Payload is saved to `CustomerFirmographic` table.

## 4. Core Mathematical Engines: RFM & Repurchase Interval

### 1. RFM Calculation (Run asynchronously every 24h)

For every customer `i`:

- Recency (`R_i`): Days since latest `order.placed`.
- Frequency (`F_i`): Total count of completed orders.
- Monetary (`M_i`): Total net spend across all orders.

Quintile distribution (`1` to `5`) is assigned across the store's customer base:

```text
Score_i = Concat(R_tier, F_tier, M_tier)
```

- `555` → Champions / VIPs.
- `511` → New Promising Customers.
- `155` → Can't Lose Them (High spend, long inactive time).
- `111` → Lost / Hibernating.

### 2. Expected Repurchase Delta

For customers with `F >= 2`:

```text
Δt_avg = (1 / (N - 1)) * Σ(t_{k+1} - t_k)
```

If `(Current Date - t_last) > Δt_avg × 1.25`, trigger "Churn Risk" signal.

## 5. Database Schema (PostgreSQL / Prisma Core Entities)

> Fuente de verdad implementada: `supabase/migrations/20261016000000_phase1_multitenant.sql`
> (SQL directo, sin Prisma). El modelo Prisma de abajo es el blueprint; Fase 1 = `stores`,
> `channels`, `market_regions`, `customers`, `orders`. Fase 2 = `customer_market_stats` + RFM.

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum CustomerType {
  B2C
  B2B
}

enum ActionStatus {
  PENDING_REVIEW
  APPROVED
  REJECTED
  DISPATCHED
  FAILED
}

enum OutreachChannel {
  EMAIL
  WHATSAPP
}

enum CustomerSource {
  ecommerce // synced from platform, upsert-only (never deleted)
  local     // created in-app, untouched by sync
}

// Tenant = one connected store (Medusa URL or Shopify domain).
// merchantId reserved for multi-user; null = single-merchant instance.
model Store {
  id           String   @id @default(uuid())
  merchantId   String?
  platform     String   // medusa | shopify | woocommerce
  shopUrl      String   // canonical connection key
  name         String?
  shopCurrency String   @default("PEN")
  channels     Channel[]
  markets      MarketRegion[]
  customers    Customer[]
  orders       Order[]
  createdAt    DateTime @default(now())

  @@unique([platform, shopUrl])
}

// Canonical sales channel: Medusa sales_channel / Shopify publication.
model Channel {
  id       String  @id @default(uuid())
  storeId  String
  store    Store   @relation(fields: [storeId], references: [id], onDelete: Cascade)
  source   String  // medusa_sales_channel | shopify_channel
  sourceId String  // sc_xxx / gid://shopify/Publication/...
  name     String
  orders   Order[]

  @@unique([storeId, source, sourceId])
}

// Canonical commercial zone + currency: Medusa region / Shopify market.
// Currency is the reliable axis (countries[] is often empty — e.g. digital goods).
model MarketRegion {
  id        String   @id @default(uuid())
  storeId   String
  store     Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  source    String   // medusa_region | shopify_market
  sourceId  String   // reg_xxx / gid://shopify/Market/...
  name      String
  currency  String   // PEN, USD, MXN
  countries String[] // ISO2, best-effort
  orders    Order[]

  @@unique([storeId, source, sourceId])
}

model Customer {
  id               String                 @id @default(uuid())
  storeId          String
  store            Store                  @relation(fields: [storeId], references: [id], onDelete: Cascade)
  externalId       String?                // Medusa/Shopify customer ID (null = local-only)
  source           CustomerSource         @default(ecommerce)
  email            String                 @index
  phone            String?
  firstName        String?
  lastName         String?
  customerType     CustomerType           @default(B2C)
  // Global RFM only valid in shopCurrency (see CustomerMarketStats + totalShopCurrency).
  rfmScore         String?                // e.g. "554"
  recencyDays      Int?
  frequencyCount   Int                    @default(0)
  totalMonetary    Decimal                @default(0.0) @db.Decimal(12, 2)
  avgIntervalDays  Float?
  lastOrderAt      DateTime?
  firmographic     CustomerFirmographic?
  orders           Order[]
  actions          ProposedAction[]
  marketStats      CustomerMarketStats[]
  externalCreatedAt DateTime?
  lastSyncedAt     DateTime?
  createdAt        DateTime               @default(now())
  updatedAt        DateTime               @updatedAt

  @@unique([storeId, externalId])
}

model CustomerFirmographic {
  id              String    @id @default(uuid())
  customerId      String    @unique
  customer        Customer  @relation(fields: [customerId], references: [id])
  domain          String
  companyName     String?
  industry        String?
  businessModel   String?   // Wholesaler, Retailer, Agency
  summaryRaw      String?   @db.Text
  scrapedAt       DateTime  @default(now())
}

model Order {
  id                String    @id @default(uuid())
  externalOrderId   String    @unique
  storeId           String
  store             Store     @relation(fields: [storeId], references: [id], onDelete: Cascade)
  customerId        String
  customer          Customer  @relation(fields: [customerId], references: [id], onDelete: Cascade)
  channelId         String?
  channel           Channel?  @relation(fields: [channelId], references: [id])
  marketId          String?
  market            MarketRegion? @relation(fields: [marketId], references: [id])
  totalAmount       Decimal   @db.Decimal(12, 2) // minor units, ORIGINAL currency
  currency          String    // original currency — never aggregated across currencies
  totalShopCurrency Decimal?  @db.Decimal(12, 2) // normalized to Store.shopCurrency (Fase 2)
  country           String?   // shipping/billing ISO2, best-effort
  itemsJson         Json      // Normalized array of line items
  placedAt          DateTime
}

// Fase 2 (RFM engine): actionable RFM lives here, per market/currency.
// Mixing S/349 PEN with $610 USD in one score produces wrong copy/pricing.
model CustomerMarketStats {
  id             String        @id @default(uuid())
  customerId     String
  customer       Customer      @relation(fields: [customerId], references: [id], onDelete: Cascade)
  marketId       String?
  market         MarketRegion? @relation(fields: [marketId], references: [id])
  currency       String
  frequencyCount Int           @default(0)
  totalMonetary  Decimal       @db.Decimal(12, 2)
  recencyDays    Int?
  rfmScore       String?
  lastOrderAt    DateTime?

  @@unique([customerId, marketId, currency])
}

model ProposedAction {
  id              String        @id @default(uuid())
  customerId      String
  customer        Customer      @relation(fields: [customerId], references: [id])
  reasoning       String        // "Customer hasn't reordered their monthly coffee beans in 35 days."
  channel         OutreachChannel
  subject         String?
  body            String        @db.Text
  status          ActionStatus  @default(PENDING_REVIEW)
  dispatchedAt    DateTime?
  revenueAttributed Decimal?    @db.Decimal(12, 2)
  createdAt       DateTime      @default(now())
}
```

**Phased implementation:** Fase 1 (migration `0001`): `stores`, `channels`, `market_regions`, `customers`, `orders` (raw currency + FKs, no conversion). Fase 2 (RFM engine): `customer_market_stats` + `totalShopCurrency` conversion + views `churn_risk_view` / `rfm_summary`.

## 6. Technology Stack

- **Runtime & Framework:** Node.js 20.19+ with Next.js (latest, App Router, TypeScript end-to-end). API routes act as a thin proxy; all intelligence lives in ADK.
- **UI:** shadcn/ui + TailwindCSS (merchant dashboard, chat, canvas).
- **Database & Auth:** Supabase (PostgreSQL + Auth + Realtime). Read models via Supabase client; views `churn_risk_view` / `rfm_summary` with RLS per merchant.
- **Queue / Job Scheduling:** Upstash Redis + QStash/BullMQ (event ingestion, daily RFM cron, Firecrawl scraping tasks).
- **Deep Scraping:** Firecrawl API (clean markdown extraction).
- **AI Orchestration:** [ADK for TypeScript](https://github.com/google/adk-js) (`@google/adk`, Node 20.19+). `LlmAgent` with Zod-validated function tools over Supabase views/tables. Dev/test via `@google/adk-devtools` (`adk web`, `adk run`). No Vercel AI SDK.
- **Outbound Channels:**
  - **Email:** Resend API (clean developer experience, high deliverability).
  - **WhatsApp:** Meta Cloud API or Twilio WhatsApp Business API.

```bash
npm install @google/adk
npm install -D @google/adk-devtools
```

## 7. Chat + Canvas (ADK)

- **Chat:** conversational layer over customers, RFM, orders and `ProposedAction`. The Next.js frontend talks to the ADK agent directly (its API/SSE); Next.js API routes are only a thin proxy.
- **Agent tools (read-only by default):** `listChurnRisk`, `rfmBreakdown`, `getCustomer`, `listActions`, `draftCampaign`. `approveAction`/`dispatch` require explicit merchant confirmation.
- **Canvas:** renders agent artifacts next to the chat — `chart` (RFM/churn), `table` (customer segments), `actionDraft` (editable campaign copy before approval). One editable draft at a time (artifact pattern).
- **Persistence:** Supabase tables `conversations` + `messages`; generated drafts stay as `ProposedAction` rows with `PENDING_REVIEW`.

## 8. Metering LLM por tenant (issue #15)

- **Tabla:** `llm_usage` (`supabase/migrations/20261020000003_llm_usage.sql`), una fila por llamada con `store_id` obligatorio + `process/provider/model/prompt/completion/total/reasoning/latency/used_fallback/success`. RLS: lectura por `is_store_member(store_id)`; escritura solo `service_role` desde server. Vista `llm_usage_daily` para agregados por día/proceso/modelo.
- **Wrapper:** `web/lib/ai/usage.ts` — `parseChatUsage` tolera OpenAI/DeepSeek (`usage.prompt_tokens/...`), Anthropic (`input_tokens/output_tokens`) y Gemini (`usageMetadata`); devuelve `null` sin conteo. `logLlmUsage` nunca lanza (warn si falta `store_id` o Supabase) y se llama fire-and-forget.
- **Dónde se loguea:** no-streaming JSON (`profiling/llm.ts`, `ai/investigate.ts`, `ai/enrich.ts`, `retrieval.ts` via `meter`, `contactability.ts`, `verticals.ts`, `copywriter.ts` proceso `proposer_draft`, `prospect.ts` proceso `prospect_scan`, `profiling/pipeline.ts` + `synthesizer/critic`) y adaptadores ADK (`adk/models/openai-compatible.ts`, `anthropic.ts` via `config.storeId/process` desde `customer-agent.ts`). Fallback loguea solo la fila del modelo que respondió con `used_fallback=true` (sin doble conteo). Sin `usage` real no se inventa: no hay fila (el `success=false` con 0 queda para fase 2).
- **Lectura:** `GET /api/usage?store=<uuid>&from=&to=&process=` agrega `llm_usage` (RLS aplica); pill informativo en el header (`usage-pill.tsx`, total hoy + histórico, sin link).
- **Fuera de alcance:** `ai/decisions.ts` (Decisions API: devuelve `answers` con probabilidades, sin `usage`/tokens — no hay qué medir) y backfill histórico (solo forward). `llm_usage_daily` existe para futuros agregados; la ruta agrega en código.
