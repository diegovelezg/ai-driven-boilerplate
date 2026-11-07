"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { isCompanyKind, normalizeCompany, normalizeContact, type CompanyKind } from "@/lib/crm";
import { normalizeCommissionPct } from "@/lib/agency-commission";
import { resolveActor } from "@/lib/actor";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";

export interface CrmState {
  ok: boolean;
  message: string;
}

async function resolveTenantStore(): Promise<{ storeId: string } | { error: string }> {
  const storeId = await resolveActiveStoreId();
  if (!storeId) return { error: "Sin tienda." };
  if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
    return { error: "Sin acceso a esta tienda." };
  }
  return { storeId };
}

export async function createCompanyAction(form: FormData): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const kindRaw = String(form.get("kind") ?? "").trim();
  if (!isCompanyKind(kindRaw)) return { ok: false, message: "Tipo requerido: agencia, anunciante o proveedor." };
  const kind: CompanyKind = kindRaw;
  const commissionRaw = form.get("agency_commission_pct");
  const hasCommissionInput =
    commissionRaw !== null && String(commissionRaw).trim() !== "";
  let commissionPct: number | null = null;
  if (hasCommissionInput) {
    const parsed = normalizeCommissionPct(String(commissionRaw).trim());
    if (parsed === null) return { ok: false, message: "Comisión inválida (0-100)." };
    commissionPct = parsed;
  }
  // La comisión solo aplica a agencias y solo la gestionan owner/admin.
  if (hasCommissionInput && kind !== "agencia") {
    return { ok: false, message: "Solo las agencias llevan comisión." };
  }
  if (hasCommissionInput) {
    const { requireMinRole } = await import("@/lib/tenant");
    const allowed = await requireMinRole(t.storeId, "admin").catch(() => false);
    if (allowed === false) return { ok: false, message: "Requiere rol admin o propietario." };
  }
  const parsed = normalizeCompany({
    name: String(form.get("name") ?? ""),
    kind,
    tax_id: String(form.get("tax_id") ?? "") || null,
    domain: String(form.get("domain") ?? "") || null,
    email: String(form.get("email") ?? "") || null,
    phone: String(form.get("phone") ?? "") || null,
    city: String(form.get("city") ?? "") || null,
    country: String(form.get("country") ?? "") || null,
    notes: String(form.get("notes") ?? "") || null,
    external_ref: String(form.get("external_ref") ?? "") || null,
  });
  if (!parsed.ok) return { ok: false, message: parsed.error };
  try {
    const db = getSupabase();
    const actor = await resolveActor();
    const { data, error } = await db
      .from("companies")
      .insert({
        store_id: t.storeId,
        ...parsed.value,
        ...(hasCommissionInput ? { agency_commission_pct: commissionPct } : {}),
        created_by: actor,
        updated_by: actor,
      })
      .select("id")
      .maybeSingle();
    if (error || !data) return { ok: false, message: `DB write: ${error?.message ?? "sin id"}` };
    revalidatePath("/companies");
    return { ok: true, message: "Empresa creada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export async function setCompanyKindAction(input: { companyId: string; kind: CompanyKind }): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  if (!isCompanyKind(input.kind)) return { ok: false, message: "Tipo requerido: agencia, anunciante o proveedor." };
  try {
    const db = getSupabase();
    const { error } = await db
      .from("companies")
      .update({ kind: input.kind, updated_by: await resolveActor(), updated_at: new Date().toISOString() })
      .eq("store_id", t.storeId)
      .eq("id", input.companyId);
    if (error) return { ok: false, message: `DB write: ${error.message}` };
    revalidatePath("/companies");
    revalidatePath(`/companies/${input.companyId}`);
    return { ok: true, message: "Tipo actualizado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/**
 * Comisión de agencia (% sobre bruto, default a nivel empresa).
 * Solo agencias y solo owner/admin (FEATURE agency.commission.edit).
 * `pct` null/"" = sin acuerdo (NULL = 0 efectivo).
 */
export async function setAgencyCommissionAction(input: {
  companyId: string;
  pct: number | string | null;
}): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const { requireMinRole } = await import("@/lib/tenant");
  const allowed = await requireMinRole(t.storeId, "admin").catch(() => false);
  if (allowed === false) return { ok: false, message: "Requiere rol admin o propietario." };
  const pct = normalizeCommissionPct(input.pct);
  // Distingue "limpiar" (null/"") de valor inválido (p. ej. 150 o texto).
  const raw = input.pct;
  const wantsClear = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
  if (!wantsClear && pct === null) return { ok: false, message: "Comisión inválida (0-100)." };
  try {
    const db = getSupabase();
    const { data: co } = await db
      .from("companies")
      .select("id,kind")
      .eq("store_id", t.storeId)
      .eq("id", input.companyId)
      .maybeSingle();
    if (!co) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    if ((co as Record<string, unknown>).kind !== "agencia") {
      return { ok: false, message: "Solo las agencias llevan comisión." };
    }
    const { error } = await db
      .from("companies")
      .update({ agency_commission_pct: pct, updated_by: await resolveActor(), updated_at: new Date().toISOString() })
      .eq("store_id", t.storeId)
      .eq("id", input.companyId);
    if (error) return { ok: false, message: `DB write: ${error.message}` };
    revalidatePath("/companies");
    revalidatePath(`/companies/${input.companyId}`);
    return { ok: true, message: pct === null ? "Comisión eliminada." : "Comisión actualizada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export async function createContactAction(form: FormData): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const companyId = String(form.get("company_id") ?? "");
  if (!companyId) return { ok: false, message: "Falta empresa." };
  const parsed = normalizeContact({
    company_id: companyId,
    first_name: String(form.get("first_name") ?? "") || null,
    last_name: String(form.get("last_name") ?? "") || null,
    email: String(form.get("email") ?? "") || null,
    phone: String(form.get("phone") ?? "") || null,
    job_title: String(form.get("job_title") ?? "") || null,
    is_primary: form.get("is_primary") === "on",
    notes: undefined,
  });
  if (!parsed.ok) return { ok: false, message: parsed.error };
  try {
    const db = getSupabase();
    // La empresa debe ser del mismo tenant.
    const { data: co } = await db.from("companies").select("id").eq("store_id", t.storeId).eq("id", companyId).maybeSingle();
    if (!co) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    // Dedupe por empresa: mismo email o teléfono → ya existe (idempotente con import).
    if (parsed.value.email) {
      const { data: dupe } = await db
        .from("contacts")
        .select("id")
        .eq("company_id", companyId)
        .ilike("email", parsed.value.email)
        .limit(1)
        .maybeSingle();
      if (dupe) return { ok: true, message: "Contacto ya existía." };
    }
    if (parsed.value.phone) {
      const { data: dupe } = await db
        .from("contacts")
        .select("id")
        .eq("company_id", companyId)
        .eq("phone", parsed.value.phone)
        .limit(1)
        .maybeSingle();
      if (dupe) return { ok: true, message: "Contacto ya existía." };
    }
    const actor = await resolveActor();
    if (parsed.value.is_primary) {
      await db.from("contacts").update({ is_primary: false, updated_by: actor, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("is_primary", true);
    }
    const { error } = await db.from("contacts").insert({ store_id: t.storeId, ...parsed.value, created_by: actor, updated_by: actor });
    if (error) return { ok: false, message: `DB write: ${error.message}` };
    revalidatePath(`/companies/${companyId}`);
    revalidatePath("/companies");
    revalidatePath("/contacts");
    return { ok: true, message: "Contacto agregado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

// Variante para `useActionState` en /companies/new: en éxito redirige
// al listado; en error devuelve el mensaje sin navegar.
export async function createCompanyRedirectAction(_prev: CrmState, form: FormData): Promise<CrmState> {
  const res = await createCompanyAction(form);
  if (res.ok) redirect("/companies");
  return res;
}
// `(formData: FormData) => void | Promise<void>`, y el `action` debe ser
// una referencia serializable a un Server Action (no un closure inline:
// eso falla con "Functions cannot be passed directly to Client Components").
export async function createCompanyFormAction(form: FormData): Promise<void> {
  void await createCompanyAction(form);
}

export async function createContactFormAction(form: FormData): Promise<void> {
  void await createContactAction(form);
}
