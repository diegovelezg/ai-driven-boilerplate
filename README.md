# MEOW

> Sistema de **gestión comercial DOOH**: empresas, inventario (venues/pantallas/slots),
> órdenes de inserción (contrato → hard hold → autorización → materiales → emisión →
> certificación → cobranza) y marcas.
>
> **Fase 2 (2026-11-07):** se extirpó el motor de retención original
> (modelo probabilístico + loop scout→strategist→copywriter→dispatcher→analyst).
> Migración `20261122000000_drop_retention_engine.sql`. Sin morning pipeline,
> sin cron (worker no-op), chat en pausa (501) hasta el agente DOOH.

## Qué es (y qué no es)

No es un CRM. Guardar y segmentar clientes ya es commodity. MEOW es un **motor de
decisión y acción** encima de los datos del negocio: ingesta desde el ecommerce, construye una
comprensión viva de quién compra, qué compra, cada cuánto debería volver y qué cuentas se están
enfriando; y luego, de forma autónoma, **propone la siguiente mejor acción** (WhatsApp/email),
que el humano aprueba antes de que se ejecute.

La diferencia con CRM/analytics/marketing automation:
el CRM *almacena*, el analytics *describe*, el marketing automation *ejecuta reglas que tú
armaste*; MEOW **decide y propone por ti, y cierra el loop midiendo el resultado**.

## El problema

Un negocio con clientes recurrentes **pierde ingresos porque no sabe cuándo un cliente ya
debería haber vuelto a comprar ni tiene cómo contactarlo a tiempo por el canal correcto
(WhatsApp)**. El churn es silencioso: nadie detecta al que se está yendo, nadie le escribe el
mensaje correcto, y nadie mide si vuelve.

## El loop (implementado)

1. **Detectar** — `scout` abre `churn_signals` desde `customer_predictions` (quién ya debería
   haber recomprado / quién se enfría).
2. **Decidir** — `strategist` prioriza (`open` → `prioritized`) y asigna `objective`
   (`vip_care` / `winback` / `nurture`).
3. **Proponer** — `copywriter` (LLM + juez de contactabilidad) redacta el mensaje
   (WhatsApp/email) como `proposed_actions` en `pending_review`.
4. **Aprobar** — *human-in-the-loop*: el dueño revisa en `/review` y aprueba/rechaza.
5. **Ejecutar** — `dispatcher` envía (email vía SendGrid real; WhatsApp retenido sin proveedor,
   o `RETAIN_DISPATCH_STUB=1` en dev). Pre-envío con gate: opt-out, recompra, sello, juez.
6. **Medir** — `analyst` atribuye sesiones post-envío a `revenue_attributed` y cierra señales.

Pipeline diario (`web/lib/morning-run.ts:runMorningPipeline`):

```
sync (runSyncOnce) → enrichment → brain → regenerate(stale) → [foto si sync trajo órdenes]
  → scout → strategist → copywriter (límite 10) → prospect (B2B-only, tope 10 pendientes)
```

Cada paso deja su corrida en `background_runs` (cinta visible en UI). Best-effort: un paso que
falla no tumba los siguientes ni el login. Slot atómico `claimRunSlot` (sin duplicados entre
réplicas). Cron prod: Scheduled Task Coolify `npm run worker -- --once --kinds=sync,morning`
(ver `docs/coolify.md`).

## Primer caso: tupantalla.com

