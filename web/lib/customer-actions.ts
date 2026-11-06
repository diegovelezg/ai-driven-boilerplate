"use server";

import { revalidatePath } from "next/cache";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { MANUAL_FIELDS, type ManualField } from "@/lib/customers-db";

export interface UpdateCustomerState {
  ok: boolean;
  message: string;
}

const MAX_LEN: Record<ManualField, number> = {
  first_name: 120,
  last_name: 120,
  phone: 40,
  company_name: 160,
  customer_type: 10,
};

function clean(field: ManualField, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/\s+/g, " ");
  if (v.length > MAX_LEN[field]) return null;
  if (field === "customer_type") {
    // B2B-only: solo se acepta B2B (legacy B2C se rechaza).
    return v.toUpperCase() === "B2B" ? "B2B" : null;
  }
  return v;
}

/**
 * Guarda overrides manuales (edición inline/modal). `id` = dbId (uuid de la
 * fila, no el external_id). No toca columnas base:
 * base sin perder lo editado.
 * Semántica: valor vacío = revertir al valor base (elimina el override).
 * `reverts` es azúcar explícito para lo mismo (botones de revertir).
 */
export async function updateCustomerAction(input: {
  id: string;
  values?: Partial<Record<ManualField, string>>;
  reverts?: ManualField[];
}): Promise<UpdateCustomerState> {
  if (!isSupabaseConfigured()) {
    return { ok: false, message: "Supabase no configurado." };
  }
  if (!input.id) return { ok: false, message: "Falta id." };

  const patch: Record<string, string> = {};
  for (const k of MANUAL_FIELDS) {
    const raw = input.values?.[k];
    if (raw === undefined) continue;
    const v = clean(k, raw);
    if (v === null) return { ok: false, message: `Valor inválido para ${k}.` };
    patch[k] = v;
  }
  const reverts = (input.reverts ?? []).filter((k) => MANUAL_FIELDS.includes(k));
  if (Object.keys(patch).length === 0 && reverts.length === 0) {
    return { ok: false, message: "Sin cambios." };
  }

  try {
    const db = getSupabase();
    const { data: row, error: readErr } = await db
      .from("customers")
      .select("manual_edits")
      .eq("id", input.id)
      .maybeSingle();
    if (readErr || !row) return { ok: false, message: "Customer no encontrado." };
    const next = { ...((row.manual_edits as Record<string, string> | null) ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") delete next[k];
      else next[k] = v;
    }
    for (const k of reverts) delete next[k];
    const { error: writeErr } = await db
      .from("customers")
      .update({ manual_edits: next })
      .eq("id", input.id);
    if (writeErr) return { ok: false, message: `DB write: ${writeErr.message}` };
    revalidatePath("/customers");
    return { ok: true, message: "Guardado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
