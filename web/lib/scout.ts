// Scout (Detectar, Fase B): lee `customer_predictions` del día (motor
// probabilístico retention:v1) → upsert en `churn_signals`. Determinista,
// sin LLM. La máquina de estados (open/prioritized/actioned/closed) y la
// idempotencia se mantienen; lo que cambia es el criterio: solo `actuar`
// (y `revision_humana` como `vip_care`) abren señal, con score = pRecompraH.
// Corre en background con `background_runs` kind `scout`.
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, setRunTotal, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";

const log = createLogger("scout");

/** Versión del criterio detector. Sube cuando cambia la regla. */
export const SCOUT_GEN = "scout:v2:retention";

export interface ScoutSummary {
  scanned: number;
  created: number;
  updated: number;
  closed: number;
}

interface PredRow {
  customer_id: string;
  model: string;
  p_recompra_h: number | null;
  p25_days: number | null;
  p75_days: number | null;
  decision: string;
  evidence_json: Record<string, unknown> | null;
}

/** Escaneo completo de la tienda. Idempotente: re-ejecutar actualiza/cierra, no duplica. */
export async function runScout(runId: string, storeId: string): Promise<void> {
  const db = getSupabase();
  let scanned = 0;
  let created = 0;
  let updated = 0;
  let closed = 0;
  const step = (current: string | null) =>
    advanceRun(runId, { processed: scanned, failed: 0, current });

  try {
    // Predicciones frescas del día: si no hay as_of de hoy, correr el modelo
    // aquí mismo (no se asume cron existente).
    const dayStart = new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      ),
    ).toISOString();
    const { data: fresh } = await db
      .from("customer_predictions")
      .select("id")
      .eq("store_id", storeId)
      .gte("as_of", dayStart)
      .limit(1);
    if (!fresh || fresh.length === 0) {
      log(`run ${runId} sin predicciones de hoy: corriendo retention primero`);
      const { runRetentionModel } = await import("@/lib/retention");
      try {
        const r = await runRetentionModel(storeId, new Date());
        log(`run ${runId} retention predicted=${r.predicted} actuar=${r.actuar}`);
      } catch (e) {
        log(`run ${runId} retention ERROR ${e instanceof Error ? e.message : e}`);
      }
    }

    // Última predicción por cliente (las de hoy si existen, si no las últimas).
    const predByCust = new Map<string, PredRow>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("customer_predictions")
        .select("customer_id,model,p_recompra_h,p25_days,p75_days,decision,evidence_json,as_of")
        .eq("store_id", storeId)
        .order("as_of", { ascending: false })
        .range(from, from + 999);
      if (error) throw new Error(`Predictions read: ${error.message}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const cid = String(r.customer_id ?? "");
        if (!cid || predByCust.has(cid)) continue;
        predByCust.set(cid, {
          customer_id: cid,
          model: String(r.model ?? ""),
          p_recompra_h: r.p_recompra_h == null ? null : Number(r.p_recompra_h),
          p25_days: r.p25_days == null ? null : Number(r.p25_days),
          p75_days: r.p75_days == null ? null : Number(r.p75_days),
          decision: String(r.decision ?? ""),
          evidence_json: (r.evidence_json as Record<string, unknown> | null) ?? null,
        });
      }
      if (!rows || rows.length < 1000) break;
      // Suficiente para cubrir la tienda en la práctica; el loop completo
      // garantiza última-por-cliente aunque haya varias fechas.
      if (from > 9000) break;
    }
    log(`run ${runId} predicciones=${predByCust.size}`);

    // Clientes con ≥1 compra (F=1 incluido: la distinción la hace el modelo).
    const customers: Array<{
      id: string;
      email: string;
      orders_count: number;
      country: string | null;
    }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("customers")
        .select("id,email,orders_count,country")
        .eq("store_id", storeId)
        .gte("orders_count", 1)
        .range(from, from + 999);
      if (error) throw new Error(`Customers read: ${error.message}`);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        customers.push({
          id: String(r.id),
          email: String(r.email ?? ""),
          orders_count: Number(r.orders_count ?? 0),
          country: (r.country as string | null) ?? null,
        });
      }
      if (!data || data.length < 1000) break;
    }
    log(`run ${runId} buyers=${customers.length}`);
    await setRunTotal(runId, customers.length).catch(() => {});

    for (const c of customers) {
      scanned += 1;
      if (scanned % 25 === 0) await step(null);
      try {
        const pred = predByCust.get(c.id) ?? null;
        const { data: existing } = await db
          .from("churn_signals")
          .select("id,score,status")
          .eq("store_id", storeId)
          .eq("customer_id", c.id)
          .in("status", ["open", "prioritized", "actioned"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const prev = (existing ?? null) as { id: string; score: number | null; status: string } | null;
        // Anti-duplicado por customer (issue #9): un cliente = una señal viva.
        // Se conserva la más reciente (prev) y se cierran las demás
        // open/prioritized, esté gestionada o no. Antes solo se limpiaba con
        // prev actioned: dos open del mismo cliente sobrevivían y el
        // copywriter redactaba dos borradores al mismo WhatsApp (dedup por
        // signal_id, no por customer).
        if (prev) {
          try {
            const { data: dupes } = await db
              .from("churn_signals")
              .select("id")
              .eq("store_id", storeId)
              .eq("customer_id", c.id)
              .in("status", ["open", "prioritized"])
              .neq("id", prev.id)
              .limit(10);
            let dupClosed = 0;
            for (const d of (dupes ?? []) as Array<Record<string, unknown>>) {
              const { error } = await db
                .from("churn_signals")
                .update({ status: "closed", closed_at: new Date().toISOString() })
                .eq("id", String(d.id));
              if (!error) dupClosed += 1;
            }
            closed += dupClosed;
          } catch {
            // Limpieza best-effort: no rompe el escaneo.
          }
          if (prev.status === "actioned") continue;
        }

        const actionable =
          pred?.decision === "actuar" || pred?.decision === "revision_humana";
        if (actionable && pred) {
          const kind = pred.decision === "revision_humana" ? "vip_care" : "churn_risk";
          // score = probabilidad real (no heurístico).
          const score =
            pred.p_recompra_h == null
              ? null
              : Math.round(Math.min(1, Math.max(0, pred.p_recompra_h)) * 100) / 100;
          const ev = pred.evidence_json ?? {};
          const t = ev.t_days != null ? Math.round(Number(ev.t_days)) : null;
          const ciclo =
            ev.cycle_days != null ? Math.round(Number(ev.cycle_days)) : null;
          const p25 = pred.p25_days != null ? Math.round(pred.p25_days) : null;
          const p75 = pred.p75_days != null ? Math.round(pred.p75_days) : null;
          // Prefijo "sin comprar hace {t}d" parseable por mira/copywriter.
          const reason =
            t !== null && ciclo !== null && p25 !== null && p75 !== null
              ? `sin comprar hace ${t}d (ciclo ~${ciclo}d, vuelve típicamente entre ${p25}–${p75}d)`
              : t !== null && ciclo !== null
                ? `sin comprar hace ${t}d (ciclo ~${ciclo}d)`
                : t !== null
                  ? `sin comprar hace ${t}d`
                  : `retention ${pred.decision}`;
          if (prev) {
            const { error } = await db
              .from("churn_signals")
              .update({ score, reason, kind, country: c.country })
              .eq("id", prev.id);
            if (error) throw new Error(`Signal update: ${error.message}`);
            updated += 1;
          } else {
            const { error } = await db.from("churn_signals").insert({
              store_id: storeId,
              customer_id: c.id,
              country: c.country,
              kind,
              score,
              reason,
              status: "open",
              evidence_json: { generator: SCOUT_GEN, run_id: runId, at: new Date().toISOString() },
            });
            if (error) throw new Error(`Signal insert: ${error.message}`);
            created += 1;
          }
        } else if (prev) {
          // Ya no es accionable (vigilar/orgánico/dormido/suprimido o sin
          // predicción): la señal abierta ya no aplica.
          const { error } = await db
            .from("churn_signals")
            .update({ status: "closed", closed_at: new Date().toISOString() })
            .eq("id", prev.id);
          if (error) throw new Error(`Signal close: ${error.message}`);
          closed += 1;
        }
      } catch (e) {
        log(`run ${runId} ${c.email || c.id} ERROR ${e instanceof Error ? e.message : e}`);
      }
    }

    // Barrido de huérfanas: señales open/prioritized de clientes sin
    // predicción (0 sesiones reales o fuera del loop) y sin borrador vivo.
    // Limpia basura de la era v1 (p. ej. cuentas test) sin tocar lo gestionado.
    try {
      const { data: orphans, error: oErr } = await db
        .from("churn_signals")
        .select("id,customer_id")
        .eq("store_id", storeId)
        .in("status", ["open", "prioritized"])
        .limit(1000);
      if (oErr) throw new Error(`Orphans read: ${oErr.message}`);
      const rows = (orphans ?? []) as Array<Record<string, unknown>>;
      const noPred = rows.filter((r) => !predByCust.has(String(r.customer_id ?? "")));
      if (noPred.length > 0) {
        const { data: busy } = await db
          .from("proposed_actions")
          .select("signal_id")
          .eq("store_id", storeId)
          .in("status", ["pending_review", "approved"])
          .not("signal_id", "is", null)
          .limit(500);
        const busySet = new Set(
          ((busy ?? []) as Array<Record<string, unknown>>).map((a) => String(a.signal_id ?? "")),
        );
        const stale = noPred.filter((r) => !busySet.has(String(r.id ?? "")));
        for (const r of stale) {
          const { error } = await db
            .from("churn_signals")
            .update({ status: "closed", closed_at: new Date().toISOString() })
            .eq("id", String(r.id));
          if (!error) closed += 1;
        }
        if (stale.length > 0) log(`run ${runId} huérfanas cerradas=${stale.length}`);
      }
    } catch (e) {
      log(`run ${runId} orphans ERROR ${e instanceof Error ? e.message : e}`);
    }

    await step(null);
    const status: RunStatus = "done";
    // Filosofía TeamPulse: outcome humano, no contadores de log. El detalle
    // (nuevas/actualizadas/cerradas) queda en el log, no en el summary.
    log(`run ${runId} detalle nuevas=${created} actualizadas=${updated} cerradas=${closed}`);
    const ready = created + updated;
    const summary: string =
      ready > 0
        ? `Vigiló ${scanned} · ${ready} listos para actuar`
        : `Vigiló ${scanned}, nadie necesita mensaje · no quemamos descuentos`;
    await finishRun(runId, {
      status,
      processed: scanned,
      failed: 0,
      summary,
      pulseState: ready > 0 ? "active" : "paused",
    });
    log(`run ${runId} ${status} ${summary}`);
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed: scanned,
      failed: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}
