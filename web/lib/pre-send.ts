// Puerta pre-envío (issue #13): revalidación antes de marcar `dispatched`.
// La regla pura vive en `lib/pre-send-rule.ts` (testeable, sin IO); acá el
// gate con BD. La usan el dispatcher y el envío-al-aprobar: mismo criterio
// en ambas vías, sin duplicar.
import { getSupabase } from "@/lib/supabase";
import { isRealDbOrder } from "@/lib/canonical";
import { createLogger } from "@/lib/log";
import {
  evaluatePreSend,
  SENDABLE_DECISIONS,
  type HoldCode,
  type PreSendResult,
  type SkipCode,
} from "@/lib/pre-send-rule";

export type { HoldCode, PreSendResult, SkipCode };
export { evaluatePreSend, SENDABLE_DECISIONS };

const log = createLogger("pre-send");

export interface GateRow {
  id: string;
  storeId: string;
  customerId: string;
  channel: string;
  /** ISO de aprobación; fallback a creación si la fila es pre-#19. */
  approvedAt: string | null;
  createdAt: string | null;
  signalId: string | null;
  failOpen: boolean;
}

/**
 * Lee los hechos y aplica `evaluatePreSend`. Nunca lanza: ante error de
 * lectura devuelve hold (fail-closed: sin auto-envío a ciegas) salvo que el
 * fallo sea inexistencia de la fila (la procesó otro lado).
 */
export async function checkPreSendGate(row: GateRow): Promise<PreSendResult> {
  const db = getSupabase();
  try {
    const since = row.approvedAt ?? row.createdAt;
    // Sin marca temporal no se puede revalidar recompra/contacto: hold.
    if (!since) {
      return { send: false, terminal: false, code: "stale_prediction", message: "Sin fecha de aprobación: no se puede revalidar, sin auto-envío." };
    }
    const sinceIso = new Date(since).toISOString();
    const [opt, orders, other, sig, pred] = await Promise.all([
      db
        .from("opt_outs")
        .select("id", { count: "exact", head: true })
        .eq("store_id", row.storeId)
        .eq("customer_id", row.customerId)
        .eq("channel", row.channel),
      db
        .from("orders")
        .select("placed_at,status,payment_status,is_test")
        .eq("store_id", row.storeId)
        .eq("customer_id", row.customerId)
        .gt("placed_at", sinceIso)
        .order("placed_at", { ascending: true })
        .limit(20),
      db
        .from("proposed_actions")
        .select("id", { count: "exact", head: true })
        .eq("store_id", row.storeId)
        .eq("customer_id", row.customerId)
        .eq("status", "dispatched")
        .neq("id", row.id)
        .gt("dispatched_at", sinceIso),
      row.signalId
        ? db.from("churn_signals").select("status").eq("id", row.signalId).maybeSingle()
        : Promise.resolve({ data: null as Record<string, unknown> | null }),
      db
        .from("customer_predictions")
        .select("decision")
        .eq("store_id", row.storeId)
        .eq("customer_id", row.customerId)
        .order("as_of", { ascending: false })
        .order("model_version", { ascending: false })
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);
    const optedOut = (opt.count ?? 0) > 0;
    const repurchasedSinceApproval = ((orders.data ?? []) as Array<Record<string, unknown>>).some(
      (o) =>
        typeof o.placed_at === "string" &&
        isRealDbOrder({
          status: (o.status as string | null) ?? null,
          payment_status: (o.payment_status as string | null) ?? null,
          is_test: Boolean(o.is_test),
        }),
    );
    const contactedRecentlyElsewhere = (other.count ?? 0) > 0;
    const signalDismissed =
      ((sig.data as Record<string, unknown> | null)?.status as string | undefined) === "dismissed";
    const predDecision = ((pred.data as Record<string, unknown> | null)?.decision as string | undefined) ?? null;
    const predictionSendable =
      predDecision === null ? null : SENDABLE_DECISIONS.has(predDecision);
    return evaluatePreSend({
      optedOut,
      repurchasedSinceApproval,
      signalDismissed,
      contactedRecentlyElsewhere,
      failOpen: row.failOpen,
      predictionSendable,
    });
  } catch (e) {
    log(`gate ERROR ${row.id}: ${e instanceof Error ? e.message : e} (hold fail-closed)`);
    return { send: false, terminal: false, code: "fail_open", message: "Fallo leyendo revalidación: sin auto-envío hasta revisar." };
  }
}

/** ¿Cliente con baja en un canal? (scout/copywriter la usan antes de trabajar). */
export async function isOptedOut(
  storeId: string,
  customerId: string,
  channel: string,
): Promise<boolean> {
  try {
    const { count } = await getSupabase()
      .from("opt_outs")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("customer_id", customerId)
      .eq("channel", channel);
    return (count ?? 0) > 0;
  } catch {
    // Ante error de lectura se supone NO opted-out (fail-open auditado en
    // log): el gate pre-envío vuelve a chequear y frena si hace falta.
    log(`opt-out read ERROR store=${storeId} (se supone contactable)`);
    return false;
  }
}

/** ¿Cliente con baja en AMBOS canales? (scout: sin señal si no hay por dónde). */
export async function isFullyOptedOut(storeId: string, customerId: string): Promise<boolean> {
  try {
    const { data } = await getSupabase()
      .from("opt_outs")
      .select("channel")
      .eq("store_id", storeId)
      .eq("customer_id", customerId)
      .limit(2);
    const chans = new Set(((data ?? []) as Array<Record<string, unknown>>).map((r) => String(r.channel ?? "")));
    return chans.has("email") && chans.has("whatsapp");
  } catch {
    log(`opt-out read ERROR store=${storeId} (se supone contactable)`);
    return false;
  }
}
