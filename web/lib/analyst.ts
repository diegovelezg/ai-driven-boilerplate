// Analyst (Medir, Fase A): ventana post-envío según arquetipo (H) → ¿volvió a comprar?
// → `revenue_attributed`, cierra la señal. Determinista, sin LLM.
// Mide coincidencia ATRIBUIDA (orden tras envío en ventana), jamás incremental:
// sin holdout no hay causalidad (issue #12). El holdout sigue bloqueado por #4.
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { isRealDbOrder } from "@/lib/canonical";
import { formatMoney, formatNumber } from "@/lib/format";
import { sessionize } from "@/lib/retention-model";

const log = createLogger("analyst");

export interface AnalystOpts {
  /** Ventana de atribución en días tras el envío. */
  windowDays?: number;
}

export async function runAnalyst(
  runId: string,
  storeId: string,
  opts: AnalystOpts = {},
): Promise<void> {
  const db = getSupabase();
  let windowDays = opts.windowDays ?? 14;
  if (opts.windowDays == null) {
    try {
      const { getStoreProfile } = await import("@/lib/store-profiles");
      const { HORIZON_BY_ARCHETYPE } = await import("@/lib/retention-model");
      const profile = await getStoreProfile(storeId).catch(() => null);
      if (profile) windowDays = HORIZON_BY_ARCHETYPE[profile.archetype] ?? 14;
    } catch {
      windowDays = 14;
    }
  }
  let measured = 0;
  let converted = 0;
  let revenueMinor = 0;
  let waiting = 0;
  try {
    // Cola pendiente paginada: .limit(100) atrasaba medición sin aviso.
    const all: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 500) {
      const { data, error } = await db
        .from("proposed_actions")
        .select("id,customer_id,signal_id,dispatched_at,customers(email)")
        .eq("store_id", storeId)
        .eq("status", "dispatched")
        .is("revenue_attributed", null)
        .not("dispatched_at", "is", null)
        .order("dispatched_at", { ascending: true })
        .order("id", { ascending: true })
        .range(off, off + 499);
      if (error) throw new Error(`Actions read: ${error.message}`);
      const page = (data ?? []) as Array<Record<string, unknown>>;
      all.push(...page);
      if (page.length < 500) break;
      if (all.length >= 5000) {
        log(`run ${runId} pendientes truncados a ${all.length} (CAP 5k): resto queda para próxima corrida`);
        break;
      }
    }
    const data = all;
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      customer_id: String(r.customer_id),
      signal_id: (r.signal_id as string | null) ?? null,
      dispatched_at: String(r.dispatched_at),
      email: String((r.customers as Record<string, unknown> | null)?.email ?? ""),
    }));
    log(`run ${runId} start pendientes=${rows.length} ventana=${windowDays}d`);

    // Issue #12 P1: una orden = una atribución (primera acción previa).
    // Se agrupa por cliente, se sesioniza (pago partido = 1 compra) y cada
    // sesión se asigna a la primera acción cuya ventana la contenga.
    // Además: filtro por moneda de la tienda (no mezclar PEN+MXN) y criterio
    // único de orden real (isRealDbOrder: incluye payment_status).
    const { resolveShopCurrency } = await import("@/lib/store-profiles");
    const shopCurrency = await resolveShopCurrency(storeId).catch(() => null);
    const byCustomer = new Map<string, typeof rows>();
    for (const a of rows) {
      const list = byCustomer.get(a.customer_id) ?? [];
      list.push(a);
      byCustomer.set(a.customer_id, list);
    }
    // Orden cronológico por cliente: la primera acción previa gana la sesión.
    for (const list of byCustomer.values()) {
      list.sort((a, b) => +new Date(a.dispatched_at) - +new Date(b.dispatched_at));
    }
    const revenueByAction = new Map<string, number>();

    // N+1 serial por cliente: con cola grande se acota y se deja constancia.
    if (byCustomer.size > 200) {
      log(`run ${runId} cola grande: ${byCustomer.size} clientes por medir (serie acotada 5k/cliente)`);
    }
    for (const [cid, list] of byCustomer) {
      const earliest = list[0];
      const sent0 = new Date(earliest.dispatched_at).getTime();
      // Ventana global del cliente: desde el primer envío hasta el fin de la
      // última ventana (una sola query por cliente, no N+1 por acción).
      const latestEnd =
        Math.max(...list.map((a) => new Date(a.dispatched_at).getTime())) +
        windowDays * 86_400_000;
      // Ventana del cliente paginada: .limit(200) subatribuía a heavy buyers.
      const opages: Array<Record<string, unknown>> = [];
      for (let ooff = 0; ; ooff += 500) {
        const { data: opage, error: oErr } = await db
          .from("orders")
          .select("total_amount,placed_at,status,payment_status,is_test,currency")
          .eq("store_id", storeId)
          .eq("customer_id", cid)
          .gt("placed_at", new Date(sent0).toISOString())
          .lte("placed_at", new Date(latestEnd).toISOString())
          .order("placed_at", { ascending: true })
          .order("id", { ascending: true })
          .range(ooff, ooff + 499);
        if (oErr) throw new Error(`Orders read: ${oErr.message}`);
        const orows = (opage ?? []) as Array<Record<string, unknown>>;
        opages.push(...orows);
        if (orows.length < 500) break;
        if (opages.length >= 5000) break;
      }
      const orders = opages;
      const sessions = sessionize(
        (((orders ?? []) as Array<Record<string, unknown>>)
          .filter((o) => {
            const cur = (o.currency as string | null) ?? null;
            if (shopCurrency && cur && cur.toUpperCase() !== shopCurrency.toUpperCase()) return false;
            return isRealDbOrder({
              status: typeof o.status === "string" ? o.status : null,
              payment_status: typeof o.payment_status === "string" ? o.payment_status : null,
              is_test: o.is_test === true,
            });
          })
          .map((o) => {
            const d = new Date(String(o.placed_at));
            return {
              placedAt: d.getTime(),
              ticketMinor: Number(o.total_amount ?? 0),
              currency: (o.currency as string | null) ?? null,
            };
          })
          .filter((x) => Number.isFinite(x.placedAt))),
      );
      // Asignar cada sesión a la primera acción cuya ventana la contenga.
      const assigned = new Set<number>();
      for (const a of list) {
        const sent = new Date(a.dispatched_at).getTime();
        const end = sent + windowDays * 86_400_000;
        let rev = 0;
        sessions.forEach((s, idx) => {
          if (assigned.has(idx)) return;
          if (s.at > sent && s.at <= end) {
            assigned.add(idx);
            rev += s.ticketMinor;
          }
        });
        revenueByAction.set(a.id, rev);
      }
    }

    for (const a of rows) {
      await advanceRun(runId, { processed: measured, failed: 0, current: null });
      try {
        const sent = new Date(a.dispatched_at);
        const windowEnd = new Date(sent.getTime() + windowDays * 86_400_000);
        const now = new Date();
        const revenue = revenueByAction.get(a.id) ?? 0;
        const windowClosed = now > windowEnd;
        // Solo se escribe cuando hay conversión o la ventana ya cerró
        // (mientras tanto se sigue esperando, sin marcar).
        if (revenue > 0 || windowClosed) {
          const { error: upErr } = await db
            .from("proposed_actions")
            .update({ revenue_attributed: revenue })
            .eq("id", a.id);
          if (upErr) throw new Error(`Action update: ${upErr.message}`);
          if (a.signal_id) {
            await db
              .from("churn_signals")
              .update({ status: "closed", closed_at: new Date().toISOString() })
              .eq("id", a.signal_id);
          }
          measured += 1;
          if (revenue > 0) {
            converted += 1;
            revenueMinor += revenue;
          }
          log(`run ${runId} ${a.email} → revenue=${revenue}${revenue > 0 ? " (convirtió)" : " (sin compra en ventana)"}`);
        } else {
          waiting += 1;
          log(`run ${runId} ${a.email} → ventana abierta, se espera`);
        }
      } catch (e) {
        log(`run ${runId} ${a.email || a.id} ERROR ${e instanceof Error ? e.message : e}`);
      }
    }

    await advanceRun(runId, { processed: measured, failed: 0, current: null });
    // Hito 2 (#25.7): atribución estratificada por canal/objetivo/banda.
    // Reusa veto 24h (vetados nunca llegan a dispatched: no contaminan) y
    // alimenta el gatillo P5/cohorte de #22 (log auditable, sin auto-aplicar aquí).
    // Reusa proposed_leads.similar como lookalike: el pool ya vive en prospect
    // (buildSimilarPool), aquí solo se evita medir lo vetado.
    try {
      const breakdown = await attributionBySlice(storeId, 90).catch(() => null);
      if (breakdown) {
        const byCanal = Object.entries(breakdown.byChannel).map(([k, v]) => `${k} ${v}`).join(" · ").slice(0, 160);
        if (byCanal) log(`run ${runId} atribucion_90d canal: ${byCanal}`);
        const byObj = Object.entries(breakdown.byObjective).map(([k, v]) => `${k} ${v}`).join(" · ").slice(0, 160);
        if (byObj) log(`run ${runId} atribucion_90d objetivo: ${byObj}`);
        const byDec = Object.entries(breakdown.byDecision).map(([k, v]) => `${k} ${v}`).join(" · ").slice(0, 160);
        if (byDec) log(`run ${runId} atribucion_90d banda/decision: ${byDec}`);
      }
      // Enlace #22: si existe la calibración P5 o la cohorte accionable, se deja
      // constancia para el tune (el tune decide; el analyst no auto-aplica).
      try {
        const { readFileSync, existsSync } = await import("node:fs");
        const { join, dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const here = dirname(fileURLToPath(import.meta.url));
        const calPath = join(here, "..", ".data", "calibrate-retention.json");
        if (existsSync(calPath)) {
          const raw = readFileSync(calPath, "utf-8").slice(0, 2000);
          if (/2 fallos|fuera de tolerancia|skill/i.test(raw)) {
            log(`run ${runId} p5_gatillo: calibración con señal para el tune #22 (ver .data/calibrate-retention.json)`);
          }
        }
      } catch {
        // sin calibración local: nada que enlazar.
      }
    } catch {
      // best-effort: la medición principal ya cerró.
    }
    const status: RunStatus = "done";
    // Filosofía TeamPulse: el $ es lo único que importa aquí. La pausa
    // (ventana abierta) se explica, no se esconde en el log.
    let summary: string;
    if (converted > 0) {
      try {
        const { data: st } = await db.from("stores").select("shop_currency").eq("id", storeId).maybeSingle();
        const cur = ((st ?? {}) as Record<string, unknown>).shop_currency as string | null ?? null;
        summary = `${formatNumber(converted)} ${converted === 1 ? "volvió" : "volvieron"} · ${formatMoney(Math.round(revenueMinor), cur)} recuperado`;
      } catch {
        summary = `${formatNumber(converted)} ${converted === 1 ? "volvió" : "volvieron"} · recupero medido`;
      }
    } else if (waiting > 0) {
      summary = `Observando ${formatNumber(waiting)} ${waiting === 1 ? "enviado" : "enviados"}, mide si vuelven en ${formatNumber(windowDays)}d`;
    } else if (measured > 0) {
      summary = `${formatNumber(measured)} ${measured === 1 ? "medido" : "medidos"}, sin retorno en ventana · seguimos vigilando`;
    } else {
      summary = "Nada que medir aún · mide solo cuando hay envíos";
    }
    await finishRun(runId, {
      status,
      processed: measured,
      failed: 0,
      summary,
      pulseState: converted > 0 ? "active" : "paused",
    });
    log(`run ${runId} ${status} ${summary}`);
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed: measured,
      failed: 0,
      error: e instanceof Error ? e.message : String(e),
      pulseState: "paused",
    });
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}

