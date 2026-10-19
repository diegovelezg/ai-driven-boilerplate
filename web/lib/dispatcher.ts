// Dispatcher (Ejecutar, Fase A): solo acciones `approved` → envío.
// ESTADO: stub honesto — BLOQUEADO por decisión comercial (proveedor
// WhatsApp Cloud API vs Twilio + email Resend vs SendGrid + credenciales).
// Sin `RETAIN_DISPATCH_STUB=1` no cambia nada: lista las aprobadas y lo
// deja por escrito en el run. Con el flag (solo dev/test) marca
// `dispatched` para poder medir el loop con el analyst.
// El envío real entrará aquí cuando se defina el proveedor.
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, setRunTotal } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { COPYWRITER_GEN } from "@/lib/copywriter-gen";

const log = createLogger("dispatcher");

export async function runDispatcher(runId: string, storeId: string): Promise<void> {
  const db = getSupabase();
  const stub = process.env.RETAIN_DISPATCH_STUB === "1";
  let dispatched = 0;
  try {
    // Cola aprobada paginada + conteo exacto: .limit(50) dejaba excedente sin
    // enviar y lo reportaba como total.
    const { count: totalApproved } = await db
      .from("proposed_actions")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("status", "approved");
    const all: Array<Record<string, unknown>> = [];
    for (let off = 0; ; off += 500) {
      const { data, error } = await db
        .from("proposed_actions")
        .select("id,customer_id,channel,evidence_json,customers(email)")
        .eq("store_id", storeId)
        .eq("status", "approved")
        .order("created_at", { ascending: true })
        .range(off, off + 499);
      if (error) throw new Error(`Actions read: ${error.message}`);
      const page = (data ?? []) as Array<Record<string, unknown>>;
      all.push(...page);
      if (page.length < 500) break;
      if (all.length >= 5000) break;
    }
    if ((totalApproved ?? all.length) > all.length) {
      log(`run ${runId} cola truncada: ${all.length}/${totalApproved} aprobadas (CAP 5k)`);
    }
    const rows = (all as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      customer_id: String(r.customer_id ?? ""),
      email: String((r.customers as Record<string, unknown> | null)?.email ?? ""),
      channel: String(r.channel ?? "?"),
      generator: ((r.evidence_json as Record<string, unknown> | null)?.generator as string | null) ?? null,
    }));
    // Puerta de sello (issue #9): lo aprobado con criterios viejos no se
    // envía (revócalo en Review). Sin esto, un telegrama v5 aprobado antes
    // del juez saldría igual por esta cola.
    const fresh = rows.filter((r) => r.generator === COPYWRITER_GEN);
    const stale = rows.length - fresh.length;
    if (stale > 0) {
      log(`run ${runId} omitidas_sello_viejo=${stale} (revocar en Review, no se envían)`);
    }
    // Uno por cliente por corrida (issue #9): aunque se aprueben dos del
    // mismo, sale la más antigua. Orden ya ascendente: se queda la primera.
    const seenCust = new Set<string>();
    const beforeFresh = fresh.length;
    const sendable = fresh.filter((r) => {
      if (r.customer_id && seenCust.has(r.customer_id)) return false;
      if (r.customer_id) seenCust.add(r.customer_id);
      return true;
    });
    const dupHeld = beforeFresh - sendable.length;
    if (dupHeld > 0) {
      log(`run ${runId} retenidas_dupe_customer=${dupHeld} (una por cliente por corrida)`);
    }
    log(`run ${runId} start aprobadas=${sendable.length} (sello viejo omitidas=${stale}, dupes retenidas=${dupHeld}) stub=${stub ? "on" : "off"}`);
    await setRunTotal(runId, sendable.length).catch(() => {});
    if (!stub) {
      // Filosofía TeamPulse: bloqueado pero explicado, con siguiente paso.
      const summary =
        sendable.length > 0
          ? `${sendable.length} ${sendable.length === 1 ? "listo" : "listos"}, conecta WhatsApp/email para enviar · no envío sin tu permiso`
          : stale > 0
            ? "En pausa, solo hay aprobadas viejas · revócalas en Review"
            : "En pausa, nada aprobado · no envío sin tu permiso";
      await finishRun(runId, {
        status: "done",
        processed: 0,
        failed: 0,
        summary,
        pulseState: sendable.length > 0 ? "needs" : "paused",
      });
      log(`run ${runId} done ${summary}`);
      return;
    }
    for (const a of sendable) {
      await advanceRun(runId, { processed: dispatched, failed: 0, current: null });
      const { error: upErr } = await db
        .from("proposed_actions")
        .update({ status: "dispatched", dispatched_at: new Date().toISOString() })
        .eq("id", a.id);
      if (upErr) {
        log(`run ${runId} ${a.email} ERROR ${upErr.message}`);
        continue;
      }
      dispatched += 1;
      log(`run ${runId} ${a.email} → dispatched [STUB ${a.channel}, sin proveedor real]`);
    }
    await advanceRun(runId, { processed: dispatched, failed: 0, current: null });
    // Modo prueba local: se marca para medir el loop sin proveedor real.
    const summary =
      dispatched > 0
        ? `${dispatched} ${dispatched === 1 ? "enviada" : "enviadas"} (modo prueba), solo lo aprobado`
        : "En pausa, nada aprobado · no envío sin tu permiso";
    await finishRun(runId, {
      status: "done",
      processed: dispatched,
      failed: 0,
      summary,
      pulseState: dispatched > 0 ? "active" : "paused",
    });
    log(`run ${runId} done ${summary}`);
  } catch (e) {
    await finishRun(runId, {
      status: "error",
      processed: dispatched,
      failed: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}
