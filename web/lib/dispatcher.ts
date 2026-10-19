// Dispatcher (Ejecutar, Fase A): solo acciones `approved` → envío.
// ESTADO: email real vía SendGrid (Settings → Email transaccional). WhatsApp
// sigue BLOQUEADO (sin proveedor conectado): queda en cola `approved` y se
// reporta, no se toca. Con `RETAIN_DISPATCH_STUB=1` (solo dev/test) no se
// llama a ningún proveedor: marca `dispatched` para medir el loop con el analyst.
import { getSupabase } from "@/lib/supabase";
import { advanceRun, finishRun, setRunTotal } from "@/lib/background";
import { createLogger } from "@/lib/log";
import { COPYWRITER_GEN } from "@/lib/copywriter-gen";

const log = createLogger("dispatcher");

export async function runDispatcher(runId: string, storeId: string): Promise<void> {
  const db = getSupabase();
  const stub = process.env.RETAIN_DISPATCH_STUB === "1";
  let dispatched = 0;
  let failed = 0;
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
        .select("id,customer_id,channel,subject,body,evidence_json,customers(email)")
        .eq("store_id", storeId)
        .eq("status", "approved")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
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
      subject: (r.subject as string | null) ?? null,
      body: String(r.body ?? ""),
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
      // Ruta real: solo email/SendGrid. WhatsApp queda en cola (sin proveedor).
      const { readConnections } = await import("@/lib/store");
      const conn = await readConnections().catch(() => null);
      const emailReady =
        conn?.emailProvider === "sendgrid" && !!conn.emailApiKey && !!conn.emailFrom;
      const emails = sendable.filter((r) => r.channel === "email");
      const whats = sendable.filter((r) => r.channel !== "email");
      if (whats.length > 0) {
        log(`run ${runId} retenidos_sin_proveedor=${whats.length} (WhatsApp sin conectar, siguen approved)`);
      }
      if (!emailReady) {
        // Filosofía TeamPulse: bloqueado pero explicado, con siguiente paso.
        const summary =
          emails.length > 0
            ? `${emails.length} ${emails.length === 1 ? "listo" : "listos"}, conecta SendGrid en Settings para enviar · no envío sin tu permiso`
            : whats.length > 0
              ? "En pausa, solo hay WhatsApp aprobado y no hay proveedor · conecta WhatsApp o revoca en Review"
              : stale > 0
                ? "En pausa, solo hay aprobadas viejas · revócalas en Review"
                : "En pausa, nada aprobado · no envío sin tu permiso";
        await finishRun(runId, {
          status: "done",
          processed: 0,
          failed: 0,
          summary,
          pulseState: emails.length > 0 || whats.length > 0 ? "needs" : "paused",
        });
        log(`run ${runId} done ${summary}`);
        return;
      }
      const { sendViaSendGrid } = await import("@/lib/comms/email/sendgrid");
      for (const a of emails) {
        await advanceRun(runId, { processed: dispatched, failed, current: null });
        if (!a.email || !a.body || !a.subject) {
          failed += 1;
          log(`run ${runId} ${a.email || a.id} OMITIDO sin ${!a.email ? "destino" : !a.subject ? "asunto" : "cuerpo"} (regenera en Review)`);
          continue;
        }
        const r = await sendViaSendGrid({
          apiKey: conn!.emailApiKey,
          from: conn!.emailFrom,
          msg: { to: a.email, subject: a.subject, text: a.body },
        });
        if (!r.ok) {
          // Se deja `approved` para reintento en la próxima corrida.
          failed += 1;
          log(`run ${runId} ${a.email} ERROR ${r.error} (queda approved, reintenta próximo run)`);
          continue;
        }
        // Guarda anti-carrera: si otro run la procesó, no hay fila y no cuenta.
        const { data: won, error: upErr } = await db
          .from("proposed_actions")
          .update({ status: "dispatched", dispatched_at: new Date().toISOString() })
          .eq("id", a.id)
          .eq("status", "approved")
          .select("id");
        if (upErr) {
          failed += 1;
          log(`run ${runId} ${a.email} ERROR ${upErr.message}`);
          continue;
        }
        if (!won || won.length === 0) {
          log(`run ${runId} ${a.email} ya procesada por otro run (no cuenta)`);
          continue;
        }
        dispatched += 1;
        log(`run ${runId} ${a.email} → dispatched [sendgrid email]`);
      }
      await advanceRun(runId, { processed: dispatched, failed, current: null });
      const summary =
        dispatched > 0
          ? `${dispatched} ${dispatched === 1 ? "enviada" : "enviadas"} por email, solo lo aprobado${whats.length > 0 ? ` · ${whats.length} WhatsApp en cola (sin proveedor)` : ""}${failed > 0 ? ` · ${failed} fallidas (reintentan)` : ""}`
          : failed > 0
            ? `${failed} fallidas por email (reintentan próximo run) · no invento envíos`
            : whats.length > 0
              ? "En pausa, solo hay WhatsApp aprobado y no hay proveedor · no envío sin tu permiso"
              : "En pausa, nada aprobado · no envío sin tu permiso";
      await finishRun(runId, {
        status: dispatched === 0 && failed > 0 ? "error" : "done",
        processed: dispatched,
        failed,
        summary,
        pulseState: dispatched > 0 ? "active" : failed > 0 || whats.length > 0 ? "needs" : "paused",
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
      failed,
      error: e instanceof Error ? e.message : String(e),
    });
    log(`run ${runId} ERROR ${e instanceof Error ? e.message : e}`);
  }
}
