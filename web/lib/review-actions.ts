"use server";

import { revalidatePath } from "next/cache";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { COPYWRITER_GEN, draftSingleSignal } from "@/lib/copywriter";
import { getChannelVariants, isReusableChannelVariant, type ChannelVariant } from "@/lib/channel-variants";
import { isFreshGenerator, isV1SignalReason } from "@/lib/copywriter-gen";
import { advanceRun, finishRun, getLatestRun, hasConflict, setRunTotal, startRun, type BackgroundRun } from "@/lib/background";
import { busyMessage } from "@/lib/operations";
import { runSingleWithAudit, singleSignalScope, type SingleFinish } from "@/lib/single-audit";
import { createLogger } from "@/lib/log";
import { startCopywriterAction } from "@/lib/retention-actions";
import { createServerSupabase } from "@/lib/supabase-server";
import { formatNumber } from "@/lib/format";
import { DISMISS_REASON_LABEL, cleanDismissReason } from "@/lib/dismiss-reasons";

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
  const now = new Date().toISOString();
  // Al rechazar (o revocar vía status) se limpia el aprobador: una fila que
  // vuelve a no-aprobada no debe mostrar un aprobador viejo. El rechazo sí
  // deja su propio sello (quién/cuándo).
  const patch =
    status === "approved"
      ? { status, approved_by: await resolveApprover(), approved_at: now, rejected_by: null, rejected_at: null }
      : { status, approved_by: null, approved_at: null, rejected_by: await resolveApprover(), rejected_at: now };
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
  const now = new Date().toISOString();
  const { error } = await getSupabase()
    .from("proposed_leads")
    .update({ status, decided_by: await resolveApprover(), decided_at: now })
    .eq("id", id)
    .eq("status", "pending_review");
  if (error) return { ok: false, message: error.message };
  revalidatePath("/review");
  return { ok: true, message: status === "approved" ? "Lead aprobado." : "Descartado." };
}

/** Envía un aprobado-email en el acto (aprobar = enviar). Solo sello vigente
 *  y SendGrid configurado; si algo falta o falla, queda `approved` y lo
 *  reintenta el dispatcher. Guarda anti-carrera por status. La puerta
 *  pre-envío (issue #13) frena antes de llamar al proveedor: skip terminal
 *  archiva, hold deja en cola para ojo humano. */
