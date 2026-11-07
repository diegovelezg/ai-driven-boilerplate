import { FunctionTool, type BaseTool } from "@google/adk";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { isRealDbOrder } from "@/lib/canonical";
import { formatMoney } from "@/lib/format";
import { rankItems } from "@/lib/finance";
import { domainFromEmail } from "@/lib/domains";
import { queryStoreCustomers } from "@/lib/customers-db";
import { loadCustomerOrdersAndRfm, loadCustomerFirmographics } from "@/lib/customer-data";
import { getIcp, runProspect } from "@/lib/prospect";
import { hasConflict, startRun } from "@/lib/background";

/**
 * Contexto inyectado por la GUI: la tienda siempre; el customer solo cuando hay
 * ficha/drawer abierto; `view` indica desde qué vista se habla (p.ej. 'customers').
 * El contexto enfoca, no limita: sin customerId las tools de ficha lo piden.
 */
export interface AgentContext {
  storeId: string | null;
  customerId?: string | null;
  view?: string | null;
  /** Etiqueta legible del foco (p.ej. "Alonso Javier Carrillo Vega <email>"): orienta mensajes ambiguos. */
  focusLabel?: string | null;
  /**
   * Producto en foco (ficha/drawer de catálogo): habilita las tools
   * get_product_summary/movements/buyers. Sin productId esas tools lo piden.
   */
  productId?: string | null;
  /**
   * Empresa en foco (drawer de empresas): habilita get_company_profile.
   * Sin companyId esa tool lo pide.
   */
  companyId?: string | null;
}

function needStore(ctx: AgentContext): string | null {
  return ctx.storeId ?? null;
}

/**
 * Totales por moneda ya formateados (SSOT `lib/format`, es-PE).
 * El LLM usa el display verbatim en el chat; los minor crudos son solo
 * para comparar/ordenar, nunca los divide ni formatea él.
 */
function moneyByCurrency(map: Record<string, number>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).map(([cur, v]) => [cur, formatMoney(v, cur)]),
  );
}

/** Regla display para descripciones/notes de tools con dinero. */
const DISPLAY_RULE =
  "Cifras *_display ya formateadas (SSOT es-PE): úsalas verbatim en el chat; los minor crudos son solo para comparar/ordenar, nunca los dividas ni formatees tú.";

/**
 * Tools del agente generalista de retención. Ámbito tienda (resumen, señales,
 * acciones, buscar customer) + ámbito ficha (perfil, compras/RFM, empresa
 * enriquecida / empresa CRM, producto) + loop de retención como tools (scout/strategist/copywriter/dispatcher/
 * analyst corren en background y devuelven run_id; el humano aprueba en
 * /review). Lectura + disparo de workers: proponer/enviar nunca es directo.
 */
