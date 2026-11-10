// Menciones y audiencia del muro (issue #11): puro, sin dependencias.
// Client-safe a propósito: lo importa el feed ("use client") y lo
// re-exporta `@/lib/insights` (server). Solo dependencias client-safe
// (`./format` ya lo usan componentes cliente). Nunca server-libs aquí.
import { formatDayMonth, formatMoney } from "./format";
import { joinHaystack } from "./search-text";
export interface InsightAudience {
  user_ids?: string[];
  emails?: string[];
  roles?: string[];
}

export interface AudienceMe {
  userId: string | null;
  email: string | null;
  role: string | null;
}

/** ¿Este post es de `Mis pendientes` para (userId, email, role)? */
export function isMine(audience: InsightAudience, me: AudienceMe): boolean {
  const aud = {
    user_ids: audience.user_ids ?? [],
    emails: (audience.emails ?? []).map((e) => e.toLowerCase()),
    roles: audience.roles ?? [],
  };
  if (me.userId && aud.user_ids.includes(me.userId)) return true;
  if (me.email && aud.emails.includes(me.email.trim().toLowerCase())) return true;
  if (me.role && aud.roles.includes(me.role)) return true;
  return false;
}

/** Menciones visibles de un aviso: `@usuario` por email + `@rol` por rol.
//  El taggeo es explícito en la card, nunca implícito. Puro y testeable. */
export function audienceMentions(audience: { emails?: string[]; roles?: string[] }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of audience.emails ?? []) {
    const e = String(raw ?? "").trim().toLowerCase();
    if (!e) continue;
    const at = e.indexOf("@");
    const token = `@${at > 0 ? e.slice(0, at) : e}`;
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  for (const raw of audience.roles ?? []) {
    const r = String(raw ?? "").trim().toLowerCase();
    if (!r) continue;
    const token = `@${r}`;
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/** CTA primario del aviso con deep-link a drawer (issue #11).
 *  Puro y testeable. El href siempre abre la ficha (drawer vía ?order= /
 *  ?pantalla= / ?company=) o la lista filtrada para kinds globales; nunca
 *  un genérico "Abrir". Solo rutas internas (fail-closed a "/"). */
export interface InsightCtaInput {
  kind?: string | null;
  scopeKind?: string | null;
  scopeId?: string | null;
  links?: string[] | null;
}

export interface InsightCta {
  label: string;
  /** Deep-link canónico (compartible cross-page: /orders?order=<id>). */
  href: string;
  /** drawer = abrir encima de la página actual (buildDrawerHref);
   *  page = navegar a la vista destino (listas de globales). */
  target: "drawer" | "page";
  /** Param canónico del drawer (?order=, ?pantalla=…) cuando target=drawer. */
  param?: string;
  /** Id de entidad cuando target=drawer. */
  id?: string;
}

const ORDER_CTA_LABEL: Record<string, string> = {
  sin_om: "Registrar OM",
  material: "Aprobar material",
  sin_evidencia: "Subir evidencia",
  por_certificar: "Certificar",
  termina_sin_relevo: "Ver relevo",
  renovacion: "Ver relevo",
};

function safeInternal(href: unknown, fallback = "/"): string {
  const h = String(href ?? "").trim();
  return h.startsWith("/") ? h : fallback;
}

/** Rescata el id de entidad desde links legacy (`/orders?order=<id>`)
 *  cuando scope_id viene null (filas pre-migración o seeds viejos). */
function idFromLinks(links: string[] | null | undefined, params: string[]): string | null {
  const raw = Array.isArray(links) ? String(links[0] ?? "") : "";
  if (!raw.startsWith("/")) return null;
  const q = raw.indexOf("?");
  if (q < 0) return null;
  try {
    const sp = new URLSearchParams(raw.slice(q + 1));
    for (const p of params) {
      const v = (sp.get(p) ?? "").trim();
      if (v) return v;
    }
  } catch {
    return null;
  }
  return null;
}

export function insightCta(i: InsightCtaInput): InsightCta {
  const kind = String(i.kind ?? "").trim();
  const scopeKind = String(i.scopeKind ?? "").trim();
  const scopeId = String(i.scopeId ?? "").trim();
  const firstLink = Array.isArray(i.links) ? String(i.links[0] ?? "").trim() : "";
  const orderId = scopeId || (scopeKind === "order" ? (idFromLinks(i.links, ["order", "orden"]) ?? "") : "");
  const screenId = scopeId || (scopeKind === "screen" ? (idFromLinks(i.links, ["pantalla", "screen"]) ?? "") : "");
  const companyId = scopeId || (scopeKind === "company" ? (idFromLinks(i.links, ["company", "empresa"]) ?? "") : "");
  if (scopeKind === "order" && orderId) {
    return {
      label: ORDER_CTA_LABEL[kind] ?? "Ver orden",
      href: `/orders?order=${encodeURIComponent(orderId)}`,
      target: "drawer",
      param: "order",
      id: orderId,
    };
  }
  // Sin scope pero con id en el link legacy: igual abre el drawer.
  if (!scopeKind) {
    const legacyOrder = idFromLinks(i.links, ["order", "orden"]);
    if (legacyOrder) {
      return { label: ORDER_CTA_LABEL[kind] ?? "Ver orden", href: `/orders?order=${encodeURIComponent(legacyOrder)}`, target: "drawer", param: "order", id: legacyOrder };
    }
    const legacyScreen = idFromLinks(i.links, ["pantalla", "screen"]);
    if (legacyScreen) {
      return { label: "Ver pantalla", href: `/screens?pantalla=${encodeURIComponent(legacyScreen)}`, target: "drawer", param: "pantalla", id: legacyScreen };
    }
    const legacyCompany = idFromLinks(i.links, ["company", "empresa"]);
    if (legacyCompany) {
      return { label: "Ver empresa", href: `/companies?company=${encodeURIComponent(legacyCompany)}`, target: "drawer", param: "company", id: legacyCompany };
    }
  }
  if (scopeKind === "screen" && screenId) {
    return { label: "Ver pantalla", href: `/screens?pantalla=${encodeURIComponent(screenId)}`, target: "drawer", param: "pantalla", id: screenId };
  }
  if (scopeKind === "company" && companyId) {
    return { label: "Ver empresa", href: `/companies?company=${encodeURIComponent(companyId)}`, target: "drawer", param: "company", id: companyId };
  }
  if (kind === "por_certificar") {
    return { label: "Certificar", href: "/orders?stage=por_certificar", target: "page" };
  }
  if (kind === "renovacion" || kind === "termina_sin_relevo") {
    return { label: "Ver relevo", href: safeInternal(firstLink || "/orders", "/orders"), target: "page" };
  }
  if (kind === "ocupacion") {
    return { label: "Ver inventario", href: "/screens", target: "page" };
  }
  if (kind === "huecos") {
    return { label: "Cotizar huecos", href: "/screens", target: "page" };
  }
  if (kind === "sin_om") return { label: "Registrar OM", href: safeInternal(firstLink || "/orders", "/orders"), target: "page" };
  if (kind === "material") return { label: "Aprobar material", href: safeInternal(firstLink || "/orders", "/orders"), target: "page" };
  if (kind === "sin_evidencia") return { label: "Subir evidencia", href: safeInternal(firstLink || "/orders", "/orders"), target: "page" };
  return { label: "Abrir", href: safeInternal(firstLink || "/orders", "/orders"), target: "page" };
}
/** Todos los params de drawer (canónicos + alias ES). Abrir un drawer
 *  limpia los demás: un solo drawer visible a la vez, en cualquier página. */
export const DRAWER_PARAMS = [
  "order",
  "orden",
  "pantalla",
  "screen",
  "company",
  "empresa",
  "contact",
  "contacto",
  "brand",
  "marca",
];

/** Href de drawer sobre la página actual: no navega, solo setea el param
 *  (?order=…) preservando filtros/?store=. Cerrar vuelve al estado previo.
 *  El DrawerHost del layout renderiza la ficha (ver drawer-host.tsx). */
export function buildDrawerHref(pathname: string, search: string, param: string, id: string): string {
  const params = new URLSearchParams(search);
  for (const p of DRAWER_PARAMS) params.delete(p);
  params.set(param, id);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Limpia referencias crudas del cuerpo del aviso (URLs, rutas internas,
 *  UUIDs): el CTA de la card ya lleva el deep-link. Puro y testeable. */
export function stripBodyLinks(body: string): string {
  return String(body ?? "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\/(orders|screens|companies|contacts|brands|finance|occupancy|inbox|muro|settings|help)(?:\/[\w\-.?=&%]*)*/g, " ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ")
    .replace(/[?&][\w\-]+=(?=\s|[.,;:]|$)/g, " ")
    .replace(/\s+(en|de|del|al|a|para|por|con|desde|hacia|sobre)(?=\s*[.;:]?\s*$)/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/** Haystack normalizado de un aviso (mismos campos que filtra el feed).
 *  Paridad con `screenHaystack` (screens), órdenes y marcas: título +
 *  cuerpo + kind + empresa/marca del contexto + métricas de urgencia +
 *  menciones visibles. Tildes, mayúsculas y orden dejan de importar. */
export interface InsightSearchInput {
  title?: unknown;
  body?: unknown;
  kind?: unknown;
  context?: {
    company?: unknown;
    brand?: unknown;
    metrics?: Array<{ label?: unknown; value?: unknown }> | null;
  } | null;
  audience?: { emails?: string[]; roles?: string[] };
}

export function insightHaystack(i: InsightSearchInput): string {
  const metrics = Array.isArray(i.context?.metrics)
    ? i.context.metrics.map((m) => `${String(m?.label ?? "")} ${String(m?.value ?? "")}`)
    : [];
  return joinHaystack([
    i.title,
    i.body,
    i.kind,
    i.context?.company,
    i.context?.brand,
    ...metrics,
    ...audienceMentions(i.audience ?? {}),
  ]);
}

/** Contexto legible de un aviso ("Cliente: Alicorp · Monto: S/ 4.200").
 *  Solo presenta cifras exactas que ya trae el hecho; nunca estima. */
export function describeContextShort(c: {
  company?: string | null;
  brand?: string | null;
  screens?: number | null;
  amountMinor?: number | null;
  currency?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  metrics?: Array<{ label?: unknown; value?: unknown }> | null;
} | null | undefined): string | null {
  const items = contextItems(c);
  return items ? items.map((i) => `${i.label}: ${i.value}`).join(" · ") : null;
}

export interface ContextItem {
  label: string;
  value: string;
}

/** Items estructurados para el panel de la card. Prioridad: `metrics`
 *  (urgencia por kind global) sobre los campos de OI. Puro y testeable. */
export function contextItems(c: {
  company?: string | null;
  brand?: string | null;
  screens?: number | null;
  amountMinor?: number | null;
  currency?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  metrics?: Array<{ label?: unknown; value?: unknown }> | null;
} | null | undefined): ContextItem[] | null {
  if (!c) return null;
  if (Array.isArray(c.metrics)) {
    const items = c.metrics
      .filter((m) => m && typeof m === "object")
      .map((m) => ({
        label: String((m as { label?: unknown }).label ?? "").trim(),
        value: String((m as { value?: unknown }).value ?? "").trim(),
      }))
      .filter((m) => m.label && m.value)
      .slice(0, 4);
    if (items.length > 0) return items;
  }
  const items: ContextItem[] = [];
  if (c.company) {
    items.push({
      label: "Cliente",
      value: c.brand && c.brand !== c.company ? `${c.company} · ${c.brand}` : c.company,
    });
  } else if (c.brand) {
    items.push({ label: "Marca", value: c.brand });
  }
  if (typeof c.screens === "number" && c.screens > 0) {
    items.push({ label: "Pantallas", value: String(c.screens) });
  }
  if (typeof c.amountMinor === "number" && c.amountMinor > 0 && c.currency) {
    items.push({ label: "Monto", value: formatMoney(c.amountMinor, c.currency) });
  }
  const s = formatDayMonth(c.startsAt);
  const e = formatDayMonth(c.endsAt);
  if (s !== "—" && e !== "—") items.push({ label: "Vigencia", value: `${s} → ${e}` });
  else if (s !== "—") items.push({ label: "Vigencia", value: `desde ${s}` });
  else if (e !== "—") items.push({ label: "Vigencia", value: `hasta ${e}` });
  return items.length > 0 ? items : null;
}
