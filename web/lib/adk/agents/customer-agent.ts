import { FunctionTool, LlmAgent } from "@google/adk";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { getCrmCompany, listCrmCompanies } from "@/lib/crm-db";
import { getOrderDetail, listOrders } from "@/lib/orders-db";
import { listScreens } from "@/lib/screens-db";
import { getScreenConflicts } from "@/lib/availability";
import { bucketMonthly, computeFinanceKpis } from "@/lib/finance";
import { getDashboardSnapshot } from "@/lib/dashboard";
import { ORDER_STAGE_LABELS, orderStage } from "@/lib/order-stage";
import { BILLING_LABELS, billingStatus } from "@/lib/billing-status";
import { invoiceMatchesOrder, normalizeCurrency } from "@/lib/currency";

export interface AgentContext {
  storeId: string | null;
  customerId?: string | null;
  companyId?: string | null;
  view?: string | null;
  focusLabel?: string | null;
}

export const CUSTOMER_AGENT_NAME = "dooh_agent";

const DOOH_INSTRUCTION = `Eres dooh_agent, el asistente comercial DOOH de la tienda (único agente del día a día).
Respondes sobre empresas (anunciantes, agencias, proveedores), órdenes de inserción, pantallas/inventario y finanzas.
Tienes 5 tools de SOLO LECTURA: get_company, get_order, search_inventory, get_finance, explain_kpi. Úsalas antes de afirmar cifras.
Nunca inventes montos, fechas ni disponibilidad: si la tool devuelve vacío o error, dilo en honesto.
No hablas de churn, predicciones, winback ni scoring: ese motor no existe en este producto.
No escribes en base de datos: para crear/editar se usan las server actions existentes de la UI, nunca INSERT desde el chat.
Moneda siempre explícita (PEN/USD según la orden o la vista); nunca mezcles monedas ni heredes en silencio.
En accionables, enlaza a la vista real: /orders/:id, /screens, /companies/:id.`;

function needStore(ctx: AgentContext): string | null {
  return ctx.storeId ?? null;
}

function getCompanyTool(ctx: AgentContext) {
  return new FunctionTool({
    name: "get_company",
    description:
      "Ficha de una empresa del tenant (anunciante/agencia/proveedor) con contactos y OIs. Busca por company_id exacto o por texto q (nombre/tax_id/dominio).",
    parameters: z.object({
      company_id: z.string().uuid().describe("ID exacto de la empresa (crm_companies.id).").optional(),
      q: z.string().min(2).max(120).describe("Texto a buscar (nombre, RUC, dominio o email).").optional(),
    }),
    execute: async ({ company_id, q }: { company_id?: string; q?: string }) => {
      const storeId = needStore(ctx);
      if (!storeId) return { error: "Sin tienda en contexto." };
      if (!company_id && !q) return { error: "Pasa company_id o q (mínimo 2 caracteres)." };
      try {
        if (company_id) {
          const detail = await getCrmCompany(storeId, company_id);
          if (!detail) return { error: "Empresa no encontrada." };
          const c = detail.company as Record<string, unknown>;
          return {
            id: String(c.id ?? company_id),
            name: (c.name as string | null) ?? null,
            kind: (c.kind as string | null) ?? null,
            tax_id: (c.tax_id as string | null) ?? null,
            domain: (c.domain as string | null) ?? null,
            email: (c.email as string | null) ?? null,
            phone: (c.phone as string | null) ?? null,
            city: (c.city as string | null) ?? null,
            country: (c.country as string | null) ?? null,
            contacts: detail.contacts.slice(0, 20).map((t) => ({
              id: t.id,
              name: [t.first_name, t.last_name].filter(Boolean).join(" ") || null,
              email: t.email,
              phone: t.phone,
              job_title: t.job_title,
              is_primary: t.is_primary,
            })),
            ios: detail.ios.slice(0, 20),
            campaigns_count: detail.campaigns.length,
          };
        }
        const found = await listCrmCompanies(storeId, { q: q ?? "", pageSize: 5 });
        if (found.total === 0) return { found: 0, candidates: [] };
        if (found.rows.length === 1) {
          const detail = await getCrmCompany(storeId, found.rows[0].id);
          if (!detail) return { found: 1, candidates: found.rows };
          const c = detail.company as Record<string, unknown>;
          return {
            found: 1,
            id: String(c.id ?? ""),
            name: (c.name as string | null) ?? null,
            kind: (c.kind as string | null) ?? null,
            contacts: detail.contacts.slice(0, 20),
            ios: detail.ios.slice(0, 20),
          };
        }
        return {
          found: found.total,
          candidates: found.rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, tax_id: r.tax_id })),
          hint: "Varias coincidencias: reintenta con company_id exacto.",
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Lectura de empresa falló." };
      }
    },
  });
}

