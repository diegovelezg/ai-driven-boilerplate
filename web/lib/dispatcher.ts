// Dispatcher (Ejecutar, Fase A): solo acciones `approved` → envío.
// ESTADO: stub honesto — BLOQUEADO por decisión comercial (proveedor
// WhatsApp Cloud API vs Twilio + email Resend vs SendGrid + credenciales).
// Sin `RETAIN_DISPATCH_STUB=1` no cambia nada: lista las aprobadas y lo
// deja por escrito en el run. Con el flag (solo dev/test) marca
// `dispatched` para poder medir el loop con el analyst.
// El envío real entrará aquí cuando se defina el proveedor.
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun } from "@/lib/background";
import { createLogger } from "@/lib/log";

const log = createLogger("dispatcher");

export async function runDispatcher(runId: string, storeId: string): Promise<void> {
  const db = getSupabase();
  const stub = process.env.RETAIN_DISPATCH_STUB === "1";
  let dispatched = 0;
  try {
    const { data, error } = await db
      .from("proposed_actions")
      .select("id,customer_id,channel,customers(email)")
      .eq("store_id", storeId)
      .eq("status", "approved")
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(`Actions read: ${error.message}`);
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      email: String((r.customers as Record<string, unknown> | null)?.email ?? ""),
      channel: String(r.channel ?? "?"),
    }));
    log(`run ${runId} start aprobadas=${rows.length} stub=${stub ? "on" : "off"}`);
    if (!stub) {
      const summary = `${rows.length} aprobadas en espera (sin proveedor: define WhatsApp/email para enviar)`;
      await finishRun(runId, { status: "done", processed: 0, failed: 0, summary });
      log(`run ${runId} done ${summary}`);
      return;
    }
    for (const a of rows) {
      await advanceRun(runId, { processed: dispatched, failed: 0, current: a.email || a.id });
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
    const summary = `${dispatched} marcadas dispatched [STUB]`;
    await finishRun(runId, { status: "done", processed: dispatched, failed: 0, summary });
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
