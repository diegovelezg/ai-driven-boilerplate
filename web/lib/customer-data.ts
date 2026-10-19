// Lecturas de compras + firmográficos de un customer. Compartido por las API
// routes y las tools del agente ADK (misma fuente de verdad).
import { getSupabase } from "@/lib/supabase";
import { isRealOrder } from "@/lib/medusa";
import { enrichOrderItems } from "@/lib/media-context";
import { classifyDomain, domainFromEmail, type DomainType } from "@/lib/domains";
import { ARCHETYPES, getStoreProfile } from "@/lib/store-profiles";

export interface CustomerOrderItem {
  title: string;
  quantity: number;
  /** Rango de pauta (dateStart/dateEnd) o null. Ver lib/media-context.ts. */
  pauta?: string | null;
  /** Lo que tecleó el cliente (media_comments) o null. */
  clienteDijo?: string | null;
  /** Lo que contiene la pieza (caption IA) o null. */
  contiene?: string | null;
  categoria?: string | null;
  /** Resto de metadata escalar (talla, color…), sanitizado. */
  detalles?: Record<string, string | number | boolean>;
}

export interface CustomerOrder {
  date: string | null;
  total: number;
  currency: string | null;
  items: CustomerOrderItem[];
}

export interface CustomerRfm {
  recencyDays: number | null;
  frequency: number;
  monetary: number;
  currency: string | null;
  avgTicket: number;
  /** Ciclo esperado de recompra (días): mediana del cliente → ciclo de la tienda → default del arquetipo. */
  expectedCycleDays: number | null;
  /** De dónde salió el ciclo: cliente|tienda|arquetipo. */
  cycleSource: "cliente" | "tienda" | "arquetipo" | null;
  churnMultiplier: number | null;
  /** Estado vs el ciclo esperado: al_dia|por_vencer|vencido. */
  dueStatus: "al_dia" | "por_vencer" | "vencido" | null;
  /** Días desde que venció (0 si aún no vence). */
  overdueDays: number | null;
}

/** Estado vs el ciclo esperado (puro: lo usa la ficha). */
export function dueStatusFor(
  recencyDays: number | null,
  expectedCycleDays: number | null,
  churnMultiplier: number,
): CustomerRfm["dueStatus"] {
  if (recencyDays === null || expectedCycleDays === null) return null;
  if (recencyDays > expectedCycleDays * churnMultiplier) return "vencido";
  if (recencyDays > expectedCycleDays) return "por_vencer";
  return "al_dia";
}

export interface CustomerFirmographics {
  domain: string;
  domainType: DomainType | "none";
  enrichable: boolean;
  enriched: boolean;
  companyName: string | null;
  industry: string | null;
  description: string | null;
  size: string | null;
  location: string | null;
  logoUrl: string | null;
  sourceUrl: string | null;
  confidence: number | null;
  enrichedAt: string | null;
}

/** Mediana de intervalos entre compras (días). null si F<2 o sin fechas.
 *  Un solo gap no es ritmo: se exigen ≥2 gaps (≥3 sesiones); si no, null y el
 *  ciclo cae a tienda/arquetipo. */
export function medianInterval(datesAsc: Date[]): number | null {
  if (datesAsc.length < 2) return null;
  // Sesiones: pedidos con <1d de separación son una sola compra en cuotas
  // (mismo día / pagos partidos), no cadencia. Solo gaps entre sesiones cuentan.
  const sessions: Date[] = [datesAsc[0]];
  for (let i = 1; i < datesAsc.length; i += 1) {
    const gap = (datesAsc[i].getTime() - sessions[sessions.length - 1].getTime()) / 86_400_000;
    if (gap >= 1) sessions.push(datesAsc[i]);
  }
  if (sessions.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sessions.length; i += 1) {
    gaps.push((sessions[i].getTime() - sessions[i - 1].getTime()) / 86_400_000);
  }
  if (gaps.length < 2) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(1, Math.round(med));
}

export interface CustomerOrdersAndRfm {
  orders: CustomerOrder[];
  summary: CustomerRfm;
}

/** Compras (más reciente primero) + hechos temporales del cliente.
 *  Display pagina N recientes; la mediana del ciclo se calcula sobre el
 *  historial completo (solo fechas, paginado) para no sesgar con la ventana. */
