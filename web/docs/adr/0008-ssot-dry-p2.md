# ADR 0008 — SSOT/DRY P2 (issue #8)

Fecha: 2026-11-07. Alcance mínimo y seguro: centralizar sin reescribir.

## Dónde vive cada SSOT

| Duplicación | SSOT | Consumidores |
|---|---|---|
| Badges crudos (paid/overdue, paused/draft, Borrador fantasma, b2c/B2B) | `lib/ui-badges.tsx`: `invoiceBadgeDisplay`, `companyIoBadgeDisplay`, `campaignBadgeDisplay`, `MODEL_LABEL` | `components/order-badges.tsx`, `components/company-badges.tsx`, `components/profile-chat.tsx` |
| Estado activo/inactivo y en-pauta en listas | `components/ui/badge.tsx` (`success`/`secondary`) directo | `screens-list.tsx`, `brands-list.tsx` |
| Chats de ficha ×4 | `lib/entity-chat.tsx` (`EntityChat` sobre `ChatShell` + `useStreamChat`) | `empresa-chat.tsx`, `marca-chat.tsx`, `contact-chat.tsx`, `orden-chat.tsx`. `profile-chat.tsx` NO migra (server actions + propuesta) |
| Rutas chat 501 ×6 | `lib/api/chat-route.ts` (`createChatRoute`) | `app/api/chat/route.ts`, `companies/[id]/chat`, `contacts/[id]/chat`, `orders/[id]/chat`, `brands/[name]/chat`, `screens/[id]/chat` |
| `SORT_ALIASES` ×3 | `lib/sort.ts` (+ `resolveSortAlias` genérico) | `lib/crm-db.ts`, `lib/screens-db.ts`, `lib/brand-db.ts` (re-exportan por compat) |
| `startOfDayUTC` ×2 | `lib/dates.ts` | `lib/dashboard.ts`, `lib/billing-status.ts` |
| `resolveTenantStore` ×3 | `lib/tenant.ts` (`resolveTenantStoreAction`) | `lib/crm-actions.ts`, `lib/order-actions.ts`, `lib/screens-actions.ts` (alias local, misma firma). `dooh-import-actions.ts` NO migra (lógica legacy distinta: best-effort + crea tenant) |
| `String(x ?? 'PEN')` y `.toUpperCase()` manual | `lib/currency.ts` (`normalizeCurrency`, `isValidCurrency`, `invoiceMatchesOrder`, issue #6) | `lib/tenant.ts`, `lib/dashboard.ts`, `lib/orders-db.ts`, `lib/finance.ts`, `orders-list.tsx`, `finance/page.tsx`, `orders/orden-drawer.tsx`. Regla: moneda explícita o nada — null/'' nunca hereda en lectura |
| Moneda en BD | `currency_iso` DOMAIN + trigger `io_invoices_currency_parity` (migración `20261208000000_currency_ssot.sql`) | `io_orders`/`io_invoices`/`sys_stores` al dominio; mismatch PEN↔USD aborta en escritura; `inv_screens.currency` (muerta, cero usos) dropeada con guarda RAISE |
| `EMAIL_RE` ×4 | `lib/validation.ts` (`EMAIL_RE`, `isValidEmail`) | `lib/crm.ts`, `contacts/new/nuevo-form.tsx`, `companies/empresa-drawer.tsx`, `login/login-form.tsx`. `lib/retrieval.ts` NO se toca (extractor global, no validador) |
| País sin `isCountryCode` | `lib/countries.ts` + `lib/crm.ts` (`normalizeCompany` exige `isCountryCode`) | `companies/company-validation.ts` (espejo exacto: servidor y cliente aceptan lo mismo) |
| Orden sin validación cliente | `orders/order-validation.ts` (espejo de `updateOrderAction`: entero ≥ 0 o `__none`) | `orders/order-edit-form.tsx` (form `noValidate` + borde + toast + foco; valores fuera de la lista corta se muestran tal cual) |
| Listas ×5 (chrome + selección) | `components/entity-list.tsx`: `useEntitySelection` (?param= ↔ drawer, issue #9), `EntityCount` (truncated), `EntityEmpty`, `EntityPagination` | `companies/contacts/orders/screens/brands-list.tsx`. Columnas/filtros/tarjetas siguen por dominio |
| Pills inline | `components/ui/badge.tsx` directo | `marca-drawer.tsx`, `pantalla-drawer.tsx` (incl. `Chip` local y tags), `companies-list.tsx` (grilla), `duplicates-list.tsx` |
| Truncados silenciosos | flags `truncated` en libs + pintura en UI | `screens-db` (conteo exacto base + muestra), `crm-db` contacts (base + muestra), `dashboard` (counts + snapshot), `tenant.listStores`/`getActiveStore`, `listScreenFilterOptions`; UI: `EntityCount`, página Hoy, contactos, finance (facturas sin moneda) |

## No-SSOT intencionales (fuera de alcance)

- `inbox-tag.tsx` borrado (era deadcode Fase 2); tags de pantalla usan `Badge secondary` vía `Chip` local.
- Columnas/tarjetas/filtros por lista, validación company/screen/contact (reglas de dominio distintas; contact tiene su `contact-validation.ts` espejo), research ×3, qc/legal, DataTable vs DrawerTable, Empresa/MarcaResearch: divergencias reales, reescribirlas rompe más de lo que arregla.
- Fuzzy SQL/JS: paridad parcial testeada — ambos comparten `normalizeSearch` + `tokenizeSearch` (tope 6) y AND de tokens; SQL añade `word_similarity > 0.45` para typos y ranking `similarity()`, JS exige substring + `matchScore` prefijo. Ver `crm-search.test.ts` / `screens-search.test.ts`.
- `background.ts` (`sys_runs` cinta) y `single-audit.ts` (auditoría single + `JUDGE_VETO_PREFIX`) están VIVOS a propósito: los usan `profile-actions` y `background-status`. No borrar (issue #10): el deadcode es el motor de retención extirpado, no la cinta.
- `dooh-import-actions.ts` conserva su `resolveTenantStoreId` propio (fail-closed, sin autocreación): el import necesita su mensaje de error específico, no el genérico de `resolveTenantStoreAction`.