async function trySendApprovedEmail(
  id: string,
): Promise<{ sent: boolean; message: string; disposition: "sent" | "skip" | "hold" | "retry" }> {
  const db = getSupabase();
  const { data: row } = await db
    .from("proposed_actions")
    .select("id,store_id,customer_id,channel,subject,body,evidence_json,approved_at,created_at,signal_id,customers(email)")
    .eq("id", id)
    .eq("status", "approved")
    .maybeSingle();
  const r = (row ?? null) as Record<string, unknown> | null;
  if (!r) return { sent: false, message: "Ya procesada por otro lado.", disposition: "retry" };
  if (String(r.channel ?? "") !== "email") return { sent: false, message: "No es email.", disposition: "retry" };
  const body = String(r.body ?? "");
  const subject = (r.subject as string | null) ?? null;
  if (!subject || !body) return { sent: false, message: "Sin asunto o cuerpo.", disposition: "retry" };
  const ev0 = ((r.evidence_json as Record<string, unknown> | null) ?? {});
  if (isStaleDraft(ev0)) {
    return { sent: false, message: "Criterios viejos: regenera en Review.", disposition: "retry" };
  }
  const to = String(((r.customers as Record<string, unknown> | null)?.email) ?? "");
  if (!to) return { sent: false, message: "Sin destinatario.", disposition: "retry" };
  // Puerta pre-envío ANTES del proveedor (nunca se envía sin revalidar).
  const { checkPreSendGate } = await import("@/lib/pre-send");
  const contact0 = (ev0.contactability as Record<string, unknown> | null) ?? {};
  const gate = await checkPreSendGate({
    id: String(r.id ?? id),
    storeId: String(r.store_id ?? ""),
    customerId: String(r.customer_id ?? ""),
    channel: String(r.channel ?? ""),
    approvedAt: (r.approved_at as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
    signalId: (r.signal_id as string | null) ?? null,
    failOpen: contact0.fail_open === true,
  });
  if (!gate.send) {
    if (gate.terminal) {
      await db
        .from("proposed_actions")
        .update({
          status: "skipped",
          evidence_json: { ...ev0, skip: { code: gate.code, reason: gate.message, at: new Date().toISOString(), by: (await resolveApprover()) ?? "system" } },
        })
        .eq("id", id)
        .eq("status", "approved");
      return { sent: false, message: `Frenado y archivado (skip ${gate.code}): ${gate.message}`, disposition: "skip" };
    }
    return { sent: false, message: `Retenido (hold ${gate.code}): ${gate.message} Queda en cola para revisión.`, disposition: "hold" };
  }
  const conn = await readConnections().catch(() => null);
  if (!conn || conn.emailProvider !== "sendgrid" || !conn.emailApiKey || !conn.emailFrom) {
    return { sent: false, message: "SendGrid sin configurar en Settings.", disposition: "retry" };
  }
  const { sendViaSendGrid } = await import("@/lib/comms/email/sendgrid");
  const res = await sendViaSendGrid({ apiKey: conn.emailApiKey, from: conn.emailFrom, msg: { to, subject, text: body } });
  if (!res.ok) return { sent: false, message: res.error ?? "SendGrid falló.", disposition: "retry" };
  const prev = ((r.evidence_json as Record<string, unknown> | null) ?? {});
  const { data: won } = await db
    .from("proposed_actions")
    .update({
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
      evidence_json: { ...prev, sent_via: "approve", sent_by: (await resolveApprover()) ?? "system" },
    })
    .eq("id", id)
    .eq("status", "approved")
    .select("id");
  if (!won || won.length === 0) return { sent: false, message: "Ya procesada por otro lado.", disposition: "retry" };
  return { sent: true, message: "Aprobada y enviada por email.", disposition: "sent" };
}

export async function approveActionAction(id: string): Promise<ReviewOp> {
  const base = await setActionStatus(id, "approved");
  if (!base.ok) return base;
  // Aprobar = enviar (email): intento inmediato; si falla, queda approved
  // y lo reintenta el dispatcher. WhatsApp sigue manual (wa.me).
  const send = await trySendApprovedEmail(id);
  if (send.sent) return { ok: true, message: send.message };
  // WhatsApp es manual (wa.me): aprobar solo abre la cola, el humano envía
  // desde su número y marca "Ya lo envié". Dejarlo explícito en el mensaje.
  if (send.message === "No es email." || send.message === "Ya procesada por otro lado.") {
    const { data: chRow } = await getSupabase().from("proposed_actions").select("channel").eq("id", id).maybeSingle();
    if (String((chRow as Record<string, unknown> | null)?.channel ?? "") === "whatsapp") {
      return { ok: true, message: "Aprobada. Envía desde WhatsApp y marca Ya lo envié." };
    }
    return base;
  }
  if (send.disposition === "skip") return { ok: true, message: `Aprobada. ${send.message}` };
  return { ok: true, message: `Aprobada, pero no se pudo enviar: ${send.message} Queda en cola para el dispatcher.` };
}

export async function rejectActionAction(id: string): Promise<ReviewOp> {
  return setActionStatus(id, "rejected");
}

/** Cancela un envío aún no salido (approved → pending_review, solo si
 *  dispatched_at es null): vuelve a Clientes por contactar. Si ya no te
 *  interesa, descártalo desde pendientes. */
export async function revokeApprovalAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: prev } = await db
    .from("proposed_actions")
    .select("evidence_json")
    .eq("id", id)
    .eq("status", "approved")
    .is("dispatched_at", null)
    .maybeSingle();
  if (!prev) return { ok: false, message: "Ya enviado o inexistente: nada que cancelar." };
  const prevEv = (((prev ?? {}) as Record<string, unknown>).evidence_json as Record<string, unknown> | null) ?? {};
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("proposed_actions")
    // Revocar limpia approved_by/at: la fila vuelve a pendiente y no debe
    // seguir mostrando quién la había aprobado (issue #19 Paso 1). Quién
    // revocó queda en evidence (no es estado terminal).
    .update({
      status: "pending_review",
      approved_by: null,
      approved_at: null,
      evidence_json: { ...prevEv, revoke: { at: now, by: await resolveApprover() } },
    })
    .eq("id", id)
    .eq("status", "approved")
    .is("dispatched_at", null)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!data || data.length === 0) {
    return { ok: false, message: "Ya enviado o inexistente: nada que cancelar." };
  }
  revalidatePath("/review");
  return { ok: true, message: "Envío cancelado: vuelve a pendientes." };
}

