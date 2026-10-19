# AI Retention Engine

> Sistema agéntico de **retención y comprensión de negocio**: entiende tu negocio y actúa
> sobre él (detecta, decide, propone, ejecuta con aprobación humana y mide).

## Qué es (y qué no es)

No es un CRM. Guardar y segmentar clientes ya es commodity. AI Retention Engine es un **motor de
decisión y acción** encima de los datos del negocio: los ingesta, construye una comprensión
viva de quién compra, qué compra, cada cuánto debería volver y qué cuentas se están enfriando;
y luego, de forma autónoma, **propone la siguiente mejor acción** (WhatsApp/email), que el
humano aprueba antes de que se ejecute.

La diferencia con un CRM/analytics/marketing automation:
el CRM *almacena*, el analytics *describe*, el marketing automation *ejecuta reglas que tú
armaste*; AI Retention Engine **decide y propone por ti, y cierra el loop midiendo el resultado**.

## El problema

Un negocio con clientes recurrentes **pierde ingresos porque no sabe cuándo un cliente ya
debería haber vuelto a comprar ni tiene cómo contactarlo a tiempo por el canal correcto
(WhatsApp)**. El churn es silencioso: nadie detecta al que se está yendo, nadie le escribe el
mensaje correcto, y nadie mide si vuelve.

## El loop (MVP)

1. **Detectar** — quién ya debería haber recomprado y no lo hizo / quién se está enfriando.
2. **Decidir** — a quién contactar primero y con qué objetivo.
3. **Proponer** — el agente redacta el mensaje (WhatsApp/email) personalizado.
4. **Aprobar** — *human-in-the-loop*: el dueño revisa y aprueba.
5. **Ejecutar** — se envía por el canal elegido.
6. **Medir** — ¿el cliente volvió a comprar?

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
| RFM | Días desde la última campaña · nº de campañas · gasto total |
| Señal de churn | Anunciante que ya no reserva tras su intervalo habitual |
| Canal | WhatsApp (Perú), email |
| Medición | ¿Reservó otra campaña? |

## Estado actual del repo

**Existe (Fase 1, ecommerce):**

- Conector **Medusa** en modo solo lectura: sincroniza `customers`, `orders`, `channels`,
  `market_regions` a Supabase (`supabase/migrations/20261016000000_phase1_multitenant.sql`).
- Dashboard Next.js (App Router) que lee desde BD (no del ecommerce en vivo): `/settings`,
  `/customers`.
- Chat por cliente con LLM (streaming; config de modelos con primario + fallback).
- Agente de retención con **ADK** (`@google/adk`): `LlmAgent` con tools read-only sobre la ficha/compras/empresa del customer. Modelo, esfuerzo y fallback desde `web/config/llm_models.json`; soporta proveedores **OpenAI estándar**, **Anthropic** y **Gemini** (failover entre proveedores vía `RoutedLlm`).
- Perfiles de tienda, ediciones manuales de cliente, fingerprint.
- RFM por quintiles + ciclo esperado en ficha (`expectedCycleDays`, `dueStatus`;
  jerarquía cliente → tienda → arquetipo), solo lectura.
- Set perfilador del tenant (investigator/sector/synthesizer/critic, aislado en
  `web/lib/profiling/`) + taxonomía Shopify + brief sectorial cacheado.
- Enriquecimiento por dominios + gate B2B en piloto.

**No existe todavía:**

- Motor RFM persistido (cron 24h, `CustomerMarketStats`, vistas `churn_risk_view`).
- Acciones propuestas (`ProposedAction`) y el loop de aprobación.
- Despacho por WhatsApp/email.
- Adaptador de **tupantalla** (primer caso).
- Canvas del agente.

## Fuera de alcance (por ahora)

- **No mezclar con el bot de respuestas** (sistema existente, se mantiene separado).
- **Solo customers ya conectados**: trabajamos únicamente con los datos que ya tenemos.
- Multi-plataforma (Shopify/Woo) y multi-cliente: se retoma si tupantalla valida.

## Documentación

- Blueprint técnico y visión ampliada (ecommerce/Medusa): [`docs/architecture.md`](docs/architecture.md).
- Web (stack, quickstart, sync): [`web/README.md`](web/README.md).