[TuPantalla](https://tupantalla.com) es un marketplace de **publicidad digital en vía pública
(DOOH) en Perú**: los anunciantes reservan pantallas (Cusco, Arequipa, Lima, etc.), pagan con
tarjeta o Yape, suben su arte y se publica.

Es el primer caso (dogfooding) porque: los datos son propios (cero fricción de integración),
es B2B (anunciantes = negocios), WhatsApp-first, y el ciclo de recompra es claro y medible.

Mapeo:

| Concepto | En tupantalla |
|---|---|
| Cliente | Anunciante (negocio/emprendimiento) |
| Recompra | Nueva campaña reservada |
| Señal | `sin comprar hace {t}d (ciclo ~{c}d, p25–p75)` |
| Canal | WhatsApp (Perú), email |
| Medición | ¿Reservó otra campaña? (`revenue_attributed`) |

## Estado actual del repo

**Existe (motor + UI completos, no solo Fase 1):**

- **Conector Medusa** en modo solo lectura: sincroniza `customers`, `orders`, `products`,
  `channels`, `market_regions` a Supabase (56 migraciones en `supabase/migrations/`).
  Punto centralizado `web/lib/connectors/` (`getConnector(platform)` +
  `syncStoreFromPlatform()`); Shopify/Woo lanzan `sin-backend` (agregar = 1 archivo + 1 línea).
- **Motor probabilístico de recompra `retention:v3:episodes-mixture`** (`web/lib/retention-model.ts`
  + `web/lib/retention.ts`): grilla bayesiana LogNormal + censura, Modelo A `renovacion` (F≥2) /
  Modelo B `segunda_compra` (F=1), `sessionize` (<1d) → `episodeize` (ventana por tenant),
  mezcla de K ritmos (EM+BIC, K≤4), decisión `v4:nodormido-exception`. Salida:
  `customer_predictions` (foto diaria por `store,customer,as_of`).
  Autocalibración 30d: `tenant_model_params` + `band-calibrate` / `close-watch-calibrate` /
  `model-tune` (backtest WFO, trust-region, fail-open a legacy).
- **Loop multiagente**: `scout:v2` → `strategist:v2` → `copywriter:v16` +
  juez `contactability:v5` → `prospect:v6` (B2B-only, SearXNG + scraping) → `dispatcher`
  (email real, WhatsApp retenido) → `analyst` (1 orden = 1 atribución).
  `TenantBrain` diario en `store_profiles.brain_json` (top activos, ventana mediana,
  ticket p50/p80, voz cliente); `runStaleRefresh` re-redacta pendientes con sello viejo
  (nunca toca `approved`/`dispatched`, nada se auto-envía).
- **Dashboard Next.js 16 (App Router)**: `/` Hoy (actuar/vigilar, embudo, por revisar,
  recuperado, feed enviados), `/customers` (cartera + predicciones + duplicados + chat por
  cliente), `/review` (inbox actions/leads/signals), `/finanzas` (KPIs 12m + en juego
  probabilístico), `/products` (catálogo + stats por market/moneda), `/settings`
  (tienda/negocio/motor/email), `/ayuda`.
- **Chat por cliente/producto/tienda con ADK** (`@google/adk`): `LlmAgent` + 22 tools
  read-only (`list_signals`, `get_product_buyers`, `approve_actions`, …) con envelope
  `{items,total_count,returned,truncated}`. Modelos primario + fallback en
  `web/config/llm_models.json` (OpenAI / Anthropic / Gemini vía `RoutedLlm`).
- **Transversales**: metering LLM por tenant (`llm_usage`), secretos cifrados en
  `store_secrets`, perfiles de tienda + taxonomía + vertical + recalibración con HITL,
  enriquecimiento por dominios + gate B2B, matriz de conflictos `operations.ts`,
  schema-guard, `jobs` + `run_slot` (slot atómico), i18n pendiente (issue #1).

**No existe todavía / deliberadamente retenido:**

- Envío real de **WhatsApp** (decisión comercial pendiente, issue #4): el dispatcher retiene
  en `approved` sin proveedor; email sí envía.
- Conectores **Shopify/Woo** (stubs con error explícito) y adaptador de **tupantalla**
  (hoy opera vía Medusa como tenant de prueba).
- Auto-aplicación del tune (#22) y SSOT total scope/moneda (#28, parcialmente atacado):
  specs cerrados, implementación acotada a `buyers honestos + scope sin fallbacks`.
- Multilenguaje ES/EN/PT (issue #1 abierto).

## Issues: estado real

24 cerrados (#2–#6, #8–#26, #28), 2 abiertos (#1 i18n, #27 episodios+mezcla — ya mergeado en
`main` como `retention:v3:episodes-mixture`, queda seguimiento de calibración).
Hitos cerrados e implementados: loop retención (#2), motor probabilístico (#5), vigilante
perfil (#6), consola diaria (#8), copywriter v8 (#9), math P1 (#10), kind/objective + mira
(#11), analyst (#12), pre-envío (#13), ejes GUI (#14), metering (#15), ops-status (#16),
envelope (#17). Specs cerrados sin implementación total: #20 secrets-DB (existe tabla pero
convive con JSON), #21 vigilar/tenant/market, #22 autoadaptativo, #23 coherencia, #24 jobs,
#25 TenantBrain-padre (Hito 1 hecho), #26 stale-refresh (implementado `runStaleRefresh`),
#28 SSOT (parcial).

## Fuera de alcance (por ahora)

- **No mezclar con el bot de respuestas** (sistema existente, se mantiene separado).
- **Solo customers ya conectados**: trabajamos únicamente con los datos que ya tenemos.
- Multi-plataforma (Shopify/Woo) y multi-idioma: se retoman si tupantalla valida.

## Documentación

- Blueprint técnico y motores: [`docs/architecture.md`](docs/architecture.md).
- Web (stack, quickstart, sync, worker): [`web/README.md`](web/README.md).
- Deploy Coolify (Supabase lean + SearXNG + web + cron): [`docs/coolify.md`](docs/coolify.md).
