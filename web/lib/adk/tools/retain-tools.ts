import { FunctionTool, type BaseTool } from "@google/adk";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
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
      "Resumen de la tienda: nº de customers, compradores, FACTURACIÓN BRUTA acumulada por moneda (revenue_by_currency), señales abiertas y acciones pendientes. NO es recupero: ventas ≠ recuperado. Para 'cuánto recuperamos' usa SIEMPRE get_recovery_stats.",
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const db = getSupabase();
      const custQuery = withMarket(
        db.from("customers").select("orders_count,total_spent,currency").eq("store_id", storeId),
        "id",
      );
      const sigQuery = withMarket(
        db.from("churn_signals").select("id", { count: "exact" }).eq("store_id", storeId).in("status", ["open", "prioritized"]),
      );
      const actQuery = withMarket(
        db.from("proposed_actions").select("id", { count: "exact" }).eq("store_id", storeId).eq("status", "pending_review"),
      );
      const [{ data: customers, error }, { data: signals }, { data: actions }, { data: profile }] = await Promise.all([
        custQuery.limit(5000),
        sigQuery,
        actQuery,
        db.from("store_profiles").select("business_model,industry,icp_description").eq("store_id", storeId).maybeSingle(),
      ]);
      if (error) return { error: error.message };
      const rows = (customers ?? []) as Array<Record<string, unknown>>;
      const revenue: Record<string, number> = {};
      for (const r of rows) {
        const cur = String(r.currency ?? "?");
        revenue[cur] = (revenue[cur] ?? 0) + Number(r.total_spent ?? 0);
      }
      const prof = (profile ?? {}) as Record<string, unknown>;
      return {
        customers: rows.length,
        buyers: rows.filter((r) => Number(r.orders_count ?? 0) > 0).length,
        revenue_by_currency: revenue,
        open_signals: (signals as Array<unknown> | null)?.length ?? 0,
        pending_actions: (actions as Array<unknown> | null)?.length ?? 0,
        icp: (prof.icp_description as string) ?? null,
        business_model: (prof.business_model as string) ?? null,
        industry: (prof.industry as string) ?? null,
      };
    },
  });

  const recovery = new FunctionTool({
    name: "get_recovery_stats",
    description:
      "ÚNICA fuente de 'cuánto recuperamos': revenue_attributed medido por el analyst (clientes que volvieron tras acción, ventana 14d). Devuelve rescatado del mes calendario actual y de últimos 30d + nº de conversiones. Si es 0/vacío, NO sustituyas con ventas: di 'aún sin recupero medido'.",
    parameters: z.object({}),
    execute: async () => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const rq = withMarket(
        getSupabase()
          .from("proposed_actions")
          .select("revenue_attributed,dispatched_at,created_at")
          .eq("store_id", storeId)
          .not("revenue_attributed", "is", null),
      );
      const { data, error } = await rq.limit(500);
      if (error) return { error: error.message };
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const last30 = now.getTime() - 30 * 86_400_000;
      let recoveredMonth = 0;
      let recovered30d = 0;
      let convertedMonth = 0;
      let converted30d = 0;
      let measured = 0;
      for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
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
      return {
        recovered_this_month: Math.round(recoveredMonth),
        converted_this_month: convertedMonth,
        recovered_30d: Math.round(recovered30d),
        converted_30d: converted30d,
        measured_actions: measured,
        note: "Solo revenue_attributed (retención medida). La facturación bruta de get_store_summary NUNCA es recupero.",
      };
    },
  });

  const signals = new FunctionTool({
    name: "list_signals",
    description:
      "Señales de churn de la tienda (quién se está enfriando, con motivo y score). Por defecto abiertas y priorizadas. Si el merchant pide una cantidad ('los 3 primeros', 'dame 5'), pásala en 'limit' (1-20, default 10).",
    parameters: z.object({
      status: z.enum(["open", "prioritized", "actioned", "closed", "dismissed"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    execute: async ({ status, limit }: { status?: string; limit?: number }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const wanted = status ? [status] : ["open", "prioritized"];
      const sq = withMarket(
        getSupabase()
          .from("churn_signals")
          .select("id,customer_id,kind,score,reason,status,created_at,customers(email,first_name,last_name)")
          .eq("store_id", storeId)
          .in("status", wanted),
      );
      const { data, error } = await sq
        .order("created_at", { ascending: false })
        .limit(limit ?? 10);
      if (error) return { error: error.message };
      return data ?? [];
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
        .limit(limit ?? 10);
      if (error) return { error: error.message };
      return data ?? [];
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
      "Busca un customer por email o nombre y devuelve su id para enfocar la conversación (úsalo si te nombran a alguien sin ficha abierta).",
    parameters: z.object({ q: z.string().min(2) }),
    execute: async ({ q }: { q: string }) => {
      if (!storeId) return { error: "Sin tienda en contexto." };
      const like = `%${q}%`;
      const fq = withMarket(
        getSupabase()
          .from("customers")
          .select("id,email,first_name,last_name,orders_count,total_spent")
          .eq("store_id", storeId)
          .or(`email.ilike.${like},first_name.ilike.${like},last_name.ilike.${like}`),
        "id",
      );
      const { data, error } = await fq.limit(5);
      if (error) return { error: error.message };
      return data ?? [];
    },
  });

  const noCustomer = { error: "Sin customer en contexto: abre su ficha o usa find_customer para localizarlo." };

  const SEGMENTS = [
    "Campeón",
    "Recurrente",
    "Ocasional",
    "En riesgo",
    "Inactivo",
    "Nuevo",
    "Sin compras",
  ] as const;

  /** Filtra la tabla de Customers: la vista muestra, aquí solo se cuenta.
   *  Los filtros son los mismos de la tabla (?segment=&ticket=&freq=&vip=&q=):
   *  el chat los escribe, no los duplica. Lo omitido no filtra. */
  const filterCustomers = new FunctionTool({
    name: "filter_customers",
    description:
      "Filtra la tabla de Customers y devuelve cuántos coinciden (la vista los muestra; aquí no se listan filas). Segmento: Campeón, Recurrente, Ocasional, En riesgo, Inactivo, Nuevo o Sin compras. ticketTier 0-3 = cuartil de ticket (3 = top). freqBucket 0-3 = 1, 2, 3–5, 6+ compras. vip = solo insignia 'No los pierdas'. q = texto libre (email/nombre/teléfono). Pasa SOLO lo que pida el merchant.",
    parameters: z.object({
      q: z.string().min(2).max(100).optional(),
      segment: z.enum(SEGMENTS).optional(),
      ticketTier: z.number().int().min(0).max(3).optional(),
      freqBucket: z.number().int().min(0).max(3).optional(),
      vip: z.boolean().optional(),
    }),
    execute: async ({
      q,
      segment,
      ticketTier,
      freqBucket,
      vip,
    }: {
      q?: string;
      segment?: string;
      ticketTier?: number;
      freqBucket?: number;
      vip?: boolean;
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
          segment: (segment as (typeof SEGMENTS)[number] | undefined) ?? null,
          ticketTier: ticketTier ?? null,
          freqBucket: freqBucket ?? null,
          noLosPierdas: vip ?? false,
        },
        scope,
      );
      return {
        filter: {
          q: q?.trim() || null,
          segment: segment ?? null,
          ticket: ticketTier ?? null,
          freq: freqBucket ?? null,
          vip: vip ? true : null,
        },
        count: res.totalCount,
      };
    },
  });

  const profile = new FunctionTool({
    name: "get_customer_profile",
    description:
      "Ficha del customer en contexto: nombre, email, teléfono, empresa, tipo (B2B/B2C), compras y gasto. Úsala para identidad.",
    parameters: z.object({}),
    execute: async () => {
      if (!customerId) return noCustomer;
      const { data, error } = await getSupabase()
        .from("customers")
        .select("first_name,last_name,email,phone,company_name,customer_type,orders_count,total_spent,currency,created_at")
        .eq("id", customerId)
        .maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "Customer no encontrado." };
      const c = data as Record<string, unknown>;
      return {
        first_name: (c.first_name as string) ?? null,
        last_name: (c.last_name as string) ?? null,
        email: (c.email as string) ?? null,
        phone: (c.phone as string) ?? null,
        company_name: (c.company_name as string) ?? null,
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
      "Historial de compras del customer en contexto (más reciente primero) con ítems y resumen RFM (recencia, frecuencia, gasto, ticket, scores 1-5 vs la tienda y segmento). Para compras, churn o recompra.",
    parameters: z.object({}),
    execute: async () => {
      if (!customerId) return noCustomer;
      const result = await loadCustomerOrdersAndRfm(customerId, 30);
      if (!result) return { error: "Customer no encontrado." };
      return result;
    },
  });

  const firmographics = new FunctionTool({
    name: "get_customer_firmographics",
    description:
      "Empresa del customer en contexto por su dominio (nombre, industria, tamaño, ubicación). Puede no estar enriquecida.",
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
        .limit(limit ?? 10);
      if (error) return { error: error.message };
      return data ?? [];
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
        "Lanza el scout: detecta quién debería haber recomprado (RFM + intervalo) y abre señales en churn_signals. Tarda ~1 min en background; devuelve run_id. Si ya corre uno, devuelve ese.",
    },
    {
      name: "start_strategist_run",
      label: "Estratega",
      description:
        "Lanza el estratega: prioriza las señales abiertas (valor × score) con objetivo winback|nurture|vip_care. Corre tras el scout; devuelve run_id.",
    },
    {
      name: "start_copywriter_run",
      label: "Copywriter",
      description:
        "Lanza el copywriter: redacta con LLM un WhatsApp/email por señal priorizada (historial real) a pending_review para /review. Nunca envía. Gasta LLM; límite 10 por corrida. Devuelve run_id.",
    },
    {
      name: "start_dispatcher_run",
      label: "Dispatcher",
      description:
        "Lanza el dispatcher: envía las acciones aprobadas. STUB sin proveedor real (WhatsApp/email pendiente de decisión comercial): sin RETAIN_DISPATCH_STUB no cambia nada. Devuelve run_id.",
    },
    {
      name: "start_analyst_run",
      label: "Analyst",
      description:
        "Lanza el analyst: mide conversiones en ventana 14d post-envío (revenue_attributed) y cierra señales. Devuelve run_id.",
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
