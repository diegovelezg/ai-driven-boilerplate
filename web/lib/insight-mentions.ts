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
