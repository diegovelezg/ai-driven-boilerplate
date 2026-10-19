import { FunctionTool, type BaseTool } from "@google/adk";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { domainFromEmail } from "@/lib/domains";
import { applyScopeFilter, type MarketScope } from "@/lib/markets";
import { queryStoreCustomers } from "@/lib/customers-db";
import { loadCustomerOrdersAndRfm, loadCustomerFirmographics } from "@/lib/customer-data";
import { getIcp, runProspect } from "@/lib/prospect";
import { startRun } from "@/lib/background";

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
   * Filtro global por mercado (null = todos). Por ISO2 (corto); IDs solo en
   * el fallback sin países (ver resolveMarketScope en lib/markets).
   */
  marketCountries?: string[] | null;
  marketCustomerIds?: string[] | null;
}

function needStore(ctx: AgentContext): string | null {
  return ctx.storeId ?? null;
}

/**
 * Tools del agente generalista de retención. Ámbito tienda (resumen, señales,
 * acciones, buscar customer) + ámbito ficha (perfil, compras/RFM, empresa)
 * + loop de retención como tools (scout/strategist/copywriter/dispatcher/
 * analyst corren en background y devuelven run_id; el humano aprueba en
 * /review). Lectura + disparo de workers: proponer/enviar nunca es directo.
 */