/** Reabre un mensaje rechazado/cancelado (rejected → pending_review):
 *  "rescatar si te arrepentiste" — vuelve a Clientes por contactar sin
 *  duplicar. Solo si aún no salió (dispatched_at null). */
export async function reopenActionAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: prev } = await db
    .from("proposed_actions")
    .select("evidence_json")
    .eq("id", id)
    .eq("status", "rejected")
    .is("dispatched_at", null)
    .maybeSingle();
  if (!prev) return { ok: false, message: "Ya reabierto o inexistente: nada que rescatar." };
  const prevEv = (((prev ?? {}) as Record<string, unknown>).evidence_json as Record<string, unknown> | null) ?? {};
  const { data, error } = await db
    .from("proposed_actions")
    .update({
      status: "pending_review",
      rejected_by: null,
      rejected_at: null,
      evidence_json: { ...prevEv, reopen: { at: new Date().toISOString(), by: await resolveApprover() } },
    })
    .eq("id", id)
    .eq("status", "rejected")
    .is("dispatched_at", null)
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!data || data.length === 0) {
    return { ok: false, message: "Ya reabierto o inexistente: nada que rescatar." };
  }
  revalidatePath("/review");
  return { ok: true, message: "Rescatado: vuelve a Clientes por contactar." };
}

/** Da de baja a un cliente en un canal (issue #13): nunca más enviable por
 *  ahí. Modelo mínimo sin UI en v1 (las actions existen para la futura UI y
 *  para gestión manual). Se respeta en scout, copywriter y pre-envío. */
export async function optOutCustomerAction(
  customerDbId: string,
  channel: string,
  reason?: string | null,
): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  if (channel !== "email" && channel !== "whatsapp") {
    return { ok: false, message: "Canal inválido (email o whatsapp)." };
  }
  const db = getSupabase();
  const { data: cust } = await db
    .from("customers")
    .select("id,store_id")
    .eq("id", customerDbId)
    .maybeSingle();
  const storeId = ((cust ?? {}) as Record<string, unknown>).store_id as string | null ?? null;
  if (!storeId) return { ok: false, message: "Cliente inexistente." };
  const { error } = await db.from("opt_outs").upsert(
    { store_id: storeId, customer_id: customerDbId, channel, reason: reason?.trim().slice(0, 200) ?? null },
    { onConflict: "store_id,customer_id,channel" },
  );
  if (error) return { ok: false, message: error.message };
  revalidatePath("/review");
  return { ok: true, message: `Baja registrada en ${channel}: no se le volverá a escribir por ahí.` };
}

