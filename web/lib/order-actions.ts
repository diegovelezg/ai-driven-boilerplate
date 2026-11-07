"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { getScreenConflicts, getScreenOccupancy, type ScreenConflict } from "@/lib/availability";
import { resolveActor } from "@/lib/actor";
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
  // Condición de pago en días (0 = Contado). Fuente numérica para vencimientos:
  // due_date = issue_date + N días. El texto es solo display (paymentTermsLabel).
  const termsRaw = String(form.get("payment_terms_days") ?? "").trim();
  const payment_terms_days = termsRaw === "" ? null : Number(termsRaw);
  if (payment_terms_days !== null && (!Number.isInteger(payment_terms_days) || payment_terms_days < 0)) {
    return { ok: false, message: "Condición de pago inválida." };
  }
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
    // Anti-sobreventa en la venta: el cliente no es la garantía (carrera entre
    // dos vendedores). Si una pantalla se ocupó después del chequeo UI, se
    // rechaza aquí con mensaje amable (el trigger es la última línea).
    const conflicts = await getScreenConflicts(
      t.storeId,
      inis.reduce((a, b) => (a < b ? a : b)),
      fins.reduce((a, b) => (a > b ? a : b)),
    );
    const hit = conflicts.find((c) => screens.includes(c.screen_id));
    if (hit) {
      const who = [hit.io_number, hit.brand].filter(Boolean).join(" · ");
      return { ok: false, message: `Pantalla ocupada en ese periodo${who ? ` por ${who}` : ""}.` };
    }
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
    // Auditoría: quién crea (y primer editor). Todo update futuro de la orden
    // (editar, firmar, cancelar) debe sellar updated_by + updated_at.
    const actor = await resolveActor();
    const base = {
      store_id: t.storeId,
      advertiser_company_id: advertiser,
      billing_company_id: billing,
      brand,
      status: "draft",
      // Periodo de la OI = envolvente de sus líneas (fechas inclusivas).
      starts_at: inis.reduce((a, b) => (a < b ? a : b)),
      ends_at: fins.reduce((a, b) => (a > b ? a : b)),
      payment_terms_days,
      created_by: actor,
      updated_by: actor,
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
      revalidatePath("/orders");
      return { ok: true, message: "Orden creada." };
    }
    return { ok: false, message: "Colisión de numeración, reintenta." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export async function createOrderRedirectAction(_prev: CrmState, form: FormData): Promise<CrmState> {
  const res = await createOrderAction(form);
  if (res.ok) redirect("/orders");
  return res;
}

export interface AvailabilityState {
  ok: boolean;
  conflicts: ScreenConflict[];
  message: string;
}

/** Disponibilidad por periodo para el formulario (el server action revalida al crear). */
export async function checkAvailabilityAction(input: {
  starts: string;
  ends: string;
}): Promise<AvailabilityState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, conflicts: [], message: t.error };
  const valid = /^\d{4}-\d{2}-\d{2}$/;
  if (!valid.test(input.starts) || !valid.test(input.ends) || input.ends < input.starts) {
    return { ok: false, conflicts: [], message: "Periodo inválido." };
  }
  try {
    return { ok: true, conflicts: await getScreenConflicts(t.storeId, input.starts, input.ends), message: "" };
  } catch (e) {
    return { ok: false, conflicts: [], message: e instanceof Error ? e.message : "Error." };
  }
}

export interface OccupancyState {
  ok: boolean;
  occupancy: Record<string, Array<{ starts: string; ends: string }>>;
  message: string;
}

/** Rangos ocupados por pantalla (calendarios de disponibilidad, próximo hueco). */
export async function getScreenOccupancyAction(input: {
  screenIds: string[];
  from: string;
}): Promise<OccupancyState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, occupancy: {}, message: t.error };
  const ids = [...new Set((input.screenIds ?? []).map(String).filter(Boolean))].slice(0, 200);
  if (ids.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(input.from)) {
    return { ok: false, occupancy: {}, message: "Parámetros inválidos." };
  }
  try {
    return { ok: true, occupancy: await getScreenOccupancy(t.storeId, ids, input.from), message: "" };
  } catch (e) {
    return { ok: false, occupancy: {}, message: e instanceof Error ? e.message : "Error." };
  }
}
