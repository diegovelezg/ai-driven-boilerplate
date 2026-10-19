// Data analyst del set perfilador: números de la tienda, determinista.
// Sin LLM para los números; el synthesizer los interpreta.
// Aislado del loop de retención: solo lee customers/orders/domains.
import { getSupabase } from "@/lib/supabase";
import { isRealOrder } from "@/lib/medusa";
import { classifyDomain, domainFromEmail } from "@/lib/domains";

export interface TenantStats {
  customers: number;
  buyers: number;
  companyRate: number;
  customDomainRate: number;
  repeatRate: number;
  /** Ticket mediano en moneda de la tienda (minor units tal cual). */
  ticketMedian: number | null;
  ticketCurrency: string | null;
  /** Top dominios propios por nº de customers (quién compra, con evidencia). */
  topDomains: Array<{ domain: string; customers: number }>;
  /** Muestra de companies enriquecidas (si hay). */
  enrichedSample: Array<{ domain: string; company: string | null; industry: string | null }>;
  /** Mediana de medianas de intervalo entre sesiones (días) + qué % de
   *  compradores la informa (≥3 sesiones). Materia del ciclo propuesto. */
  intervalMedian: number | null;
  intervalCoverage: number;
}

const FREE = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "aol.com", "proton.me", "protonmail.com", "uol.com.br",
]);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Stats del tenant para confrontar sector vs realidad. Lanza si falla (sin ceros falsos). */
export async function tenantStats(storeId: string): Promise<TenantStats & { sampleN: number; truncated: boolean }> {
  const db = getSupabase();
  const PAGE = 1000;
  const CAP = 20000;
  const rows: Array<{ email: string; company_name: string | null; orders_count: number }> = [];
  let truncated = false;
  for (let off = 0; ; off += PAGE) {
    const { data: page, error } = await db
      .from("customers")
      .select("email,company_name,orders_count")
      .eq("store_id", storeId)
      .range(off, off + PAGE - 1);
    if (error) throw new Error(`tenantStats customers: ${error.message}`);
    const prows = (page ?? []) as Array<{ email: string; company_name: string | null; orders_count: number }>;
    rows.push(...prows);
    if (prows.length < PAGE) break;
    if (rows.length >= CAP) {
      truncated = true;
      break;
    }
  }
  const n = rows.length;
  let company = 0, repeat = 0, buyers = 0, customCust = 0;
  const domCount = new Map<string, number>();
  for (const r of rows) {
    if (r.company_name?.trim()) company += 1;
    if (Number(r.orders_count ?? 0) >= 2) repeat += 1;
    if (Number(r.orders_count ?? 0) > 0) buyers += 1;
    const d = domainFromEmail(String(r.email ?? ""));
    if (d && classifyDomain(d).enrichable && !FREE.has(d)) {
      customCust += 1;
      domCount.set(d, (domCount.get(d) ?? 0) + 1);
    }
  }
  const topDomains = [...domCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([domain, c]) => ({ domain, customers: c }));

  const orows: Array<{ customer_id: string; total_amount: number; currency: string; placed_at: string | null; status: string | null; payment_status: string | null; is_test: boolean }> = [];
  let ordersTruncated = false;
  for (let off = 0; ; off += PAGE) {
    const { data: opage, error: oErr } = await db.from("orders").select("customer_id,total_amount,currency,placed_at,status,payment_status,is_test").eq("store_id", storeId).range(off, off + PAGE - 1);
    if (oErr) throw new Error(`tenantStats orders: ${oErr.message}`);
    const prows = (opage ?? []) as Array<{ customer_id: string; total_amount: number; currency: string; placed_at: string | null; status: string | null; payment_status: string | null; is_test: boolean }>;
    orows.push(...prows);
    if (prows.length < PAGE) break;
    if (orows.length >= CAP) {
      ordersTruncated = true;
      break;
    }
  }
  const { data: domains } = topDomains.length > 0
    ? await db.from("domains").select("domain,company_name,industry").in("domain", topDomains.map((t) => t.domain)).limit(8)
    : { data: [] as Array<Record<string, unknown>> };
  const byCur = new Map<string, number[]>();
  const byCust = new Map<string, Date[]>();
  for (const o of orows) {
    // Ticket solo sobre órdenes reales: test/canceladas contaminaban la mediana.
    if (!isRealOrder({ status: o.status ?? null, paymentStatus: o.payment_status ?? null, isTest: Boolean(o.is_test) })) continue;
    const cur = String(o.currency ?? "?");
    if (!byCur.has(cur)) byCur.set(cur, []);
    byCur.get(cur)!.push(Number(o.total_amount ?? 0));
    if (!o.placed_at) continue;
    const d = new Date(o.placed_at);
    if (Number.isNaN(d.getTime())) continue;
    if (!byCust.has(o.customer_id)) byCust.set(o.customer_id, []);
    byCust.get(o.customer_id)!.push(d);
  }
  // Mediana de intervalos por cliente (misma sesión: gaps <1d) y mediana global.
  const medians: number[] = [];
  for (const dates of byCust.values()) {
    if (dates.length < 2) continue;
    dates.sort((a, b) => a.getTime() - b.getTime());
    const sessions: Date[] = [dates[0]];
    for (let i = 1; i < dates.length; i += 1) {
      if ((dates[i].getTime() - sessions[sessions.length - 1].getTime()) / 86_400_000 >= 1) {
        sessions.push(dates[i]);
      }
    }
    if (sessions.length < 3) continue;
    const gaps: number[] = [];
    for (let i = 1; i < sessions.length; i += 1) {
      gaps.push((sessions[i].getTime() - sessions[i - 1].getTime()) / 86_400_000);
    }
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    medians.push(gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
  }
  medians.sort((a, b) => a - b);
  const mid = Math.floor(medians.length / 2);
  const intervalMedian =
    medians.length > 0
      ? Math.max(1, Math.round(medians.length % 2 === 1 ? medians[mid] : (medians[mid - 1] + medians[mid]) / 2))
      : null;
  let ticketCurrency: string | null = null;
  let ticketMedian: number | null = null;
  for (const [cur, vals] of byCur) {
    if (ticketMedian === null || vals.length > (byCur.get(ticketCurrency ?? "")?.length ?? 0)) {
      ticketCurrency = cur;
      ticketMedian = median(vals);
    }
  }
  return {
    customers: n,
    buyers,
    companyRate: n > 0 ? company / n : 0,
    customDomainRate: n > 0 ? customCust / n : 0,
    repeatRate: n > 0 ? repeat / n : 0,
    ticketMedian,
    ticketCurrency,
    topDomains,
    enrichedSample: ((domains ?? []) as Array<Record<string, unknown>>).map((d) => ({
      domain: String(d.domain ?? ""),
      company: (d.company_name as string) ?? null,
      industry: (d.industry as string) ?? null,
    })),
    intervalMedian,
    intervalCoverage: buyers > 0 ? medians.length / buyers : 0,
    sampleN: n,
    truncated: truncated || ordersTruncated,
  };
}