/** Revierte una baja (el destinatario volvió a aceptar). */
export async function optInCustomerAction(
  customerDbId: string,
  channel: string,
): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  if (channel !== "email" && channel !== "whatsapp") {
    return { ok: false, message: "Canal inválido (email o whatsapp)." };
  }
  const { error } = await getSupabase()
    .from("opt_outs")
    .delete()
    .eq("customer_id", customerDbId)
    .eq("channel", channel);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/review");
  return { ok: true, message: `Baja revertida en ${channel}.` };
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
      return { ok: false, message: `WhatsApp admite hasta 450 caracteres (van ${formatNumber(cleanBody.length)}).` };
    }
  } else if (channel === "email") {
    cleanSubject = (subject ?? "").trim().slice(0, 200) || null;
    if (!cleanSubject) return { ok: false, message: "El email necesita asunto." };
    if (cleanBody.length > 800) {
      return { ok: false, message: `Email admite hasta 800 caracteres (van ${formatNumber(cleanBody.length)}).` };
    }
  } else {
    return { ok: false, message: `Canal desconocido: ${channel}.` };
  }
  const prev = ((r.evidence_json as Record<string, unknown> | null) ?? {});
  const prevVariants = getChannelVariants(prev);
  const { error } = await db
    .from("proposed_actions")
    .update({
      subject: cleanSubject,
      body: cleanBody,
      evidence_json: {
        ...prev,
        // La edición humana valida el texto: sella criterios actuales para
        // que no quede como stale eterno (botón Regenerar + puerta de envío).
        generator: COPYWRITER_GEN,
        // La edición es la verdad del canal: el switch la restaura tal cual.
        variants: {
          ...prevVariants,
          [channel]: {
            subject: cleanSubject,
            body: cleanBody,
            generator: COPYWRITER_GEN,
            at: new Date().toISOString(),
            manual: true,
          },
        },
        manual_edit: {
          at: new Date().toISOString(),
          by: await resolveApprover(),
          prev_generator: (prev.generator as string | null) ?? null,
        },
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

/** Variante de borrador por canal: el tipo vive en `lib/channel-variants`
 *  (los helpers síncronos se importan desde ahí; "use server" solo permite
 *  exportar funciones async, así que no se re-exportan valores aquí). */
export type { ChannelVariant } from "@/lib/channel-variants";

/** Cambia el canal de un pendiente al otro (solo si el cliente tiene ambos
 *  contactos): si ya existe variante fresca del otro canal, se restaura sin
 *  LLM; si no, se redacta con canal forzado y ambas versiones quedan en
 *  caché (`evidence_json.variants`). Una sola fila viva por cliente:
 *  imposible aprobar/enviar ambas (anti-spam por construcción). */
export async function switchChannelAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: row, error: rErr } = await db
    .from("proposed_actions")
    .select("id,channel,subject,body,signal_id,customer_id,evidence_json,customers(email,phone,country)")
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
  const prev = ((r.evidence_json as Record<string, unknown> | null) ?? {});
  const prevVariants = getChannelVariants(prev);
  // Guarda la versión actual antes de salir de ella: así el toggle es
  // reversible sin LLM (incluye ediciones manuales, ya selladas frescas).
  const currentBody = String(r.body ?? "");
  const currentSubject = current === "email" ? ((r.subject as string | null) ?? null) : null;
  const keptVariants: Record<string, ChannelVariant> = { ...prevVariants };
  if (currentBody.trim()) {
    keptVariants[current] = {
      subject: currentSubject,
      body: currentBody.slice(0, 2000),
      generator: (prev.generator as string | null) ?? null,
      at: new Date().toISOString(),
      manual: Boolean((prev as Record<string, unknown>).manual_edit),
    };
  }
  // Cache hit: variante fresca del otro canal → swap sin LLM, sin tocar la
  // señal ni Medusa. La cola no se reordena (created_at intacto).
  const cached = prevVariants[target] ?? keptVariants[target];
  if (isReusableChannelVariant(target, cached)) {
    const v = cached as ChannelVariant;
    const { error: uErr } = await db
      .from("proposed_actions")
      .update({
        channel: target,
        subject: target === "email" ? v.subject : null,
        body: v.body.slice(0, 2000),
        evidence_json: {
          ...prev,
          generator: v.generator ?? COPYWRITER_GEN,
          variants: keptVariants,
          channel_switch: {
            from: current,
            to: target,
            at: new Date().toISOString(),
            by: await resolveApprover(),
            prev_generator: (prev.generator as string | null) ?? null,
            reused: true,
          },
        },
      })
      .eq("id", id)
      .eq("status", "pending_review");
    if (uErr) {
      revalidatePath("/review");
      return { ok: false, message: uErr.message };
    }
    revalidatePath("/review");
    return { ok: true, message: `Mensaje para ${target === "email" ? "Email" : "WhatsApp"} restaurado (versión guardada, sin regenerar).` };
  }
  const conn = await readConnections();
  if (!conn.medusaUrl) return { ok: false, message: "Sin conexión a Medusa (Settings)." };
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return { ok: false, message: "Tienda sin sincronizar." };
  // Re-redacción in place sobre la misma fila: created_at intacto (la cola
  // no se reordena) y nunca hay dos filas vivas (anti-spam por construcción).
  // La señal se presta a prioritized para componer y vuelve a actioned.
  await db.from("churn_signals").update({ status: "prioritized" }).eq("id", signalId);
  const { previewSignalCopy } = await import("@/lib/copywriter");
  const preview = await previewSignalCopy(storeId, signalId, target);
  if (!preview.ok) {
    await db.from("churn_signals").update({ status: "actioned" }).eq("id", signalId);
    revalidatePath("/review");
    return { ok: false, message: preview.message };
  }
  const { error: uErr } = await db
    .from("proposed_actions")
    .update({
      channel: preview.channel,
      subject: preview.channel === "email" ? preview.subject : null,
      body: preview.body.slice(0, 2000),
      evidence_json: {
        ...prev,
        // Re-redactado con el copywriter actual: sella criterios actuales.
        generator: COPYWRITER_GEN,
        variants: {
          ...keptVariants,
          [preview.channel]: {
            subject: preview.channel === "email" ? preview.subject : null,
            body: preview.body.slice(0, 2000),
            generator: COPYWRITER_GEN,
            at: new Date().toISOString(),
          },
        },
        channel_switch: {
          from: current,
          to: preview.channel,
          at: new Date().toISOString(),
          by: await resolveApprover(),
          prev_generator: (prev.generator as string | null) ?? null,
          reused: false,
        },
      },
    })
    .eq("id", id)
    .eq("status", "pending_review");
  await db.from("churn_signals").update({ status: "actioned" }).eq("id", signalId);
  if (uErr) {
    revalidatePath("/review");
    return { ok: false, message: uErr.message };
  }
  revalidatePath("/review");
  return { ok: true, message: `Mensaje para ${preview.channel === "email" ? "Email" : "WhatsApp"} redactado de nuevo.` };
}

/** Descarta un lead (pending_review → rejected): no te interesa.
 *  No desaparece: queda en "Descartados" y se puede reabrir. */
export async function rejectLeadAction(id: string): Promise<ReviewOp> {
  return setLeadStatus(id, "rejected");
}

/** Marca un lead como contactado (pending_review/approved → contacted):
 *  lo contactaste por tu cuenta (email/tel/RRSS de la tarjeta). Cierra el loop
 *  sin reinyectar: no vuelve a pendientes ni se repropone (dedupe por URL). */
export async function markLeadContactedAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const now = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from("proposed_leads")
    .update({ status: "contacted", contacted_by: await resolveApprover(), contacted_at: now })
    .eq("id", id)
    .in("status", ["pending_review", "approved"])
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!data || data.length === 0) {
    return { ok: false, message: "Ya contactado o inexistente: nada que marcar." };
  }
  revalidatePath("/review");
  return { ok: true, message: "Marcado como contactado." };
}

