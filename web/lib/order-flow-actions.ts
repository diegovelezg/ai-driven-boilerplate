"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { requireMyStoreAccess } from "@/lib/tenant";
import { normalizeCurrency } from "@/lib/currency";
import { isValidISODate, todayLima } from "@/lib/format";
import { resolveActor } from "@/lib/actor";

export interface OrderFlowState {
  ok: boolean;
  message: string;
}

/** Mutaciones del drawer: requieren vendedor o superior (viewer = solo lectura).
 *  null = anon-dev explícito (permite); sin auth y sin bypass = false (deniega). */
async function denyViewer(storeId: string): Promise<string | null> {
  const { denyRole } = await import("@/lib/tenant");
  return denyRole(storeId, "seller");
}

/** Carga una fila propia por id con chequeo de membresía (fail-closed).
 *  Devuelve la fila + storeId, o el mensaje de error. "No encontrada"
 *  enmascara tanto la ausencia como la falta de acceso (no oráculo).
 *  Sin chequeo de rol: el caller aplica `denyViewer`/status después, en el
 *  orden que cada flujo exige. */
async function loadOwnedRow(
  db: ReturnType<typeof getSupabase>,
  table: "io_orders" | "io_agency_orders" | "io_creatives" | "io_photo_checks" | "io_invoices",
  id: string,
  columns: string,
): Promise<{ row: Record<string, unknown>; storeId: string } | { error: string }> {
  const { data, error } = await db.from(table).select(columns).eq("id", id).maybeSingle();
  if (error || !data) return { error: "No encontrada." };
  // Cliente sin tipar por tabla dinámica: la fila es objeto (o null, ya
  // descartado arriba); el cast pasa por `unknown` en un solo lugar.
  const row = data as unknown as Record<string, unknown>;
  const storeId = String(row.store_id ?? "");
  if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
    return { error: "No encontrada." };
  }
  return { row, storeId };
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
    const loaded = await loadOwnedRow(
      db,
      "io_orders",
      orderId,
      "id,store_id,status,billing_company_id,agency_company_id,billing_contact_id,signer_contact_id,payment_contact_id,manager_contact_id",
    );
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const { row, storeId } = loaded;
    if (String(row.status ?? "") === "cancelled") {
      return { ok: false, message: "La orden está cancelada." };
    }
    const denied = await denyViewer(storeId);
    if (denied) return { ok: false, message: denied };
    if (String(row.status ?? "") === "signed") {
      return { ok: false, message: "La orden ya está firmada." };
    }
    // Nada nuevo con archivados: la firma congela la NP, así que las
    // contrapartes deben estar activas (lo firmado vive en el snapshot).
    {
      const { archivedBlockerMessage } = await import("@/lib/order-guards");
      const coIds = [row.billing_company_id, row.agency_company_id].filter((v): v is string => !!v);
      const ctIds = [
        row.billing_contact_id,
        row.signer_contact_id,
        row.payment_contact_id,
        row.manager_contact_id,
      ].filter((v): v is string => !!v);
      const [{ data: cos }, { data: cts }] = await Promise.all([
        coIds.length > 0
          ? db.from("crm_companies").select("id,name,deleted_at").eq("store_id", storeId).in("id", [...new Set(coIds)])
          : Promise.resolve({ data: [] }),
        ctIds.length > 0
          ? db
              .from("crm_contacts")
              .select("id,first_name,last_name,email,deleted_at")
              .eq("store_id", storeId)
              .in("id", [...new Set(ctIds)])
          : Promise.resolve({ data: [] }),
      ]);
      const coById = new Map(((cos ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), r]));
      const ctById = new Map(((cts ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), r]));
      const labels: Array<[unknown, string]> = [
        [row.billing_company_id, "facturador"],
        [row.agency_company_id, "intermediaria"],
      ];
      const refs: Array<{ label: string; archived: boolean; name: string | null }> = labels
        .filter(([id]) => !!id)
        .map(([id, label]) => {
          const r = coById.get(String(id));
          // Sin fila = fuera del tenant: otra validación lo frena; aquí no duplica.
          if (!r) return { label, archived: false, name: null };
          return { label, archived: r.deleted_at != null, name: typeof r.name === "string" ? r.name : null };
        });
      const ctLabels = ["POC", "firmante", "pago", "responsable"] as const;
      const ctKeys = ["billing_contact_id", "signer_contact_id", "payment_contact_id", "manager_contact_id"] as const;
      ctKeys.forEach((k, i) => {
        const id = row[k];
        if (!id) return;
        const r = ctById.get(String(id));
        if (!r) return;
        const n = [r.first_name, r.last_name].filter((v) => typeof v === "string" && (v as string).trim()).join(" ");
        refs.push({
          label: ctLabels[i],
          archived: r.deleted_at != null,
          name: n || (typeof r.email === "string" ? r.email : null),
        });
      });
      const block = archivedBlockerMessage(refs);
      if (block) return { ok: false, message: block };
    }
    const actor = await resolveActor();
    const now = new Date().toISOString();
    // Foto inmutable al firmar: el PDF la prefiere al dato vivo (resiste
    // archivo o cambio de empresas/contactos). Falla abierto: si el detalle
    // no carga, la firma igual procede (el PDF usa el vivo).
    let snapshot_json: Record<string, unknown> | null = null;
    try {
      const { getOrderDetail } = await import("@/lib/orders-db");
      const { buildOrderSnapshot } = await import("@/lib/order-snapshot");
      const { normalizeCurrency } = await import("@/lib/currency");
      const detail = await getOrderDetail(storeId, orderId);
      if (detail) {
        const gross = detail.lines.reduce((a, l) => a + Number(l.rate_minor ?? 0), 0);
        const toContact = (c: { name: string; role: string | null; email: string | null; phone: string | null } | null) =>
          c ? { name: c.name, role: c.role, email: c.email, phone: c.phone } : null;
        snapshot_json = buildOrderSnapshot({
          signed_at: now,
          currency: normalizeCurrency((detail.order.currency as string | null | undefined) ?? "PEN"),
          payment_terms_days:
            typeof detail.order.payment_terms_days === "number" ? (detail.order.payment_terms_days as number) : null,
          gross_minor: gross,
          advertiser_name: detail.advertiser_name,
          billing_name: detail.billing_name,
          billing_tax_id: detail.billing_tax_id,
          billing_city: detail.billing_city,
          billing_country: detail.billing_country,
          agency_name: detail.agency_name,
          agency_tax_id: detail.agency_tax_id,
          agency_commission_pct: detail.agency_commission_pct,
          billing_contact: toContact(detail.contacts.billing),
          signer_contact: toContact(detail.contacts.signer),
          payment_contact: toContact(detail.contacts.payment),
          manager_contact: toContact(detail.contacts.manager),
        }) as unknown as Record<string, unknown>;
      }
    } catch {
      snapshot_json = null;
    }
    const { error: werr } = await db
      .from("io_orders")
      .update({
        status: "signed",
        signed_at: now,
        signed_by_agency: (input.signedByAgency ?? "").trim() || null,
        signed_by_company: (input.signedByCompany ?? "").trim() || null,
        updated_at: now,
        updated_by: actor ?? null,
        ...(snapshot_json ? { snapshot_json } : {}),
      })
      .eq("store_id", storeId)
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
    const loaded = await loadOwnedRow(db, "io_orders", orderId, "id,store_id,status");
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const { row, storeId } = loaded;
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
      .eq("store_id", storeId)
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
  const loaded = await loadOwnedRow(db, "io_orders", orderId, "id,store_id,status");
  if ("error" in loaded) return loaded;
  const denied = await denyViewer(loaded.storeId);
  if (denied) return { error: denied };
  return loaded;
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
    const loaded = await loadOwnedRow(db, "io_agency_orders", id, "id,store_id,io_id");
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const { row: r, storeId: childStore } = loaded;
    const denied = await denyViewer(childStore);
    if (denied) return { ok: false, message: denied };
    const actor = await resolveActor();
    const { error: derr } = await db.from("io_agency_orders").delete().eq("store_id", childStore).eq("id", id);
    if (derr) return { ok: false, message: `DB write: ${derr.message}` };
    await db
      .from("io_orders")
      .update({ updated_at: new Date().toISOString(), updated_by: actor })
      .eq("store_id", childStore)
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
      .eq("store_id", chk.storeId)
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
    const loaded = await loadOwnedRow(db, "io_creatives", id, "id,store_id,io_id");
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const { row: r, storeId: childStore } = loaded;
    const denied = await denyViewer(childStore);
    if (denied) return { ok: false, message: denied };
    const actor = await resolveActor();
    const { error: derr } = await db.from("io_creatives").delete().eq("store_id", childStore).eq("id", id);
    if (derr) return { ok: false, message: `DB write: ${derr.message}` };
    await db
      .from("io_orders")
      .update({ updated_at: new Date().toISOString(), updated_by: actor })
      .eq("store_id", childStore)
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
      .eq("store_id", chk.storeId)
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
    const loaded = await loadOwnedRow(db, "io_photo_checks", id, "id,store_id");
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const { row: r } = loaded;
    const denied = await denyViewer(String(r.store_id ?? ""));
    if (denied) return { ok: false, message: denied };
    const { error: derr } = await db.from("io_photo_checks").delete().eq("store_id", String(r.store_id ?? "")).eq("id", id);
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
      .eq("store_id", chk.storeId)
      .eq("id", orderId);
    if (werr) return { ok: false, message: `DB write: ${werr.message}` };
    revalidatePath("/orders");
    return { ok: true, message: "Orden cancelada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Reactiva una orden cancelada (vuelve a borrador). Requiere vendedor+. */
export async function reactivateOrderAction(input: { orderId: string }): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  try {
    const db = getSupabase();
    const chk = await orderStore(db, orderId);
    if ("error" in chk) return { ok: false, message: chk.error };
    if (String(chk.row.status ?? "") !== "cancelled") {
      return { ok: false, message: "Solo se puede reactivar una orden cancelada." };
    }
    const actor = await resolveActor();
    const now = new Date().toISOString();
    const { error: werr } = await db
      .from("io_orders")
      .update({ status: "draft", updated_at: now, updated_by: actor })
      .eq("store_id", chk.storeId)
      .eq("id", orderId);
    if (werr) return { ok: false, message: `DB write: ${werr.message}` };
    revalidatePath("/orders");
    return { ok: true, message: "Orden reactivada como borrador." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Elimina una orden en borrador o cancelada (solo owner).
 *  Líneas, OM/OC, materiales y foto checks caen por cascada (ON DELETE
 *  CASCADE en BD). Bloqueado si tiene historia que quedaría huérfana
 *  (facturas, reservas, campañas o play logs: SET NULL en BD). */
export async function deleteOrderAction(input: { orderId: string }): Promise<OrderFlowState> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  try {
    const db = getSupabase();
    const loaded = await loadOwnedRow(db, "io_orders", orderId, "id,store_id,status");
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const { row, storeId } = loaded;
    const { denyRole } = await import("@/lib/tenant");
    const denied = await denyRole(storeId, "owner", "Solo el propietario puede eliminar órdenes.");
    if (denied) return { ok: false, message: denied };
    const status = String(row.status ?? "");
    if (status !== "draft" && status !== "cancelled") {
      return { ok: false, message: "Cancela la orden antes de eliminarla." };
    }
    const [invs, books, camps, plays] = await Promise.all([
      db.from("io_invoices").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("io_id", orderId),
      db.from("inv_bookings").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("insertion_order_id", orderId),
      db.from("io_campaigns").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("insertion_order_id", orderId),
      db.from("io_play_logs").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("io_id", orderId),
    ]);
    if ((invs.count ?? 0) > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${invs.count} factura(s). Anúlalas o registra una nueva orden.` };
    }
    if ((books.count ?? 0) > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${books.count} reserva(s).` };
    }
    if ((camps.count ?? 0) > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${camps.count} campaña(s) vinculada(s).` };
    }
    if ((plays.count ?? 0) > 0) {
      return { ok: false, message: `No se puede eliminar: tiene ${plays.count} registro(s) de emisión.` };
    }
    const { error: derr } = await db.from("io_orders").delete().eq("store_id", storeId).eq("id", orderId);
    if (derr) return { ok: false, message: `DB write: ${derr.message}` };
    revalidatePath("/orders");
    return { ok: true, message: "Orden eliminada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

function realDate(v: string): boolean {
  return isValidISODate(v);
}

/** Registra una factura emitida contra la orden (monto, número, fechas, estado inicial).
 *  La moneda es siempre la de la orden (el trigger io_invoice_currency_check
 *  aborta cualquier mezcla PEN/USD). Sin `draft` en v1: nace emitida; el cobro se registra por separado. */
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
  if (status !== "issued") {
    return { ok: false, message: "Registra la factura emitida y luego su cobro con fecha y referencia." };
  }
  try {
    const db = getSupabase();
    const loaded = await loadOwnedRow(db, "io_orders", orderId, "id,store_id,status,currency,billing_company_id");
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const { row, storeId } = loaded;
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
      .eq("store_id", storeId)
      .eq("id", orderId);
    revalidatePath("/orders");
    revalidatePath("/");
    revalidatePath("/finance");
    return { ok: true, message: "Factura emitida registrada. Registra sus cobros por separado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Anular una factura no perdona ni elimina cobros: la RPC verifica saldo bajo lock.
 * El estado pagada se deriva de los cobros, nunca se cambia con un botón. */
export async function setInvoiceStatusAction(input: {
  invoiceId: string;
  status: string;
}): Promise<OrderFlowState> {
  if (input.status !== "cancelled") return { ok: false, message: "Registra o revierte un cobro para actualizar el saldo." };
  try {
    const db = getSupabase();
    const loaded = await loadOwnedRow(db, "io_invoices", String(input.invoiceId ?? ""), "id,store_id");
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const denied = await denyViewer(loaded.storeId);
    if (denied) return { ok: false, message: denied };
    const { error } = await db.rpc("io_cancel_invoice", {
      p_store: loaded.storeId, p_invoice: input.invoiceId, p_actor: await resolveActor(),
    });
    if (error) return { ok: false, message: error.message };
    refreshBilling();
    return { ok: true, message: "Factura anulada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

function refreshBilling() {
  revalidatePath("/orders");
  revalidatePath("/finance");
  revalidatePath("/");
}

export async function recordInvoicePaymentAction(input: {
  invoiceId: string;
  requestId: string;
  amountMinor: number;
  paidOn: string;
  reference: string;
}): Promise<OrderFlowState> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return { ok: false, message: "Monto de cobro inválido." };
  }
  if (!isValidISODate(input.paidOn) || input.paidOn > todayLima()) {
    return { ok: false, message: "Fecha de cobro inválida o futura." };
  }
  if (!input.reference?.trim() || input.reference.trim().length > 200) {
    return { ok: false, message: "Indica una referencia de cobro (máx 200)." };
  }
  try {
    const db = getSupabase();
    const loaded = await loadOwnedRow(db, "io_invoices", input.invoiceId, "id,store_id");
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const denied = await denyViewer(loaded.storeId);
    if (denied) return { ok: false, message: denied };
    // No bloquear por cancelación de la orden: una deuda puede seguir vigente.
    const { error } = await db.rpc("io_record_invoice_payment", {
      p_store: loaded.storeId, p_invoice: input.invoiceId, p_payment: input.requestId,
      p_amount: input.amountMinor, p_paid_on: input.paidOn,
      p_reference: input.reference.trim(), p_actor: await resolveActor(),
    });
    if (error) return { ok: false, message: error.message };
    refreshBilling();
    return { ok: true, message: "Cobro registrado." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export async function voidInvoicePaymentAction(input: {
  invoiceId: string;
  paymentId: string;
  reason: string;
}): Promise<OrderFlowState> {
  if (!input.reason?.trim() || input.reason.trim().length > 500) {
    return { ok: false, message: "Indica el motivo de la reversión (máx 500)." };
  }
  try {
    const db = getSupabase();
    const loaded = await loadOwnedRow(db, "io_invoices", input.invoiceId, "id,store_id");
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const denied = await denyViewer(loaded.storeId);
    if (denied) return { ok: false, message: denied };
    const { error } = await db.rpc("io_void_invoice_payment", {
      p_store: loaded.storeId, p_invoice: input.invoiceId, p_payment: input.paymentId,
      p_reason: input.reason.trim(), p_actor: await resolveActor(),
    });
    if (error) return { ok: false, message: error.message };
    refreshBilling();
    return { ok: true, message: "Registro de cobro revertido; se conserva su historial." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}
