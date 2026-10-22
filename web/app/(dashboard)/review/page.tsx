import Link from "next/link";
import { formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { readConnections } from "@/lib/store";
import { isSupabaseConfigured, getSupabase } from "@/lib/supabase";
import { resolveStoreId } from "@/lib/customers-db";
import {
  ReviewLists,
  HISTORY_PAGE_SIZE,
  type ActionRow,
  type LeadRow,
  type SignalRow,
} from "./review-lists";
import { getRankedMira } from "@/lib/mira";
import { resolveContact } from "@/lib/comms/contact";
import { buildWaMeUrl } from "@/lib/comms/whatsapp/wame";
import {
  applyScopeFilter,
  resolveMarketScope,
} from "@/lib/markets";
import { requireMyStoreAccess } from "@/lib/tenant";

export const instant = false;

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    market?: string;
    tab?: string;
    /** Filtro del chat ("muéstrame los 3"): IDs exactos por sección. */
    actionIds?: string;
    leadIds?: string;
    signalIds?: string;
    /** Paginación de historiales (los únicos que crecen sin cota). */
    apage?: string;
    cpage?: string;
  }>;
}) {
  const conn = await readConnections();
  const connected = Boolean(conn.medusaUrl);
  const dbReady = isSupabaseConfigured();
  const sp = await searchParams;
  const clampPage = (raw: string | undefined): number => {
    const n = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const sentPage = clampPage(sp.apage);
  const contactedPage = clampPage(sp.cpage);

  let actions: ActionRow[] = [];
  /** Aprobadas aún no enviadas (invisibles hasta hoy: solo se listaba pending). */
  let approvedActions: ActionRow[] = [];
  /** Rechazadas/canceladas recientes: nada desaparece, se rescatan con Reabrir. */
  let rejectedActions: ActionRow[] = [];
  /** Enviadas (historial paginado con total exacto). */
  let dispatchedActions: ActionRow[] = [];
  let dispatchedTotal = 0;
  let contactedTotal = 0;
  let leads: LeadRow[] = [];
  /** Aprobados aún no contactados: "Ya lo contacté" los cierra. */
  let approvedLeads: LeadRow[] = [];
  /** Contactados y descartados: filtros visibles, nada desaparece para siempre. */
  let contactedLeads: LeadRow[] = [];
  let discardedLeads: LeadRow[] = [];
  let signals: SignalRow[] = [];
  /** Descartadas recientes (contactar igual): reabrir las devuelve a la cola. */
  let dismissedSignals: SignalRow[] = [];
  let runningKinds = new Set<string>();
  let error: string | null = null;
  /** Dominios que ya son customers (para el check “no es cliente actual”). */
  const customerDomains = new Set<string>();
  let shopCurrency: string | null = null;
  let ultimaCompraLabel = "última compra";
  let isB2BReview = true;
  /** Gate del botón prospectar: solo B2B (fail-open en error; el backend veta). */
  let prospectEligible = true;

  if (connected && dbReady) {
    try {
      const storeId = await resolveStoreId(conn.medusaUrl);
      if (!storeId) {
        error = "Tienda aún sin sincronizar.";
      } else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda. Pide a tu admin que te agregue en merchant_users.";
      } else {
        const db = getSupabase();
        // Filtro global por país/mercado (?market= del header). Acciones y
        // señales filtran por sus customers; leads no tienen país (van todos).
        const scope = await resolveMarketScope(storeId, sp.market).catch(() => null);
        const [{ data: a, error: aErr }, { data: ap, error: apErr }, { data: ar, error: arErr }, { data: ds, error: dsErr }, { count: dsTotal, error: dsCountErr }, { data: l, error: lErr }, { data: al, error: alErr }, { data: cl, error: clErr }, { count: clTotal, error: clCountErr }, { data: dl, error: dlErr }, { data: br }] =
          await Promise.all([
            (async () => {
              const aq = applyScopeFilter(
                db
                  .from("proposed_actions")
                  .select("id,customer_id,channel,subject,body,status,created_at,approved_by,approved_at,dispatched_at,revenue_attributed,evidence_json,customers(email,first_name,last_name,phone,country),churn_signals(reason,score,kind)")
                  .eq("store_id", storeId)
                  .eq("status", "pending_review"),
                scope,
              );
              return aq.order("created_at", { ascending: false }).limit(30);
            })(),
            (async () => {
              const aq = applyScopeFilter(
                db
                  .from("proposed_actions")
                  .select("id,customer_id,channel,subject,body,status,created_at,approved_by,approved_at,dispatched_at,revenue_attributed,evidence_json,customers(email,first_name,last_name,phone,country),churn_signals(reason,score,kind)")
                  .eq("store_id", storeId)
                  .eq("status", "approved")
                  .is("dispatched_at", null),
                scope,
              );
              return aq.order("created_at", { ascending: true }).limit(30);
            })(),
            (async () => {
              const aq = applyScopeFilter(
                db
                  .from("proposed_actions")
                  .select("id,customer_id,channel,subject,body,status,created_at,approved_by,approved_at,dispatched_at,revenue_attributed,evidence_json,customers(email,first_name,last_name,phone,country),churn_signals(reason,score,kind)")
                  .eq("store_id", storeId)
                  .eq("status", "rejected"),
                scope,
              );
              return aq.order("created_at", { ascending: false }).limit(20);
            })(),
            (async () => {
              const aq = applyScopeFilter(
                db
                  .from("proposed_actions")
                  .select("id,customer_id,channel,subject,body,status,created_at,approved_by,approved_at,dispatched_at,revenue_attributed,evidence_json,customers(email,first_name,last_name,phone,country),churn_signals(reason,score,kind)")
                  .eq("store_id", storeId)
                  .eq("status", "dispatched"),
                scope,
              );
              return aq
                .order("dispatched_at", { ascending: false })
                .range(sentPage * HISTORY_PAGE_SIZE, sentPage * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE - 1);
            })(),
            (async () => {
              const cq = applyScopeFilter(
                db
                  .from("proposed_actions")
                  .select("id", { count: "exact", head: true })
                  .eq("store_id", storeId)
                  .eq("status", "dispatched"),
                scope,
              );
              return cq;
            })(),
            applyScopeFilter(
              db
                .from("proposed_leads")
                .select("id,company,domain,url,contact,source,created_at,icp_score,reason,evidence_json")
                .eq("store_id", storeId)
                .eq("status", "pending_review"),
              scope,
              null,
            )
              .order("icp_score", { ascending: false, nullsFirst: false })
              .limit(30),
            // Aprobados aún no contactados: "Ya lo contacté" los cierra.
            applyScopeFilter(
              db
                .from("proposed_leads")
                .select("id,company,domain,url,contact,source,created_at,icp_score,reason,evidence_json")
                .eq("store_id", storeId)
                .eq("status", "approved"),
              scope,
              null,
            )
              .order("created_at", { ascending: true })
              .limit(30),
            // Contactados (historial paginado con total exacto) y descartados.
            applyScopeFilter(
              db
                .from("proposed_leads")
                .select("id,company,domain,url,contact,source,created_at,icp_score,reason,evidence_json")
                .eq("store_id", storeId)
                .eq("status", "contacted"),
              scope,
              null,
            )
              .order("created_at", { ascending: false })
              .range(contactedPage * HISTORY_PAGE_SIZE, contactedPage * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE - 1),
            applyScopeFilter(
              db
                .from("proposed_leads")
                .select("id", { count: "exact", head: true })
                .eq("store_id", storeId)
                .eq("status", "contacted"),
              scope,
              null,
            ),
            applyScopeFilter(
              db
                .from("proposed_leads")
                .select("id,company,domain,url,contact,source,created_at,icp_score,reason,evidence_json")
                .eq("store_id", storeId)
                .in("status", ["rejected", "discarded"]),
              scope,
              null,
            )
              .order("created_at", { ascending: false })
              .limit(20),
            // Corridas en curso: la sección vacía muestra skeleton, no un vacío engañoso.
            db
              .from("background_runs")
              .select("kind,status")
              .eq("store_id", storeId)
              .order("started_at", { ascending: false })
              .limit(10),
          ]);
        if (aErr) throw new Error(`Actions read: ${aErr.message}`);
        if (apErr) throw new Error(`Approved read: ${apErr.message}`);
        if (arErr) throw new Error(`Rejected read: ${arErr.message}`);
        if (dsErr) throw new Error(`Dispatched read: ${dsErr.message}`);
        if (dsCountErr) throw new Error(`Dispatched count: ${dsCountErr.message}`);
        if (lErr) throw new Error(`Leads read: ${lErr.message}`);
        if (alErr) throw new Error(`Approved leads read: ${alErr.message}`);
        if (clErr) throw new Error(`Contacted leads read: ${clErr.message}`);
        if (clCountErr) throw new Error(`Contacted count: ${clCountErr.message}`);
        if (dlErr) throw new Error(`Discarded leads read: ${dlErr.message}`);
        // head:true no trae filas: el total vive en `count` de la respuesta.
        dispatchedTotal = dsTotal ?? 0;
        contactedTotal = clTotal ?? 0;
        runningKinds = new Set(
          ((br ?? []) as Array<Record<string, unknown>>)
            .filter((r) => r.status === "running")
            .map((r) => String(r.kind ?? "")),
        );
        const toActionRow = (r: Record<string, unknown>) => {
          const c = (r.customers ?? {}) as Record<string, unknown>;
          const sig = (r.churn_signals ?? {}) as Record<string, unknown>;
          const name =
            [c.first_name, c.last_name].filter(Boolean).join(" ") || String(c.email ?? "");
          const channel = String(r.channel ?? "?");
          const body = String(r.body ?? "");
          // Capacidades del cliente: qué canales se pueden ofrecer y el link
          // wa.me cuando hay teléfono normalizable (null → solo email).
          const caps = resolveContact({
            email: typeof c.email === "string" ? c.email : null,
            phone: typeof c.phone === "string" ? c.phone : null,
            countryIso: typeof c.country === "string" ? c.country : null,
          });
          const wameUrl =
            channel === "whatsapp"
              ? buildWaMeUrl({
                  phone: typeof c.phone === "string" ? c.phone : null,
                  countryIso: typeof c.country === "string" ? c.country : null,
                  text: body,
                })
              : null;
          return {
            id: String(r.id),
            channel,
            subject: (r.subject as string | null) ?? null,
            body,
            status: String(r.status ?? ""),
            created_at: String(r.created_at ?? ""),
            customerId: String(r.customer_id ?? ""),
            email: String(c.email ?? ""),
            name,
            reason: (sig.reason as string | null) ?? null,
            score: sig.score == null ? null : Number(sig.score),
            kind: (sig.kind as string | null) ?? null,
            generator: ((r.evidence_json as Record<string, unknown> | null)?.generator as string | null) ?? null,
            approvedBy: (r.approved_by as string | null) ?? null,
            approvedAt: (r.approved_at as string | null) ?? null,
            dispatchedAt: (r.dispatched_at as string | null) ?? null,
            revenueMinor: r.revenue_attributed == null ? null : Number(r.revenue_attributed),
            wameUrl,
            canSwitchChannel: caps.capability === "both",
          };
        };
        actions = ((a ?? []) as Array<Record<string, unknown>>).map(toActionRow);
        approvedActions = ((ap ?? []) as Array<Record<string, unknown>>).map(toActionRow);
        rejectedActions = ((ar ?? []) as Array<Record<string, unknown>>).map(toActionRow);
        dispatchedActions = ((ds ?? []) as Array<Record<string, unknown>>).map(toActionRow);
        // Sustento del motor: última predicción por cliente + última orden real.
        // Un join en JS sobre dos queries bulk (sin N+1).
        try {
          const { getStoreProfile } = await import("@/lib/store-profiles");
          const profile = await getStoreProfile(storeId).catch(() => null);
          const cat = profile?.catalogType ?? null;
          ultimaCompraLabel = cat === "servicio" || cat === "digital" ? "última pauta" : "última compra";
          isB2BReview = profile?.archetype === "b2b_proyecto" || profile?.archetype === "b2b_recurrente";
          const custIds = [...new Set(actions.map((x) => x.customerId).filter(Boolean))];
          if (custIds.length > 0) {
            const [{ data: pr }, { data: or }] = await Promise.all([
              db
                .from("customer_predictions")
                .select("customer_id,decision,p_recompra_h,p_low,p_high,horizon_days,ticket_esperado_minor,confidence,evidence_json")
                .eq("store_id", storeId)
                .in("customer_id", custIds)
                .order("as_of", { ascending: false })
                .order("model_version", { ascending: false })
                .limit(500),
              db
                .from("orders")
                .select("customer_id,placed_at,items_json")
                .eq("store_id", storeId)
                .in("customer_id", custIds)
                .order("placed_at", { ascending: false })
                .limit(500),
            ]);
            const predById = new Map<string, Record<string, unknown>>();
            for (const r of (pr ?? []) as Array<Record<string, unknown>>) {
              const cid = String(r.customer_id ?? "");
              if (cid && !predById.has(cid)) predById.set(cid, r);
            }
            const lastById = new Map<string, { at: string; items: string[] }>();
            for (const r of (or ?? []) as Array<Record<string, unknown>>) {
              const cid = String(r.customer_id ?? "");
              if (!cid || lastById.has(cid)) continue;
              const items = Array.isArray(r.items_json)
                ? (r.items_json as Array<Record<string, unknown>>)
                    .map((i) => String(i.title ?? "").trim())
                    .filter((t) => t && t !== "—")
                    .slice(0, 3)
                : [];
              lastById.set(cid, { at: String(r.placed_at ?? "").slice(0, 10), items });
            }
            actions = actions.map((x) => {
              const p = predById.get(x.customerId ?? "");
              const o = lastById.get(x.customerId ?? "");
              if (!p) return x;
              const ev = (p.evidence_json as Record<string, unknown> | null) ?? {};
              return {
                ...x,
                predCycleDays: ev.cycle_days == null ? null : Number(ev.cycle_days),
                predTDays: ev.t_days == null ? null : Number(ev.t_days),
                predHorizon: p.horizon_days == null ? null : Number(p.horizon_days),
                predP: p.p_recompra_h == null ? null : Number(p.p_recompra_h),
                predPLow: p.p_low == null ? null : Number(p.p_low),
                predPHigh: p.p_high == null ? null : Number(p.p_high),
                predTicketMinor:
                  p.ticket_esperado_minor == null ? null : Number(p.ticket_esperado_minor),
                predConfidence: (p.confidence as string | null) ?? null,
                lastOrderAt: o?.at ?? null,
                lastOrderItems: o?.items ?? null,
              };
            });
          }
        } catch {
          // Sin predicciones: las tarjetas usan el texto de respaldo.
        }
        const toLeadRow = (r: Record<string, unknown>): LeadRow => ({
          id: String(r.id),
          company: (r.company as string | null) ?? null,
          domain: (r.domain as string | null) ?? null,
          url: String(r.url ?? ""),
          contact: (r.contact as string | null) ?? null,
          source: (r.source as string | null) ?? null,
          created_at: String(r.created_at ?? ""),
          icp_score: r.icp_score == null ? null : Number(r.icp_score),
          reason: (r.reason as string | null) ?? null,
          evidence: (r.evidence_json as LeadRow["evidence"]) ?? null,
        });
        leads = ((l ?? []) as Array<Record<string, unknown>>).map(toLeadRow);
        approvedLeads = ((al ?? []) as Array<Record<string, unknown>>).map(toLeadRow);
        contactedLeads = ((cl ?? []) as Array<Record<string, unknown>>).map(toLeadRow);
        discardedLeads = ((dl ?? []) as Array<Record<string, unknown>>).map(toLeadRow);
        // Solo el check “ya es customer” se calcula en vivo (barato); el resto
        // viene guardado por el agente al crear el lead (evidence_json).
        try {
          const [{ data: ce }, { data: st }] = await Promise.all([
            db.from("customers").select("email").eq("store_id", storeId).limit(5000),
            db.from("stores").select("shop_currency").eq("id", storeId).maybeSingle(),
          ]);
          const { domainFromEmail, classifyDomain } = await import("@/lib/domains");
          for (const c of ((ce ?? []) as Array<Record<string, unknown>>)) {
            const d = domainFromEmail(String(c.email ?? ""));
            if (d && classifyDomain(d).enrichable) customerDomains.add(d);
          }
          shopCurrency = ((st ?? {}) as Record<string, unknown>).shop_currency as string | null ?? null;
          // Con filtro de mercado los montos se leen en su moneda (MX→MXN).
          if (scope?.market?.currency) shopCurrency = scope.market.currency.toUpperCase();
        } catch {
          // checks degradados: se muestra lo que haya
        }
        // Mismo ranking que el Overview (lib/mira): la #1 de Hoy es la #1 aquí.
        // Universos monetarios: la foránea va después, no mezclada.
        // Con filtro de mercado el market es el universo (foreign vacío).
        const mira = await getRankedMira(storeId, 100, {
          ...(scope ?? {}),
          currency: scope?.market?.currency?.toUpperCase() ?? null,
        });
        signals = [...mira.rows, ...mira.foreign].map((r) => ({
          id: r.signalId,
          kind: r.kind,
          objective: r.objective ?? null,
          score: r.score,
          reason: r.reason,
          status: r.status,
          email: r.email,
          name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
          createdAt: r.createdAt ?? null,
          customerId: r.customerDbId,
          daysSince: r.daysSince ?? null,
          ordersCount: r.ordersCount,
          totalSpent: r.totalSpent,
          currency: r.currency,
        }));
        // Descartadas recientes para "contactar igual" (issue #14 B3): la mira
        // solo trae open/prioritized y el descarte no tenía remedio.
        try {
          const dq = applyScopeFilter(
            db
              .from("churn_signals")
              .select("id,customer_id,kind,objective,score,reason,status,created_at,customers(email,first_name,last_name)")
              .eq("store_id", storeId)
              .eq("status", "dismissed"),
            scope,
          );
          const { data: dd } = await dq.order("closed_at", { ascending: false }).limit(20);
          dismissedSignals = ((dd ?? []) as Array<Record<string, unknown>>).map((r) => {
            const c = (r.customers ?? {}) as Record<string, unknown>;
            const email = String(c.email ?? "");
            return {
              id: String(r.id ?? ""),
              kind: String(r.kind ?? ""),
              objective: (r.objective as string | null) ?? null,
              score: r.score == null ? null : Number(r.score),
              reason: (r.reason as string | null) ?? null,
              status: "dismissed",
              email,
              name: [c.first_name, c.last_name].filter(Boolean).join(" ") || email,
              createdAt: (r.created_at as string | null) ?? null,
              customerId: String(r.customer_id ?? ""),
            };
          });
        } catch {
          dismissedSignals = [];
        }
        // Sustento del motor para "Clientes en riesgo" (igual que en
        // "Clientes por contactar"): última predicción + última orden real.
        // Bulk en 2 queries (sin N+1), cubriendo abiertas y descartadas.
        try {
          const sigCustIds = [
            ...new Set(
              [...signals, ...dismissedSignals]
                .map((x) => x.customerId)
                .filter((v): v is string => !!v),
            ),
          ];
          if (sigCustIds.length > 0) {
            const [{ data: spr }, { data: sor }] = await Promise.all([
              db
                .from("customer_predictions")
                .select("customer_id,decision,p_recompra_h,p_low,p_high,horizon_days,ticket_esperado_minor,valor_esperado_minor,confidence,evidence_json")
                .eq("store_id", storeId)
                .in("customer_id", sigCustIds)
                .order("as_of", { ascending: false })
                .order("model_version", { ascending: false })
                .limit(500),
              db
                .from("orders")
                .select("customer_id,placed_at,items_json")
                .eq("store_id", storeId)
                .in("customer_id", sigCustIds)
                .order("placed_at", { ascending: false })
                .limit(500),
            ]);
            const sPredById = new Map<string, Record<string, unknown>>();
            for (const r of (spr ?? []) as Array<Record<string, unknown>>) {
              const cid = String(r.customer_id ?? "");
              if (cid && !sPredById.has(cid)) sPredById.set(cid, r);
            }
            const sLastById = new Map<string, { at: string; items: string[] }>();
            for (const r of (sor ?? []) as Array<Record<string, unknown>>) {
              const cid = String(r.customer_id ?? "");
              if (!cid || sLastById.has(cid)) continue;
              const items = Array.isArray(r.items_json)
                ? (r.items_json as Array<Record<string, unknown>>)
                    .map((i) => String(i.title ?? "").trim())
                    .filter((t) => t && t !== "—")
                    .slice(0, 3)
                : [];
              sLastById.set(cid, { at: String(r.placed_at ?? "").slice(0, 10), items });
            }
            const enrichSignal = (x: SignalRow): SignalRow => {
              const p = sPredById.get(x.customerId ?? "");
              const o = sLastById.get(x.customerId ?? "");
              const next: SignalRow = {
                ...x,
                lastOrderAt: o?.at ?? x.lastOrderAt ?? null,
                lastOrderItems: o?.items ?? x.lastOrderItems ?? null,
              };
              if (!p) return next;
              const ev = (p.evidence_json as Record<string, unknown> | null) ?? {};
              return {
                ...next,
                predCycleDays: ev.cycle_days == null ? null : Number(ev.cycle_days),
                predTDays: ev.t_days == null ? null : Number(ev.t_days),
                predHorizon: p.horizon_days == null ? null : Number(p.horizon_days),
                predP: p.p_recompra_h == null ? null : Number(p.p_recompra_h),
                predPLow: p.p_low == null ? null : Number(p.p_low),
                predPHigh: p.p_high == null ? null : Number(p.p_high),
                predTicketMinor:
                  p.ticket_esperado_minor == null ? null : Number(p.ticket_esperado_minor),
                predValorMinor:
                  p.valor_esperado_minor == null ? null : Number(p.valor_esperado_minor),
                predConfidence: (p.confidence as string | null) ?? null,
              };
            };
            signals = signals.map(enrichSignal);
            dismissedSignals = dismissedSignals.map(enrichSignal);
          }
        } catch {
          // Sin predicciones: las tarjetas usan el texto de respaldo.
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
    // Gate B2B del botón (best-effort; el backend veta igual).
    // Sin acceso al tenant no se resuelve elegibilidad (no filtrar datos).
    try {
      if (!error) {
        const sid = conn.medusaUrl ? await resolveStoreId(conn.medusaUrl).catch(() => null) : null;
        if (sid && (await requireMyStoreAccess(sid).catch(() => null)) !== false) {
          const { prospectEligibility } = await import("@/lib/prospect");
          prospectEligible = (await prospectEligibility(sid)).eligible;
        }
      }
    } catch {
      prospectEligible = true;
    }
  }

  // Filtro del chat: IDs exactos ("muéstrame los 3"). Se aplica sobre lo ya
  // cargado (respeta mercado); con IDs inexistentes la sección queda vacía.
  const parseIds = (raw: string | undefined): Set<string> | null => {
    if (!raw) return null;
    const set = new Set(
      raw.split(",").map((s) => s.trim()).filter(Boolean),
    );
    return set.size > 0 ? set : null;
  };
  const actionFilter = parseIds(sp.actionIds);
  const leadFilter = parseIds(sp.leadIds);
  const signalFilter = parseIds(sp.signalIds);
  if (actionFilter) actions = actions.filter((a) => actionFilter.has(a.id));
  if (leadFilter) leads = leads.filter((l) => leadFilter.has(l.id));
  if (signalFilter) signals = signals.filter((s) => signalFilter.has(s.id));
  const chatFiltered =
    (actionFilter ? ` · ${formatNumber(actions.length)} borradores` : "") +
    (leadFilter ? ` · ${formatNumber(leads.length)} leads` : "") +
    (signalFilter ? ` · ${formatNumber(signals.length)} señales` : "");
  // Con filtro del chat, la vista muestra SOLAMENTE lo pedido: las secciones
  // no filtradas se ocultan en vez de seguir listando todo.
  const showActions = !chatFiltered || Boolean(actionFilter);
  const showLeads = !chatFiltered || Boolean(leadFilter);
  const showSignals = !chatFiltered || Boolean(signalFilter);
  // Tab inicial: con filtro del chat manda lo pedido; si no, ?tab= (deep-link).
  const initialTab =
    actionFilter ? "actions" : leadFilter ? "leads" : signalFilter ? "signals"
    : sp.tab === "leads" || sp.tab === "signals" ? sp.tab : "actions";
  const clearParams = new URLSearchParams();
  if (sp.market) clearParams.set("market", sp.market);
  if (sp.tab === "leads" || sp.tab === "signals") clearParams.set("tab", sp.tab);
  const clearQs = clearParams.toString();
  const clearChatFilter = `/review${clearQs ? `?${clearQs}` : ""}`;
  const inboxTotal = actions.length + leads.length + signals.length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="Bandeja de entrada"
        title="Review"
        description="Mensajes, señales y empresas: todo lo que necesita tu decisión."
        badge={
          inboxTotal > 0 ? (
            <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary tabular-nums">
              {formatNumber(inboxTotal)} por revisar
            </span>
          ) : undefined
        }
      />

      {chatFiltered && (
        <AppCard
          footer={
            <Button render={<Link href={clearChatFilter} />} nativeButton={false} variant="outline" size="sm">
              Limpiar filtro
            </Button>
          }
        >
          <p className="text-sm">
            Filtrado por el chat{chatFiltered}.
          </p>
        </AppCard>
      )}

      {(!connected || !dbReady) && (
        <AppCardState>
          {!connected
            ? "Conecta Medusa en Settings para revisar propuestas."
            : "Supabase no configurado (`supabase start` + `web/.env.local`)."}
        </AppCardState>
      )}

      {error && (
        <AppCardState>{error}</AppCardState>
      )}

      {connected && dbReady && !error && (
        <>
          <ReviewLists
            // Remount solo cuando cambia LO PEDIDO (filtro del chat o market):
            // con `key={initialTab}` cada click en un tab desmontaba todo
            // (se perdía edición/selección y la página parpadeaba).
            key={`${sp.market ?? ""}|${sp.actionIds ?? ""}|${sp.leadIds ?? ""}|${sp.signalIds ?? ""}`}
            actions={actions}
            approvedActions={approvedActions}
            rejectedActions={rejectedActions}
            dispatchedActions={dispatchedActions}
            dispatchedTotal={dispatchedTotal}
            dispatchedPage={sentPage}
            leads={leads}
            approvedLeads={approvedLeads}
            contactedLeads={contactedLeads}
            contactedTotal={contactedTotal}
            contactedPage={contactedPage}
            discardedLeads={discardedLeads}
            signals={signals}
            dismissedSignals={dismissedSignals}
            visible={{ actions: showActions, leads: showLeads, signals: showSignals }}
            runningKinds={[...runningKinds]}
            marketId={sp.market ?? null}
            customerDomains={[...customerDomains]}
            shopCurrency={shopCurrency}
            filtered={Boolean(chatFiltered)}
            initialTab={initialTab as "actions" | "leads" | "signals"}
            ultimaCompraLabel={ultimaCompraLabel}
            isB2B={isB2BReview}
            prospectEligible={prospectEligible}
          />

        </>
      )}
    </div>
  );
}