/** Reabre un lead descartado (rejected/discarded → pending_review):
 *  "contactar igual" — vuelve a pendientes sin duplicar (dedupe por URL). */
export async function reopenLeadAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: prev } = await db
    .from("proposed_leads")
    .select("evidence_json")
    .eq("id", id)
    .in("status", ["rejected", "discarded"])
    .maybeSingle();
  if (!prev) return { ok: false, message: "Ya reabierto o inexistente: nada que reabrir." };
  const prevEv = (((prev ?? {}) as Record<string, unknown>).evidence_json as Record<string, unknown> | null) ?? {};
  const { data, error } = await db
    .from("proposed_leads")
    .update({
      status: "pending_review",
      decided_by: null,
      decided_at: null,
      evidence_json: { ...prevEv, reopen: { at: new Date().toISOString(), by: await resolveApprover() } },
    })
    .eq("id", id)
    .in("status", ["rejected", "discarded"])
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!data || data.length === 0) {
    return { ok: false, message: "Ya reabierto o inexistente: nada que reabrir." };
  }
  revalidatePath("/review");
  return { ok: true, message: "Reabierto: vuelve a pendientes." };
}

/** Descarta una señal abierta/priorizada sin acción (el humano la juzga irrelevante). */
export async function dismissSignalAction(id: string, reason?: string | null): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const cleanReason = cleanDismissReason(reason);
  const db = getSupabase();
  const { data: prev } = await db
    .from("churn_signals")
    .select("evidence_json")
    .eq("id", id)
    .maybeSingle();
  const prevEv =
    (((prev ?? {}) as Record<string, unknown>).evidence_json as Record<string, unknown> | null) ?? {};
  const now = new Date().toISOString();
  const by = await resolveApprover();
  const { error } = await db
    .from("churn_signals")
    .update({
      status: "dismissed",
      closed_at: now,
      closed_by: by,
      evidence_json: cleanReason
        ? {
          ...prevEv,
          dismiss: {
            reason: cleanReason,
            label: DISMISS_REASON_LABEL[cleanReason],
            at: now,
            by,
          },
        }
        : prevEv,
    })
    .eq("id", id)
    .in("status", ["open", "prioritized"]);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/review");
  return {
    ok: true,
    message: cleanReason
      ? `Señal descartada (${DISMISS_REASON_LABEL[cleanReason]}).`
      : "Señal descartada.",
  };
}