export async function loadCustomerOrdersAndRfm(
  dbId: string,
  orderLimit = 20,
  offset = 0,
): Promise<(CustomerOrdersAndRfm & { totalOrders: number; truncated: boolean }) | null> {
  const db = getSupabase();
  const { data: customer, error: custErr } = await db
    .from("customers")
    .select("store_id,orders_count,total_spent,currency,last_order_at")
    .eq("id", dbId)
    .maybeSingle();
  if (custErr || !customer) return null;

  // Ventana display: trae de más por test/canceladas, pagina por offset real.
  // Orden estable (placed_at + id): sin tie-breaker el offset duplica/omite.
  const { data: orders, error } = await db
    .from("orders")
    .select("total_amount,currency,placed_at,items_json,status,payment_status,is_test")
    .eq("customer_id", dbId)
    .order("placed_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + Math.max(orderLimit * 3, 60) - 1);
  if (error) throw new Error(error.message);

  // Solo compras reales: misma regla que los agregados del sync
  // (cabecera orders_count ↔ lista visibles, por construcción).
  const realRows = ((orders as Array<Record<string, unknown>> | null) ?? []).filter((o) =>
    isRealOrder({
      status: (o.status as string) ?? null,
      paymentStatus: (o.payment_status as string) ?? null,
      isTest: Boolean(o.is_test),
    }),
  );
  const sliced = realRows.slice(0, orderLimit);
  const rawPerOrder = sliced.map((o) =>
    (((o.items_json as Array<Record<string, unknown>>) ?? []).slice(0, 5)).map((i) => ({
      title: String(i.title ?? "—"),
      quantity: Number(i.quantity ?? 0),
      metadata: (i.metadata as Record<string, unknown> | undefined) ?? undefined,
    })),
  );
  // 1 sola query de captions para todas las líneas (ver lib/media-context.ts).
  const enrichedFlat = await enrichOrderItems(customer.store_id as string, rawPerOrder.flat());
  let cursor = 0;
  const orderRows: CustomerOrder[] = sliced.map((o, oi) => {
    const items = enrichedFlat.slice(cursor, cursor + rawPerOrder[oi].length);
    cursor += rawPerOrder[oi].length;
    return {
      date: (o.placed_at as string) ?? null,
      total: Number(o.total_amount ?? 0),
      currency: (o.currency as string) ?? null,
      items,
    };
  });

  const frequency = Number(customer.orders_count ?? 0);
  const monetary = Number(customer.total_spent ?? 0);
  const currency = (customer.currency as string) ?? null;
  const lastRaw = (customer.last_order_at as string) ?? (orderRows[0]?.date as string | null) ?? null;
  const lastDate = lastRaw ? new Date(lastRaw) : null;
  const recencyDays =
    lastDate && !Number.isNaN(lastDate.getTime())
      ? Math.max(0, Math.floor((Date.now() - lastDate.getTime()) / 86_400_000))
      : null;

  // Ciclo esperado: mediana del cliente sobre HISTORIAL COMPLETO (solo fechas,
  // paginado) → ciclo de tienda → arquetipo. No usar la ventana display.
  const allDates: Date[] = [];
  const DPAGE = 1000;
  for (let off = 0; ; off += DPAGE) {
    const { data: dpage, error: dErr } = await db
      .from("orders")
      .select("placed_at,status,payment_status,is_test")
      .eq("customer_id", dbId)
      .order("placed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(off, off + DPAGE - 1);
    if (dErr) throw new Error(dErr.message);
    const rows = (dpage ?? []) as Array<Record<string, unknown>>;
    for (const o of rows) {
      if (!isRealOrder({ status: (o.status as string) ?? null, paymentStatus: (o.payment_status as string) ?? null, isTest: Boolean(o.is_test) })) continue;
      if (!o.placed_at) continue;
      const d = new Date(o.placed_at as string);
      if (!Number.isNaN(d.getTime())) allDates.push(d);
    }
    if (rows.length < DPAGE) break;
    if (allDates.length > 20000) break;
  }
  const customerMedian = medianInterval(allDates);
  const storeId = customer.store_id as string;
  const tenantProfile = await getStoreProfile(storeId).catch(() => null);
  const tenantCycle = tenantProfile?.repurchaseCycleDays ?? null;
  const archetypeCycle = tenantProfile
    ? (ARCHETYPES[tenantProfile.archetype]?.defaultCycleDays ?? null)
    : null;
  const expectedCycleDays = customerMedian ?? tenantCycle ?? archetypeCycle;
  const cycleSource =
    customerMedian !== null ? "cliente" : tenantCycle !== null ? "tienda" : archetypeCycle !== null ? "arquetipo" : null;
  const churnMultiplier = tenantProfile?.churnMultiplier ?? 1.25;
  const dueStatus = dueStatusFor(recencyDays, expectedCycleDays, churnMultiplier);
  const overdueDays =
    recencyDays === null || expectedCycleDays === null
      ? null
      : Math.max(0, recencyDays - expectedCycleDays);

  return {
    orders: orderRows,
    totalOrders: frequency,
    truncated: frequency > orderRows.length + offset,
    summary: {
      recencyDays,
      frequency,
      monetary,
      currency,
      avgTicket: frequency > 0 ? Math.round(monetary / frequency) : 0,
      expectedCycleDays,
      cycleSource,
      churnMultiplier,
      dueStatus,
      overdueDays,
    },
  };
}

/** Firmográficos de la empresa del customer (enriquecimiento por dominio). */
export async function loadCustomerFirmographics(
  dbId: string,
): Promise<CustomerFirmographics | null> {
  const db = getSupabase();
  const { data: customer, error } = await db
    .from("customers")
    .select("email")
    .eq("id", dbId)
    .maybeSingle();
  if (error || !customer) return null;

  const domain = domainFromEmail(String(customer.email ?? ""));
  const cls = classifyDomain(domain);
  const base: CustomerFirmographics = {
    domain,
    domainType: cls.type,
    enrichable: cls.enrichable,
    enriched: false,
    companyName: null,
    industry: null,
    description: null,
    size: null,
    location: null,
    logoUrl: null,
    sourceUrl: null,
    confidence: null,
    enrichedAt: null,
  };
  if (!cls.enrichable) return base;

  const { data: row } = await db.from("domains").select("*").eq("domain", domain).maybeSingle();
  if (!row) return base;

  return {
    ...base,
    enriched: true,
    companyName: (row.company_name as string) ?? null,
    industry: (row.industry as string) ?? null,
    description: (row.description as string) ?? null,
    size: (row.size as string) ?? null,
    location: (row.location as string) ?? null,
    logoUrl: (row.logo_url as string) ?? null,
    sourceUrl: (row.source_url as string) ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    enrichedAt: (row.enriched_at as string) ?? null,
  };
}
