"use server";

import { revalidatePath } from "next/cache";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { COPYWRITER_GEN, draftSingleSignal } from "@/lib/copywriter";
import { advanceRun, busyMessage, finishRun, getLatestRun, hasConflict, startRun, type BackgroundRun } from "@/lib/background";
import { runSingleWithAudit, singleSignalScope, type SingleFinish } from "@/lib/single-audit";
import { createLogger } from "@/lib/log";
import { startCopywriterAction } from "@/lib/retention-actions";
import { createServerSupabase } from "@/lib/supabase-server";

export interface ReviewOp {
  ok: boolean;
  message: string;
  /** Corrida visible en la cinta (Fase 2): solo las acciones que crean
   *  run la devuelven; el resto la omite. */
  run?: BackgroundRun | null;
}

/** Issue #19 Paso 1: identidad del aprobador = email de la sesión Supabase
 *  (mismo identificador que muestra el header/UserMenu). Es solo auditoría,
 *  sin roles ni permisos. Sin sesión resoluble (p. ej. dev sin login) queda
 *  null y la UI muestra "aprobado (sin registro)": nunca un nombre inventado. */
async function resolveApprover(): Promise<string | null> {
  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

async function setActionStatus(id: string, status: "approved" | "rejected"): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  // Al rechazar (o revocar vía status) se limpia el aprobador: una fila que
  // vuelve a no-aprobada no debe mostrar un aprobador viejo.
  const patch =
    status === "approved"
      ? { status, approved_by: await resolveApprover(), approved_at: new Date().toISOString() }
      : { status, approved_by: null, approved_at: null };
  const { error } = await getSupabase()
    .from("proposed_actions")
    .update(patch)
    .eq("id", id)
    .eq("status", "pending_review");
  if (error) return { ok: false, message: error.message };
  revalidatePath("/review");
  return { ok: true, message: status === "approved" ? "Aprobada." : "Rechazada." };
}

async function setLeadStatus(id: string, status: "approved" | "rejected"): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const { error } = await getSupabase()
    .from("proposed_leads")
    .update({ status })
    .eq("id", id)
    .eq("status", "pending_review");
  if (error) return { ok: false, message: error.message };
  revalidatePath("/review");
  return { ok: true, message: status === "approved" ? "Lead aprobado." : "Lead rechazado." };
}

export async function approveActionAction(id: string): Promise<ReviewOp> {
  return setActionStatus(id, "approved");
}

export async function rejectActionAction(id: string): Promise<ReviewOp> {
  return setActionStatus(id, "rejected");
}

/** Revoca una aprobación aún no enviada (approved → rejected, solo si
 *  dispatched_at es null). Sin esto, lo aprobado es invisible en Review
 *  (solo lista pending) y el dispatcher lo enviaría sin remedio. */
export async function revokeApprovalAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const { data, error } = await getSupabase()
    .from("proposed_actions")
    // Revocar limpia approved_by/at: la fila pasa a rejected y no debe
    // seguir mostrando quién la había aprobado (issue #19 Paso 1).
    .update({ status: "rejected", approved_by: null, approved_at: null })
    .eq("id", id)
    .eq("status", "approved")
    .is("dispatched_at", null)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!data || data.length === 0) {
    return { ok: false, message: "Ya enviada o inexistente: no se puede revocar." };
  }
  revalidatePath("/review");
  return { ok: true, message: "Aprobación revocada: no se enviará." };
}

/** Edita asunto/cuerpo de un pendiente (solo pending_review). Valida los mismos
 *  topes del redactor (whatsapp ≤450 sin asunto, email con asunto + ≤800) y
 *  deja auditoría `manual_edit` en evidence_json. */