/** Señal abierta/priorizada más reciente de un cliente (para la ficha:
 *  Redactar/Descartar operan sobre ella; null = no está en Hoy). */
export async function getCustomerSignalAction(
  customerDbId: string,
): Promise<{ signalId: string | null }> {
  if (!isSupabaseConfigured()) return { signalId: null };
  try {
    const { data } = await getSupabase()
      .from("churn_signals")
      .select("id")
      .eq("customer_id", customerDbId)
      .in("status", ["open", "prioritized"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const id = ((data ?? {}) as Record<string, unknown>).id;
    return { signalId: typeof id === "string" ? id : null };
  } catch {
    return { signalId: null };
  }
}

/** Reabre una señal descartada (dismissed → open): "contactar igual" auditado
 *  (issue #14 B3). El descarte escondía la señal de la mira 30d sin remedio;
 *  reabrir la devuelve a la cola y el próximo scout la re-evalúa. Limpia
 *  closed_at para no arrastrar el descarte viejo. */
export async function reopenSignalAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: prev } = await db
    .from("churn_signals")
    .select("evidence_json")
    .eq("id", id)
    .eq("status", "dismissed")
    .maybeSingle();
  if (!prev) return { ok: false, message: "Ya reabierta o inexistente: nada que reabrir." };
  const prevEv = (((prev ?? {}) as Record<string, unknown>).evidence_json as Record<string, unknown> | null) ?? {};
  const { data, error } = await db
    .from("churn_signals")
    .update({
      status: "open",
      closed_at: null,
      closed_by: null,
      evidence_json: { ...prevEv, reopen: { at: new Date().toISOString(), by: await resolveApprover() } },
    })
    .eq("id", id)
    .eq("status", "dismissed")
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!data || data.length === 0) {
    return { ok: false, message: "Ya reabierta o inexistente: nada que reabrir." };
  }
  revalidatePath("/review");
  return { ok: true, message: "Reabierta: vuelve a la cola para contactar igual." };
}

/** Reabre la última señal descartada de un cliente (ficha/Hoy/Customers).
 *  `customerDbId` = uuid de `customers`. Sin descartes → mensaje honesto. */