export function createRetainTools(ctx: AgentContext): BaseTool[] {
  const storeId = needStore(ctx);
  const customerId = ctx.customerId ?? null;
  const marketScope = {
    countries: ctx.marketCountries ?? null,
    customerIds: ctx.marketCustomerIds ?? null,
  };

  /** Aplica el filtro de mercado (NULL-comodín: sin país pasa todo filtro). */
  const withMarket = <T>(q: T, idCol: string | null = "customer_id"): T =>
    applyScopeFilter(q, marketScope, idCol);

  const summary = new FunctionTool({
    name: "get_store_summary",
    description:
      "Resumen de la tienda: nº de customers, compradores, desglose B2B/B2C (conteos y compradores por tipo efectivo), FACTURACIÓN BRUTA acumulada por moneda (revenue_by_currency), señales abiertas y acciones pendientes. NO es recupero: ventas ≠ recuperado. Para 'cuánto recuperamos' usa SIEMPRE get_recovery_stats.",
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      // Conteos exactos (no .length de una ventana): única fuente de totales.
      const baseCust = withMarket(
        db.from("customers").select("id", { count: "exact", head: true }).eq("store_id", storeId),
        "id",
      );
      const baseBuyers = withMarket(
        db.from("customers").select("id", { count: "exact", head: true }).eq("store_id", storeId).gt("orders_count", 0),
        "id",
      );
      const sigCountQ = withMarket(
        db.from("churn_signals").select("id", { count: "exact", head: true }).eq("store_id", storeId).in("status", ["open", "prioritized"]),
      );
      const actCountQ = withMarket(
        db.from("proposed_actions").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("status", "pending_review"),
      );
      // Agregados (revenue + B2B/B2C): paginado completo en lotes, con flag si se capa.
      // PostgREST no suma por moneda: se pagina y se suma en JS sobre el universo.
      const PAGE = 1000;
      const CAP = 50000;
      let offset = 0;
      let truncated = false;
      const revenue: Record<string, number> = {};
      let b2b = 0;
      let b2c = 0;
      let b2bBuyers = 0;
      let b2cBuyers = 0;
      for (;;) {
        const pageQ = withMarket(
          db.from("customers").select("orders_count,total_spent,currency,customer_type,manual_edits").eq("store_id", storeId),
          "id",
        );
        const { data, error: pageErr } = await pageQ.range(offset, offset + PAGE - 1);
        if (pageErr) return { error: pageErr.message };
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        for (const r of rows) {
          const cur = String(r.currency ?? "?");
          revenue[cur] = (revenue[cur] ?? 0) + Number(r.total_spent ?? 0);
          const overrides = (r.manual_edits as Record<string, unknown> | null) ?? {};
          const manual =
            typeof overrides["customer_type"] === "string" && overrides["customer_type"] !== ""
              ? String(overrides["customer_type"]).toUpperCase()
              : null;
          const tipo = (manual ?? String(r.customer_type ?? "B2C")).toUpperCase() === "B2B" ? "B2B" : "B2C";
          const isBuyer = Number(r.orders_count ?? 0) > 0;
          if (tipo === "B2B") {
            b2b += 1;
            if (isBuyer) b2bBuyers += 1;
          } else {
            b2c += 1;
            if (isBuyer) b2cBuyers += 1;
          }
        }
        offset += rows.length;
        if (rows.length < PAGE) break;
        if (offset >= CAP) {
          truncated = true;
          break;
        }
      }
      const [{ count: totalCustomers }, { count: totalBuyers }, { count: openSignals }, { count: pendingActions }, { data: profile }] =
        await Promise.all([baseCust, baseBuyers, sigCountQ, actCountQ,
          db.from("store_profiles").select("business_model,industry,icp_description").eq("store_id", storeId).maybeSingle(),
        ]);
      const prof = (profile ?? {}) as Record<string, unknown>;
      return {
        customers: totalCustomers ?? offset,
        buyers: totalBuyers ?? 0,
        b2b_count: b2b,
        b2c_count: b2c,
        b2b_buyers: b2bBuyers,
        b2c_buyers: b2cBuyers,
        revenue_by_currency: revenue,
        open_signals: openSignals ?? 0,
        pending_actions: pendingActions ?? 0,
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
      "ÚNICA fuente de 'cuánto recuperamos': revenue_attributed medido por el analyst (clientes que volvieron tras acción, ventana según arquetipo). Devuelve rescatado del mes calendario actual y de últimos 30d + nº de conversiones. Si es 0/vacío, NO sustituyas con ventas: di 'aún sin recupero medido'.",
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      const { count: totalMeasured } = await withMarket(
        getSupabase()
          .from("proposed_actions")
          .select("id", { count: "exact", head: true })
          .eq("store_id", storeId)
          .not("revenue_attributed", "is", null),
      );
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
        const rq = withMarket(
          db
            .from("proposed_actions")
            .select("revenue_attributed,dispatched_at,created_at")
            .eq("store_id", storeId)
            .not("revenue_attributed", "is", null),
        );
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
      return {
        recovered_this_month: Math.round(recoveredMonth),
        converted_this_month: convertedMonth,
        recovered_30d: Math.round(recovered30d),
        converted_30d: converted30d,
        measured_actions: measured,
        total_measured: totalMeasured ?? measured,
        truncated,
        note: "Solo revenue_attributed (retención medida). La facturación bruta de get_store_summary NUNCA es recupero.",
      };
    },
  });

  const signals = new FunctionTool({
    name: "list_signals",
    description:
      "Señales del scout (quién debería haber recomprado, con motivo). Insumo interno del loop, no vocabulario del merchant: para sus preguntas usa las decisiones del motor (filter_customers: actuar, vigilar…) y responde en el chat. Si el merchant pide una cantidad ('los 3 primeros', 'dame 5'), pásala en 'limit' (1-20, default 10).",
    parameters: z.object({
      status: z.enum(["open", "prioritized", "actioned", "closed", "dismissed"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    execute: async ({ status, limit }: { status?: string; limit?: number }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const wanted = status ? [status] : ["open", "prioritized"];
      const n = limit ?? 10;
      const { count } = await withMarket(
        getSupabase().from("churn_signals").select("id", { count: "exact", head: true }).eq("store_id", storeId).in("status", wanted),
      );
      const sq = withMarket(
        getSupabase()
          .from("churn_signals")
          .select("id,customer_id,kind,score,reason,status,created_at,customers(email,first_name,last_name)")
          .eq("store_id", storeId)
          .in("status", wanted),
      );
      const { data, error } = await sq
        .order("created_at", { ascending: false })
        .limit(n);
      if (error) return { error: error.message };
      const rows = data ?? [];
      return {
        items: rows,
        total_count: count ?? rows.length,
        returned_count: rows.length,
        truncated: (count ?? rows.length) > rows.length,
      };
    },
  });

  const actions = new FunctionTool({
    name: "list_actions",
    description:
      "Acciones propuestas (mensajes WhatsApp/email). Por defecto las pendientes de revisión del humano. Si el merchant pide una cantidad ('los 3 primeros') pásala en 'limit' (1-20, default 10); si pide un canal ('solo WhatsApp'), pásalo en 'channel'.",
    parameters: z.object({
      status: z.enum(["pending_review", "approved", "rejected", "dispatched", "failed"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      channel: z.enum(["whatsapp", "email"]).optional(),
    }),
    execute: async ({ status, limit, channel }: { status?: string; limit?: number; channel?: string }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const n = limit ?? 10;
      let countQ = withMarket(
        getSupabase()
          .from("proposed_actions")
          .select("id", { count: "exact", head: true })
          .eq("store_id", storeId)
          .eq("status", status ?? "pending_review"),
      );
      if (channel) countQ = countQ.eq("channel", channel);
      const { count } = await countQ;
      let aq = withMarket(
        getSupabase()
          .from("proposed_actions")
          .select("id,customer_id,channel,subject,body,status,created_at,signal_id,evidence_json,customers(email,first_name,last_name),churn_signals(reason,score,kind)")
          .eq("store_id", storeId)
          .eq("status", status ?? "pending_review"),
      );
      if (channel) aq = aq.eq("channel", channel);
      const { data, error } = await aq
        .order("created_at", { ascending: false })
        .limit(n);
      if (error) return { error: error.message };
      const rows = data ?? [];
      return {
        items: rows,
        total_count: count ?? rows.length,
        returned_count: rows.length,
        truncated: (count ?? rows.length) > rows.length,
      };
    },
  });

  /** Escritura con guarda: solo filas pending de ESTA tienda cambian. */
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
      "Aprueba borradores pendientes para que el dispatcher pueda enviarlos. SOLO después de confirmación explícita del merchant en esta conversación (p.ej. 'sí, aprueba los 3'). Pasa los 'id' tal cual los devolvió list_actions (máx 20). Nunca apruebes sin que te lo confirmen.",
    parameters: z.object({ ids: z.array(z.string()).min(1).max(20) }),
    execute: async ({ ids }: { ids: string[] }) => setActionsStatus(ids, "approved"),
  });

  const rejectActions = new FunctionTool({
    name: "reject_actions",
    description:
      "Rechaza borradores pendientes (no se enviarán). SOLO después de confirmación explícita del merchant en esta conversación. Pasa los 'id' tal cual los devolvió list_actions (máx 20).",
    parameters: z.object({ ids: z.array(z.string()).min(1).max(20) }),
    execute: async ({ ids }: { ids: string[] }) => setActionsStatus(ids, "rejected"),
  });

  const find = new FunctionTool({
    name: "find_customer",
    description:
      "Busca un customer por email, nombre, teléfono o empresa —incluida la empresa enriquecida (nombre, industria, descripción/qué es, sede, dominio)— o por lo que compra/contrata (marca/categoría, ej. 'fisioterapia', 'K-pop', 'muebles') y devuelve su id para enfocar la conversación (úsalo si te nombran a alguien sin ficha abierta). Ej.: 'PUCP', 'universidad', 'educación superior'.",
    parameters: z.object({ q: z.string().min(2) }),
    execute: async ({ q }: { q: string }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      const esc = q.replace(/[%_\\]/g, "\\$&").replace(/,/g, " ");
      const like = `%${esc}%`;
      const fq = withMarket(
        getSupabase()
          .from("customers")
          .select("id,email,first_name,last_name,phone,company_name,orders_count,total_spent")
          .eq("store_id", storeId)
          .or(`email.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like},company_name.ilike.${like}`),
        "id",
      );
      const { data, error } = await fq.limit(5);
      if (error) return { error: error.message };
      const rows = ((data ?? []) as Array<Record<string, unknown>>).slice();
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
          const dq = withMarket(
            db
              .from("customers")
              .select("id,email,first_name,last_name,phone,company_name,orders_count,total_spent")
              .eq("store_id", storeId)
              .like("email", `%@${escD}`),
            "id",
          );
          const { data: dc } = await dq.limit(5 - rows.length);
          for (const c of ((dc ?? []) as Array<Record<string, unknown>>)) {
            if (seen.has(String(c.id))) continue;
            seen.add(String(c.id));
            rows.push({ ...c, enriched_company: firmByDomain.get(d)?.company ?? null });
          }
        }
      }
      // Contenido pautado (captions Nivel 1): marca/categoría/qué anuncia.
      if (rows.length < 5) {
        const { searchContentCustomerIds } = await import("@/lib/media-context");
        const hits = await searchContentCustomerIds(storeId, q).catch(() => new Map());
        const known = new Set(rows.map((r) => String((r as Record<string, unknown>).id)));
        const ids = [...hits.keys()].filter((id) => !known.has(id)).slice(0, 5 - rows.length);
        if (ids.length > 0) {
          const { data: cc } = await db
            .from("customers")
            .select("id,email,first_name,last_name,phone,company_name,orders_count,total_spent")
            .eq("store_id", storeId)
            .in("id", ids);
          for (const c of ((cc ?? []) as Array<Record<string, unknown>>)) {
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
      return { items: rows, returned_count: rows.length, total_count: null, truncated: false, note: "Top-5 por relevancia; puede haber más coincidencias." };
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
   *  Los filtros son los mismos de la tabla (?decision=&vista=&q=&tipo=B2B|B2C):
   *  el chat los escribe, no los duplica. Lo omitido no filtra. */
  const filterCustomers = new FunctionTool({
    name: "filter_customers",
    description:
      "Filtra la tabla de Customers y devuelve cuántos coinciden (la vista los muestra; aquí no se listan filas). decision: actuar, vigilar, no-tocar, organico, dormido, sin_canal, contactado_reciente o revision_humana (criterio del motor, foto del día). vista=ventana7: vigilar que entra en ventana en 7 días. ritmo: con-ritmo, primera o sin-compras (segmentación estructural). customer_type: B2B o B2C (tipo efectivo: override manual ?? clasificación por dominio). q = texto libre (email/nombre/teléfono/empresa, incluida la enriquecida: nombre, industria, descripción). Pasa SOLO lo que pida el merchant.",
    parameters: z.object({
      q: z.string().min(2).max(100).optional(),
      decision: z.enum(DECISIONS).optional(),
      vista: z.enum(["ventana7"]).optional(),
      ritmo: z.enum(["con-ritmo", "primera", "sin-compras"] as const).optional(),
      customer_type: z.enum(["B2B", "B2C"]).optional(),
    }),
    execute: async ({
      q,
      decision,
      vista,
      ritmo,
      customer_type,
    }: {
      q?: string;
      decision?: string;
      vista?: string;
      ritmo?: string;
      customer_type?: string;
    }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const scope: MarketScope = {
        market: null,
        countries: marketScope.countries,
        customerIds: marketScope.customerIds,
      };
      const res = await queryStoreCustomers(
        storeId,
        q?.trim() ?? "",
        1,
        1,
        undefined,
        {
          decision: (decision as (typeof DECISIONS)[number] | undefined) ?? null,
          vista: vista === "ventana7" ? "ventana7" : null,
          ritmo: ritmo ?? null,
          customerType: customer_type ?? null,
        },
        scope,
      );
      return {
        filter: {
          q: q?.trim() || null,
          decision: decision ?? null,
          vista: vista ?? null,
          ritmo: ritmo ?? null,
          customer_type: customer_type ?? null,
        },
        count: res.totalCount,
      };
    },
  });

  const profile = new FunctionTool({
    name: "get_customer_profile",
    description:
      "Ficha del customer en contexto: nombre, email, teléfono, empresa (efectiva: manual > Medusa > enriquecida), tipo (B2B/B2C), compras y gasto. Si la empresa viene del enriquecimiento, incluye industria y descripción (qué es). Úsala para identidad.",
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
      // Empresa efectiva (misma regla que la GUI): manual > Medusa > enriquecida.
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
        currency: (c.currency as string) ?? null,
        created_at: (c.created_at as string) ?? null,
      };
    },
  });

  const orders = new FunctionTool({
    name: "get_customer_orders",
    description:
      "Historial de compras del customer en contexto (más reciente primero) con ítems, hechos temporales (recencia, frecuencia, gasto, ticket, ciclo esperado sobre historial completo) y predicción. Devuelve envelope {orders, summary, prediction, totalOrders, truncated}. Pasa limit (1-30, default 10) y offset para paginar; si truncated=true hay más historial.",
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
      const { data: pred } = await getSupabase()
        .from("customer_predictions")
        .select("model,p_recompra_h,p_low,p_high,horizon_days,expected_days,p25_days,p75_days,ticket_esperado_minor,valor_esperado_minor,decision,confidence,as_of")
        .eq("customer_id", customerId)
        .order("as_of", { ascending: false })
        .limit(1)
        .maybeSingle();
      return { ...result, prediction: pred ?? null };
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
      "Leads propuestos por el prospector (negocios parecidos al ICP, con score y motivo). Por defecto los pendientes de revisión del humano. País por sus customers de referencia; sin evidencia se ven en todo filtro. Si el merchant pide una cantidad, pásala en 'limit' (1-20, default 10).",
    parameters: z.object({
      status: z.enum(["pending_review", "approved", "rejected", "contacted", "discarded"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    execute: async ({ status, limit }: { status?: string; limit?: number }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const n = limit ?? 10;
      const { count } = await withMarket(
        getSupabase()
          .from("proposed_leads")
          .select("id", { count: "exact", head: true })
          .eq("store_id", storeId)
          .eq("status", status ?? "pending_review"),
        null,
      );
      const lq = withMarket(
        getSupabase()
          .from("proposed_leads")
          .select("id,company,domain,url,contact,icp_score,reason,status,created_at,evidence_json")
          .eq("store_id", storeId)
          .eq("status", status ?? "pending_review"),
        null,
      );
      const { data, error } = await lq
        .order("icp_score", { ascending: false })
        .limit(n);
      if (error) return { error: error.message };
      const rows = data ?? [];
      return {
        items: rows,
        total_count: count ?? rows.length,
        returned_count: rows.length,
        truncated: (count ?? rows.length) > rows.length,
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
      const db = getSupabase();
      try {
        await getIcp(storeId);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
      const { data: running } = await db
        .from("background_runs")
        .select("id")
        .eq("store_id", storeId)
        .eq("kind", "prospect")
        .eq("status", "running")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (running) return { run_id: (running as Record<string, unknown>).id, already_running: true };
      const runId = await startRun(storeId, "prospect", "Prospección", 1);
      void runProspect(runId, storeId, { queries: queries ?? 2, perQuery: perQuery ?? 5, focus: focus?.trim() || null }).catch(() => undefined);
      return { run_id: runId, already_running: false, focus: focus?.trim() || null };
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
    const db = getSupabase();
    const { data: running } = await db
      .from("background_runs")
      .select("id")
      .eq("store_id", storeId)
      .eq("kind", kind)
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (running) return { run_id: (running as Record<string, unknown>).id, already_running: true };
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

  return [summary, recovery, signals, actions, approveActions, rejectActions, find, filterCustomers, profile, orders, firmographics, leads, prospect, ...loopTools];
}