export async function updateDraftContentAction(
  id: string,
  subject: string | null,
  body: string,
): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: row, error: rErr } = await db
    .from("proposed_actions")
    .select("id,channel,evidence_json")
    .eq("id", id)
    .eq("status", "pending_review")
    .maybeSingle();
  if (rErr) return { ok: false, message: rErr.message };
  const r = (row ?? null) as Record<string, unknown> | null;
  if (!r) return { ok: false, message: "Solo pendientes: lo aprobado/enviado no se edita." };
  const channel = String(r.channel ?? "");
  const cleanBody = body.trim().slice(0, 2000);
  if (!cleanBody) return { ok: false, message: "El mensaje no puede quedar vacío." };
  let cleanSubject: string | null = null;
  if (channel === "whatsapp") {
    if (cleanBody.length > 450) {
      return { ok: false, message: `WhatsApp admite hasta 450 caracteres (van ${cleanBody.length}).` };
    }
  } else if (channel === "email") {
    cleanSubject = (subject ?? "").trim().slice(0, 200) || null;
    if (!cleanSubject) return { ok: false, message: "El email necesita asunto." };
    if (cleanBody.length > 800) {
      return { ok: false, message: `Email admite hasta 800 caracteres (van ${cleanBody.length}).` };
    }
  } else {
    return { ok: false, message: `Canal desconocido: ${channel}.` };
  }
  const prev = ((r.evidence_json as Record<string, unknown> | null) ?? {});
  const { error } = await db
    .from("proposed_actions")
    .update({
      subject: cleanSubject,
      body: cleanBody,
      evidence_json: {
        ...prev,
        manual_edit: { at: new Date().toISOString(), by: await resolveApprover() },
      },
    })
    .eq("id", id)
    .eq("status", "pending_review");
  if (error) return { ok: false, message: error.message };
  revalidatePath("/review");
  return { ok: true, message: "Borrador actualizado." };
}

/** Trae un customer listo para el drawer (ficha completa desde Review).
 *  Solo lectura, acotado a la tienda conectada. */
export async function getDrawerCustomerAction(
  customerDbId: string,
): Promise<ReviewOp & { customer?: import("@/lib/customers-db").EditableCustomer | null }> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const conn = await readConnections();
  if (!conn.medusaUrl) return { ok: false, message: "Sin conexión a Medusa (Settings)." };
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return { ok: false, message: "Tienda sin sincronizar." };
  const { data, error } = await getSupabase()
    .from("customers")
    .select("*")
    .eq("id", customerDbId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: "Cliente inexistente." };
  const { toEditableCustomer } = await import("@/lib/customers-db");
  return { ok: true, message: "ok", customer: toEditableCustomer(data as Record<string, unknown>) };
}

/** Marca un aprobado-WhatsApp como enviado manual (flujo wa.me: el humano
 *  lo envió desde su número, sin API que lo confirme). approved → dispatched.
 *  Solo whatsapp + dispatched_at null; el analyst mide igual que el email. */
export async function markDispatchedAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: row } = await db
    .from("proposed_actions")
    .select("id,channel,evidence_json")
    .eq("id", id)
    .maybeSingle();
  const r = (row ?? null) as Record<string, unknown> | null;
  if (!r) return { ok: false, message: "Borrador inexistente." };
  if (String(r.channel ?? "") !== "whatsapp") {
    return { ok: false, message: "Solo aplica a WhatsApp manual (el email lo envía el dispatcher)." };
  }
  const prev = ((r.evidence_json as Record<string, unknown> | null) ?? {});
  const { data, error } = await db
    .from("proposed_actions")
    .update({
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
      evidence_json: {
        ...prev,
        manual_send: { via: "wa.me", at: new Date().toISOString(), by: await resolveApprover() },
      },
    })
    .eq("id", id)
    .eq("status", "approved")
    .is("dispatched_at", null)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!data || data.length === 0) {
    return { ok: false, message: "Ya enviada o sin aprobar: nada que marcar." };
  }
  revalidatePath("/review");
  return { ok: true, message: "Marcada como enviada por WhatsApp." };
}

/** Cambia el canal de un pendiente al otro (solo si el cliente tiene ambos
 *  contactos): borra el borrador, devuelve la señal a `prioritized` y
 *  redacta de nuevo con canal forzado. Una sola fila viva por cliente:
 *  imposible aprobar/enviar ambas (anti-spam por construcción). */