function getOrderTool(ctx: AgentContext) {
  return new FunctionTool({
    name: "get_order",
    description:
      "Estado real de una orden de inserción: etapa operativa (Firmada/Materiales/Al aire/Por certificar/Cerrada), OM, materiales/QC y cobro en paralelo. Busca por order_id, io_number o texto q.",
    parameters: z.object({
      order_id: z.string().uuid().describe("ID exacto de la orden (io_orders.id).").optional(),
      io_number: z.string().min(3).max(40).describe("Número legible (p.ej. SM-2026-0005).").optional(),
      q: z.string().min(2).max(120).describe("Texto a buscar (marca, anunciante o número).").optional(),
    }),
    execute: async ({ order_id, io_number, q }: { order_id?: string; io_number?: string; q?: string }) => {
      const storeId = needStore(ctx);
      if (!storeId) return { error: "Sin tienda en contexto." };
      if (!order_id && !io_number && !q) return { error: "Pasa order_id, io_number o q." };
      try {
        const db = getSupabase();
        let targetId: string | null = order_id ?? null;
        if (!targetId) {
          const needle = (io_number ?? q ?? "").trim();
          const rows = await listOrders(storeId, { q: needle });
          if (rows.length === 0) return { error: `Sin órdenes para "${needle}".` };
          const exact = io_number
            ? rows.find((r) => r.io_number.toLowerCase() === io_number.toLowerCase())
            : rows.length === 1
              ? rows[0]
              : null;
          if (!exact) {
            return {
              found: rows.length,
              candidates: rows.slice(0, 5).map((r) => ({
                id: r.id,
                io_number: r.io_number,
                brand: r.brand,
                stage: ORDER_STAGE_LABELS[r.stage],
                billing: BILLING_LABELS[r.billing],
              })),
              hint: "Varias coincidencias: reintenta con order_id o io_number exacto.",
            };
          }
          targetId = exact.id;
        }
        const detail = await getOrderDetail(storeId, targetId!);
        if (!detail) return { error: "Orden no encontrada." };
        const o = detail.order as Record<string, unknown>;
        const status = String(o.status ?? "");
        const hasOm = detail.io_agency_orders.length > 0;
        const creaAny = detail.creatives.length > 0;
        const creaPending = detail.creatives.filter(
          (c) => c.qc_status !== "approved" || c.legal_status !== "approved",
        ).length;
        const materialsOk = creaAny && creaPending === 0;
        const endsAt = o.ends_at ? Date.parse(String(o.ends_at)) : NaN;
        const ended = Number.isFinite(endsAt) ? endsAt <= Date.now() : false;
        const certified = detail.photos_count > 0;
        const { index, stage } = orderStage({
          status: status || null,
          signed: status === "signed",
          hasOm,
          materialsOk,
          ended,
          certified,
        });
        const gross = detail.lines.reduce((a, l) => a + Number(l.rate_minor ?? 0), 0);
        const orderCurrency = normalizeCurrency(o.currency ?? "PEN", "PEN");
        const invSame = detail.invoices.filter((v) => invoiceMatchesOrder(v.currency, orderCurrency));
        const bill = billingStatus({
          gross_minor: gross,
          invoices: invSame.map((v) => ({
            amount_minor: Number(v.amount_minor ?? 0),
            status: String(v.status ?? ""),
            issue_date: (v.issue_date as string | null) ?? null,
            due_date: (v.due_date as string | null) ?? null,
          })),
          starts_at: (o.starts_at as string | null) ?? null,
          payment_terms_days: typeof o.payment_terms_days === "number" ? (o.payment_terms_days as number) : null,
        });
        void db;
        return {
          id: String(o.id ?? targetId),
          io_number: (o.io_number as string | null) ?? null,
          brand: (o.brand as string | null) ?? null,
          status,
          stage,
          stage_label: ORDER_STAGE_LABELS[stage],
          stage_index: index,
          advertiser: detail.advertiser_name,
          billing_company: detail.billing_name,
          starts_at: (o.starts_at as string | null) ?? null,
          ends_at: (o.ends_at as string | null) ?? null,
          currency: orderCurrency,
          om: { has_om: hasOm, count: detail.io_agency_orders.length },
          materiales: { any: creaAny, pending: creaPending, ok: materialsOk },
          evidencia: { photos: detail.photos_count, certified },
          cobertura: { lines: detail.lines.length, bookings: detail.bookings_count, gross_minor: gross },
          cobro: {
            status: bill.status,
            label: BILLING_LABELS[bill.status],
            invoiced_minor: bill.invoiced_minor,
            paid_minor: bill.paid_minor,
            pending_minor: bill.pending_minor,
            overdue_minor: bill.overdue_minor,
            is_prepaid: bill.isPrepaid,
          },
          deep_link: `/orders/${String(o.id ?? targetId)}`,
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Lectura de orden falló." };
      }
    },
  });
}

function searchInventoryTool(ctx: AgentContext) {
  return new FunctionTool({
    name: "search_inventory",
    description:
      "Busca pantallas del inventario por texto/ciudad y marca ocupación en un periodo. Respeta el hard-hold io_check_hold_overlap: un booking confirmado/activo solapa y bloquea el slot.",
    parameters: z.object({
      q: z.string().min(2).max(120).describe("Texto (pantalla, venue, distrito, marca).").optional(),
      city: z.string().min(2).max(80).describe("Ciudad (p.ej. Lima).").optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inicio inclusivo yyyy-mm-dd.").optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fin inclusivo yyyy-mm-dd.").optional(),
    }),
    execute: async ({ q, city, from, to }: { q?: string; city?: string; from?: string; to?: string }) => {
      const storeId = needStore(ctx);
      if (!storeId) return { error: "Sin tienda en contexto." };
      if ((from && !to) || (!from && to)) return { error: "Pasa from y to juntos (yyyy-mm-dd)." };
      if (from && to && to < from) return { error: `Rango inválido: ${from} > ${to}.` };
      try {
        const found = await listScreens(storeId, {
          q: q ?? "",
          city: city ?? null,
          active: "active",
          pageSize: 20,
        });
        if (found.total === 0) return { found: 0, rows: [] };
        if (!from || !to) {
          return {
            found: found.total,
            rows: found.rows.map((s) => ({
              id: s.id,
              name: s.name,
              city: s.city,
              venue: s.venue_name,
              price_pen: s.price_pen,
              impact_day: s.impact_day,
            })),
            hint: "Sin periodo: ocupación no evaluada. Pasa from/to para disponibilidad.",
          };
        }
        const conflicts = await getScreenConflicts(storeId, from, to);
        const busyBy = new Map<string, typeof conflicts>();
        for (const c of conflicts) {
          const arr = busyBy.get(c.screen_id) ?? [];
          arr.push(c);
          busyBy.set(c.screen_id, arr);
        }
        return {
          found: found.total,
          period: { from, to },
          rows: found.rows.map((s) => {
            const busy = busyBy.get(s.id) ?? [];
            return {
              id: s.id,
              name: s.name,
              city: s.city,
              venue: s.venue_name,
              price_pen: s.price_pen,
              free: busy.length === 0,
              conflicts: busy.slice(0, 3).map((c) => ({
                io_number: c.io_number,
                brand: c.brand,
                starts: c.starts,
                ends: c.ends,
                source: c.source,
              })),
            };
          }),
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Búsqueda de inventario falló." };
      }
    },
  });
}

async function fetchFinance(storeId: string, currency?: string) {
  const db = getSupabase();
  const { data: store } = await db.from("sys_stores").select("shop_currency").eq("id", storeId).maybeSingle();
  const base = normalizeCurrency((store as Record<string, unknown> | null)?.shop_currency ?? "PEN", "PEN");
  const viewCurrency = currency ? normalizeCurrency(currency, base) : base;
  const { data: ioData, error: ioErr } = await db
    .from("io_orders")
    .select("id,currency")
    .eq("store_id", storeId)
    .neq("status", "cancelled")
    .limit(500);
  if (ioErr) throw new Error(`ios: ${ioErr.message}`);
  const ios = (ioData ?? []) as Array<Record<string, unknown>>;
  const ioIds = ios.map((r) => String(r.id));
  const currencyByIo = new Map(ios.map((r) => [String(r.id), normalizeCurrency(r.currency, viewCurrency)]));
  let lineRows: Array<Record<string, unknown>> = [];
  if (ioIds.length > 0) {
    const { data: ldata, error: lerr } = await db
      .from("io_lines")
      .select("io_id,rate_minor,starts_at")
      .eq("store_id", storeId)
      .in("io_id", ioIds)
      .limit(5000);
    if (lerr) throw new Error(`lineas: ${lerr.message}`);
    lineRows = (ldata ?? []) as Array<Record<string, unknown>>;
  }
  const { data: invData, error: invErr } = await db
    .from("io_invoices")
    .select("amount_minor,currency,status")
    .eq("store_id", storeId)
    .limit(2000);
  if (invErr) throw new Error(`facturas: ${invErr.message}`);
  const invRows = (invData ?? []) as Array<Record<string, unknown>>;
  const finOrders = lineRows
    .filter((r) => currencyByIo.get(String(r.io_id ?? "")) === viewCurrency)
    .map((r) => ({
      total_amount: Number(r.rate_minor ?? 0),
      currency: viewCurrency,
      placed_at: (r.starts_at as string | null) ?? null,
    }));
  const buckets = bucketMonthly(finOrders, viewCurrency);
  const kpis = computeFinanceKpis(finOrders, viewCurrency);
  let invoiced = 0;
  let paid = 0;
  for (const v of invRows) {
    if (!invoiceMatchesOrder(v.currency, viewCurrency)) continue;
    const amount = Math.max(0, Math.round(Number(v.amount_minor ?? 0) || 0));
    const st = String(v.status ?? "");
    if (st === "cancelled" || st === "draft" || amount <= 0) continue;
    if (st === "paid" || st === "issued" || st === "overdue") invoiced += amount;
    if (st === "paid") paid += amount;
  }
  return { currency: viewCurrency, base, buckets, kpis, invoiced_minor: invoiced, paid_minor: paid, pending_minor: Math.max(0, invoiced - paid) };
}

function getFinanceTool(ctx: AgentContext) {
  return new FunctionTool({
    name: "get_finance",
    description:
      "KPIs de finanzas DOOH en una moneda explícita: ventas 30d, órdenes, ticket, deltas y cobro (facturado/cobrado/pendiente). Nunca mezcla monedas.",
    parameters: z.object({
      currency: z.string().regex(/^[A-Za-z]{3}$/).describe("ISO3 explícita (p.ej. PEN). Vacío = moneda base.").optional(),
    }),
    execute: async ({ currency }: { currency?: string }) => {
      const storeId = needStore(ctx);
      if (!storeId) return { error: "Sin tienda en contexto." };
      try {
        const f = await fetchFinance(storeId, currency);
        return {
          currency: f.currency,
          ventas_30d_minor: f.kpis.sales30dMinor,
          ordenes_30d: f.kpis.orders30d,
          ticket_medio_minor: f.kpis.ticket30dMinor,
          delta_ventas_pct: f.kpis.salesDeltaPct,
          delta_ordenes_pct: f.kpis.ordersDeltaPct,
          cobro: { facturado_minor: f.invoiced_minor, cobrado_minor: f.paid_minor, pendiente_minor: f.pending_minor },
          ultimos_3_meses: f.buckets.slice(-3),
          deep_link: "/finance",
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Lectura de finanzas falló." };
      }
    },
  });
}

const EXPLAINABLE_KPIS = [
  "ventas_30d",
  "ticket",
  "cobranza",
  "ocupacion_14d",
  "al_aire",
  "por_certificar",
  "renovacion_30d",
  "huecos",
  "alertas",
] as const;

function explainKpiTool(ctx: AgentContext) {
  return new FunctionTool({
    name: "explain_kpi",
    description:
      "Explica un KPI del Hoy (muro de insights): qué significa, números exactos del snapshot y 1 accionable con deep-link. Nunca inventa cifras; sin novedad, silencio honesto.",
    parameters: z.object({
      kpi: z.enum(EXPLAINABLE_KPIS).describe("Indicador a explicar."),
      currency: z.string().regex(/^[A-Za-z]{3}$/).describe("ISO3 explícita para montos.").optional(),
    }),
    execute: async ({ kpi, currency }: { kpi: (typeof EXPLAINABLE_KPIS)[number]; currency?: string }) => {
      const storeId = needStore(ctx);
      if (!storeId) return { error: "Sin tienda en contexto." };
      try {
        const [snap, fin] = await Promise.all([getDashboardSnapshot(storeId), fetchFinance(storeId, currency)]);
        const cur = fin.currency;
        switch (kpi) {
          case "ventas_30d":
            return {
              kpi,
              currency: cur,
              lectura: `Vendes ${fin.kpis.orders30d} órdenes por ${fin.kpis.sales30dMinor} céntimos en 30d (ticket ${fin.kpis.ticket30dMinor}).`,
              numeros: fin.kpis,
              accionable: fin.kpis.orders30d === 0 ? "Sin órdenes 30d: revisa inventario libre en /screens." : "Detalle por marca y pantalla en /finance.",
              deep_link: "/finance",
            };
          case "ticket":
            return {
              kpi,
              currency: cur,
              lectura: `Ticket medio 30d: ${fin.kpis.ticket30dMinor} céntimos por orden.`,
              numeros: { ticket: fin.kpis.ticket30dMinor, ordenes: fin.kpis.orders30d },
              accionable: "Compara mejor/peor mes en /finance.",
              deep_link: "/finance",
            };
          case "cobranza":
            return {
              kpi,
              currency: cur,
              lectura: `Facturado ${fin.invoiced_minor}, cobrado ${fin.paid_minor}, pendiente ${fin.pending_minor} (${cur}).`,
              numeros: { facturado: fin.invoiced_minor, cobrado: fin.paid_minor, pendiente: fin.pending_minor },
              accionable: "Prioriza vencidas en /finance.",
              deep_link: "/finance",
            };
          case "ocupacion_14d":
            return {
              kpi,
              lectura: snap.ocupacion14d.ratio === null
                ? "Sin pantallas activas para medir ocupación."
                : `Ocupación 14d: ${Math.round(snap.ocupacion14d.ratio * 100)}% (${snap.ocupacion14d.diasVendidos}/${snap.ocupacion14d.diasDisponibles} pantalla-día).`,
              numeros: snap.ocupacion14d,
              accionable: snap.huecos.length > 0 ? `Hueco mayor: ${snap.huecos[0].screenName} (${snap.huecos[0].diasLibres}d libres). Ver /screens.` : "Sin huecos top: ver /screens.",
              deep_link: "/screens",
            };
          case "al_aire":
            return {
              kpi,
              lectura: `${snap.alAire.ois} OIs al aire en ${snap.alAire.pantallas} pantallas hoy.`,
              numeros: snap.alAire,
              accionable: "Detalle por orden en /orders.",
              deep_link: "/orders",
            };
          case "por_certificar":
            return {
              kpi,
              lectura: `${snap.porCertificar} OIs terminadas sin foto-check: riesgo de disputa al cobrar.`,
              numeros: { por_certificar: snap.porCertificar },
              accionable: snap.porCertificar > 0 ? "Sube evidencia antes de facturar. Ver /orders." : "Sin pendientes de certificación.",
              deep_link: "/orders",
            };
          case "renovacion_30d":
            return {
              kpi,
              lectura: `${snap.renovacion30d.conRelevo}/${snap.renovacion30d.total} OIs que terminan en 30d tienen relevo del mismo anunciante.`,
              numeros: snap.renovacion30d,
              accionable: snap.renovacion30d.total - snap.renovacion30d.conRelevo > 0 ? "Contacta anunciantes sin relevo (ficha en /companies)." : "Todo con relevo.",
              deep_link: "/orders",
            };
          case "huecos":
            return {
              kpi,
              lectura: snap.huecos.length === 0 ? "Sin huecos medidos." : `Top huecos 14d: ${snap.huecos.slice(0, 3).map((h) => `${h.screenName} (${h.diasLibres}d)`).join(", ")}.`,
              numeros: snap.huecos.slice(0, 5),
              accionable: "Oferta esos huecos a anunciantes activos. Ver /screens.",
              deep_link: "/screens",
            };
          case "alertas":
            return {
              kpi,
              lectura: snap.alerts.length === 0 ? "Sin alertas operativas." : `${snap.alerts.length} alertas: ${snap.alerts.slice(0, 3).map((a) => `${a.kind} ${a.ioNumber}`).join(", ")}.`,
              numeros: snap.alerts.slice(0, 5).map((a) => ({ kind: a.kind, io: a.ioNumber, detail: a.detail })),
              accionable: snap.alerts.length > 0 ? `Ataca primero ${snap.alerts[0].kind} ${snap.alerts[0].ioNumber}: ${snap.alerts[0].detail} (/orders/${snap.alerts[0].ioId}).` : "Todo bajo control.",
              deep_link: snap.alerts.length > 0 ? `/orders/${snap.alerts[0].ioId}` : "/orders",
            };
        }
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Explicación falló." };
      }
    },
  });
}

export function createDoohTools(ctx: AgentContext) {
  return [getCompanyTool(ctx), getOrderTool(ctx), searchInventoryTool(ctx), getFinanceTool(ctx), explainKpiTool(ctx)];
}

/**
 * Agente DOOH único del día a día (negocio/empresas/órdenes/inventario/finanzas).
 * 5 tools read-only cableadas; escrituras vía server actions existentes.
 */
export function getCustomerAgent(ctx?: AgentContext) {
  const safe: AgentContext = {
    storeId: ctx?.storeId ?? null,
    customerId: ctx?.customerId ?? null,
    companyId: ctx?.companyId ?? null,
    view: ctx?.view ?? null,
    focusLabel: ctx?.focusLabel ?? null,
  };
  return new LlmAgent({
    name: CUSTOMER_AGENT_NAME,
    description: "Asistente comercial DOOH: empresas, órdenes, inventario y finanzas.",
    instruction: DOOH_INSTRUCTION,
    tools: createDoohTools(safe),
  });
}