export async function reopenCustomerSignalAction(customerDbId: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const db = getSupabase();
  const { data: sig, error: sErr } = await db
    .from("churn_signals")
    .select("id")
    .eq("customer_id", customerDbId)
    .eq("status", "dismissed")
    .order("closed_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (sErr) return { ok: false, message: sErr.message };
  if (!sig) return { ok: false, message: "Sin descartes para reabrir en este cliente." };
  return reopenSignalAction(String((sig as Record<string, unknown>).id ?? ""));
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
  let sent = 0;
  let held = 0;
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
      if (upErr) continue;
      ok += 1;
      // Aprobar = enviar (email): intento inmediato por fila; WhatsApp y
      // fallos quedan approved para el dispatcher / flujo manual. Los skip
      // de la puerta pre-envío ya están archivados: no cuentan como cola.
      const send = await trySendApprovedEmail(t.id).catch(() => ({ sent: false as const, message: "error", disposition: "retry" as const }));
      if (send.sent) sent += 1;
      else if (send.disposition !== "skip" && send.message !== "No es email." && send.message !== "Ya procesada por otro lado.") held += 1;
      if (runId) {
        await advanceRun(runId, { processed: ok, failed: 0, current: null }).catch(() => {});
      }
    }
    const message =
      sent > 0
        ? `${formatNumber(ok)} de ${formatNumber(targets.length)} aprobadas, ${formatNumber(sent)} enviadas por email${held > 0 ? `, ${formatNumber(held)} en cola (las envía el dispatcher)` : ""}.`
        : `${formatNumber(ok)} de ${formatNumber(targets.length)} aprobadas${held > 0 ? ` (${formatNumber(held)} emails en cola para el dispatcher)` : ""}.`;
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
  return !isFreshGenerator(String(evidence.generator ?? ""));
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
  const log = createLogger("review-actions");
  // Corrida visible (MO único: toda mutación larga va a la cinta de toasts).
  // El scan + borrado tarda segundos y antes era sincrónico e invisible: el
  // botón quedaba en "Regenerando…" sin toast. Se cierra ANTES de arrancar el
  // copywriter (la matriz los marca incompatibles: un regenerate running
  // frenaría al copywriter con "En curso").
  let regenRunId: string | null = null;
  try {
    regenRunId = await startRun(storeId, "regenerate", "Regenerando borradores", 0);
  } catch (e) {
    log(`regenerate startRun falló: ${e instanceof Error ? e.message : e}`);
  }
  const closeRegen = async (p: {
    status: "done" | "error";
    processed: number;
    summary?: string | null;
    error?: string | null;
  }) => {
    if (!regenRunId) return;
    const id = regenRunId;
    regenRunId = null;
    await finishRun(id, {
      status: p.status,
      processed: p.processed,
      failed: 0,
      summary: p.summary ?? null,
      error: p.error ?? null,
    }).catch(() => {});
  };
  const failRegen = async (message: string): Promise<ReviewOp> => {
    await closeRegen({ status: "error", processed: 0, error: message });
    return { ok: false, message };
  };
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
    if (error) return failRegen(error.message);
    const page = (data ?? []) as Array<Record<string, unknown>>;
    all.push(...page);
    if (regenRunId) {
      await advanceRun(
        regenRunId,
        { processed: all.length, failed: 0, current: `revisando ${formatNumber(all.length)}` },
      ).catch(() => {});
    }
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
  if (regenRunId) {
    await setRunTotal(regenRunId, Math.max(stale.length, 1)).catch(() => {});
  }
  if (stale.length === 0) {
    const message = scanTruncated
      ? "Revisados 5000 pendientes sin stale en la ventana; puede haber más fuera del CAP."
      : "Nada que regenerar: todo con criterios actuales.";
    await closeRegen({ status: "done", processed: all.length, summary: message });
    return { ok: true, message };
  }
  // División con refresh-retention-v1.ts: el refresh solo cierra señales
  // legacy SIN borrador vivo (las vivas las salta a propósito); este botón
  // cubre las CON borrador vivo (v1 + legacy con señal) y purga huérfanos
  // sin señal (no se pueden redactar ni enviar: el dispatcher los bloquea).
  // Solo se reabre lo `actioned`: lo ya cerrado/descartado no se reinicia,
  // así no se reinyecta lo que el refresh purgó.
  const withSignal = stale.filter((r) => String(r.signal_id ?? ""));
  const noSignalRows = stale.filter((r) => !String(r.signal_id ?? ""));
  const noSignalIds = noSignalRows.map((r) => String(r.id));
  const sids = [...new Set(withSignal.map((r) => String(r.signal_id)))];
  let v1Count = 0;
  let legacyCount = 0;
  if (sids.length > 0) {
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
      if (isV1SignalReason(reason)) v1Count += 1;
      else legacyCount += 1;
    }
  }
  const idsWithSignal = withSignal.map((r) => String(r.id));
  const idsAll = [...idsWithSignal, ...noSignalIds];
  if (idsAll.length === 0) {
    const message = "Nada que regenerar: todo con criterios actuales.";
    await closeRegen({ status: "done", processed: stale.length, summary: message });
    return { ok: true, message };
  }
  let deleted = 0;
  for (let i = 0; i < idsAll.length; i += 200) {
    const { error: delErr } = await db.from("proposed_actions").delete().in("id", idsAll.slice(i, i + 200));
    if (delErr) return failRegen(delErr.message);
    deleted += Math.min(200, idsAll.length - i);
    if (regenRunId) {
      await advanceRun(
        regenRunId,
        { processed: deleted, failed: 0, current: `borrando ${formatNumber(deleted)}/${formatNumber(idsAll.length)}` },
      ).catch(() => {});
    }
  }
  for (let i = 0; i < sids.length; i += 200) {
    await db.from("churn_signals").update({ status: "prioritized" }).in("id", sids.slice(i, i + 200)).eq("status", "actioned");
  }
  revalidatePath("/review");
  // Cierre del regenerate antes del copywriter (incompatibles en la matriz).
  await closeRegen({
    status: "done",
    processed: idsAll.length,
    summary: `${formatNumber(idsAll.length)} borrador(es) viejo(s) a regenerar`,
  });
  const started = await startCopywriterAction();
  const parts: string[] = [];
  if (idsWithSignal.length > 0) {
    const detail =
      v1Count + legacyCount === idsWithSignal.length && (v1Count > 0 || legacyCount > 0)
        ? ` (${formatNumber(v1Count)} v1 + ${formatNumber(legacyCount)} legacy)`
        : "";
    parts.push(`${formatNumber(idsWithSignal.length)} con señal a regenerar${detail}`);
  }
  if (noSignalIds.length > 0) {
    parts.push(`${formatNumber(noSignalIds.length)} huérfano(s) sin señal purgados (no se podían redactar ni enviar)`);
  }
  const extra = parts.length > 0 ? ` ${parts.join(" · ")}.` : "";
  return {
    ok: started.ok,
    message: `${formatNumber(idsAll.length)} borrador(es) viejo(s) procesados.${extra} ${started.message}`,
    run: started.run,
  };
}

