"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireMyStoreAccess } from "@/lib/tenant";
import { normalizeCurrency } from "@/lib/currency";
import { resolveActor } from "@/lib/actor";

export interface OrderFlowState {
  ok: boolean;
  message: string;
}

/** Mutaciones del drawer: requieren vendedor o superior (viewer = solo lectura).
 *  null = anon-dev explícito (permite); sin auth y sin bypass = false (deniega). */
async function denyViewer(storeId: string): Promise<string | null> {
  const { requireMinRole } = await import("@/lib/tenant");
  const allowed = await requireMinRole(storeId, "seller").catch(() => false);
  return allowed === false ? "Requiere rol vendedor o superior." : null;
}

/** Pasa la OI de borrador a firmada (el cliente la firmó). */
export async function signOrderAction(input: {
  orderId: string;
  signedByAgency?: string | null;
  signedByCompany?: string | null;
}): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("io_orders")
      .select("id,store_id,status")
      .eq("id", orderId)
      .maybeSingle();
    if (error || !data) return { ok: false, message: "No encontrada." };
    const row = data as Record<string, unknown>;
    const storeId = String(row.store_id ?? "");
    if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
      return { ok: false, message: "No encontrada." };
    }
    if (String(row.status ?? "") === "cancelled") {
      return { ok: false, message: "La orden está cancelada." };
    }
    const denied = await denyViewer(storeId);
    if (denied) return { ok: false, message: denied };
    if (String(row.status ?? "") === "signed") {
      return { ok: false, message: "La orden ya está firmada." };
    }
    const actor = await resolveActor();
    const now = new Date().toISOString();
    const { error: werr } = await db
      .from("io_orders")
      .update({
        status: "signed",
        signed_at: now,
        signed_by_agency: (input.signedByAgency ?? "").trim() || null,
        signed_by_company: (input.signedByCompany ?? "").trim() || null,
        updated_at: now,
        updated_by: actor ?? null,
      })
      .eq("id", orderId);
    if (werr) return { ok: false, message: `DB write: ${werr.message}` };
    revalidatePath("/orders");
    return { ok: true, message: "Orden marcada como firmada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Registra la OM de la agencia (hito Autorizada: libera Materiales).
 *  KISS: solo URL del documento. kind fijo 'OM', code = URL (única por tienda). */
export async function createAgencyOrderAction(input: {
  orderId: string;
  documentUrl: string;
}): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  const url = String(input.documentUrl ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, message: "Pega la URL del documento (http(s))." };
  }
  const kind = "OM";
  const code = url;
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("io_orders")
      .select("id,store_id,status")
      .eq("id", orderId)
      .maybeSingle();
    if (error || !data) return { ok: false, message: "No encontrada." };
    const row = data as Record<string, unknown>;
    const storeId = String(row.store_id ?? "");
    if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
      return { ok: false, message: "No encontrada." };
    }
    if (String(row.status ?? "") !== "signed") {
      return { ok: false, message: "Marca la orden como firmada primero." };
    }
    const denied = await denyViewer(storeId);
    if (denied) return { ok: false, message: denied };
    const actor = await resolveActor();
    const now = new Date().toISOString();
    const { error: werr } = await db.from("io_agency_orders").insert({
      store_id: storeId,
      io_id: orderId,
      kind,
      code,
      portal: null,
      issued_at: null,
      document_url: url,
      notes: null,
      created_by: actor,
    });
    if (werr) {
      if (werr.code === "23505") return { ok: false, message: "Ese documento ya está registrado." };
      return { ok: false, message: `DB write: ${werr.message}` };
    }
    await db
      .from("io_orders")
      .update({ updated_at: now, updated_by: actor })
      .eq("id", orderId);
    revalidatePath("/orders");
    return { ok: true, message: "Documento registrado: la orden está autorizada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

async function orderStore(
  db: ReturnType<typeof getSupabase>,
  orderId: string,
): Promise<{ row: Record<string, unknown>; storeId: string } | { error: string }> {
  const { data, error } = await db
    .from("io_orders")
    .select("id,store_id,status")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !data) return { error: "No encontrada." as const };
  const row = data as Record<string, unknown>;
  const storeId = String(row.store_id ?? "");
  if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
    return { error: "No encontrada." as const };
  }
  const denied = await denyViewer(storeId);
  if (denied) return { error: denied };
  return { row, storeId };
}

function httpUrl(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : null;
}