export async function switchChannelAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: row, error: rErr } = await db
    .from("proposed_actions")
    .select("id,channel,signal_id,customer_id,customers(email,phone,country)")
    .eq("id", id)
    .eq("status", "pending_review")
    .maybeSingle();
  if (rErr) return { ok: false, message: rErr.message };
  const r = (row ?? null) as Record<string, unknown> | null;
  if (!r) return { ok: false, message: "Solo pendientes: aprueba o rechaza primero." };
  const signalId = String(r.signal_id ?? "");
  if (!signalId) return { ok: false, message: "Sin señal atada: no se puede cambiar de canal." };
  const current = String(r.channel ?? "");
  if (current !== "email" && current !== "whatsapp") {
    return { ok: false, message: `Canal desconocido: ${current}.` };
  }
  const c = ((r.customers as Record<string, unknown> | null) ?? {});
  const { resolveContact } = await import("@/lib/comms/contact");
  const caps = resolveContact({
    email: typeof c.email === "string" ? c.email : null,
    phone: typeof c.phone === "string" ? c.phone : null,
    countryIso: typeof c.country === "string" ? c.country : null,
  });
  if (caps.capability !== "both") {
    return {
      ok: false,
      message:
        caps.capability === "email-only"
          ? "Solo hay email de este cliente: no hay WhatsApp a dónde cambiar."
          : caps.capability === "whatsapp-only"
            ? "Solo hay teléfono de este cliente: no hay email a dónde cambiar."
            : "Sin contacto válido para este cliente.",
    };
  }
  const target = (current === "email" ? "whatsapp" : "email") as "email" | "whatsapp";
  const conn = await readConnections();
  if (!conn.medusaUrl) return { ok: false, message: "Sin conexión a Medusa (Settings)." };
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return { ok: false, message: "Tienda sin sincronizar." };
  // Borra el pendiente y libera la señal; si algo falla después, la señal
  // queda priorizada y el humano reintenta (nunca dos filas vivas).
  const { error: dErr } = await db
    .from("proposed_actions")
    .delete()
    .eq("id", id)
    .eq("status", "pending_review");
  if (dErr) return { ok: false, message: dErr.message };
  await db.from("churn_signals").update({ status: "prioritized" }).eq("id", signalId);
  const draft = await draftSingleSignal(storeId, signalId, { forceChannel: target });
  revalidatePath("/review");
  return draft.ok
    ? { ok: true, message: `Ahora en ${target === "email" ? "Email" : "WhatsApp"}.` }
    : { ok: false, message: `Se liberó la señal pero el borrador falló: ${draft.message}` };
}

export async function approveLeadAction(id: string): Promise<ReviewOp> {
  return setLeadStatus(id, "approved");
}
export async function rejectLeadAction(id: string): Promise<ReviewOp> {
  return setLeadStatus(id, "rejected");
}

/** Descarta una señal abierta/priorizada sin acción (el humano la juzga irrelevante). */
export async function dismissSignalAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const { error } = await getSupabase()
    .from("churn_signals")
    .update({ status: "dismissed", closed_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["open", "prioritized"]);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/review");
  return { ok: true, message: "Señal descartada." };
}

/** Redacta un borrador para UNA señal (CTA "Redactar" en "Tus 5 de hoy").
 *  Issue #16 Fase 1: aunque sea síncrono, deja corrida de auditoría
 *  `copywriter_single` (start → draft → finish) para que el veto del juez
 *  quede como estado consultable y no solo en `console.log` /
 *  `evidence_json`. El run va acotado a la señal (`singleSignalScope`); el
 *  `current` lleva el `signalId` como trazabilidad mínima. El cierre
 *  garantizado vive en `runSingleWithAudit` (P0: ni un throw deja
 *  `running` eterno). */
