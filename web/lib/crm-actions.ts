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
    if (parsed === null) return { ok: false, message: "Comisión inválida (entero 0-100)." };
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
    address: String(form.get("address") ?? "") || null,
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
      .from("crm_companies")
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
  const { requireMinRole } = await import("@/lib/tenant");
  const allowed = await requireMinRole(t.storeId, "seller").catch(() => false);
  if (allowed === false) return { ok: false, message: "Requiere rol vendedor o superior." };
  if (!isCompanyKind(input.kind)) return { ok: false, message: "Tipo requerido: agencia, anunciante o proveedor." };
  try {
    const db = getSupabase();
    const { error } = await db
      .from("crm_companies")
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
 * Edición inline de la ficha (drawer): identidad y contacto.
 * El tipo se edita con setCompanyKindAction; la comisión con su propio action.
 * Requiere rol vendedor o superior (FEATURE crm.edit).
 */
export async function updateCompanyAction(input: {
  companyId: string;
  patch: {
    name?: string | null;
    tax_id?: string | null;
    domain?: string | null;
    email?: string | null;
    phone?: string | null;
    city?: string | null;
    country?: string | null;
    address?: string | null;
  };
}): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const { requireMinRole } = await import("@/lib/tenant");
  const allowed = await requireMinRole(t.storeId, "seller").catch(() => false);
  if (allowed === false) return { ok: false, message: "Requiere rol vendedor o superior." };
  const companyId = String(input.companyId ?? "").trim();
  if (!companyId) return { ok: false, message: "Falta empresa." };
  try {
    const db = getSupabase();
    const { data: existing, error: rerr } = await db
      .from("crm_companies")
      .select("id,name,kind,tax_id,domain,email,phone,address,city,country")
      .eq("store_id", t.storeId)
      .eq("id", companyId)
      .maybeSingle();
    if (rerr || !existing) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    const row = existing as Record<string, unknown>;
    if (!isCompanyKind(row.kind)) return { ok: false, message: "Define el tipo de empresa primero." };
    const p = (input.patch ?? {}) as Record<string, string | null | undefined>;
    const val = (k: string, fb: unknown) => (p[k] !== undefined ? p[k] : (fb as string | null));
    const parsed = normalizeCompany({
      name: String(val("name", row.name) ?? ""),
      kind: row.kind,
      tax_id: val("tax_id", row.tax_id),
      domain: val("domain", row.domain),
      email: val("email", row.email),
      phone: val("phone", row.phone),
      address: val("address", row.address),
      city: val("city", row.city),
      country: val("country", row.country),
    });
    if (!parsed.ok) return { ok: false, message: parsed.error };
    const actor = await resolveActor();
    const { error } = await db
      .from("crm_companies")
      .update({
        name: parsed.value.name,
        tax_id: parsed.value.tax_id,
        domain: parsed.value.domain,
        email: parsed.value.email,
        phone: parsed.value.phone,
        address: parsed.value.address,
        city: parsed.value.city,
        country: parsed.value.country,
        updated_by: actor,
        updated_at: new Date().toISOString(),
      })
      .eq("store_id", t.storeId)
      .eq("id", companyId);
    if (error) return { ok: false, message: `DB write: ${error.message}` };
    revalidatePath("/companies");
    revalidatePath(`/companies/${companyId}`);
    return { ok: true, message: "Empresa actualizada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/**
 * Edición inline del contacto (drawer). Requiere rol vendedor o superior.
 * Si se marca principal, desmarca a los demás de la misma empresa (1 principal).
 */
export async function updateContactAction(input: {
  contactId: string;
  patch: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
    job_title?: string | null;
    is_primary?: boolean;
  };
}): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const { requireMinRole } = await import("@/lib/tenant");
  const allowed = await requireMinRole(t.storeId, "seller").catch(() => false);
  if (allowed === false) return { ok: false, message: "Requiere rol vendedor o superior." };
  const contactId = String(input.contactId ?? "").trim();
  if (!contactId) return { ok: false, message: "Falta contacto." };
  try {
    const db = getSupabase();
    const { data: existing, error: rerr } = await db
      .from("crm_contacts")
      .select("id,company_id,first_name,last_name,email,phone,job_title,is_primary")
      .eq("store_id", t.storeId)
      .eq("id", contactId)
      .maybeSingle();
    if (rerr || !existing) return { ok: false, message: "Contacto no encontrado en esta tienda." };
    const row = existing as Record<string, unknown>;
    const p = (input.patch ?? {}) as Record<string, string | boolean | null | undefined>;
    const sVal = (k: string, fb: unknown) => (p[k] !== undefined ? (p[k] as string | null) : (fb as string | null));
    const parsed = normalizeContact({
      company_id: typeof row.company_id === "string" ? row.company_id : null,
      first_name: sVal("first_name", row.first_name),
      last_name: sVal("last_name", row.last_name),
      email: sVal("email", row.email),
      phone: sVal("phone", row.phone),
      job_title: sVal("job_title", row.job_title),
      is_primary: p.is_primary !== undefined ? p.is_primary === true : row.is_primary === true,
    });
    if (!parsed.ok) return { ok: false, message: parsed.error };
    const actor = await resolveActor();
    const now = new Date().toISOString();
    if (parsed.value.is_primary && typeof row.company_id === "string" && row.company_id) {
      await db
        .from("crm_contacts")
        .update({ is_primary: false, updated_by: actor, updated_at: now })
        .eq("store_id", t.storeId)
        .eq("company_id", row.company_id)
        .eq("is_primary", true)
        .neq("id", contactId);
    }
    const { error } = await db
      .from("crm_contacts")
      .update({ ...parsed.value, updated_by: actor, updated_at: now })
      .eq("store_id", t.storeId)
      .eq("id", contactId);
    if (error) return { ok: false, message: `DB write: ${error.message}` };
    revalidatePath("/contacts");
    revalidatePath("/companies");
    return { ok: true, message: "Contacto actualizado." };
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
  // Distingue "limpiar" (null/"") de valor inválido (p. ej. 150, 12.5 o texto).
  const raw = input.pct;
  const wantsClear = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
  if (!wantsClear && pct === null) return { ok: false, message: "Comisión inválida (entero 0-100)." };
  try {
    const db = getSupabase();
    const { data: co } = await db
      .from("crm_companies")
      .select("id,kind")
      .eq("store_id", t.storeId)
      .eq("id", input.companyId)
      .maybeSingle();
    if (!co) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    if ((co as Record<string, unknown>).kind !== "agencia") {
      return { ok: false, message: "Solo las agencias llevan comisión." };
    }
    const { error } = await db
      .from("crm_companies")
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
  const { requireMinRole } = await import("@/lib/tenant");
  const allowed = await requireMinRole(t.storeId, "seller").catch(() => false);
  if (allowed === false) return { ok: false, message: "Requiere rol vendedor o superior." };
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
    const { data: co } = await db.from("crm_companies").select("id").eq("store_id", t.storeId).eq("id", companyId).maybeSingle();
    if (!co) return { ok: false, message: "Empresa no encontrada en esta tienda." };
    // Dedupe por empresa: mismo email o teléfono → ya existe (idempotente con import).
    if (parsed.value.email) {
      const { data: dupe } = await db
        .from("crm_contacts")
        .select("id")
        .eq("company_id", companyId)
        .ilike("email", parsed.value.email)
        .limit(1)
        .maybeSingle();
      if (dupe) return { ok: true, message: "Contacto ya existía." };
    }
    if (parsed.value.phone) {
      const { data: dupe } = await db
        .from("crm_contacts")
        .select("id")
        .eq("company_id", companyId)
        .eq("phone", parsed.value.phone)
        .limit(1)
        .maybeSingle();
      if (dupe) return { ok: true, message: "Contacto ya existía." };
    }
    const actor = await resolveActor();
    if (parsed.value.is_primary) {
      await db.from("crm_contacts").update({ is_primary: false, updated_by: actor, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("is_primary", true);
    }
    const { error } = await db.from("crm_contacts").insert({ store_id: t.storeId, ...parsed.value, created_by: actor, updated_by: actor });
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
// Variante para `useActionState` en /contacts/new: en éxito redirige
// al listado; en error devuelve el mensaje sin navegar.
export async function createContactRedirectAction(_prev: CrmState, form: FormData): Promise<CrmState> {
  const res = await createContactAction(form);
  if (res.ok) redirect("/contacts");
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

/**
 * Fusiona contactos duplicados: el sobreviviente conserva su empresa y
 * absorbe datos faltantes; las campañas que apuntaban a los eliminados
 * se re-apuntan; `is_primary` se preserva (si algún eliminado era principal
 * y el sobreviviente no, este pasa a serlo, liberando al anterior de su
 * empresa para respetar 1 principal por empresa).
 */
export async function mergeContactsAction(input: { survivorId: string; loserIds: string[] }): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const loserIds = [...new Set((input.loserIds ?? []).filter((id) => id && id !== input.survivorId))];
  if (!input.survivorId || loserIds.length === 0) return { ok: false, message: "Elige el contacto que queda y al menos uno para fusionar." };
  try {
    const db = getSupabase();
    const ids = [input.survivorId, ...loserIds];
    const { data, error } = await db
      .from("crm_contacts")
      .select("id,company_id,first_name,last_name,email,phone,job_title,is_primary")
      .eq("store_id", t.storeId)
      .in("id", ids);
    if (error) throw new Error(`DB read: ${error.message}`);
    const found = new Map(((data ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.id), c]));
    const survivor = found.get(input.survivorId);
    if (!survivor) return { ok: false, message: "El contacto que queda ya no existe." };
    const losers = loserIds.map((id) => found.get(id)).filter((c): c is Record<string, unknown> => !!c);
    if (losers.length === 0) return { ok: false, message: "Los contactos a fusionar ya no existen." };
    const actor = await resolveActor();
    const now = new Date().toISOString();
    // Rellena huecos del sobreviviente con datos de los eliminados (en orden).
    // Se aplica DESPUÉS de borrar: si el sobreviviente absorbe el email o
    // teléfono de un eliminado de su misma empresa, el update no choca con
    // los unique (company_id, lower(email)) / (company_id, phone).
    const patch: Record<string, unknown> = {};
    for (const f of ["first_name", "last_name", "email", "phone", "job_title"] as const) {
      if (survivor[f] == null || String(survivor[f]).trim() === "") {
        const donor = losers.find((l) => l[f] != null && String(l[f]).trim() !== "");
        if (donor) patch[f] = donor[f];
      }
    }
    const survivorCompany = (survivor.company_id as string | null) ?? null;
    const promote = survivor.is_primary !== true && losers.some((l) => l.is_primary === true);
    if (promote) {
      patch.is_primary = true;
      // Respeta 1 principal por empresa (unique contacts_company_primary_uidx).
      if (survivorCompany) {
        const { error: demoteErr } = await db
          .from("crm_contacts")
          .update({ is_primary: false, updated_by: actor })
          .eq("store_id", t.storeId)
          .eq("company_id", survivorCompany)
          .eq("is_primary", true)
          .neq("id", input.survivorId);
        if (demoteErr) throw new Error(`DB write: ${demoteErr.message}`);
      }
    }
    // Re-apunta campañas (única FK a contacts) ANTES de borrar: el delete
    // pondría primary_contact_id en NULL y se perdería el vínculo.
    const { error: campErr } = await db
      .from("io_campaigns")
      .update({ primary_contact_id: input.survivorId })
      .eq("store_id", t.storeId)
      .in("primary_contact_id", loserIds);
    if (campErr) throw new Error(`DB write: ${campErr.message}`);
    const { error: delErr } = await db.from("crm_contacts").delete().eq("store_id", t.storeId).in("id", loserIds);
    if (delErr) throw new Error(`DB write: ${delErr.message}`);
    if (Object.keys(patch).length > 0) {
      const { error: upErr } = await db
        .from("crm_contacts")
        .update({ ...patch, updated_by: actor, updated_at: now })
        .eq("store_id", t.storeId)
        .eq("id", input.survivorId);
      if (upErr) throw new Error(`DB write: ${upErr.message}`);
    }
    revalidatePath("/contacts");
    revalidatePath("/contacts/duplicates");
    return { ok: true, message: `Fusionados ${losers.length + 1} contactos en uno.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