/** Elimina un OM/OC (por error al registrar). Sin OMs la orden vuelve a Firmada. */
export async function deleteAgencyOrderAction(input: { agencyOrderId: string }): Promise<OrderFlowState> {
  const id = String(input.agencyOrderId ?? "").trim();
  if (!id) return { ok: false, message: "Falta el registro." };
  try {
    const db = getSupabase();
    const { data, error } = await db.from("io_agency_orders").select("id,store_id,io_id").eq("id", id).maybeSingle();
    if (error || !data) return { ok: false, message: "No encontrada." };
    const r = data as Record<string, unknown>;
    if ((await requireMyStoreAccess(String(r.store_id ?? "")).catch(() => false)) === false) {
      return { ok: false, message: "No encontrada." };
    }
    const denied = await denyViewer(String(r.store_id ?? ""));
    if (denied) return { ok: false, message: denied };
    const actor = await resolveActor();
    const { error: derr } = await db.from("io_agency_orders").delete().eq("id", id);
    if (derr) return { ok: false, message: `DB write: ${derr.message}` };
    await db
      .from("io_orders")
      .update({ updated_at: new Date().toISOString(), updated_by: actor })
      .eq("id", String(r.io_id ?? ""));
    revalidatePath("/orders");
    return { ok: true, message: "OM/OC eliminado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Adjunta un material (pieza). KISS: solo URL, nace aprobado.
 *  El tamaño de pieza es opcional: duración en segundos y resolución en px
 *  (el aspecto se deriva). El nombre se deriva del archivo. */
export async function attachCreativeAction(input: {
  orderId: string;
  fileUrl: string;
  durationSec?: number | string | null;
  widthPx?: number | string | null;
  heightPx?: number | string | null;
}): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  const fileUrl = httpUrl(input.fileUrl);
  if (!orderId) return { ok: false, message: "Falta la orden." };
  if (!fileUrl) return { ok: false, message: "Pega la URL del material (http(s))." };
  const optNum = (v: unknown): number | null | undefined => {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n;
  };
  const duration = optNum(input.durationSec);
  if (duration === undefined) return { ok: false, message: "Duración inválida: segundos (> 0)." };
  const widthPx = optNum(input.widthPx);
  if (widthPx === undefined || (widthPx !== null && !Number.isInteger(widthPx))) {
    return { ok: false, message: "Ancho inválido: px (entero > 0)." };
  }
  const heightPx = optNum(input.heightPx);
  if (heightPx === undefined || (heightPx !== null && !Number.isInteger(heightPx))) {
    return { ok: false, message: "Alto inválido: px (entero > 0)." };
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const aspect =
    widthPx !== null && heightPx !== null
      ? `${widthPx / gcd(widthPx, heightPx)}:${heightPx / gcd(widthPx, heightPx)}`
      : null;
  let name = "Material";
  try {
    const base = new URL(fileUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    const clean = decodeURIComponent(base).trim();
    if (clean) name = clean.slice(0, 120);
  } catch {
    // nombre por defecto
  }
  try {
    const db = getSupabase();
    const chk = await orderStore(db, orderId);
    if ("error" in chk) return { ok: false, message: chk.error };
    if (String(chk.row.status ?? "") === "cancelled") return { ok: false, message: "La orden está cancelada." };
    const actor = await resolveActor();
    const { error: werr } = await db.from("io_creatives").insert({
      store_id: chk.storeId,
      io_id: orderId,
      created_by: actor,
      name,
      file_url: fileUrl,
      duration_s: duration,
      width_px: widthPx,
      height_px: heightPx,
      aspect,
      qc_status: "approved",
      legal_status: "approved",
    });
    if (werr) return { ok: false, message: `DB write: ${werr.message}` };
    await db
      .from("io_orders")
      .update({ updated_at: new Date().toISOString(), updated_by: actor })
      .eq("id", orderId);
    revalidatePath("/orders");
    return { ok: true, message: "Material adjuntado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Elimina un material (por error al adjuntar). */
export async function deleteCreativeAction(input: { creativeId: string }): Promise<OrderFlowState> {
  const id = String(input.creativeId ?? "").trim();
  if (!id) return { ok: false, message: "Falta la pieza." };
  try {
    const db = getSupabase();
    const { data, error } = await db.from("io_creatives").select("id,store_id,io_id").eq("id", id).maybeSingle();
    if (error || !data) return { ok: false, message: "No encontrada." };
    const r = data as Record<string, unknown>;
    if ((await requireMyStoreAccess(String(r.store_id ?? "")).catch(() => false)) === false) {
      return { ok: false, message: "No encontrada." };
    }
    const denied = await denyViewer(String(r.store_id ?? ""));
    if (denied) return { ok: false, message: denied };
    const actor = await resolveActor();
    const { error: derr } = await db.from("io_creatives").delete().eq("id", id);
    if (derr) return { ok: false, message: `DB write: ${derr.message}` };
    await db
      .from("io_orders")
      .update({ updated_at: new Date().toISOString(), updated_by: actor })
      .eq("id", String(r.io_id ?? ""));
    revalidatePath("/orders");
    return { ok: true, message: "Material eliminado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Adjunta un foto check (foto o video por URL). */
export async function attachPhotoAction(input: { orderId: string; url: string }): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  const url = httpUrl(input.url);
  if (!orderId) return { ok: false, message: "Falta la orden." };
  if (!url) return { ok: false, message: "El adjunto debe ser una URL http(s)." };
  const isVideo = /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(url);
  try {
    const db = getSupabase();
    const chk = await orderStore(db, orderId);
    if ("error" in chk) return { ok: false, message: chk.error };
    if (String(chk.row.status ?? "") === "cancelled") return { ok: false, message: "La orden está cancelada." };
    const actor = await resolveActor();
    const { error: werr } = await db.from("io_photo_checks").insert({
      store_id: chk.storeId,
      io_id: orderId,
      photo_url: isVideo ? null : url,
      video_url: isVideo ? url : null,
      created_by: actor,
    });
    await db
      .from("io_orders")
      .update({ updated_at: new Date().toISOString(), updated_by: actor ?? null })
      .eq("id", orderId);
    if (werr) return { ok: false, message: `DB write: ${werr.message}` };
    revalidatePath("/orders");
    return { ok: true, message: isVideo ? "Video adjuntado." : "Foto adjuntada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Elimina un foto check (por error al adjuntar). */
export async function deletePhotoAction(input: { photoId: string }): Promise<OrderFlowState> {
  const id = String(input.photoId ?? "").trim();
  if (!id) return { ok: false, message: "Falta el registro." };
  try {
    const db = getSupabase();
    const { data, error } = await db.from("io_photo_checks").select("id,store_id").eq("id", id).maybeSingle();
    if (error || !data) return { ok: false, message: "No encontrada." };
    const r = data as Record<string, unknown>;
    if ((await requireMyStoreAccess(String(r.store_id ?? "")).catch(() => false)) === false) {
      return { ok: false, message: "No encontrada." };
    }
    const denied = await denyViewer(String(r.store_id ?? ""));
    if (denied) return { ok: false, message: denied };
    const { error: derr } = await db.from("io_photo_checks").delete().eq("id", id);
    if (derr) return { ok: false, message: `DB write: ${derr.message}` };
    revalidatePath("/orders");
    return { ok: true, message: "Adjunto eliminado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Cancela la orden (terminal). Los adjuntos se conservan como evidencia. */
export async function cancelOrderAction(input: { orderId: string }): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  try {
    const db = getSupabase();
    const chk = await orderStore(db, orderId);
    if ("error" in chk) return { ok: false, message: chk.error };
    if (String(chk.row.status ?? "") === "cancelled") return { ok: false, message: "La orden ya está cancelada." };
    const actor = await resolveActor();
    const now = new Date().toISOString();
    const { error: werr } = await db
      .from("io_orders")
      .update({ status: "cancelled", updated_at: now, updated_by: actor })
      .eq("id", orderId);
    if (werr) return { ok: false, message: `DB write: ${werr.message}` };
    revalidatePath("/orders");
    return { ok: true, message: "Orden cancelada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

function realDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Registra una factura emitida contra la orden (monto, número, fechas, estado inicial).
 *  La moneda es siempre la de la orden (el trigger io_invoice_currency_check
 *  aborta cualquier mezcla PEN/USD). Sin `draft` en v1: nace emitida o pagada. */
export async function createInvoiceAction(input: {
  orderId: string;
  number: string;
  amountMinor: number;
  issueDate?: string | null;
  dueDate?: string | null;
  status?: string;
}): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  const number = String(input.number ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  if (!number || number.length > 60) return { ok: false, message: "Número de factura requerido (máx 60)." };
  const rawMinor = Number(input.amountMinor);
  if (!Number.isInteger(rawMinor) || rawMinor < 1 || rawMinor > 99_999_999_999) {
    return { ok: false, message: "Monto inválido: debe ser mayor a 0." };
  }
  const minor = rawMinor;
  const issue = String(input.issueDate ?? "").trim();
  const due = String(input.dueDate ?? "").trim();
  if (issue && !realDate(issue)) return { ok: false, message: "Emisión inválida (aaaa-mm-dd)." };
  if (due && !realDate(due)) return { ok: false, message: "Vencimiento inválido (aaaa-mm-dd)." };
  if (issue && due && due < issue) return { ok: false, message: "Vence antes de la emisión." };
  const status = String(input.status ?? "issued").trim() || "issued";
  if (status !== "issued" && status !== "paid") {
    return { ok: false, message: "Estado inicial inválido (emitida o pagada)." };
  }
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("io_orders")
      .select("id,store_id,status,currency,billing_company_id")
      .eq("id", orderId)
      .maybeSingle();
    if (error || !data) return { ok: false, message: "No encontrada." };
    const row = data as Record<string, unknown>;
    const storeId = String(row.store_id ?? "");
    if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
      return { ok: false, message: "No encontrada." };
    }
    if (String(row.status ?? "") === "cancelled") return { ok: false, message: "La orden está cancelada." };
    // Factura electrónica: exige razón social con RUC (no se factura al aire).
    const billingId = String(row.billing_company_id ?? "");
    if (!billingId) return { ok: false, message: "Sin empresa de facturación: fíjala en la ficha de la orden." };
    const { data: co, error: coErr } = await db
      .from("crm_companies")
      .select("tax_id")
      .eq("store_id", storeId)
      .eq("id", billingId)
      .maybeSingle();
    if (coErr || !co) return { ok: false, message: "Sin empresa de facturación: fíjala en la ficha de la orden." };
    if (!String((co as Record<string, unknown>).tax_id ?? "").trim()) {
      return { ok: false, message: "Sin RUC: complétalo en la ficha de la empresa antes de facturar." };
    }
    const denied = await denyViewer(storeId);
    if (denied) return { ok: false, message: denied };
    const currency = normalizeCurrency(row.currency ?? "PEN");
    const actor = await resolveActor();
    const { error: werr } = await db.from("io_invoices").insert({
      store_id: storeId,
      io_id: orderId,
      number,
      amount_minor: minor,
      currency,
      issue_date: issue || null,
      due_date: due || null,
      status,
    });
    if (werr) {
      if (werr.code === "23505") return { ok: false, message: "Ese número ya existe en esta tienda." };
      if (/io_invoice_currency_check/i.test(werr.message)) {
        return { ok: false, message: "La moneda no coincide con la de la orden." };
      }
      return { ok: false, message: `DB write: ${werr.message}` };
    }
    await db
      .from("io_orders")
      .update({ updated_at: new Date().toISOString(), updated_by: actor })
      .eq("id", orderId);
    revalidatePath("/orders");
    revalidatePath("/");
    return { ok: true, message: status === "paid" ? "Factura registrada como pagada." : "Factura emitida registrada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Cambia el estado de una factura: emitida ↔ pagada, cualquiera → anulada.
 *  `vencida` se deriva sola (emitida + vencimiento < hoy) y no necesita botón.
 *  Anulada es terminal (no suma en cobro): para corregir, registra una nueva.
 *  Sin `draft` en v1: un `draft` legacy nunca transiciona (fail-closed). */
function isTerminalInvoiceStatus(s: string): boolean {
  return s === "cancelled";
}

const INVOICE_TRANSITIONS: Record<string, readonly string[]> = {
  issued: ["paid", "cancelled"],
  paid: ["issued", "cancelled"],
  cancelled: [],
};

export async function setInvoiceStatusAction(input: {
  invoiceId: string;
  status: string;
}): Promise<OrderFlowState> {
  const id = String(input.invoiceId ?? "").trim();
  const status = String(input.status ?? "").trim();
  if (!id) return { ok: false, message: "Falta la factura." };
  if (status !== "issued" && status !== "paid" && status !== "cancelled") {
    return { ok: false, message: "Estado inválido (emitida, pagada o anulada)." };
  }
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("io_invoices")
      .select("id,store_id,io_id,status")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return { ok: false, message: "No encontrada." };
    const r = data as Record<string, unknown>;
    const storeId = String(r.store_id ?? "");
    if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
      return { ok: false, message: "No encontrada." };
    }
    const denied = await denyViewer(storeId);
    if (denied) return { ok: false, message: denied };
    const current = String(r.status ?? "");
    if (isTerminalInvoiceStatus(current)) return { ok: false, message: "Anulada es terminal: registra una nueva factura." };
    if (current === status) return { ok: false, message: "La factura ya está en ese estado." };
    const allowed = INVOICE_TRANSITIONS[current];
    if (!allowed || !allowed.includes(status)) {
      return { ok: false, message: "Transición inválida (emitida ↔ pagada, cualquiera → anulada)." };
    }
    // La orden padre manda: cancelada bloquea (create ya lo exige en :419).
    const { data: parent } = await db
      .from("io_orders")
      .select("status")
      .eq("id", String(r.io_id ?? ""))
      .maybeSingle();
    if (String((parent as Record<string, unknown> | null)?.status ?? "") === "cancelled") {
      return { ok: false, message: "La orden está cancelada." };
    }
    const actor = await resolveActor();
    const { error: werr } = await db.from("io_invoices").update({ status }).eq("id", id);
    if (werr) return { ok: false, message: `DB write: ${werr.message}` };
    await db
      .from("io_orders")
      .update({ updated_at: new Date().toISOString(), updated_by: actor })
      .eq("id", String(r.io_id ?? ""));
    revalidatePath("/orders");
    revalidatePath("/");
    const label = status === "paid" ? "pagada" : status === "cancelled" ? "anulada" : "emitida";
    return { ok: true, message: `Factura marcada como ${label}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
