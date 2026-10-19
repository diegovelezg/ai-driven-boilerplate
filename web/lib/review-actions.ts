"use server";

import { revalidatePath } from "next/cache";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { readConnections } from "@/lib/store";
import { resolveStoreId } from "@/lib/customers-db";
import { COPYWRITER_GEN, draftSingleSignal } from "@/lib/copywriter";
import { advanceRun, finishRun, startRun } from "@/lib/background";
import { runSingleWithAudit, type SingleFinish } from "@/lib/single-audit";
import { createLogger } from "@/lib/log";
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

/** Revoca una aprobación aún no enviada (approved → rejected, solo si
 *  dispatched_at es null). Sin esto, lo aprobado es invisible en Review
 *  (solo lista pending) y el dispatcher lo enviaría sin remedio. */
export async function revokeApprovalAction(id: string): Promise<ReviewOp> {
  if (!isSupabaseConfigured()) return { ok: false, message: "Falta Supabase en .env.local." };
  const { data, error } = await getSupabase()
    .from("proposed_actions")
    .update({ status: "rejected" })
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
 *  `evidence_json`. Sin `scope_id` aún (Fase 0 lo agrega); el `current`
 *  lleva el `signalId` como trazabilidad mínima. El cierre garantizado
 *  vive en `runSingleWithAudit` (P0: ni un throw deja `running` eterno). */
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
  const r = await runSingleWithAudit({
    start: async () => {
      try {
        return await startRun(storeId, "copywriter_single", "Redacción individual", 1);
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
  const all: Array<Record<string, unknown>> = [];
  let scanTruncated = false;
  for (let off = 0; ; off += 500) {
    const { data, error } = await db
      .from("proposed_actions")
      .select("id,signal_id,evidence_json")
      .eq("store_id", storeId)
      .eq("status", "pending_review")
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
  };
}