export async function proposeSingleAction(signalId: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: sig } = await db
    .from("churn_signals")
    .select("store_id")
    .eq("id", signalId)
    .maybeSingle();
  const storeId = (sig?.store_id as string | null) ?? null;
  if (!storeId) return { ok: false, message: "Señal inexistente." };
  const log = createLogger("review-actions");
  // Lock por scope (Fase 3): otro single sobre la misma señal, el bulk o
  // regenerate en curso frenan con motivo; el resto convive. El scope sale
  // de `singleSignalScope` y se usa también en el `startRun`: si diverge,
  // el run queda global y el segundo single no conflicta en prod.
  const scope = singleSignalScope(signalId);
  const conflict = await hasConflict(storeId, { kind: "copywriter_single", ...scope });
  if (conflict) return { ok: false, message: busyMessage(conflict), run: conflict };
  const r = await runSingleWithAudit({
    start: async () => {
      try {
        return await startRun(storeId, "copywriter_single", "Redacción individual", 1, scope);
      } catch (e) {
        log(`single ${signalId} startRun falló: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    },
    advance: async (runId) => {
      try {
        await advanceRun(runId, { processed: 0, failed: 0, current: signalId });
      } catch (e) {
        log(`single ${signalId} advanceRun falló: ${e instanceof Error ? e.message : e}`);
      }
    },
    finish: async (runId, f: SingleFinish) => {
      try {
        await finishRun(runId, f);
      } catch (e) {
        log(`single ${signalId} finishRun falló: ${e instanceof Error ? e.message : e}`);
      }
    },
    draft: () => draftSingleSignal(storeId, signalId),
  });
  // El fallo también pudo mutar DB (veto escribe `contactability`): la UI
  // debe releer en vez de quedarse con la foto vieja.
  revalidatePath("/");
  revalidatePath("/review");
  const run = await getLatestRun(storeId).catch(() => null);
  return { ...r, run };
}

/** Aprueba un lote con corrida visible (Fase 3): progreso real en la
 *  cinta en vez del loop ciego desde el cliente. */
export async function approveBatchAction(ids: string[]): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  if (ids.length === 0) return { ok: true, message: "Nada que aprobar." };
  const log = createLogger("review-actions");
  const db = getSupabase();
  const { data, error } = await db
    .from("proposed_actions")
    .select("id,store_id")
    .in("id", ids)
    .eq("status", "pending_review");
  if (error) return { ok: false, message: error.message };
  const targets = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id ?? ""),
    storeId: String(r.store_id ?? ""),
  })).filter((r) => r.id && r.storeId);
  if (targets.length === 0) return { ok: true, message: "Nada que aprobar: ya resueltas." };
  const storeId = targets[0].storeId;
  const conflict = await hasConflict(storeId, { kind: "approve_batch" }).catch(() => null);
  if (conflict) return { ok: false, message: busyMessage(conflict), run: conflict };
  let runId: string | null = null;
  try {
    runId = await startRun(storeId, "approve_batch", "Aprobación en lote", targets.length);
  } catch (e) {
    log(`batch startRun falló: ${e instanceof Error ? e.message : e}`);
  }
  let ok = 0;
  try {
    // Un solo aprobador para todo el lote (la sesión no cambia a mitad).
    const approvedBy = await resolveApprover();
    const approvedAt = new Date().toISOString();
    for (const t of targets) {
      const { error: upErr } = await db
        .from("proposed_actions")
        .update({ status: "approved", approved_by: approvedBy, approved_at: approvedAt })
        .eq("id", t.id)
        .eq("status", "pending_review");
      if (!upErr) ok += 1;
      if (runId) {
        await advanceRun(runId, { processed: ok, failed: 0, current: null }).catch(() => {});
      }
    }
    const message = `${ok} de ${targets.length} aprobadas.`;
    if (runId) {
      await finishRun(runId, { status: "done", processed: ok, failed: 0, summary: message, pulseState: "active" }).catch((e) =>
        log(`batch finishRun falló: ${e instanceof Error ? e.message : e}`),
      );
    }
    revalidatePath("/review");
    const run = await getLatestRun(storeId).catch(() => null);
    return { ok: true, message, run };
  } catch (e) {
    const message = e instanceof Error ? e.message : "error";
    if (runId) {
      await finishRun(runId, { status: "error", processed: ok, failed: 1, error: message }).catch(() => {});
    }
    return { ok: false, message, run: null };
  }
}

/** ¿Este borrador nació con criterios viejos? (sin sello = v1 implícita). */
function isStaleDraft(evidence: Record<string, unknown> | null): boolean {
  if (!evidence) return true;
  return String(evidence.generator ?? "") !== COPYWRITER_GEN;
}

/** Regenera pendientes con criterios viejos: los borra, devuelve sus señales
 *  a `prioritized` y arranca el copywriter. Nunca toca approved/dispatched.
 *  Reproceso independiente por etapa: solo borradores, nada más. */
export async function regenerateStaleDraftsAction(): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const conn = await readConnections();
  if (!conn.medusaUrl) return { ok: false, message: "Sin conexión a Medusa (Settings)." };
  const db = getSupabase();
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return { ok: false, message: "Tienda sin sincronizar." };
  const regenConflict = await hasConflict(storeId, { kind: "regenerate" }).catch(() => null);
  if (regenConflict) return { ok: false, message: busyMessage(regenConflict), run: regenConflict };
  const all: Array<Record<string, unknown>> = [];
  let scanTruncated = false;
  for (let off = 0; ; off += 500) {
    const { data, error } = await db
      .from("proposed_actions")
      .select("id,signal_id,evidence_json")
      .eq("store_id", storeId)
      .eq("status", "pending_review")
      .order("id", { ascending: true })
      .range(off, off + 499);
    if (error) return { ok: false, message: error.message };
    const page = (data ?? []) as Array<Record<string, unknown>>;
    all.push(...page);
    if (page.length < 500) break;
    if (all.length >= 5000) {
      scanTruncated = true;
      break;
    }
  }
  const data = all;
  const stale = (data ?? []).filter((r) =>
    isStaleDraft((r.evidence_json as Record<string, unknown> | null) ?? null),
  );
  if (stale.length === 0) {
    return scanTruncated
      ? { ok: true, message: "Revisados 5000 pendientes sin stale en la ventana; puede haber más fuera del CAP." }
      : { ok: true, message: "Nada que regenerar: todo con criterios actuales." };
  }
  // Antirreinyección legacy (issue #9): solo se regenera lo atado a señales
  // retention:v1 (reason "ciclo ~Nd"). Los pendientes de señales del motor
  // viejo o sin señal se dejan intactos: los cubre refresh-retention-v1.ts,
  // no este botón. Sin esto, regenerar reinyecta a la cola lo que el refresh
  // purgó.
  const withSignal = stale.filter((r) => String(r.signal_id ?? ""));
  const noSignal = stale.length - withSignal.length;
  const v1Ids: string[] = [];
  const legacyIds: string[] = [];
  if (withSignal.length > 0) {
    const sids = [...new Set(withSignal.map((r) => String(r.signal_id)))];
    const sigRows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < sids.length; i += 200) {
      const { data: spage } = await db
        .from("churn_signals")
        .select("id,reason")
        .in("id", sids.slice(i, i + 200));
      sigRows.push(...((spage ?? []) as Array<Record<string, unknown>>));
    }
    const reasonById = new Map(
      ((sigRows ?? []) as Array<Record<string, unknown>>).map((s) => [String(s.id), String(s.reason ?? "")]),
    );
    for (const sid of sids) {
      const reason = reasonById.get(sid) ?? "";
      if (/ciclo ~\d+d/i.test(reason)) v1Ids.push(sid);
      else legacyIds.push(sid);
    }
  }
  const regenIds = new Set(v1Ids);
  const ids = withSignal.filter((r) => regenIds.has(String(r.signal_id))).map((r) => String(r.id));
  const skipped = stale.length - ids.length;
  if (ids.length === 0) {
    return {
      ok: true,
      message: `Nada que regenerar por aquí: ${legacyIds.length} legacy + ${noSignal} sin señal intactos (cúbrelos con scripts/refresh-retention-v1.ts).`,
    };
  }
  for (let i = 0; i < ids.length; i += 200) {
    const { error: delErr } = await db.from("proposed_actions").delete().in("id", ids.slice(i, i + 200));
    if (delErr) return { ok: false, message: delErr.message };
  }
  for (let i = 0; i < v1Ids.length; i += 200) {
    await db.from("churn_signals").update({ status: "prioritized" }).in("id", v1Ids.slice(i, i + 200)).eq("status", "actioned");
  }
  revalidatePath("/review");
  const started = await startCopywriterAction();
  const extra = skipped > 0 ? ` ${skipped} intacto(s) legacy/sin señal (van por refresh).` : "";
  return {
    ok: started.ok,
    message: `${ids.length} borrador(es) viejo(s) a regenerar.${extra} ${started.message}`,
    run: started.run,
  };
}
