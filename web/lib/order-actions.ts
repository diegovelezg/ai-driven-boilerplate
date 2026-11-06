"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import type { CrmState } from "@/lib/crm-actions";

async function resolveTenantStore(): Promise<{ storeId: string } | { error: string }> {
  const storeId = await resolveActiveStoreId();
  if (!storeId) return { error: "Sin tienda." };
  if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
    return { error: "Sin acceso a esta tienda." };
  }
  return { storeId };
}

/** Número autogenerado vía función SQL (contador atómico por tienda+año). */
async function mintIoNumber(
  db: ReturnType<typeof getSupabase>,
  storeId: string,
): Promise<string> {
  const { data, error } = await db.rpc("mint_io_number", { p_store: storeId });
  if (error || typeof data !== "string" || !data) {
    throw new Error(`No se pudo numerar la orden: ${error?.message ?? "sin número"}`);
  }
  return data;
}

/** Crea la OI en borrador con número autogenerado (etapa Firmada).
 *  Líneas y OM llegan después. */
export async function createOrderAction(form: FormData): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const company = String(form.get("company_id") ?? "").trim() || null;
  if (!company) return { ok: false, message: "Empresa requerida." };
  const brand = String(form.get("brand") ?? "").trim() || null;
  const payment_terms = String(form.get("payment_terms") ?? "").trim() || null;
  // Líneas: mismo largo en los 5 arreglos (una fila por pantalla).
  const screens = form.getAll("screen_id").map((v) => String(v).trim());
  const inis = form.getAll("line_starts_at").map((v) => String(v).trim());
  const fins = form.getAll("line_ends_at").map((v) => String(v).trim());
  const totals = form.getAll("line_total").map((v) => String(v).trim().replace(",", "."));
  const dias = form.getAll("line_cant_dias").map((v) => String(v).trim().replace(",", "."));
  if (screens.length === 0 || screens.some((s) => !s)) {
    return { ok: false, message: "Cada línea necesita su pantalla." };
  }
  if (![inis.length, fins.length, totals.length, dias.length].every((n) => n === screens.length)) {
    return { ok: false, message: "Líneas incompletas." };
  }
  const parsedLines: Array<{ screen: string; starts: string; ends: string; total: number; cant_dias: number | null }> = [];
  const nextDayLima = (d: string): string => {
    const [y, m, day] = d.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, day) + 86_400_000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T00:00:00-05:00`;
  };
  for (let i = 0; i < screens.length; i++) {
    if (!inis[i] || !fins[i]) return { ok: false, message: `Línea ${i + 1}: periodo requerido.` };
    if (fins[i] < inis[i]) return { ok: false, message: `Línea ${i + 1}: fin anterior al inicio.` };
    const total = Number(totals[i]);
    if (!Number.isFinite(total) || total <= 0) return { ok: false, message: `Línea ${i + 1}: total inválido.` };
    const cant = dias[i] ? Number(dias[i]) : NaN;
    parsedLines.push({
      screen: screens[i],
      starts: `${inis[i]}T00:00:00-05:00`,
      // Rango '[)': fin exclusivo = día siguiente a la fecha fin de la OI.
      ends: nextDayLima(fins[i]),
      total,
      cant_dias: Number.isFinite(cant) && cant > 0 ? cant : null,
    });
  }
  try {
    const db = getSupabase();
    // Las contrapartes deben pertenecer al tenant.
    const { data: cos, error: coerr } = await db
      .from("companies")
      .select("id,kind")
      .eq("store_id", t.storeId)
      .eq("id", company)
      .maybeSingle();
    if (coerr) return { ok: false, message: `DB read: ${coerr.message}` };
    if (!cos) return { ok: false, message: "Empresa fuera de tu tienda." };
    // El tipo manda: agencia → factura ella y el anunciante queda en la marca;
    // anunciante → anuncia y paga directo.
    const isAgency = (cos as Record<string, unknown>).kind === "agencia";
    const billing = company;
    const advertiser = isAgency ? null : company;
    const base = {
      store_id: t.storeId,
      advertiser_company_id: advertiser,
      billing_company_id: billing,
      brand,
      status: "draft",
      // Periodo de la OI = envolvente de sus líneas (fechas inclusivas).
      starts_at: inis.reduce((a, b) => (a < b ? a : b)),
      ends_at: fins.reduce((a, b) => (a > b ? a : b)),
      payment_terms,
    };
    // Valida pantallas del tenant antes de insertar.
    const { data: scs, error: scerr } = await db
      .from("screens")
      .select("id")
      .eq("store_id", t.storeId)
      .in("id", [...new Set(parsedLines.map((l) => l.screen))]);
    if (scerr) return { ok: false, message: `DB read: ${scerr.message}` };
    if ((scs ?? []).length !== new Set(parsedLines.map((l) => l.screen)).size) {
      return { ok: false, message: "Pantalla fuera de tu inventario." };
    }
    // Reintento único ante colisión de numeración (carrera entre dos creaciones).
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data: io, error } = await db
        .from("insertion_orders")
        .insert({ ...base, io_number: await mintIoNumber(db, t.storeId) })
        .select("id")
        .maybeSingle();
      if (error) {
        if (error.code !== "23505" || attempt === 1) {
          return { ok: false, message: `DB write: ${error.message}` };
        }
        continue;
      }
      const ioId = String((io as Record<string, unknown>).id);
      // slot_id null: el slot se asigna al confirmar la orden (etapa Autorizada).
      const { error: lerr } = await db.from("insertion_order_lines").insert(
        parsedLines.map((l) => ({
          store_id: t.storeId,
          io_id: ioId,
          screen_id: l.screen,
          slot_id: null,
          starts_at: l.starts,
          ends_at: l.ends,
          rate_minor: Math.round(l.total * 100),
          tarifa_regular_minor: null,
          cant_meses: null,
          cant_dias: l.cant_dias,
          notes: null,
        })),
      );
      if (lerr) {
        await db.from("insertion_orders").delete().eq("id", ioId);
        return { ok: false, message: `DB write líneas: ${lerr.message}` };
      }
      revalidatePath("/ordenes");
      return { ok: true, message: "Orden creada." };
    }
    return { ok: false, message: "Colisión de numeración, reintenta." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export async function createOrderRedirectAction(_prev: CrmState, form: FormData): Promise<CrmState> {
  const res = await createOrderAction(form);
  if (res.ok) redirect("/ordenes");
  return res;
}
