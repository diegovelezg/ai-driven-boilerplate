// Lecturas de compras + firmográficos de un customer. Compartido por las API
// routes y las tools del agente ADK (misma fuente de verdad).
import { getSupabase } from "@/lib/supabase";
import { isRealOrder } from "@/lib/medusa";
import { enrichOrderItems } from "@/lib/item-context";
import { classifyDomain, domainFromEmail, type DomainType } from "@/lib/domains";

export interface CustomerOrderItem {
  title: string;
  quantity: number;
  /** Precio unitario pagado (minor units) o null. Tal cual en items_json. */
  unitPrice?: number | null;
  /** Ventana (start/end) o null: pauta, turno, reserva… Ver lib/item-context.ts. */
  ventana?: string | null;
  /** Lo que escribió el cliente (comentario/nota) o null. */
  clienteDijo?: string | null;
  /** Sobre qué es la línea (contenido IA o catálogo) o null. */
  contiene?: string | null;
  categoria?: string | null;
  /** Resto de metadata (texto corto/número), sanitizado. */
  detalles?: Record<string, string | number>;
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
  /** @deprecated Ficha legacy: siempre null. El ritmo lo da el motor (p25/p75). */
  expectedCycleDays: number | null;
  /** @deprecated Ficha legacy: siempre null. */
  cycleSource: "cliente" | "tienda" | "arquetipo" | null;
  /** @deprecated Ficha legacy: siempre null. */
  churnMultiplier: number | null;
  /** @deprecated Ficha legacy: siempre null. Decisión real en `customer_predictions.decision`. */
  dueStatus: "al_dia" | "por_vencer" | "vencido" | null;
  /** @deprecated Ficha legacy: siempre null. */
  overdueDays: number | null;
}

/** @deprecated Ficha legacy: se conserva por compatibilidad/tests. Siempre retorna null en UI nueva. */
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

export interface CustomerOrdersAndRfm {
  orders: CustomerOrder[];
  summary: CustomerRfm;
}

/** Compras (más reciente primero) + hechos duros del cliente.
 *  El ciclo esperado legacy ya no se calcula (ficha usa el motor p25/p75):
 *  los campos deprecated van siempre null, sin queries extra. */
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
      unitPrice: i.unit_price == null ? null : Number(i.unit_price),
      metadata: (i.metadata as Record<string, unknown> | undefined) ?? undefined,
    })),
  );
  // 1 sola query de contenido para todas las líneas (ver lib/item-context.ts).
  // Keys del mapa del tenant (settings → metadata_map); sin mapa, todo a detalles.
  const { resolveItemKeys } = await import("@/lib/metadata-map");
  const itemKeys = await resolveItemKeys(customer.store_id as string).catch(() => null);
  const enrichedFlat = await enrichOrderItems(customer.store_id as string, rawPerOrder.flat(), itemKeys ?? undefined);
  let cursor = 0;
  const orderRows: CustomerOrder[] = sliced.map((o, oi) => {
    const items = enrichedFlat
      .slice(cursor, cursor + rawPerOrder[oi].length)
      .map((it, k) => ({ ...it, unitPrice: rawPerOrder[oi][k]?.unitPrice ?? null }));
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
      expectedCycleDays: null,
      cycleSource: null,
      churnMultiplier: null,
      dueStatus: null,
      overdueDays: null,
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