export function createRetainTools(ctx: AgentContext): BaseTool[] {
  const storeId = needStore(ctx);
  const customerId = ctx.customerId ?? null;
  const productId = ctx.productId ?? null;
  const companyId = ctx.companyId ?? null;

  const summary = new FunctionTool({
    name: "get_store_summary",
    description:
      "Resumen de la tienda B2B: nº de empresas, compradoras, FACTURACIÓN BRUTA acumulada por moneda (revenue_by_currency + revenue_by_currency_display) y por tipo (todo B2B: revenue_by_type + revenue_by_type_display por compat). NO es recupero: ventas ≠ recuperado. Para 'cuánto recuperamos' usa SIEMPRE get_recovery_stats. " + DISPLAY_RULE,
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      // Conteos exactos (no .length de una ventana): única fuente de totales.
      const baseCust = db.from("customers").select("id", { count: "exact", head: true }).eq("store_id", storeId);
      const baseBuyers = db.from("customers").select("id", { count: "exact", head: true }).eq("store_id", storeId).gt("orders_count", 0);
      const sigCountQ = db.from("churn_signals").select("id", { count: "exact", head: true }).eq("store_id", storeId).in("status", ["open", "prioritized"]);
      const actCountQ = db.from("proposed_actions").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("status", "pending_review");
      // Backlog completo del inbox (/review + badge): sin leads el chat cojea.
      // Misma fuente que `app/api/inbox-count/route.ts`.
      const leadCountQ = db.from("proposed_leads").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("status", "pending_review");
      // Agregados (revenue + B2B/B2C): paginado completo en lotes, con flag si se capa.
      // PostgREST no suma por moneda: se pagina y se suma en JS sobre el universo.
      const PAGE = 1000;
      const CAP = 50000;
      let offset = 0;
      let truncated = false;
      const revenue: Record<string, number> = {};
      /** Facturación bruta por tipo efectivo y moneda (issue #14A). */
      const revenueByType: Record<string, Record<string, number>> = { B2B: {}, B2C: {} };
      let b2b = 0;
      let b2c = 0;
      let b2bBuyers = 0;
      let b2cBuyers = 0;
      for (;;) {
        const pageQ = db.from("customers").select("orders_count,total_spent,currency,customer_type,manual_edits").eq("store_id", storeId).order("id", { ascending: true });
        const { data, error: pageErr } = await pageQ.range(offset, offset + PAGE - 1);
        if (pageErr) return { error: pageErr.message };
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        for (const r of rows) {
          const cur = String(r.currency ?? "?");
          revenue[cur] = (revenue[cur] ?? 0) + Number(r.total_spent ?? 0);
          // B2B-only: todo suma a B2B.
          const tipo = "B2B";
          const rev = revenueByType[tipo] ?? (revenueByType[tipo] = {});
          rev[cur] = (rev[cur] ?? 0) + Number(r.total_spent ?? 0);
          const isBuyer = Number(r.orders_count ?? 0) > 0;
          b2b += 1;
          if (isBuyer) b2bBuyers += 1;
        }
        offset += rows.length;
        if (rows.length < PAGE) break;
        if (offset >= CAP) {
          truncated = true;
          break;
        }
      }
      const [{ count: totalCustomers }, { count: totalBuyers }, { count: openSignals }, { count: pendingActions }, { count: leadsPending }, { data: profile }] =
        await Promise.all([baseCust, baseBuyers, sigCountQ, actCountQ, leadCountQ,
          db.from("store_profiles").select("business_model,industry,icp_description").eq("store_id", storeId).maybeSingle(),
        ]);
      const prof = (profile ?? {}) as Record<string, unknown>;
      // Totales honestos (issue #31): si un count exacto falla, null + nota.
      // Prohibido `?? offset` (ventana como total) y `?? 0` (censo falso).
      const totalsFailed =
        totalCustomers == null ||
        totalBuyers == null ||
        openSignals == null ||
        pendingActions == null ||
        leadsPending == null;
      return {
        customers: totalCustomers ?? null,
        buyers: totalBuyers ?? null,
        b2b_count: b2b,
        b2c_count: b2c,
        b2b_buyers: b2bBuyers,
        b2c_buyers: b2cBuyers,
        revenue_by_currency: revenue,
        revenue_by_currency_display: moneyByCurrency(revenue),
        revenue_by_type: revenueByType,
        revenue_by_type_display: Object.fromEntries(
          Object.entries(revenueByType).map(([t, byCur]) => [t, moneyByCurrency(byCur)]),
        ),
        open_signals: openSignals ?? null,
        pending_actions: pendingActions ?? null,
        leads_pending: leadsPending ?? null,
        totals_note: totalsFailed
          ? "Algún conteo exacto falló (null): los null no son 0 ni ventana; pide el resumen de nuevo."
          : null,
        truncated,
        note_truncated: truncated ? "Muestra parcial: universo mayor al CAP paginado; conteos exactos sí, revenue/desglose parciales." : null,
        icp: (prof.icp_description as string) ?? null,
        business_model: (prof.business_model as string) ?? null,
        industry: (prof.industry as string) ?? null,
      };
    },
  });

  const recovery = new FunctionTool({
    name: "get_recovery_stats",
    description:
      "ÚNICA fuente de 'cuánto recuperamos': revenue_attributed medido por el analyst (clientes que volvieron tras acción, ventana según arquetipo). Devuelve rescatado del mes calendario actual y de últimos 30d + nº de conversiones (con gemelos *_display ya formateados). Si es 0/vacío, NO sustituyas con ventas: di 'aún sin recupero medido'. " + DISPLAY_RULE,
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      const { count: totalMeasured } = await getSupabase()
        .from("proposed_actions")
        .select("id", { count: "exact", head: true })
        .eq("store_id", storeId)
        .not("revenue_attributed", "is", null);
      // Paginado completo: el universo atribuido suele ser chico, pero .limit(500)
      // mentía sumas. CAP alto con flag para no colgar el tool.
      const PAGE = 1000;
      const CAP = 20000;
      let offset = 0;
      let truncated = false;
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const last30 = now.getTime() - 30 * 86_400_000;
      let recoveredMonth = 0;
      let recovered30d = 0;
      let convertedMonth = 0;
      let converted30d = 0;
      let measured = 0;
      for (;;) {
        const rq = db
          .from("proposed_actions")
          .select("revenue_attributed,dispatched_at,created_at")
          .eq("store_id", storeId)
          .not("revenue_attributed", "is", null)
          .order("id", { ascending: true });
        const { data, error } = await rq.range(offset, offset + PAGE - 1);
        if (error) return { error: error.message };
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        for (const r of rows) {
          const amt = Number(r.revenue_attributed ?? 0);
          const atRaw = (r.dispatched_at as string | null) ?? (r.created_at as string | null) ?? null;
          if (!atRaw) continue;
          const t = Date.parse(atRaw);
          if (Number.isNaN(t)) continue;
          measured += 1;
          if (t >= monthStart) {
            recoveredMonth += amt;
            if (amt > 0) convertedMonth += 1;
          }
          if (t >= last30) {
            recovered30d += amt;
            if (amt > 0) converted30d += 1;
          }
        }
        offset += rows.length;
        if (rows.length < PAGE) break;
        if (offset >= CAP) {
          truncated = true;
          break;
        }
      }
      const { resolveShopCurrency } = await import("@/lib/store-profiles");
      const cur = ((await resolveShopCurrency(storeId).catch(() => null)) ?? null);
      return {
        recovered_this_month: Math.round(recoveredMonth),
        recovered_this_month_display: formatMoney(Math.round(recoveredMonth), cur),
        converted_this_month: convertedMonth,
        recovered_30d: Math.round(recovered30d),
        recovered_30d_display: formatMoney(Math.round(recovered30d), cur),
        converted_30d: converted30d,
        measured_actions: measured,
        // total_count honesto (issue #31): si el count exacto falla, null +
        // nota; `measured` es ventana parcial (CAP 20k + solo fechas válidas).
        total_measured: totalMeasured ?? null,
        truncated,
        note_truncated: truncated
          ? "Muestra parcial: universo atribuido mayor al CAP 20k; recovered_*/converted_* parciales."
          : null,
        totals_note: totalMeasured == null
          ? "Total no disponible (count falló): measured_actions es ventana, no censo."
          : null,
        note: "Solo revenue_attributed (retención medida). La facturación bruta de get_store_summary NUNCA es recupero. " + DISPLAY_RULE,
      };
    },
  });

  const signals = new FunctionTool({
    name: "list_signals",
    description:
      "Señales del scout (quién debería haber recomprado, con motivo). Insumo interno del loop, no vocabulario del merchant: para sus preguntas usa las decisiones del motor (filter_customers: actuar, vigilar…) y responde en el chat. Si el merchant pide una cantidad ('los 3 primeros', 'dame 5'), pásala en 'limit' (1-20, default 10). Sin panel lateral (solo actions/leads/filter abren Review a la derecha). Paginación con 'offset' (default 0).",
    parameters: z.object({
      status: z.enum(["open", "prioritized", "actioned", "closed", "dismissed"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    }),
    execute: async ({ status, limit, offset }: { status?: string; limit?: number; offset?: number }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const wanted = status ? [status] : ["open", "prioritized"];
      const n = limit ?? 10;
      const off = offset ?? 0;
      const { count } = await getSupabase().from("churn_signals").select("id", { count: "exact", head: true }).eq("store_id", storeId).in("status", wanted);
      const sq = getSupabase()
        .from("churn_signals")
        .select("id,customer_id,kind,score,reason,status,created_at,customers(email,first_name,last_name)")
        .eq("store_id", storeId)
        .in("status", wanted);
      const { data, error } = await sq
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(off, off + n - 1);
      if (error) return { error: error.message };
      const rows = data ?? [];
      // total_count honesto (issue #30): si el count falló, null + nota.
      if (count == null) {
        return {
          items: rows,
          total_count: null,
          returned_count: rows.length,
          truncated: null,
          note: "Total no disponible (count falló): hay más, pide offset.",
        };
      }
      return {
        items: rows,
        total_count: count,
        returned_count: rows.length,
        truncated: count > off + rows.length,
      };
    },
  });

  const actions = new FunctionTool({
    name: "list_actions",
    description:
      "Acciones propuestas (mensajes WhatsApp/email). Por defecto las pendientes de revisión del humano. Si el merchant pide una cantidad ('los 3 primeros') pásala en 'limit' (1-20, default 10); 'channel' SOLO existe en esta lista (señales/leads no filtran por canal). Paginación con 'offset' (default 0). Cada fila trae revenue_attributed + revenue_attributed_display (SSOT es-PE, verbatim). Escrituras (approve/reject) son globales a la tienda, no filtran por market.",
    parameters: z.object({
      status: z.enum(["pending_review", "approved", "rejected", "dispatched", "failed"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      channel: z.enum(["whatsapp", "email"]).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    }),
    execute: async ({ status, limit, channel, offset }: { status?: string; limit?: number; channel?: string; offset?: number }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const n = limit ?? 10;
      const off = offset ?? 0;
      let countQ = getSupabase()
        .from("proposed_actions")
        .select("id", { count: "exact", head: true })
        .eq("store_id", storeId)
        .eq("status", status ?? "pending_review");
      if (channel) countQ = countQ.eq("channel", channel);
      const { count } = await countQ;
      let aq = getSupabase()
        .from("proposed_actions")
        .select("id,customer_id,channel,subject,body,status,created_at,signal_id,revenue_attributed,dispatched_at,approved_by,evidence_json,customers(email,first_name,last_name),churn_signals(reason,score,kind)")
        .eq("store_id", storeId)
        .eq("status", status ?? "pending_review");
      if (channel) aq = aq.eq("channel", channel);
      let data: Array<Record<string, unknown>> | null = null;
      let error: { message: string } | null = null;
      {
        const res = await aq
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(off, off + n - 1);
        data = (res.data ?? []) as Array<Record<string, unknown>>;
        error = (res.error ?? null) as { message: string } | null;
      }
      // Fallback sin approved_by: DBs aún sin la migración 20261022000000
      // (mismo criterio que el feed sentFeed de page.tsx).
      if (error && /approved_by/i.test(error.message)) {
        let aq2 = getSupabase()
          .from("proposed_actions")
          .select("id,customer_id,channel,subject,body,status,created_at,signal_id,revenue_attributed,dispatched_at,evidence_json,customers(email,first_name,last_name),churn_signals(reason,score,kind)")
          .eq("store_id", storeId)
          .eq("status", status ?? "pending_review");
        if (channel) aq2 = aq2.eq("channel", channel);
        const res2 = await aq2
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(off, off + n - 1);
        data = (res2.data ?? []) as Array<Record<string, unknown>>;
        error = (res2.error ?? null) as { message: string } | null;
      }
      if (error) return { error: error.message };
      const { resolveShopCurrency: resolveShopCurrencyActions } = await import("@/lib/store-profiles");
      const shopCurActions = ((await resolveShopCurrencyActions(storeId).catch(() => null)) ?? null)?.toUpperCase() ?? null;
      const rows = (data ?? []).map((r) => ({
        ...r,
        revenue_attributed_display:
          r.revenue_attributed == null ? null : formatMoney(Number(r.revenue_attributed), shopCurActions),
      }));
      if (count == null) {
        return {
          items: rows,
          total_count: null,
          returned_count: rows.length,
          truncated: null,
          note: "Total no disponible (count falló): hay más, pide offset.",
        };
      }
      return {
        items: rows,
        total_count: count,
        returned_count: rows.length,
        truncated: count > off + rows.length,
      };
    },
  });

  /** Escritura con guarda: solo filas pending de ESTA tienda cambian. Global-a-tienda (issue #30): no filtra por market. */
  async function setActionsStatus(
    ids: string[],
    status: "approved" | "rejected",
  ): Promise<Record<string, unknown>> {
    if (!storeId) return { error: "Sin tienda en contexto." };
    const { data, error } = await getSupabase()
      .from("proposed_actions")
      .update({ status })
      .in("id", ids)
      .eq("store_id", storeId)
      .eq("status", "pending_review")
      .select("id");
    if (error) return { error: error.message };
    const n = (data ?? []).length;
    revalidatePath("/review");
    return {
      updated: n,
      requested: ids.length,
      status,
      note:
        n < ids.length
          ? "Algunos ya no estaban pendientes (IDs inválidos o ya movidos)."
          : null,
    };
  }

  const approveActions = new FunctionTool({
    name: "approve_actions",
    description:
      "Aprueba borradores pendientes para que el dispatcher pueda enviarlos. SOLO después de confirmación explícita del merchant en esta conversación (p.ej. 'sí, aprueba los 3'). Pasa los 'id' tal cual los devolvió list_actions (máx 20). Global-a-tienda: no filtra por market. Nunca apruebes sin que te lo confirmen.",
    parameters: z.object({ ids: z.array(z.string()).min(1).max(20) }),
    execute: async ({ ids }: { ids: string[] }) => setActionsStatus(ids, "approved"),
  });

  const rejectActions = new FunctionTool({
    name: "reject_actions",
    description:
      "Rechaza borradores pendientes (no se enviarán). SOLO después de confirmación explícita del merchant en esta conversación. Pasa los 'id' tal cual los devolvió list_actions (máx 20). Global-a-tienda: no filtra por market.",
    parameters: z.object({ ids: z.array(z.string()).min(1).max(20) }),
    execute: async ({ ids }: { ids: string[] }) => setActionsStatus(ids, "rejected"),
  });

  const inboxSummary = new FunctionTool({
    name: "get_inbox_summary",
    description:
      "Backlog TOTAL de /review con el mismo criterio que `app/api/inbox-count/route.ts` y el badge del sidebar: borradores pendientes + leads pendientes + señales abiertas/priorizadas (acumulado, sin filtro de fecha). Úsala para '¿qué hay por revisar?', '¿qué hago primero hoy?', '¿qué hay en el inbox?'. Cita `total` y cada parcial; nunca uses `returned_count`/`items.length` como total (ese es el bug 2-vs-N).",
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      const countScoped = async (
        table: "proposed_actions" | "proposed_leads" | "churn_signals",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apply: (q: any) => any,
        // Honesto (issue #33): null si el count falla, nunca 0 silencioso.
      ): Promise<number | null> => {
        const q = apply(db.from(table).select("id", { count: "exact", head: true }).eq("store_id", storeId));
        const { count, error } = await q;
        if (error) throw new Error(error.message);
        return count ?? null;
      };
      try {
        const [actions, leads, signals] = await Promise.all([
          countScoped("proposed_actions", (q) => q.eq("status", "pending_review")),
          countScoped("proposed_leads", (q) => q.eq("status", "pending_review")),
          countScoped("churn_signals", (q) => q.in("status", ["open", "prioritized"])),
        ]);
        const anyNull = actions == null || leads == null || signals == null;
        return {
          actions,
          leads,
          signals,
          total: anyNull ? null : (actions ?? 0) + (leads ?? 0) + (signals ?? 0),
          note: "Mismo criterio que /api/inbox-count y el badge: acumulado sin filtro de fecha.",
          counts_note: anyNull
            ? "Algún conteo exacto falló (null): los null no son 0; pide el inbox de nuevo."
            : null,
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  const hoySnapshot = new FunctionTool({
    name: "get_hoy_snapshot",
    description:
      "Héroe 'Hoy' del dashboard (foto del día del motor, `app/(dashboard)/page.tsx`): cuántos para actuar hoy, vigilar (cercano vs residual), valor en juego intra-moneda con gemelos *_display ya formateados, fotoVieja, próxima ventana y el top-1 (empieza por X). Úsala para '¿qué hago hoy?', '¿por quién empiezo?', '¿cuánto hay en juego?'. Cifras *_display verbatim; minor solo para comparar. " + DISPLAY_RULE,
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      try {
        const { resolveShopCurrency, resolveCloseWatchP } = await import("@/lib/store-profiles");
        const { isCloseWatch } = await import("@/lib/customer-predictions");
        const shopCurrency = ((await resolveShopCurrency(storeId).catch(() => null)) ?? null)?.toUpperCase() ?? null;
        const viewCur = shopCurrency;
        const closeWatchP = await resolveCloseWatchP(storeId).catch(() => 0.1);
        const PRED_CAP = 5000;
        const dayStart = new Date(
          Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
        ).toISOString();
        const cols =
          "customer_id,decision,valor_esperado_minor,p_low,p_high,ticket_esperado_minor,currency,p_recompra_h,banda_p,p25_days,p75_days,confidence,as_of,model_version,evidence_json";
        let predRows: Array<Record<string, unknown>> = [];
        let fotoVieja = false;
        {
          const { data, error } = await db
            .from("customer_predictions")
            .select(cols)
            .eq("store_id", storeId)
            .gte("as_of", dayStart)
            .order("as_of", { ascending: false })
            .order("model_version", { ascending: false })
            .order("id", { ascending: true })
            .limit(PRED_CAP);
          if (error) return { error: error.message };
          predRows = (data ?? []) as Array<Record<string, unknown>>;
        }
        if (predRows.length === 0) {
          const { data, error } = await db
            .from("customer_predictions")
            .select(cols)
            .eq("store_id", storeId)
            .order("as_of", { ascending: false })
            .order("model_version", { ascending: false })
            .order("id", { ascending: true })
            .limit(PRED_CAP);
          if (error) return { error: error.message };
          const rowsAll = (data ?? []) as Array<Record<string, unknown>>;
          const maxAsOf = rowsAll.length > 0 ? String(rowsAll[0].as_of ?? "") : null;
          predRows = maxAsOf ? rowsAll.filter((r) => String(r.as_of ?? "") === maxAsOf) : [];
          if (maxAsOf && maxAsOf < dayStart) fotoVieja = true;
        }
        let actuar = 0;
        let vigilar = 0;
        let cercano = 0;
        let residual = 0;
        let auto = 0;
        let valor = 0;
        let low = 0;
        let high = 0;
        let debiles = 0;
        let debilesCercano = 0;
        const groups = { organico: 0, dormido: 0, contactado_reciente: 0, sin_canal: 0 };
        const foreign = new Map<string, { n: number; value: number }>();
        let nextIn: number | null = null;
        const seenCust = new Set<string>();
        const pByCust = new Map<string, number>();
        for (const r of predRows) {
          const cid0 = String(r.customer_id ?? "");
          if (!cid0 || seenCust.has(cid0)) continue;
          seenCust.add(cid0);
          const d = String(r.decision ?? "");
          const cur = (r.currency as string | null) ?? null;
          const inView = viewCur === null || cur === null || cur.toUpperCase() === viewCur.toUpperCase();
          if (d === "actuar" || d === "revision_humana") actuar += 1;
          else if (d === "vigilar") {
            vigilar += 1;
            const banda = (r.banda_p as string | null) ?? null;
            const p = r.p_recompra_h == null ? null : Number(r.p_recompra_h);
            const isCercano = isCloseWatch({ decision: d, bandaP: banda, pRecompraH: p }, closeWatchP);
            if (isCercano) cercano += 1;
            else residual += 1;
            if ((r.confidence as string | null) === "baja" && isCercano) debilesCercano += 1;
          } else auto += 1;
          if ((r.confidence as string | null) === "baja" && (d === "actuar" || d === "revision_humana")) debiles += 1;
          if (d === "organico") groups.organico += 1;
          else if (d === "dormido") groups.dormido += 1;
          else if (d === "contactado_reciente") groups.contactado_reciente += 1;
          else if (d === "sin_canal") groups.sin_canal += 1;
          const ev = (r.evidence_json as Record<string, unknown> | null) ?? {};
          const t = ev.t_days == null ? null : Number(ev.t_days);
          const p25 = r.p25_days == null ? null : Number(r.p25_days);
          const v = r.valor_esperado_minor == null ? null : Number(r.valor_esperado_minor);
          const tk = r.ticket_esperado_minor == null ? null : Number(r.ticket_esperado_minor);
          if (v !== null) pByCust.set(cid0, v);
          if (d === "actuar" || d === "revision_humana") {
            if (v !== null && tk !== null) {
              if (inView) {
                valor += v;
                low += Number(r.p_low ?? 0) * tk;
                high += Number(r.p_high ?? 0) * tk;
              } else {
                const code = (cur ?? "?").toUpperCase();
                const g = foreign.get(code) ?? { n: 0, value: 0 };
                g.n += 1;
                g.value += v;
                foreign.set(code, g);
              }
            } else if (v !== null && !inView) {
              const code = (cur ?? "?").toUpperCase();
              const g = foreign.get(code) ?? { n: 0, value: 0 };
              g.n += 1;
              g.value += v;
              foreign.set(code, g);
            }
          }
          if (d === "vigilar" && p25 !== null && t !== null) {
            const diff = p25 - t;
            if (diff > 0 && (nextIn === null || diff < nextIn)) nextIn = diff;
          }
        }
        let nextWindowDate: string | null = null;
        if (nextIn !== null) {
          const dt = new Date(Date.now() + Math.ceil(nextIn) * 86_400_000);
          nextWindowDate = dt.toISOString().slice(0, 10);
        }
        // Top-1 con el criterio único de la mira (mismo que Overview/Review).
        let top1: Record<string, unknown> | null = null;
        try {
          const { getRankedMira } = await import("@/lib/mira");
          const { rows } = await getRankedMira(storeId, 5, null);
          const actionable = rows.filter(
            (a) => a.decision === "actuar" || a.decision === "revision_humana" || (a.decision == null && (a.daysSince ?? 0) <= 365),
          );
          const first = actionable[0] ?? null;
          if (first) {
            const v = first.valorEsperadoMinor ?? pByCust.get(first.customerDbId) ?? null;
            const name = [first.firstName, first.lastName].filter(Boolean).join(" ") || first.email;
            top1 = {
              name,
              email: first.email,
              customer_id: first.customerDbId,
              valor_esperado_minor: v,
              valor_esperado_display: v == null ? null : formatMoney(Math.round(v), first.currency ?? viewCur),
              decision: first.decision ?? null,
            };
          }
        } catch {
          top1 = null;
        }
        return {
          actuar,
          vigilar,
          cercano,
          residual,
          auto,
          valor_esperado_minor: Math.round(valor),
          valor_esperado_display: formatMoney(Math.round(valor), viewCur),
          valor_low_display: formatMoney(Math.round(low), viewCur),
          valor_high_display: formatMoney(Math.round(high), viewCur),
          foto_vieja: fotoVieja,
          foto_truncated: predRows.length >= PRED_CAP,
          next_window_date: nextWindowDate,
          foreign: [...foreign.entries()].map(([code, g]) => ({ code, n: g.n, value: g.value, value_display: formatMoney(Math.round(g.value), code) })),
          groups,
          debiles,
          debiles_cercano: debilesCercano,
          top1,
          view_currency: viewCur,
          market_active: false,
          truncated: predRows.length >= PRED_CAP,
          note_truncated: predRows.length >= PRED_CAP ? "Muestra parcial: predicciones mayores al CAP 5000; conteos parciales." : null,
          scope_note: null,
          note: fotoVieja ? "Foto del día anterior (sin corrida hoy): conteos de la última foto, no de hoy. Si foto_vieja=true di 'foto de ayer', nunca 'hoy'." : null,
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  const runsStatus = new FunctionTool({
    name: "get_runs_status",
    description:
      "Estado del loop (background_runs, `app/(dashboard)/page.tsx` runs/lastRun): qué corrió último por worker (scout/strategist/copywriter/dispatcher/analyst/prospect), qué sigue corriendo y qué vigiló hoy (summary). Úsala para '¿ya corrió scout?', '¿sigue corriendo?', '¿qué vigiló hoy?'.",
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      const N = 10;
      const cols = "kind,label,status,summary,started_at,pulse_state";
      const fetchRuns = async (selectCols: string) =>
        db
          .from("background_runs")
          .select(selectCols)
          .eq("store_id", storeId)
          .order("started_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(N);
      let res = await fetchRuns(cols);
      // Fallback sin pulse_state en DBs aún sin la migración 20261019000000.
      if (res.error && /pulse_state/i.test(res.error.message)) {
        res = await fetchRuns("kind,label,status,summary,started_at");
      }
      if (res.error) return { error: res.error.message };
      const runs = ((res.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
        kind: String(r.kind ?? ""),
        label: String(r.label ?? ""),
        status: String(r.status ?? ""),
        summary: (r.summary as string | null) ?? null,
        started_at: String(r.started_at ?? ""),
        pulse_state: (r.pulse_state as string | null) ?? null,
      }));
      const lastRun = (kinds: string[]) => runs.find((r) => kinds.includes(r.kind)) ?? null;
      return {
        running: runs.filter((r) => r.status === "running"),
        latest: {
          scout: lastRun(["scout"]),
          strategist: lastRun(["strategist"]),
          copywriter: lastRun(["copywriter"]),
          dispatcher: lastRun(["dispatcher"]),
          analyst: lastRun(["analyst"]),
          prospect: lastRun(["prospect"]),
        },
        runs,
        note: "Últimos 10 runs por started_at (ventana, no censo): summary es el outcome humano del worker (qué vigiló/ordenó/redactó/envió/midió).",
      };
    },
  });

  const dismissSignals = new FunctionTool({
    name: "dismiss_signals",
    description:
      "Descarta señales abiertas/priorizadas (el humano las juzga irrelevantes). SOLO después de confirmación explícita del merchant. Pasa los 'id' tal cual los devolvió list_signals (máx 20). Global-a-tienda: no filtra por market.",
    parameters: z.object({ ids: z.array(z.string()).min(1).max(20) }),
    execute: async ({ ids }: { ids: string[] }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const now = new Date().toISOString();
      // closed_by existe (20261103000000): sin sesión resoluble en el agente
      // queda null y la UI muestra "sin registro", nunca un nombre inventado.
      const { data, error } = await getSupabase()
        .from("churn_signals")
        .update({ status: "dismissed", closed_at: now, closed_by: null })
        .in("id", ids)
        .eq("store_id", storeId)
        .in("status", ["open", "prioritized"])
        .select("id");
      if (error) return { error: error.message };
      const n = (data ?? []).length;
      revalidatePath("/review");
      return {
        updated: n,
        requested: ids.length,
        status: "dismissed",
        note: n < ids.length ? "Algunas ya no estaban abiertas (IDs inválidos o ya movidas)." : null,
      };
    },
  });

  const reopenSignals = new FunctionTool({
    name: "reopen_signals",
    description:
      "Reabre señales descartadas (vuelven a la cola para contactar igual). SOLO después de confirmación explícita del merchant. Pasa los 'id' tal cual (máx 20). Global-a-tienda: no filtra por market.",
    parameters: z.object({ ids: z.array(z.string()).min(1).max(20) }),
    execute: async ({ ids }: { ids: string[] }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const { data, error } = await getSupabase()
        .from("churn_signals")
        .update({ status: "open", closed_at: null, closed_by: null })
        .in("id", ids)
        .eq("store_id", storeId)
        .eq("status", "dismissed")
        .select("id");
      if (error) return { error: error.message };
      const n = (data ?? []).length;
      revalidatePath("/review");
      return {
        updated: n,
        requested: ids.length,
        status: "open",
        note: n < ids.length ? "Algunas ya estaban reabiertas o no existen." : null,
      };
    },
  });

  const decideLead = new FunctionTool({
    name: "decide_lead",
    description:
      "Cierra el loop de un lead (review sí puede, el chat también): approved (me interesa, vuelve a pendientes de contacto), contacted (ya lo contacté por mi cuenta), discarded (no me interesa; se guarda como rejected canónico y status devuelve 'rejected') o reopen (rescata un descartado a pendientes). SOLO después de confirmación explícita del merchant. Pasa los 'id' tal cual los devolvió list_leads (máx 20). Global-a-tienda: no filtra por market.",
    parameters: z.object({
      ids: z.array(z.string()).min(1).max(20),
      decision: z.enum(["approved", "contacted", "discarded", "reopen"]),
    }),
    execute: async ({ ids, decision }: { ids: string[]; decision: string }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      const now = new Date().toISOString();
      let data: Array<Record<string, unknown>> | null = null;
      let error: { message: string } | null = null;
      // Estado efectivo en DB: discarded se guarda como rejected (canónico del
      // GUI: rejectLeadAction; review agrupa rejected+discarded). Se devuelve
      // el efectivo para no confundir con el enum del status.
      let effective = decision;
      if (decision === "approved") {
        const r = await db
          .from("proposed_leads")
          .update({ status: "approved" })
          .in("id", ids)
          .eq("store_id", storeId)
          .eq("status", "pending_review")
          .select("id");
        data = (r.data ?? []) as Array<Record<string, unknown>>;
        error = (r.error ?? null) as { message: string } | null;
      } else if (decision === "contacted") {
        const r = await db
          .from("proposed_leads")
          .update({ status: "contacted", contacted_at: now })
          .in("id", ids)
          .eq("store_id", storeId)
          .in("status", ["pending_review", "approved"])
          .select("id");
        data = (r.data ?? []) as Array<Record<string, unknown>>;
        error = (r.error ?? null) as { message: string } | null;
      } else if (decision === "discarded") {
        effective = "rejected";
        const r = await db
          .from("proposed_leads")
          .update({ status: "rejected" })
          .in("id", ids)
          .eq("store_id", storeId)
          .eq("status", "pending_review")
          .select("id");
        data = (r.data ?? []) as Array<Record<string, unknown>>;
        error = (r.error ?? null) as { message: string } | null;
      } else {
        const r = await db
          .from("proposed_leads")
          .update({ status: "pending_review" })
          .in("id", ids)
          .eq("store_id", storeId)
          .in("status", ["rejected", "discarded"])
          .select("id");
        data = (r.data ?? []) as Array<Record<string, unknown>>;
        error = (r.error ?? null) as { message: string } | null;
      }
      if (error) return { error: error.message };
      const n = (data ?? []).length;
      revalidatePath("/review");
      return {
        updated: n,
        requested: ids.length,
        status: effective,
        note: n < ids.length ? "Algunos ya estaban movidos (IDs inválidos o estado distinto)." : null,
      };
    },
  });

  const find = new FunctionTool({
    name: "find_customer",
    description:
      "Busca un customer por email, nombre, teléfono o empresa —incluida la empresa enriquecida (nombre, industria, descripción/qué es, sede, dominio)— o por lo que compra/contrata (marca/categoría, ej. 'fisioterapia', 'K-pop', 'muebles') y devuelve su id para enfocar la conversación (úsalo si te nombran a alguien sin ficha abierta). Ej.: 'PUCP', 'universidad', 'educación superior'. El gasto va en total_spent_display (ya formateado). " + DISPLAY_RULE,
    parameters: z.object({ q: z.string().min(2) }),
    execute: async ({ q }: { q: string }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      const esc = q.replace(/[%_\\]/g, "\\$&").replace(/,/g, " ");
      const like = `%${esc}%`;
      const custCols =
        "id,email,first_name,last_name,phone,company_name,orders_count,total_spent,currency,country";
      const baseFq = getSupabase()
        .from("customers")
        .select(custCols)
        .eq("store_id", storeId)
        .or(`email.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like},company_name.ilike.${like}`);
      const { data, error } = await baseFq.limit(5);
      if (error) return { error: error.message };
      const rows = ((data ?? []) as Array<Record<string, unknown>>).slice(0, 5);
      // Empresa enriquecida vive en `domains` (por dominio): dominios que
      // matchean (qué es, no solo el nombre) → customers con ese email.
      if (rows.length < 5) {
        const { data: drows } = await db
          .from("domains")
          .select("domain,company_name,industry")
          .or(`company_name.ilike.${like},industry.ilike.${like},description.ilike.${like},location.ilike.${like},domain.ilike.${like}`)
          .limit(10);
        const doms = ((drows ?? []) as Array<Record<string, unknown>>).filter((d) =>
          String((d as Record<string, unknown>).domain ?? ""),
        );
        const seen = new Set(rows.map((r) => String(r.id)));
        const firmByDomain = new Map(
          doms.map((d) => [
            String((d as Record<string, unknown>).domain),
            {
              company: ((d as Record<string, unknown>).company_name as string) ?? null,
              industry: ((d as Record<string, unknown>).industry as string) ?? null,
            },
          ]),
        );
        for (const d of [...firmByDomain.keys()].slice(0, 10)) {
          if (rows.length >= 5) break;
          const escD = d.replace(/[%_\\]/g, "\\$&");
          const dq = db
            .from("customers")
            .select(custCols)
            .eq("store_id", storeId)
            .like("email", `%@${escD}`);
          const { data: dc } = await dq.limit(5 - rows.length);
          for (const c of (((dc ?? []) as Array<Record<string, unknown>>))) {
            if (seen.has(String(c.id))) continue;
            seen.add(String(c.id));
            rows.push({ ...c, enriched_company: firmByDomain.get(d)?.company ?? null });
          }
        }
      }
      // Contenido Nivel 1: marca/categoría/qué.
      if (rows.length < 5) {
        const { searchContentCustomerIds } = await import("@/lib/item-context");
        const hits = await searchContentCustomerIds(storeId, q).catch(() => new Map());
        const known = new Set(rows.map((r) => String((r as Record<string, unknown>).id)));
        const ids = [...hits.keys()].filter((id) => !known.has(id)).slice(0, 5 - rows.length);
        if (ids.length > 0) {
          const ccq = db
            .from("customers")
            .select(custCols)
            .eq("store_id", storeId)
            .in("id", ids);
          const { data: cc } = await ccq;
          for (const c of (((cc ?? []) as Array<Record<string, unknown>>))) {
            const hit = hits.get(String(c.id));
            known.add(String(c.id));
            rows.push({
              ...c,
              matched_content: `${hit?.marca ? `${hit.marca}: ` : ""}${hit?.que ?? ""}${hit?.categoria ? ` (${hit.categoria})` : ""}`,
            });
          }
        }
      }
      // Recall truncado por diseño (top-5): se declara para no presentar como total.
      // find_customer es búsqueda por relevancia, no censo: total_count=null
      // documenta la excepción al envelope (la regla N de M no aplica aquí).
      const withDisplay = rows.map((r) => ({
        ...r,
        total_spent_display: formatMoney(Number(r.total_spent ?? 0), (r.currency as string | null) ?? null),
      }));
      return { items: withDisplay, returned_count: withDisplay.length, total_count: null, truncated: false, note: "Top-5 por relevancia; puede haber más coincidencias. " + DISPLAY_RULE };
    },
  });

  const noCustomer = { error: "Sin customer en contexto: abre su ficha o usa find_customer para localizarlo." };

  const DECISIONS = [
    "actuar",
    "vigilar",
    "no-tocar",
    "organico",
    "dormido",
    "sin_canal",
    "contactado_reciente",
    "revision_humana",
  ] as const;

  /** Filtra la tabla de Customers: la vista muestra, aquí solo se cuenta.
   *  Los filtros son los mismos de la tabla (?decision=&vista=&q=&tipo=B2B|B2C
   *  + ejes ventana/banda/elegibilidad/decil): el chat los escribe, no los
   *  duplica. Lo omitido no filtra. */
  const filterCustomers = new FunctionTool({
    name: "filter_customers",
    description:
      "Filtra la tabla de Empresas y devuelve cuántos coinciden (la vista los muestra; aquí no se listan filas). decision: actuar, vigilar, no-tocar, organico, dormido, sin_canal, contactado_reciente o revision_humana (criterio del motor, foto del día). vista=ventana7: vigilar que entra en ventana en 7 días; vista=seguimiento: vigilar cercano (recuperable o p alta, mismo corte que el héroe). ritmo: con-ritmo, primera o sin-compras (segmentación estructural). Ejes del motor: ventana (antes/en/pasada/dormido), banda (organico-probable/recuperable/lejos), elegibilidad (ok/sin-canal/contacto-reciente), decil de valor (alto 8-10/medio 4-7/bajo 1-3). q = texto libre (email/nombre/teléfono/empresa, incluida la enriquecida: nombre, industria, descripción). Pasa SOLO lo que pida el merchant.",
    parameters: z.object({
      q: z.string().min(2).max(100).optional(),
      decision: z.enum(DECISIONS).optional(),
      vista: z.enum(["ventana7", "seguimiento"]).optional(),
      ritmo: z.enum(["con-ritmo", "primera", "sin-compras"] as const).optional(),
      customer_type: z.enum(["B2B", "B2C"]).optional(),
      ventana: z.enum(["antes", "en", "pasada", "dormido"] as const).optional(),
      banda: z.enum(["organico-probable", "recuperable", "lejos"] as const).optional(),
      elegibilidad: z.enum(["ok", "sin-canal", "contacto-reciente"] as const).optional(),
      decil: z.enum(["alto", "medio", "bajo"] as const).optional(),
    }),
    execute: async ({
      q,
      decision,
      vista,
      ritmo,
      customer_type,
      ventana,
      banda,
      elegibilidad,
      decil,
    }: {
      q?: string;
      decision?: string;
      vista?: string;
      ritmo?: string;
      customer_type?: string;
      ventana?: string;
      banda?: string;
      elegibilidad?: string;
      decil?: string;
    }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const { resolveCloseWatchP } = await import("@/lib/store-profiles");
      const closeWatchCutoff = await resolveCloseWatchP(storeId).catch(() => 0.1);
      const res = await queryStoreCustomers(
        storeId,
        q?.trim() ?? "",
        1,
        1,
        undefined,
        {
          decision: (decision as (typeof DECISIONS)[number] | undefined) ?? null,
          vista: vista === "ventana7" || vista === "seguimiento" ? vista : null,
          ritmo: ritmo ?? null,
          customerType: customer_type ?? null,
          ventana: ventana ?? null,
          banda: banda ?? null,
          elegibilidad: elegibilidad ?? null,
          decil: decil ?? null,
        },
        null,
        closeWatchCutoff,
      );
      return {
        filter: {
          q: q?.trim() || null,
          decision: decision ?? null,
          vista: vista ?? null,
          ritmo: ritmo ?? null,
          customer_type: customer_type ?? null,
          ventana: ventana ?? null,
          banda: banda ?? null,
          elegibilidad: elegibilidad ?? null,
          decil: decil ?? null,
        },
        count: res.countFailed ? null : res.totalCount,
        // Sobre de conteo honesto (issue #33): la vista lista las filas a la
        // derecha; aquí solo viaja el conteo con su nota, nunca filas.
        total_count: res.countFailed ? null : res.totalCount,
        truncated: null,
        note: res.countFailed
          ? "Conteo no disponible (count falló): pide el filtro de nuevo, no cites 0."
          : res.predictionsTruncated
            ? "Conteo parcial: la foto de predicciones truncó (CAP) y los filtros del motor se evaluaron sobre la ventana."
            : "Conteo de la tabla de Customers (las filas las muestra la vista a la derecha).",
      };
    },
  });

  const profile = new FunctionTool({
    name: "get_customer_profile",
    description:
      "Ficha del customer en contexto: nombre, email, teléfono, empresa (efectiva: manual > base > enriquecida), tipo (B2B/B2C), compras y gasto (total_spent_display ya formateado). Si la empresa viene del enriquecimiento, incluye industria y descripción (qué es). Úsala para identidad. " + DISPLAY_RULE,
    parameters: z.object({}),
    execute: async () => {
      if (!customerId) return noCustomer;
      const { data, error } = await getSupabase()
        .from("customers")
        .select("first_name,last_name,email,phone,company_name,manual_edits,customer_type,orders_count,total_spent,currency,created_at")
        .eq("id", customerId)
        .maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "Customer no encontrado." };
      const c = data as Record<string, unknown>;
      // Empresa efectiva (misma regla que la GUI): manual > base > enriquecida.
      const overrides = (c.manual_edits as Record<string, unknown> | null) ?? {};
      const manualCompany =
        typeof overrides["company_name"] === "string" && overrides["company_name"] !== ""
          ? (overrides["company_name"] as string)
          : null;
      const baseCompany = (c.company_name as string) ?? null;
      let enrichedCompany: string | null = null;
      let industry: string | null = null;
      let companyDescription: string | null = null;
      if (!manualCompany && !baseCompany) {
        const domain = domainFromEmail(String(c.email ?? ""));
        if (domain) {
          const { data: drow } = await getSupabase()
            .from("domains")
            .select("company_name,industry,description")
            .eq("domain", domain)
            .maybeSingle();
          const d = drow as Record<string, unknown> | null;
          enrichedCompany = (d?.company_name as string) ?? null;
          industry = (d?.industry as string) ?? null;
          companyDescription = (d?.description as string) ?? null;
        }
      }
      return {
        first_name: (c.first_name as string) ?? null,
        last_name: (c.last_name as string) ?? null,
        email: (c.email as string) ?? null,
        phone: (c.phone as string) ?? null,
        company_name: manualCompany ?? baseCompany ?? enrichedCompany,
        company_enriched: !manualCompany && !baseCompany && !!enrichedCompany,
        industry,
        company_description: companyDescription,
        customer_type: (c.customer_type as string) ?? null,
        orders_count: Number(c.orders_count ?? 0),
        total_spent: Number(c.total_spent ?? 0),
        total_spent_display: formatMoney(Number(c.total_spent ?? 0), (c.currency as string | null) ?? null),
        currency: (c.currency as string) ?? null,
        created_at: (c.created_at as string) ?? null,
      };
    },
  });

  const orders = new FunctionTool({
    name: "get_customer_orders",
    description:
      "Historial de compras del customer en contexto (más reciente primero) con ítems, hechos temporales (recencia, frecuencia, gasto, ticket, ciclo esperado sobre historial completo) y predicción. Totales con gemelo *_display ya formateado. Devuelve envelope {orders, summary, prediction, totalOrders, truncated}. Pasa limit (1-30, default 10) y offset para paginar; si truncated=true hay más historial. " + DISPLAY_RULE,
    parameters: z.object({
      limit: z.number().int().min(1).max(30).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    }),
    execute: async ({ limit, offset }: { limit?: number; offset?: number }) => {
      if (!customerId) return noCustomer;
      const n = limit ?? 10;
      const off = offset ?? 0;
      const result = await loadCustomerOrdersAndRfm(customerId, n, off);
      if (!result) return { error: "Customer no encontrado." };
      const cur = result.summary.currency ?? null;
      const ordersWithDisplay = result.orders.map((o) => ({
        ...o,
        total_display: formatMoney(o.total, o.currency),
        items: o.items.map((it) => ({
          ...it,
          unit_price_display: it.unitPrice == null ? null : formatMoney(it.unitPrice, o.currency),
        })),
      }));
      const { data: pred } = await getSupabase()
        .from("customer_predictions")
        .select("model,p_recompra_h,p_low,p_high,horizon_days,expected_days,p25_days,p75_days,ticket_esperado_minor,valor_esperado_minor,decision,confidence,as_of")
        .eq("customer_id", customerId)
        .order("as_of", { ascending: false })
        .order("model_version", { ascending: false })
        .limit(1)
        .maybeSingle();
      const p = (pred ?? null) as Record<string, unknown> | null;
      return {
        ...result,
        orders: ordersWithDisplay,
        summary: {
          ...result.summary,
          monetary_display: formatMoney(result.summary.monetary, cur),
          avg_ticket_display: formatMoney(result.summary.avgTicket, cur),
        },
        prediction: p
          ? {
              ...p,
              ticket_esperado_display:
                p.ticket_esperado_minor == null ? null : formatMoney(Number(p.ticket_esperado_minor), cur),
              valor_esperado_display:
                p.valor_esperado_minor == null ? null : formatMoney(Number(p.valor_esperado_minor), cur),
            }
          : null,
      };
    },
  });

  const firmographics = new FunctionTool({
    name: "get_customer_firmographics",
    description:
      "Empresa del customer en contexto por su dominio (nombre, industria, descripción/qué es, tamaño, ubicación, confianza). Puede no estar enriquecida.",
    parameters: z.object({}),
    execute: async () => {
      if (!customerId) return noCustomer;
      const result = await loadCustomerFirmographics(customerId);
      if (!result) return { error: "Customer no encontrado." };
      return result;
    },
  });

  const leads = new FunctionTool({
    name: "list_leads",
    description:
      "Leads propuestos por el prospector (negocios parecidos al ICP, con score, motivo, contacto público y RRSS en evidence_json.contacts). Por defecto los pendientes de revisión del humano. País por sus customers de referencia; sin evidencia se ven en todo filtro. Si el merchant pide una cantidad, pásala en 'limit' (1-20, default 10). Solo actions/leads abren Review filtrado a la derecha (filter_customers filtra Customers; señales no abren panel). Paginación con 'offset' (default 0).",
    parameters: z.object({
      status: z.enum(["pending_review", "approved", "rejected", "contacted", "discarded"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    }),
    execute: async ({ status, limit, offset }: { status?: string; limit?: number; offset?: number }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const n = limit ?? 10;
      const off = offset ?? 0;
      const { count } = await getSupabase()
        .from("proposed_leads")
        .select("id", { count: "exact", head: true })
        .eq("store_id", storeId)
        .eq("status", status ?? "pending_review");
      const lq = getSupabase()
        .from("proposed_leads")
        .select("id,company,domain,url,contact,icp_score,reason,status,created_at,evidence_json")
        .eq("store_id", storeId)
        .eq("status", status ?? "pending_review");
      const { data, error } = await lq
        .order("icp_score", { ascending: false })
        .order("id", { ascending: true })
        .range(off, off + n - 1);
      if (error) return { error: error.message };
      const rows = data ?? [];
      if (count == null) {
        return {
          items: rows,
          total_count: null,
          returned_count: rows.length,
          truncated: null,
          note: "Total no disponible (count falló): hay más, pide offset.",
        };
      }
      return {
        items: rows,
        total_count: count,
        returned_count: rows.length,
        truncated: count > off + rows.length,
      };
    },
  });

  const prospect = new FunctionTool({
    name: "start_prospect_run",
    description:
      "Lanza al prospector: busca negocios parecidos al ICP (web → score → propone leads). Tarda minutos; corre en background y devuelve el run_id para seguimiento. Si ya hay una prospección corriendo, devuelve esa en vez de duplicar. Acepta 'focus': enfoque de ESTA corrida (p.ej. 'centros comerciales pequeños, excluir grandes malls') sin cambiar el ICP de la tienda.",
    parameters: z.object({
      queries: z.number().int().min(1).max(5).optional(),
      perQuery: z.number().int().min(1).max(10).optional(),
      focus: z.string().min(3).max(500).optional(),
    }),
    execute: async ({ queries, perQuery, focus }: { queries?: number; perQuery?: number; focus?: string }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      try {
        const { prospectEligibility } = await import("@/lib/prospect");
        const elig = await prospectEligibility(storeId);
        if (!elig.eligible) {
          const { PROSPECT_B2B_ONLY_HINT } = await import("@/lib/prospect-cap");
          return { error: PROSPECT_B2B_ONLY_HINT };
        }
      } catch {
        // sigue al ICP
      }
      try {
        await getIcp(storeId, null);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
      // Lock por compatibilidad (Fase 3): misma granularidad que la UI.
      const conflict = await hasConflict(storeId, { kind: "prospect" });
      if (conflict) return { run_id: conflict.id, already_running: true };
      const runId = await startRun(storeId, "prospect", "Prospección", 1);
      const { after } = await import("next/server");
      after(() => {
        runProspect(runId, storeId, { queries: queries ?? 3, perQuery: perQuery ?? 5, focus: focus?.trim() || null, scope: null }).catch(() => undefined);
      });
      return { run_id: runId, already_running: false, focus: focus?.trim() || null };
    },
  });

  const topProducts = new FunctionTool({
    name: "get_top_products",
    description:
      "Ranking de lo que más vende: agrupa orders.items_json por título en la moneda de la vista (nunca mezcla PEN+MXN). Solo compras reales (no test ni canceladas). Cada ítem trae revenueMinor crudo + revenue_display ya formateado. Si te piden 'qué es lo que más vendemos' usa esta tool, no get_store_summary. " + DISPLAY_RULE,
    parameters: z.object({
      limit: z.number().int().min(1).max(20).optional(),
      sort: z.enum(["revenue", "quantity", "orders"]).optional(),
    }),
    execute: async ({ limit, sort }: { limit?: number; sort?: string }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const n = limit ?? 5;
      const db = getSupabase();
      const { resolveShopCurrency } = await import("@/lib/store-profiles");
      // Sin ?? PEN: sin shop_currency no se asume moneda (null = todas,
      // como el drawer). Asumir PEN mezclaba/ocultaba otras monedas.
      const shopCurrency = ((await resolveShopCurrency(storeId).catch(() => null)) ?? null)?.toUpperCase() ?? null;
      const viewCurrency = shopCurrency;
      // Misma ventana que /finance (12m): año móvil para no mezclar historia vieja.
      const yearAgoIso = new Date(Date.now() - 400 * 86_400_000).toISOString();
      const PAGE = 1000;
      const CAP = 20000;
      let offset = 0;
      let ordersTruncated = false;
      const orows: Array<Record<string, unknown>> = [];
      for (;;) {
        const base = db
          .from("orders")
          .select("currency,customer_id,country,items_json,status,payment_status,is_test,placed_at")
          .eq("store_id", storeId)
          .gte("placed_at", yearAgoIso)
          .order("placed_at", { ascending: false })
          .order("id", { ascending: true });
        const { data, error } = await base.range(offset, offset + PAGE - 1);
        if (error) return { error: error.message };
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        orows.push(...rows);
        offset += rows.length;
        if (rows.length < PAGE) break;
        if (orows.length >= CAP) {
          ordersTruncated = true;
          break;
        }
      }
      // Solo reales: mismo criterio que analyst/RFM (issue #11/#12).
      const realRows = orows.filter((o) =>
        isRealDbOrder({
          status: typeof o.status === "string" ? o.status : null,
          payment_status: typeof o.payment_status === "string" ? o.payment_status : null,
          is_test: o.is_test === true,
        }),
      );
      // Sin viewCurrency (todas) NO se llama a rankItems con null: sumaría
      // PEN+MXN por título. Se rankea por (título, moneda) con rótulo por
      // fila, como el drawer (nunca se mezclan monedas).
      if (!viewCurrency) {
        const { normProductTitle: normTitleTop, normProductTitleLoose: normLooseTop } = await import("@/lib/product-stats");
        const byKey = new Map<string, { title: string; currency: string; quantity: number; revenueMinor: number; orders: number }>();
        for (const o of realRows) {
          const cur = ((o.currency as string | null) ?? "SIN-MONEDA").toUpperCase();
          const items = Array.isArray(o.items_json) ? o.items_json : [];
          const seenThisOrder = new Set<string>();
          for (const raw of items as Array<Record<string, unknown>>) {
            const rawTitle = String(raw.title ?? "").trim() || "Sin título";
            // Canónico (issue #29): misma normalización que rankItems/stats.
            const normKey = normLooseTop(rawTitle) || normTitleTop(rawTitle) || "sin-titulo";
            const key = `${normKey}|${cur}`;
            const qty = Number(raw.quantity ?? 0) || 0;
            const price = Number(raw.unit_price ?? 0) || 0;
            if (qty <= 0 && price <= 0) continue;
            let g = byKey.get(key);
            if (!g) {
              g = { title: rawTitle, currency: cur, quantity: 0, revenueMinor: 0, orders: 0 };
              byKey.set(key, g);
            }
            g.quantity += qty;
            g.revenueMinor += qty * price;
            if (!seenThisOrder.has(key)) {
              seenThisOrder.add(key);
              g.orders += 1;
            }
          }
        }
        const all = [...byKey.values()].sort((a, b) => b.revenueMinor - a.revenueMinor);
        const withDisplay = all.map((g) => ({ ...g, revenue_display: formatMoney(g.revenueMinor, g.currency) }));
        const pickAll = withDisplay.slice(0, n);
        const pick =
          sort === "quantity"
            ? [...pickAll].sort((a, b) => b.quantity - a.quantity)
            : sort === "orders"
              ? [...pickAll].sort((a, b) => b.orders - a.orders)
              : pickAll;
        return {
          items: pick,
          bottom: [],
          total_count: byKey.size,
          returned_count: pick.length,
          truncated: ordersTruncated || byKey.size > pick.length,
          view_currency: viewCurrency,
          note_truncated: ordersTruncated ? "Muestra parcial: órdenes mayores al CAP 20k; ranking parcial." : null,
          note: "Sin moneda de vista: ranking por (título, moneda) con rótulo por fila, nunca se suman PEN+MXN. " + DISPLAY_RULE,
        };
      }
      const { top, bottom } = rankItems(
        realRows.map((r) => ({ currency: (r.currency as string | null) ?? null, items_json: r.items_json })),
        viewCurrency,
        n,
      );
      const withRevenueDisplay = <T extends { revenueMinor: number }>(rows: T[]): (T & { revenue_display: string })[] =>
        rows.map((r) => ({ ...r, revenue_display: formatMoney(r.revenueMinor, viewCurrency) }));
      const topWithDisplay = withRevenueDisplay(top);
      const pick = sort === "quantity"
        ? [...topWithDisplay].sort((a, b) => b.quantity - a.quantity)
        : sort === "orders"
          ? [...topWithDisplay].sort((a, b) => b.orders - a.orders)
          : topWithDisplay;
      // total_count = títulos distintos intra-moneda (no el largo de la ventana).
      // Sin viewCurrency (todas) no se filtra por moneda. Canónico (issue #29).
      const { normProductTitle: normTitleCount, normProductTitleLoose: normLooseCount } = await import("@/lib/product-stats");
      const seen = new Set<string>();
      for (const o of realRows) {
        const cur = (o.currency as string | null) ?? null;
        if (viewCurrency && cur && cur.toUpperCase() !== viewCurrency) continue;
        const items = Array.isArray(o.items_json) ? (o.items_json as Array<Record<string, unknown>>) : [];
        for (const it of items) {
          const rawT = String(it.title ?? "").trim();
          const t = normLooseCount(rawT) || normTitleCount(rawT) || "sin-titulo";
          seen.add(t);
        }
      }
      const totalCount = seen.size;
      return {
        items: pick,
        bottom: withRevenueDisplay(bottom),
        total_count: totalCount,
        returned_count: pick.length,
        truncated: ordersTruncated || totalCount > pick.length,
        view_currency: viewCurrency,
        note_truncated: ordersTruncated ? "Muestra parcial: órdenes mayores al CAP 20k; ranking parcial." : null,
        note: "Entre lo vendido (sin feed de productos no se ven items con cero ventas). " + DISPLAY_RULE,
      };
    },
  });

  /**
   * Dispara un worker del loop en background. Import dinámico: los workers
   * usan `lib/log.ts` (`server-only`) y el import estático rompería `adk web`.
   */
  async function startLoopWorker(
    kind: string,
    label: string,
    mod: string,
    fn: string,
    args: unknown[] = [],
  ): Promise<Record<string, unknown>> {
    if (!storeId) return { error: "Sin tienda en contexto." };
    const conflict = await hasConflict(storeId, { kind });
    if (conflict) return { run_id: conflict.id, already_running: true };
    const runId = await startRun(storeId, kind, label, 0);
    const worker = (await import(mod)) as Record<
      string,
      (runId: string, storeId: string, ...args: unknown[]) => Promise<void>
    >;
    void worker[fn](runId, storeId, ...args).catch(() => undefined);
    return { run_id: runId, already_running: false };
  }

  const loopDefs = [
    {
      name: "start_scout_run",
      label: "Scout",
      description:
        "Vigila tu base y marca quién necesita un mensaje hoy. Tarda ~1 min en background; devuelve run_id. Si ya corre uno, devuelve ese.",
    },
    {
      name: "start_strategist_run",
      label: "Estratega",
      description:
        "Ordena por valor y ventana: dice por quién empezar. Corre tras el scout; devuelve run_id.",
    },
    {
      name: "start_copywriter_run",
      label: "Redactor",
      description:
        "Deja borradores listos para tu visto bueno en /review (WhatsApp/email con historial real). Nunca envía. Gasta LLM; límite 10 por corrida. Devuelve run_id.",
    },
    {
      name: "start_dispatcher_run",
      label: "Mensajero",
      description:
        "Envía solo lo que aprobaste, nada sin tu permiso. Sin canal conectado (WhatsApp/email) queda en espera y te pide conectar. Devuelve run_id.",
    },
    {
      name: "start_analyst_run",
      label: "Analista",
      description:
        "Mide si volvieron y cuánta plata se recuperó tras el envío. Devuelve run_id.",
    },
  ] as const;

  const loopFns: Record<string, { mod: string; fn: string }> = {
    start_scout_run: { mod: "@/lib/scout", fn: "runScout" },
    start_strategist_run: { mod: "@/lib/strategist", fn: "runStrategist" },
    start_copywriter_run: { mod: "@/lib/copywriter", fn: "runCopywriter" },
    start_dispatcher_run: { mod: "@/lib/dispatcher", fn: "runDispatcher" },
    start_analyst_run: { mod: "@/lib/analyst", fn: "runAnalyst" },
  };

  const loopTools = loopDefs.map(
    (d) =>
      new FunctionTool({
        name: d.name,
        description: d.description,
        parameters: z.object({}),
        execute: async () => {
          const w = loopFns[d.name];
          return startLoopWorker(d.name.replace("start_", "").replace("_run", ""), d.label, w.mod, w.fn);
        },
      }),
  );

  /** Guarda defensiva (hoy inalcanzable: las tools de producto solo se
   *  registran con productId en contexto; sin foco no existen). */
  const noProduct = { error: "Sin producto en contexto: abre su ficha en catálogo." };

  /** Ficha del ítem en foco: identidad + ventas autoritativas por moneda
   *  (product_stats, lo mismo que el tab Resumen del drawer). Sin scan de
   *  órdenes: barato, úsala antes de afirmar cualquier cifra del producto. */
  const productSummary = new FunctionTool({
    name: "get_product_summary",
    description:
      "Ficha del producto en foco: identidad (título, estado, handle) y ventas por moneda desde product_stats (cantidades, montos con gemelo *_display ya formateado, 30d/90d, compradores, última venta). Úsala antes de afirmar cualquier cifra de ESTE ítem; para comparar con el resto usa get_top_products. " + DISPLAY_RULE,
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      if (!productId) return noProduct;
      const db = getSupabase();
      const { data: p, error: pErr } = await db
        .from("products")
        .select("id,title,handle,platform_status,is_active")
        .eq("store_id", storeId)
        .eq("id", productId)
        .maybeSingle();
      if (pErr) return { error: pErr.message };
      if (!p) return { error: "Producto no encontrado en esta tienda." };
      const pr = p as Record<string, unknown>;
      const { data: stats, error: sErr } = await db
        .from("product_stats")
        .select("currency,qty_all,revenue_all,qty_30d,qty_90d,revenue_30d,buyers_all,last_sold_at")
        .eq("store_id", storeId)
        .eq("product_id", productId)
        .limit(10);
      if (sErr) return { error: sErr.message };
      const { resolveShopCurrency } = await import("@/lib/store-profiles");
      const shopCurrency = (await resolveShopCurrency(storeId).catch(() => null)) ?? null;
      const statRows = ((stats ?? []) as Array<Record<string, unknown>>);
      return {
        product: {
          id: String(pr.id ?? ""),
          title: String(pr.title ?? ""),
          handle: (pr.handle as string | null) ?? null,
          platform_status: (pr.platform_status as string | null) ?? null,
          is_active: pr.is_active === true,
        },
        stats_by_currency: statRows.map((s) => ({
          currency: String(s.currency ?? ""),
          qty_all: Number(s.qty_all ?? 0),
          revenue_all: Number(s.revenue_all ?? 0),
          revenue_all_display: formatMoney(Number(s.revenue_all ?? 0), String(s.currency ?? "")),
          qty_30d: Number(s.qty_30d ?? 0),
          qty_90d: Number(s.qty_90d ?? 0),
          revenue_30d: Number(s.revenue_30d ?? 0),
          revenue_30d_display: formatMoney(Number(s.revenue_30d ?? 0), String(s.currency ?? "")),
          buyers_all: Number(s.buyers_all ?? 0),
          last_sold_at: (s.last_sold_at as string | null) ?? null,
        })),
        view_currency: shopCurrency ? shopCurrency.toUpperCase() : null,
        truncated: statRows.length >= 10,
        note_truncated: statRows.length >= 10 ? "Ventana de 10 filas de product_stats: puede haber más monedas." : null,
        note: "Sin product_stats = sin ventas registradas. " + DISPLAY_RULE,
      };
    },
  });

  /** Últimas ventas del ítem en foco con metadata de ESA compra (lo mismo
   *  que el tab Movimientos del drawer). Paginado con envelope: pide SOLO
   *  lo pedido (limit/offset). El total exacto no se conoce sin escanear
   *  todo el historial: total_count=null y truncated avisa si hay más. */
  const productMovements = new FunctionTool({
    name: "get_product_movements",
    description:
      "Últimos movimientos del producto en foco (más reciente primero): fecha, cantidad, precio y monto con gemelos *_display ya formateados, y contenido de la línea (contiene/categoria de la key elegida en settings, o null). Pasa limit (1-15, default 5) y offset para paginar. Devuelve envelope {items, total_count, returned_count, truncated}: total_count=null (historial abierto); si truncated, dilo ('te muestro N, hay más'). " + DISPLAY_RULE,
    parameters: z.object({
      limit: z.number().int().min(1).max(15).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    }),
    execute: async ({ limit, offset }: { limit?: number; offset?: number }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      if (!productId) return noProduct;
      const n = limit ?? 5;
      const off = offset ?? 0;
      const db = getSupabase();
      const { data: p, error: pErr } = await db
        .from("products")
        .select("title,handle,source_id,variants_json")
        .eq("store_id", storeId)
        .eq("id", productId)
        .maybeSingle();
      if (pErr) return { error: pErr.message };
      if (!p) return { error: "Producto no encontrado en esta tienda." };
      const pr = p as Record<string, unknown>;
      // Match canónico global (issue #29): mismo índice first-wins que
      // computeProductStats/drawer (ID>variante>handle>sku>título>título loose).
      // Antes era réplica local solo-foco (sin índice global) y divergía.
      // CAP con flag honesto: si el catálogo supera el índice, se expone
      // product_index_truncated (el match por ID fuera del índice cae al
      // fallback por título y puede divergir de product_stats).
      const { buildProductPidIndex, resolveProductPid, normProductTitle, normProductTitleLoose } = await import("@/lib/product-stats");
      const PRODUCT_INDEX_CAP = 5000;
      const [{ data: prodsAll }, { count: prodsTotal }] = await Promise.all([
        db
          .from("products")
          .select("id,title,handle,source_id,variants_json")
          .eq("store_id", storeId)
          .limit(PRODUCT_INDEX_CAP),
        db.from("products").select("id", { count: "exact", head: true }).eq("store_id", storeId),
      ]);
      const pidIndex = buildProductPidIndex((prodsAll ?? []) as Array<Record<string, unknown>>);
      const indexed = (prodsAll ?? []).some((r) => String((r as Record<string, unknown>).id ?? "") === productId);
      const productIndexTruncated = (prodsTotal ?? (prodsAll ?? []).length) > (prodsAll ?? []).length;
      const normTitle = normProductTitle(String(pr.title ?? ""));
      const normTitleLoose = normProductTitleLoose(String(pr.title ?? ""));
      const isMineLine = (it: Record<string, unknown>): boolean => {
        const resolved = resolveProductPid(pidIndex, it);
        if (resolved) return resolved === productId;
        // Fallback si el catálogo truncó (5000) y este producto quedó fuera:
        // exacto + loose sobre title y product_title (canónico product-stats,
        // igual que el drawer en product-detail.ts).
        if (!indexed && (normTitle !== "" || normTitleLoose !== "")) {
          if (normProductTitle(String(it.title ?? "")) === normTitle) return true;
          if (normProductTitle(String(it.product_title ?? "")) === normTitle) return true;
          if (
            normTitleLoose !== "" &&
            (normProductTitleLoose(String(it.title ?? "")) === normTitleLoose ||
              normProductTitleLoose(String(it.product_title ?? "")) === normTitleLoose)
          )
            return true;
        }
        return false;
      };
      const { resolveShopCurrency } = await import("@/lib/store-profiles");
      const shopCurrency = ((await resolveShopCurrency(storeId).catch(() => null)) ?? null)?.toUpperCase() ?? null;
      const viewCurrency = shopCurrency;
      // Agregado paginado con CAP + flag: lotes 1000, nunca .length de ventana.
      const PAGE = 1000;
      const CAP = 20000;
      const want = off + n + 1; // +1 para saber si hay más (truncated real)
      const items: Array<Record<string, unknown>> = [];
      const metaLines: Array<{ title: string; quantity: number; metadata?: unknown; oi: number }> = [];
      let scanned = 0;
      let hitCap = false;
      for (let at = 0; ; at += PAGE) {
        const baseQ = db
          .from("orders")
          .select("currency,items_json,placed_at,customer_id,country,status,payment_status,is_test")
          .eq("store_id", storeId)
          .order("placed_at", { ascending: false })
          .order("id", { ascending: true });
        const { data, error } = await baseQ.range(at, at + PAGE - 1);
        if (error) return { error: error.message };
        const orows = (data ?? []) as Array<Record<string, unknown>>;
        for (const o of orows) {
          if (!isRealDbOrder({
            status: typeof o.status === "string" ? o.status : null,
            payment_status: typeof o.payment_status === "string" ? o.payment_status : null,
            is_test: o.is_test === true,
          })) continue;
          const cur = (o.currency as string | null) ?? null;
          // scanned = órdenes reales (issue #29).
          scanned += 1;
          const oitems = Array.isArray(o.items_json) ? (o.items_json as Array<Record<string, unknown>>) : [];
          let qty = 0;
          let revenue = 0;
          let unitPrice: number | null = null;
          const matched: Array<{ title: string; quantity: number; metadata?: unknown }> = [];
          for (const it of oitems) {
            if (!isMineLine(it)) continue;
            const q = Number(it.quantity ?? 0);
            if (!(q > 0)) continue;
            const up = Number(it.unit_price ?? 0);
            qty += q;
            revenue += q * up;
            if (unitPrice === null) unitPrice = up;
            matched.push({ title: String(it.title ?? ""), quantity: q, metadata: it.metadata });
          }
          if (qty > 0 && items.length < want) {
            const oi = items.length;
            items.push({
              placed_at: (o.placed_at as string | null) ?? null,
              qty,
              unit_price: unitPrice ?? 0,
              unit_price_display: formatMoney(unitPrice ?? 0, cur),
              revenue,
              revenue_display: formatMoney(revenue, cur),
              currency: cur,
              meta: null,
            });
            for (const m of matched) {
              metaLines.push({ ...m, oi });
            }
          }
          if (items.length >= want) break;
        }
        if (orows.length < PAGE) break;
        if (scanned >= CAP) {
          hitCap = true;
          break;
        }
        if (items.length >= want) break;
      }
      const hasMore = items.length > off + n;
      const window = items.slice(off, off + n);
      // Contenido POR LÍNEA (misma fusión que el drawer: concatena distintos).
      // Solo la key elegida en settings (contiene/categoria); ninguna otra key fluye.
      // Se enriquece solo la ventana visible para no dejar nulls falsos por topes.
      if (metaLines.length > 0 && window.length > 0) {
        const windowMeta = metaLines.filter((m) => m.oi >= off && m.oi < off + window.length);
        if (windowMeta.length > 0) {
          const { EMPTY_KEYS, resolveItemKeys } = await import("@/lib/metadata-map");
          const { enrichOrderItems } = await import("@/lib/item-context");
          const keys = await resolveItemKeys(storeId).catch(() => EMPTY_KEYS);
          const enriched = await enrichOrderItems(storeId, windowMeta, keys).catch(() => []);
          const byOi = new Map<number, typeof enriched>();
          enriched.forEach((e, i) => {
            const oi = windowMeta[i]?.oi;
            if (oi === undefined) return;
            const arr = byOi.get(oi) ?? [];
            arr.push(e);
            byOi.set(oi, arr);
          });
          for (const [oi, list] of byOi) {
            const mv = window[oi - off] as Record<string, unknown>;
            if (!mv) continue;
            const seenC = new Set<string>();
            const seenK = new Set<string>();
            const partesC: string[] = [];
            const partesK: string[] = [];
            for (const e of list) {
              if (e.contiene && !seenC.has(e.contiene)) {
                seenC.add(e.contiene);
                partesC.push(e.contiene);
              }
              if (e.categoria && !seenK.has(e.categoria)) {
                seenK.add(e.categoria);
                partesK.push(e.categoria);
              }
            }
            const contiene = partesC.length > 0 ? partesC.join(" | ").slice(0, 500) : null;
            const categoria = partesK.length > 0 ? partesK.join(" | ").slice(0, 200) : null;
            // Mismas claves que el drawer: el agente cita lo mismo que la GUI muestra.
            mv.meta = contiene || categoria ? { contiene, categoria } : null;
          }
        }
      }
      const truncated = hasMore || hitCap;
      return {
        items: window,
        total_count: null,
        returned_count: window.length,
        truncated,
        scanned_orders: scanned,
        view_currency: viewCurrency,
        product_index_truncated: productIndexTruncated,
        note_truncated: truncated ? "Ventana escaneada: puede haber más historial; no afirmes el total." : null,
        note: (productIndexTruncated ? "Índice de catálogo truncado (5000): el match por ID fuera del índice cae a título y puede divergir de product_stats. " : "") + "Meta = solo el contenido de la key elegida en settings (contiene/categoria) o null. " + DISPLAY_RULE,
      };
    },
  });

  /** Quiénes compran el ítem en foco (top por monto, lo mismo que el tab
   *  Clientes del drawer). Total = distintos reales del scan (buyerAgg.size):
   *  product_stats es por (product_id,currency) y duplica a quien compra en
   *  2 monedas; solo se expone como stats_total + flag stats_stale. */
  const productBuyers = new FunctionTool({
    name: "get_product_buyers",
    description:
      "Top compradores del producto en foco (nombre, email, empresa, cantidad y monto con revenue_display ya formateado). Pasa limit (1-20, default 5) y offset para paginar ('los otros 5' = mismo limit + offset 5). Devuelve envelope {items, total_count, returned_count, truncated, stats_stale}: total_count = compradores distintos reales; si truncated=true dilo ('te muestro N de M') y nunca afirmes que viste a todos; si stats_stale=true, product_stats está desactualizado. " + DISPLAY_RULE,
    parameters: z.object({
      limit: z.number().int().min(1).max(20).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    }),
    execute: async ({ limit, offset }: { limit?: number; offset?: number }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      if (!productId) return noProduct;
      const n = limit ?? 5;
      const off = offset ?? 0;
      const db = getSupabase();
      const [{ data: p }, { data: stats }] = await Promise.all([
        db
          .from("products")
          .select("title,handle,source_id,variants_json")
          .eq("store_id", storeId)
          .eq("id", productId)
          .maybeSingle(),
        db
          .from("product_stats")
          .select("buyers_all")
          .eq("store_id", storeId)
          .eq("product_id", productId)
          .limit(10),
      ]);
      if (!p) return { error: "Producto no encontrado en esta tienda." };
      const prp = p as Record<string, unknown>;
      // Match canónico global (issue #29): mismo índice que stats/drawer.
      // CAP con flag honesto: si el catálogo supera el índice, se expone.
      const { buildProductPidIndex: buildPidB, resolveProductPid: resolvePidB, normProductTitle: normTB, normProductTitleLoose: normLooseB } = await import("@/lib/product-stats");
      const PRODUCT_INDEX_CAP_B = 5000;
      const [{ data: prodsAllB }, { count: prodsTotalB }] = await Promise.all([
        db
          .from("products")
          .select("id,title,handle,source_id,variants_json")
          .eq("store_id", storeId)
          .limit(PRODUCT_INDEX_CAP_B),
        db.from("products").select("id", { count: "exact", head: true }).eq("store_id", storeId),
      ]);
      const pidIndexB = buildPidB((prodsAllB ?? []) as Array<Record<string, unknown>>);
      const indexedB = (prodsAllB ?? []).some((r) => String((r as Record<string, unknown>).id ?? "") === productId);
      const productIndexTruncatedB = (prodsTotalB ?? (prodsAllB ?? []).length) > (prodsAllB ?? []).length;
      const normTitleB = normTB(String(prp.title ?? ""));
      const normTitleLooseB = normLooseB(String(prp.title ?? ""));
      const isMineB = (it: Record<string, unknown>): boolean => {
        const resolved = resolvePidB(pidIndexB, it);
        if (resolved) return resolved === productId;
        // Fallback si el catálogo truncó y este producto quedó fuera:
        // exacto + loose sobre title y product_title (canónico product-stats).
        if (!indexedB && (normTitleB !== "" || normTitleLooseB !== "")) {
          if (normTB(String(it.title ?? "")) === normTitleB) return true;
          if (normTB(String(it.product_title ?? "")) === normTitleB) return true;
          if (
            normTitleLooseB !== "" &&
            (normLooseB(String(it.title ?? "")) === normTitleLooseB ||
              normLooseB(String(it.product_title ?? "")) === normTitleLooseB)
          )
            return true;
        }
        return false;
      };
      const statsTotal = ((stats ?? []) as Array<Record<string, unknown>>)
        .reduce((acc, s) => acc + Number(s.buyers_all ?? 0), 0);
      const { resolveShopCurrency } = await import("@/lib/store-profiles");
      const shopCurrency = ((await resolveShopCurrency(storeId).catch(() => null)) ?? null)?.toUpperCase() ?? null;
      const viewCurrency = shopCurrency;
      // Agregado paginado con CAP + flag: lotes 1000 sobre órdenes reales.
      const PAGE = 1000;
      const CAP = 20000;
      const buyerAgg = new Map<string, Map<string, { qty: number; revenue: number }>>();
      let scanned = 0;
      let hitCap = false;
      for (let at = 0; ; at += PAGE) {
        const baseQB = db
          .from("orders")
          .select("currency,items_json,customer_id,country,status,payment_status,is_test")
          .eq("store_id", storeId)
          .order("placed_at", { ascending: false })
          .order("id", { ascending: true });
        const { data, error } = await baseQB.range(at, at + PAGE - 1);
        if (error) return { error: error.message };
        const orows = (data ?? []) as Array<Record<string, unknown>>;
        for (const o of orows) {
          if (!isRealDbOrder({
            status: typeof o.status === "string" ? o.status : null,
            payment_status: typeof o.payment_status === "string" ? o.payment_status : null,
            is_test: o.is_test === true,
          })) continue;
          // scanned = órdenes reales (issue #29, no basura).
          scanned += 1;
          const cur = (o.currency as string | null) ?? null;
          const oitems = Array.isArray(o.items_json) ? (o.items_json as Array<Record<string, unknown>>) : [];
          let qty = 0;
          let revenue = 0;
          for (const it of oitems) {
            if (!isMineB(it)) continue;
            const q = Number(it.quantity ?? 0);
            if (!(q > 0)) continue;
            qty += q;
            revenue += q * Number(it.unit_price ?? 0);
          }
          if (qty > 0) {
            const cid = typeof o.customer_id === "string" ? o.customer_id : null;
            if (cid) {
              let perCur = buyerAgg.get(cid);
              if (!perCur) { perCur = new Map(); buyerAgg.set(cid, perCur); }
              const curKey = (cur ?? "").toUpperCase();
              const b = perCur.get(curKey) ?? { qty: 0, revenue: 0 };
              b.qty += qty;
              b.revenue += revenue;
              perCur.set(curKey, b);
            }
          }
        }
        if (orows.length < PAGE) break;
        if (scanned >= CAP) {
          hitCap = true;
          break;
        }
      }
      const rankedAll = [...buyerAgg.entries()].map(([cid, perCur]) => {
        const [currency, b] = [...perCur.entries()].sort((a, b2) => b2[1].revenue - a[1].revenue)[0]!;
        return { customer_id: cid, qty: b.qty, revenue: b.revenue, currency };
      }).sort((a, b) => b.revenue - a.revenue);
      // Total honesto: distintos reales del scan. product_stats suma por moneda
      // (duplica multi-moneda) y puede estar stale: se expone aparte, no como total.
      const total = buyerAgg.size;
      const statsStale = (stats ?? []).length === 0 ? total > 0 : statsTotal !== total;
      const ranked = rankedAll.slice(off, off + n);
      let items: Array<Record<string, unknown>> = ranked.map((r) => ({
        ...r,
        revenue_display: formatMoney(r.revenue, r.currency || null),
        email: "",
        name: "Sin nombre",
        company: null,
      }));
      if (ranked.length > 0) {
        const cq = db
          .from("customers")
          .select("id,email,first_name,last_name,company_name")
          .eq("store_id", storeId)
          .in("id", ranked.map((r) => r.customer_id));
        const { data: custs, error: cErr } = await cq;
        if (cErr) return { error: cErr.message };
        const byId = new Map(
          ((custs ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id ?? ""), c]),
        );
        items = ranked.map((r) => {
          const c = byId.get(r.customer_id);
          const name = c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "";
          return {
            ...r,
            revenue_display: formatMoney(r.revenue, r.currency || null),
            email: c ? String(c.email ?? "") : "",
            name: name || "Sin nombre",
            company: c && c.company_name ? String(c.company_name) : null,
          };
        });
      }
      const truncated = total > items.length + off || hitCap;
      const { count: nullCountryCount } = await db.from("customers").select("id", { count: "exact", head: true }).eq("store_id", storeId).is("country", null);
      return {
        items,
        total_count: total,
        returned_count: items.length,
        truncated,
        scanned_orders: scanned,
        view_currency: viewCurrency,
        stats_total: statsTotal,
        stats_stale: statsStale,
        null_country_count: nullCountryCount ?? null,
        product_index_truncated: productIndexTruncatedB,
        note_truncated: hitCap ? "Muestra parcial: universo mayor al CAP escaneado." : truncated ? `Te muestro ${items.length} de ${total}: pide offset ${off + items.length} para los siguientes.` : null,
        note: (productIndexTruncatedB ? "Índice de catálogo truncado (5000): el match por ID fuera del índice cae a título y puede divergir de product_stats. " : "") + DISPLAY_RULE,
      };
    },
  });

  /** Guarda defensiva (hoy inalcanzable: la tool de empresa solo se
   *  registra con companyId en contexto; sin foco no existe). */
  const noCompany = { error: "Sin empresa en contexto: abre su ficha en Empresas." };

  /** Ficha de la empresa en foco: identidad + contactos + pedidos (IOs
   *  donde es anunciante o facturación) + campañas donde es anunciante.
   *  Es lo mismo que ven los tabs del drawer. Úsala antes de afirmar
   *  cualquier dato de ESTA empresa. Los contactos (llamar/WhatsApp) se
   *  hacen en la GUI: la tool no escribe. No expone comisión de agencia. */
  const companyProfile = new FunctionTool({
    name: "get_company_profile",
    description:
      "Ficha de la empresa en foco: identidad (nombre, tipo, RUT, dominio, email, teléfono, ciudad/país), contactos (principal primero), pedidos/IOs (número, marca, estado) y campañas (nombre, estado). Úsala antes de afirmar cualquier dato de ESTA empresa. " + DISPLAY_RULE,
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      if (!companyId) return noCompany;
      const db = getSupabase();
      const { data: co, error: coErr } = await db
        .from("companies")
        .select("id,name,kind,tax_id,domain,email,phone,city,country")
        .eq("store_id", storeId)
        .eq("id", companyId)
        .maybeSingle();
      if (coErr) return { error: coErr.message };
      if (!co) return { error: "Empresa no encontrada en esta tienda." };
      const c = co as Record<string, unknown>;
      const [contactsRes, iosRes, campsRes, contactsTotal, iosTotal, campsTotal] = await Promise.all([
        db.from("contacts").select("first_name,last_name,email,phone,job_title,is_primary").eq("store_id", storeId).eq("company_id", companyId).order("is_primary", { ascending: false }).limit(30),
        db.from("insertion_orders").select("io_number,brand,status").eq("store_id", storeId).or(`advertiser_company_id.eq.${companyId},billing_company_id.eq.${companyId}`).order("created_at", { ascending: false }).limit(10),
        db.from("campaigns").select("name,status").eq("store_id", storeId).eq("advertiser_company_id", companyId).order("created_at", { ascending: false }).limit(10),
        db.from("contacts").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("company_id", companyId),
        db.from("insertion_orders").select("id", { count: "exact", head: true }).eq("store_id", storeId).or(`advertiser_company_id.eq.${companyId},billing_company_id.eq.${companyId}`),
        db.from("campaigns").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("advertiser_company_id", companyId),
      ]);
      const contacts = contactsRes.data ?? [];
      const ios = iosRes.data ?? [];
      const campaigns = campsRes.data ?? [];
      const cname = (row: Record<string, unknown>) =>
        [row.first_name, row.last_name].filter(Boolean).join(" ") || "—";
      return {
        company: {
          id: String(c.id ?? ""),
          name: String(c.name ?? ""),
          kind: (c.kind as string | null) ?? null,
          tax_id: (c.tax_id as string | null) ?? null,
          domain: (c.domain as string | null) ?? null,
          email: (c.email as string | null) ?? null,
          phone: (c.phone as string | null) ?? null,
          city: (c.city as string | null) ?? null,
          country: (c.country as string | null) ?? null,
        },
        contacts: ((contacts ?? []) as Array<Record<string, unknown>>).map((r) => ({
          name: cname(r),
          email: (r.email as string | null) ?? null,
          phone: (r.phone as string | null) ?? null,
          job_title: (r.job_title as string | null) ?? null,
          is_primary: r.is_primary === true,
        })),
        contacts_total: contactsTotal.count ?? null,
        ios: ((ios ?? []) as Array<Record<string, unknown>>).map((r) => ({
          io_number: String(r.io_number ?? ""),
          brand: (r.brand as string | null) ?? null,
          status: String(r.status ?? ""),
        })),
        ios_total: iosTotal.count ?? null,
        campaigns: ((campaigns ?? []) as Array<Record<string, unknown>>).map((r) => ({
          name: String(r.name ?? ""),
          status: String(r.status ?? ""),
        })),
        campaigns_total: campsTotal.count ?? null,
        note: "Listas acotadas (30 contactos, 10 IOs/campañas recientes): usa los *_total exactos para el M y dilo si hay más. Contactos del drawer (llamar/WhatsApp) no tienen tool: se hacen en la GUI. " + DISPLAY_RULE,
      };
    },
  });

  return [summary, recovery, signals, actions, approveActions, rejectActions, inboxSummary, hoySnapshot, runsStatus, dismissSignals, reopenSignals, decideLead, find, filterCustomers, profile, orders, firmographics, leads, prospect, topProducts, ...(productId ? [productSummary, productMovements, productBuyers] : []), ...(companyId ? [companyProfile] : []), ...loopTools];
}