/** Atribución estratificada (Hito 2): revenue_attributed por canal/objetivo/banda.
 *  Determinista, paginado con limit/cursor. El veto 24h ya filtró arriba
 *  (vetados nunca se redactan ni se envían): aquí solo se mide lo enviado. */
export async function attributionBySlice(
  storeId: string,
  days = 90,
): Promise<{
  byChannel: Record<string, number>;
  byObjective: Record<string, number>;
  byDecision: Record<string, number>;
  total: number;
  conversions: number;
}> {
  const db = getSupabase();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const byChannel: Record<string, number> = {};
  const byObjective: Record<string, number> = {};
  const byDecision: Record<string, number> = {};
  let total = 0;
  let conversions = 0;
  for (let off = 0; ; off += 500) {
    const { data, error } = await db
      .from("proposed_actions")
      .select("channel,revenue_attributed,evidence_json,dispatched_at")
      .eq("store_id", storeId)
      .eq("status", "dispatched")
      .not("revenue_attributed", "is", null)
      .gte("dispatched_at", since)
      .order("dispatched_at", { ascending: false })
      .order("id", { ascending: true })
      .range(off, off + 499);
    if (error) throw new Error(`Attribution read: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const rev = Number(r.revenue_attributed ?? 0);
      if (!(rev > 0)) continue;
      total += rev;
      conversions += 1;
      const ch = String(r.channel ?? "unknown");
      byChannel[ch] = (byChannel[ch] ?? 0) + rev;
      const ev = (r.evidence_json as Record<string, unknown> | null) ?? null;
      const obj = typeof ev?.objective === "string" ? ev.objective : typeof ev?.kind === "string" ? ev.kind : "unknown";
      byObjective[obj] = (byObjective[obj] ?? 0) + rev;
      const dec = typeof ev?.decision === "string" ? ev.decision : "unknown";
      byDecision[dec] = (byDecision[dec] ?? 0) + rev;
    }
    if (rows.length < 500) break;
    if (off >= 4500) break;
  }
  return { byChannel, byObjective, byDecision, total, conversions };
}
