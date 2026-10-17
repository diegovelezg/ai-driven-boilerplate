"use server";

import { revalidatePath } from "next/cache";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { COPYWRITER_GEN, draftSingleSignal } from "@/lib/copywriter";
import { startCopywriterAction } from "@/lib/retention-actions";

export interface ReviewOp {
  ok: boolean;
  message: string;
}

async function setActionStatus(id: string, status: "approved" | "rejected"): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const { error } = await getSupabase()
    .from("proposed_actions")
    .update({ status })
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

/** Redacta un borrador para UNA señal (CTA "Redactar" en "Tus 5 de hoy"). */
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
  const r = await draftSingleSignal(storeId, signalId);
  if (r.ok) {
    revalidatePath("/");
    revalidatePath("/review");
  }
  return r;
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
  const { data, error } = await db
    .from("proposed_actions")
    .select("id,signal_id,evidence_json")
    .eq("store_id", storeId)
    .eq("status", "pending_review")
    .limit(500);
  if (error) return { ok: false, message: error.message };
  const stale = ((data ?? []) as Array<Record<string, unknown>>).filter((r) =>
    isStaleDraft((r.evidence_json as Record<string, unknown> | null) ?? null),
  );
  if (stale.length === 0) return { ok: true, message: "Nada que regenerar: todo con criterios actuales." };
  const ids = stale.map((r) => String(r.id));
  const signalIds = [...new Set(stale.map((r) => String(r.signal_id ?? "")).filter(Boolean))];
  const { error: delErr } = await db.from("proposed_actions").delete().in("id", ids);
  if (delErr) return { ok: false, message: delErr.message };
  if (signalIds.length > 0) {
    await db.from("churn_signals").update({ status: "prioritized" }).in("id", signalIds).eq("status", "actioned");
  }
  revalidatePath("/review");
  const started = await startCopywriterAction();
  return {
    ok: started.ok,
    message: `${stale.length} borrador(es) viejo(s) a regenerar. ${started.message}`,
  };
}
