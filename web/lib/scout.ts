// Scout (Detectar, Fase A): RFM global + intervalo medio de recompra por
// customer → upsert en `churn_signals`. Determinista, sin LLM:
// la regla es auditable y el proceso `scout_scan` de llm_models.json queda
// reservado para casos ambiguos futuros.
// Corre en background con `background_runs` kind `scout`.
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, type RunStatus } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { ARCHETYPES, getStoreProfile } from "@/lib/store-profiles";

const log = createLogger("scout");

/** Versión del criterio detector. Sube cuando cambia la regla. */
export const SCOUT_GEN = "scout:v1:median";

const DAY_MS = 86_400_000;

/** Mediana de intervalos entre sesiones de compra (gaps <1d = una sola compra en cuotas).
 *  Un solo gap no es ritmo: se exigen ≥2 gaps (≥3 sesiones); si no, null y el
 *  ciclo cae a tienda/arquetipo. */
function medianInterval(datesAsc: Date[]): number | null {
  if (datesAsc.length < 2) return null;
  const sessions: Date[] = [datesAsc[0]];
  for (let i = 1; i < datesAsc.length; i += 1) {
    if (datesAsc[i].getTime() - sessions[sessions.length - 1].getTime() >= DAY_MS) {
      sessions.push(datesAsc[i]);
    }
  }
  if (sessions.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sessions.length; i += 1) {
    gaps.push((sessions[i].getTime() - sessions[i - 1].getTime()) / DAY_MS);
  }
  if (gaps.length < 2) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(1, Math.round(med));
}

interface ScoutCustomer {
  id: string;
  email: string;
  orders_count: number;
  total_spent: number;
  last_order_at: string | null;
  /** ISO2 atribuido (para el filtro global; lo escribe en la señal). */
  country: string | null;
}

function isRealRow(o: Record<string, unknown>): boolean {
  if (o.is_test === true) return false;
  const st = typeof o.status === "string" ? o.status.toLowerCase() : "";
  const pay = typeof o.payment_status === "string" ? o.payment_status.toLowerCase() : "";
  if (["cancelled", "canceled", "archived", "refunded"].includes(st)) return false;
  if (["refunded", "voided"].includes(pay)) return false;
  return true;
}

export interface ScoutSummary {
  scanned: number;
  created: number;
  updated: number;
  closed: number;
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
    const profile = await getStoreProfile(storeId).catch(() => null);
    const tenantCycle = profile?.repurchaseCycleDays ?? null;
    const archetypeCycle = profile ? (ARCHETYPES[profile.archetype]?.defaultCycleDays ?? null) : null;
    const multiplier = profile?.churnMultiplier ?? 1.25;
    log(`run ${runId} start store=${storeId} ciclo_tienda=${tenantCycle} ciclo_arquetipo=${archetypeCycle} mult=${multiplier}`);

    // Solo F>=2: sin recurrencia no hay churn que detectar (una sola compra no
    // establece ritmo; esos van por playbook de 2ª compra, no por señal).
    // Los sin compras tampoco pueden estar "vencidos".
    const customers: ScoutCustomer[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("customers")
        .select("id,email,orders_count,total_spent,last_order_at,country")
        .eq("store_id", storeId)
        .gte("orders_count", 2)
        .range(from, from + 999);
      if (error) throw new Error(`Customers read: ${error.message}`);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        customers.push({
          id: String(r.id),
          email: String(r.email ?? ""),
          orders_count: Number(r.orders_count ?? 0),
          total_spent: Number(r.total_spent ?? 0),
          last_order_at: (r.last_order_at as string | null) ?? null,
          country: (r.country as string | null) ?? null,
        });
      }
      if (!data || data.length < 1000) break;
    }
    log(`run ${runId} buyers=${customers.length}`);

    for (const c of customers) {
      scanned += 1;
      if (scanned % 25 === 0) await step(c.email || c.id);
      try {
        const last = c.last_order_at ? new Date(c.last_order_at) : null;
        const recency =
          last && !Number.isNaN(last.getTime())
            ? Math.max(0, Math.floor((Date.now() - last.getTime()) / DAY_MS))
            : null;

        const { data: orders } = await db
          .from("orders")
          .select("placed_at,status,payment_status,is_test")
          .eq("customer_id", c.id)
          .order("placed_at", { ascending: true })
          .limit(200);
        const dates = (((orders ?? []) as Array<Record<string, unknown>>).filter(isRealRow))
          .map((o) => (o.placed_at ? new Date(o.placed_at as string) : null))
          .filter((d): d is Date => !!d && !Number.isNaN(d.getTime()))
          .sort((a, b) => a.getTime() - b.getTime());
        const customerMedian = medianInterval(dates);
        const expected = customerMedian ?? tenantCycle ?? archetypeCycle;
        const source = customerMedian !== null ? "cliente" : tenantCycle !== null ? "tienda" : archetypeCycle !== null ? "arquetipo" : null;

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
        // Ya gestionada (con borrador): no duplicar señal ni borrador. El loop
        // se cierra por analyst (conversión) o por rechazo humano en Review.
        if (prev?.status === "actioned") {
          log(`run ${runId} ${c.email} skip ya gestionada (${prev.id})`);
          continue;
        }

        if (recency === null || expected === null) {
          if (scanned % 200 === 0) log(`run ${runId} ${c.email} skip recency=${recency} expected=${expected}`);
          continue;
        }

        if (recency > expected * multiplier) {
          const overdue = recency - expected;
          const score = Math.round((0.5 + 0.5 * Math.min(1, overdue / expected)) * 100) / 100;
          const reason = `sin comprar hace ${recency}d (media ${expected}d, ${c.orders_count} compras, ciclo ${source})`;
          if (prev) {
            const { error } = await db
              .from("churn_signals")
              .update({ score, reason, country: c.country })
              .eq("id", prev.id);
            if (error) throw new Error(`Signal update: ${error.message}`);
            updated += 1;
            log(`run ${runId} ${c.email} → update score=${score} ${reason}`);
          } else {
            const { error } = await db.from("churn_signals").insert({
              store_id: storeId,
              customer_id: c.id,
              country: c.country,
              kind: "churn_risk",
              score,
              reason,
              status: "open",
              evidence_json: { generator: SCOUT_GEN, run_id: runId, at: new Date().toISOString() },
            });
            if (error) throw new Error(`Signal insert: ${error.message}`);
            created += 1;
            log(`run ${runId} ${c.email} → open score=${score} ${reason}`);
          }
        } else if (prev) {
          // Volvió a comprar: la señal abierta ya no aplica.
          const { error } = await db
            .from("churn_signals")
            .update({ status: "closed", closed_at: new Date().toISOString() })
            .eq("id", prev.id);
          if (error) throw new Error(`Signal close: ${error.message}`);
          closed += 1;
          log(`run ${runId} ${c.email} → closed (al día: ${recency}d vs ${expected}d)`);
        }
      } catch (e) {
        log(`run ${runId} ${c.email || c.id} ERROR ${e instanceof Error ? e.message : e}`);
      }
    }

    await step(null);
    const status: RunStatus = "done";
    const summary: string = `${scanned} revisados · ${created} nuevas · ${updated} actualizadas · ${closed} cerradas`;
    await finishRun(runId, { status, processed: scanned, failed: 0, summary });
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
