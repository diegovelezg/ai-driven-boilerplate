// Default de proveedor por empresa logueada (SSOT para Inventario y Ocupación).
// Regla: explícito manda (?proveedor=uuid | own | all). Sin param, default =
// empresa de la cuenta (email sesión → contacto → compañía) > empresa
// configurada de la tienda (sys_stores.home_company_id) > red propia (casa,
// kind NULL → own) > todos. Solo aplican proveedor (su id) y casa (own);
// otros kinds no filtran. Nunca inventa: sin match → todos.
// Solo server (service_role vía lib/supabase): nunca importar en cliente.
import "server-only";

import { getSupabase } from "@/lib/supabase";
import { resolveActor } from "@/lib/actor";

export type SupplierDefault = {
  /** Valor efectivo: uuid | "own" | "all". */
  supplierValue: string;
  /** Default resuelto cuando el param está ausente (para URLs sleek y clear). */
  defaultSupplierValue: string;
  /** UUID o null (own/all → null). */
  supplierId: string | null;
  ownOnly: boolean;
  casaName: string | null;
};

/** `explicit`: null = param ausente/vacío → resolver default. "all"/"own"/uuid = explícito. */
export async function resolveSupplierDefault(
  storeId: string,
  explicit: string | null,
): Promise<SupplierDefault> {
  const db = getSupabase();
  // Empresa de la cuenta logueada: email de sesión → contacto → compañía.
  // (Sin match: se degrada a casa → todos, nunca inventa.)
  const actorEmail = (await resolveActor().catch(() => null))?.trim() || null;
  let myCompany: { id: string; kind: string | null } | null = null;
  if (actorEmail) {
    const variants = [...new Set([actorEmail, actorEmail.toLowerCase()])];
    const { data: contacts } = await db
      .from("crm_contacts")
      .select("company_id,email")
      .eq("store_id", storeId)
      .in("email", variants)
      .limit(5);
    const hit = ((contacts ?? []) as Array<Record<string, unknown>>).find(
      (c) =>
        typeof c.email === "string" &&
        c.email.toLowerCase() === actorEmail.toLowerCase() &&
        typeof c.company_id === "string" &&
        c.company_id !== "",
    );
    if (hit) {
      const { data: co } = await db
        .from("crm_companies")
        .select("id,kind")
        .eq("store_id", storeId)
        .eq("id", String(hit.company_id))
        .maybeSingle();
      const row = co as Record<string, unknown> | null;
      if (row) myCompany = { id: String(row.id), kind: (row.kind as string | null) ?? null };
    }
  }
  const { data: casa } = await db
    .from("crm_companies")
    .select("id,name")
    .eq("store_id", storeId)
    .is("kind", null)
    .limit(1)
    .maybeSingle();
  const casaName =
    typeof (casa as Record<string, unknown> | null)?.name === "string"
      ? String((casa as Record<string, unknown>).name)
      : null;
  // Vínculo tienda→empresa propia: dato configurado (sys_stores.home_company_id),
  // no heurística. Si la migración aún no corrió, el select falla y data es
  // null → se degrada a casa → todos.
  let homeCompany: { id: string; kind: string | null } | null = null;
  {
    const { data: storeRow } = await db
      .from("sys_stores")
      .select("home_company_id")
      .eq("id", storeId)
      .maybeSingle();
    const homeId = (storeRow as Record<string, unknown> | null)?.home_company_id;
    if (typeof homeId === "string" && homeId !== "") {
      const { data: hc } = await db
        .from("crm_companies")
        .select("id,kind")
        .eq("store_id", storeId)
        .eq("id", homeId)
        .maybeSingle();
      const hrow = hc as Record<string, unknown> | null;
      if (hrow) homeCompany = { id: String(hrow.id), kind: (hrow.kind as string | null) ?? null };
    }
  }
  const pick = (co: { id: string; kind: string | null } | null): string | null =>
    !co ? null : co.kind === "proveedor" ? co.id : co.kind === null ? "own" : null;
  const defaultSupplierValue =
    pick(myCompany) ?? pick(homeCompany) ?? (casaName ? "own" : "all");
  const raw = (explicit ?? "").trim().toLowerCase();
  const supplierValue = raw !== "" ? raw : defaultSupplierValue;
  const supplierId =
    supplierValue !== "own" && supplierValue !== "all" ? supplierValue : null;
  return {
    supplierValue,
    defaultSupplierValue,
    supplierId,
    ownOnly: supplierValue === "own",
    casaName,
  };
}