/** Dispara una prospección manual desde el inbox (botón "Buscar más empresas").
 *  A diferencia del auto de la mañana, sí puede pasar el tope de 10: es
 *  intención explícita. Respeta el lock `prospect` (si ya corre, devuelve la
 *  corrida en curso en vez de duplicar). Patrón SSOT sync/enrich/copywriter:
 *  `startRun` + `after(work)`; la cinta avisa el progreso y el cierre.
 *  Con `marketId` (?market= del inbox) segmenta al mercado activo. */
export async function triggerProspectAction(marketId?: string | null): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local.", run: null };
  const conn = await readConnections();
  if (!conn.medusaUrl) return { ok: false, message: "Sin conexión a Medusa (Settings).", run: null };
  const storeId = await resolveStoreId(conn.medusaUrl);
  if (!storeId) return { ok: false, message: "Tienda sin sincronizar.", run: null };
  const { getIcp, prospectEligibility } = await import("@/lib/prospect");
  let scope: { countries: string[] | null; customerIds: string[] | null } | null = null;
  let marketLabel: string | null = null;
  try {
    const { resolveMarketScope, displayMarket } = await import("@/lib/markets");
    const resolved = await resolveMarketScope(storeId, marketId ?? null);
    if (marketId && !resolved?.market) {
      return { ok: false, message: "Market inválido: no existe en esta tienda.", run: null };
    }
    if (resolved?.market) {
      scope = { countries: resolved.countries, customerIds: resolved.customerIds };
      marketLabel = displayMarket(resolved.market);
    } else if (resolved) {
      scope = { countries: resolved.countries, customerIds: resolved.customerIds };
    }
  } catch (e) {
    if (marketId) return { ok: false, message: `Market inválido: ${e instanceof Error ? e.message : "no resolvible"}.`, run: null };
    // sin marketId y sin scope: global
  }
  try {
    const elig = await prospectEligibility(storeId);
    if (!elig.eligible) {
      const { PROSPECT_B2B_ONLY_HINT } = await import("@/lib/prospect-cap");
      return { ok: false, message: PROSPECT_B2B_ONLY_HINT, run: null };
    }
  } catch {
    // sigue al ICP: si tampoco hay ICP, el error honesto sale abajo
  }
  try {
    await getIcp(storeId, scope);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), run: null };
  }
  const conflict = await hasConflict(storeId, { kind: "prospect" }).catch(() => null);
  if (conflict) return { ok: false, message: busyMessage(conflict), run: conflict };
  const log = createLogger("review-actions");
  let runId: string | null = null;
  try {
    runId = await startRun(storeId, "prospect", "Prospección", 1);
  } catch (e) {
    log(`prospect manual startRun falló: ${e instanceof Error ? e.message : e}`);
    return { ok: false, message: "No se pudo iniciar la prospección.", run: null };
  }
  const { after } = await import("next/server");
  const { runProspect } = await import("@/lib/prospect");
  after(() => {
    runProspect(runId, storeId, { queries: 3, perQuery: 5, focus: null, scope, marketLabel }).catch((e) =>
      log(`prospect manual run error ${e instanceof Error ? e.message : "error"}`),
    );
  });
  revalidatePath("/review");
  const run = await getLatestRun(storeId).catch(() => null);
  return { ok: true, message: "Prospección iniciada.", run };
}
