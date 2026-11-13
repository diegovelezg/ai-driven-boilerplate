"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { resolveTenantStoreAction as resolveTenantStore } from "@/lib/tenant";
import { getScreenOccupancy, type ScreenConflict } from "@/lib/availability";
import { DEFAULT_SLOTS_PER_SCREEN } from "@/lib/store-slots";
import { resolveActor } from "@/lib/actor";
import { isValidCurrency, normalizeCurrency } from "@/lib/currency";
import { addDays, formatDate, isoDayPart, isISODateShape, limaDayStart } from "@/lib/format";
import type { CrmState } from "@/lib/crm-actions";

// SSOT: resolveTenantStore = resolveTenantStoreAction (ver lib/tenant.ts).

/** Número autogenerado vía función SQL (contador atómico por tienda+año). */
async function mintIoNumber(
  db: ReturnType<typeof getSupabase>,
  storeId: string,
): Promise<string> {
  const { data, error } = await db.rpc("io_mint_number", { p_store: storeId });
  if (error || typeof data !== "string" || !data) {
    throw new Error(`No se pudo numerar la orden: ${error?.message ?? "sin número"}`);
  }
  return data;
}

/** Crea la OI en borrador con número autogenerado (etapa Firmada).
 *  Líneas y OM llegan después. */
export async function createOrderAction(form: FormData): Promise<CrmState> {
  const t = await resolveTenantStore("seller");
  if ("error" in t) return { ok: false, message: t.error };
  // Anunciante (bloque 1): requerido siempre; el contratante es él mismo
  // (directo) o una agencia. La marca sigue siendo texto libre del pedido.
  const advertiserRaw = String(form.get("advertiser_company_id") ?? "").trim() || null;
  if (!advertiserRaw) return { ok: false, message: "Anunciante requerido." };
  const company = String(form.get("company_id") ?? "").trim() || null;
  if (!company) return { ok: false, message: "Empresa requerida." };
  const brand = String(form.get("brand") ?? "").trim() || null;
  if (!brand) return { ok: false, message: "Marca requerida." };
  if (brand.length > 200) return { ok: false, message: "Marca muy larga (máx 200)." };
  const notes = String(form.get("notes") ?? "").trim() || null;
  if (notes !== null && notes.length > 2000) return { ok: false, message: "Notas muy largas (máx 2000)." };
  // Condición de pago en días (0 = Contado). Fuente numérica para vencimientos:
  // due_date = issue_date + N días. El texto es solo display (paymentTermsLabel).
  const termsRaw = String(form.get("payment_terms_days") ?? "").trim();
  if (termsRaw === "") return { ok: false, message: "Condición de pago requerida." };
  const payment_terms_days = Number(termsRaw);
  // Documento para facturación (select único requerido → 3 flags).
  const billingDoc = String(form.get("billing_doc") ?? "").trim();
  if (!["orden_medios", "orden_compra", "contrato"].includes(billingDoc)) {
    return { ok: false, message: "Documento para facturación requerido." };
  }
  const billing_detail = String(form.get("billing_detail") ?? "").trim() || null;
  if (billing_detail !== null && billing_detail.length > 500) {
    return { ok: false, message: "Detalle de facturación muy largo (máx 500)." };
  }
  const invoice_registration = String(form.get("invoice_registration") ?? "").trim() || null;
  if (invoice_registration !== null && invoice_registration.length > 500) {
    return { ok: false, message: "Registro de factura muy largo (máx 500)." };
  }
  const billing_portal_email = String(form.get("billing_portal_email") ?? "").trim() || null;
  if (billing_portal_email !== null && billing_portal_email.length > 320) {
    return { ok: false, message: "Correo y/o portal muy largo (máx 320)." };
  }
  if (payment_terms_days !== null && (!Number.isInteger(payment_terms_days) || payment_terms_days < 0)) {
    return { ok: false, message: "Condición de pago inválida." };
  }
  // Moneda de la IO (default: moneda del tenant). Un país puede operar PEN+USD.
  const currencyRaw = normalizeCurrency(form.get("currency"), "");
  let orderCurrency: string | null = null;
  try {
    const dbCur = getSupabase();
    const { data: storeRow } = await dbCur
      .from("sys_stores")
      .select("shop_currency")
      .eq("id", t.storeId)
      .maybeSingle();
    orderCurrency = normalizeCurrency((storeRow as Record<string, unknown> | null)?.shop_currency, "PEN");
  } catch {
    orderCurrency = "PEN";
  }
  if (currencyRaw) {
    // isValidCurrency rechaza ISO3 falsos (XXX/ZZZ/XTS/...) que el regex suelto aceptaba.
    if (!isValidCurrency(currencyRaw)) {
      return { ok: false, message: "Moneda inválida (usa PEN, USD…)." };
    }
    orderCurrency = currencyRaw;
  }
  // Líneas: mismo largo en los 6 arreglos (una fila por pantalla).
  const screens = form.getAll("screen_id").map((v) => String(v).trim());
  const inis = form.getAll("line_starts_at").map((v) => String(v).trim());
  const fins = form.getAll("line_ends_at").map((v) => String(v).trim());
  const totals = form.getAll("line_total").map((v) => String(v).trim().replace(",", "."));
  const dias = form.getAll("line_cant_dias").map((v) => String(v).trim().replace(",", "."));
  const slotsRaw = form.getAll("line_slots").map((v) => String(v).trim());
  if (slotsRaw.length > 0 && slotsRaw.length !== screens.length) {
    return { ok: false, message: "Líneas incompletas." };
  }
  const { normalizeLineSlots } = await import("@/lib/order-lines");
  if (screens.length === 0 || screens.some((s) => !s)) {
    return { ok: false, message: "Cada línea necesita su pantalla." };
  }
  if (![inis.length, fins.length, totals.length, dias.length].every((n) => n === screens.length)) {
    return { ok: false, message: "Líneas incompletas." };
  }
  const parsedLines: Array<{ screen: string; starts: string; ends: string; total: number; cant_dias: number | null; cant_slots: number }> = [];
  const nextDayLima = (d: string): string => limaDayStart(addDays(d, 1));
  for (let i = 0; i < screens.length; i++) {
    if (!inis[i] || !fins[i]) return { ok: false, message: `Línea ${i + 1}: periodo requerido.` };
    if (fins[i] < inis[i]) return { ok: false, message: `Línea ${i + 1}: fin anterior al inicio.` };
    const total = Number(totals[i]);
    if (!Number.isFinite(total) || total <= 0) return { ok: false, message: `Línea ${i + 1}: total inválido.` };
    const cant = dias[i] ? Number(dias[i]) : NaN;
    const cantSlots = normalizeLineSlots(slotsRaw[i] ?? "", { blankInvalid: true });
    if (cantSlots === null) return { ok: false, message: `Línea ${i + 1}: slots inválidos (1–100).` };
    parsedLines.push({
      screen: screens[i],
      starts: limaDayStart(inis[i]),
      // Rango '[)': fin exclusivo = día siguiente a la fecha fin de la OI.
      ends: nextDayLima(fins[i]),
      total,
      cant_dias: Number.isFinite(cant) && cant > 0 ? cant : null,
      cant_slots: cantSlots,
    });
  }
  try {
    const db = getSupabase();
    // Anti-sobreventa en la venta: el cliente no es la garantía (carrera entre
    // dos vendedores). Dos chequeos: solape intra-orden (la propia orden no
    // puede sumar cupo contra sí misma) y cupo por línea contra lo vigente
    // (su periodo × su q, no MAX sobre el envoltorio).
    const { findLineOverlaps } = await import("@/lib/order-lines");
    const { findLineConflicts } = await import("@/lib/availability");
    if (
      findLineOverlaps(parsedLines.map((l, i) => ({ screen_id: l.screen, starts: inis[i], ends: fins[i], total: l.total }))).length > 0
    ) {
      return { ok: false, message: "Dos líneas usan la misma pantalla en periodos que se cruzan." };
    }
    const hit = await findLineConflicts(
      t.storeId,
      parsedLines.map((l, i) => ({ screen_id: l.screen, starts: inis[i], ends: fins[i], slots: l.cant_slots })),
    );
    if (hit) {
      const who = [hit.conflict.io_number, hit.conflict.brand].filter(Boolean).join(" · ");
      const days = (hit.conflict.blockedDays ?? []).map((d) => formatDate(d)).join(", ");
      return { ok: false, message: `Línea ${hit.index + 1}: sin slots en ese periodo${who ? ` por ${who}` : ""}${days ? ` (${days})` : ""}.` };
    }
    // Las contrapartes deben pertenecer al tenant y estar activas (nada
    // nuevo con archivados; lo firmado vive en el snapshot de la NP).
    const { data: cos, error: coerr } = await db
      .from("crm_companies")
      .select("id,kind,name,deleted_at")
      .eq("store_id", t.storeId)
      .eq("id", company)
      .maybeSingle();
    if (coerr) return { ok: false, message: `DB read: ${coerr.message}` };
    if (!cos) return { ok: false, message: "Empresa fuera de tu tienda." };
    {
      const { archivedBlockerMessage } = await import("@/lib/order-guards");
      const block = archivedBlockerMessage([
        {
          label: "facturador",
          archived: (cos as Record<string, unknown>).deleted_at != null,
          name: (cos as Record<string, unknown>).name as string | null,
        },
      ]);
      if (block) return { ok: false, message: block };
    }
    // El tipo manda: agencia → factura ella y el anunciante queda en la marca;
    // anunciante → anuncia y paga directo. Proveedor (o sin tipo) no puede
    // ser contratante: el picker no lo ofrece y aquí se rechaza el POST
    // directo ("contratante" marca el campo en el form).
    const kind = (cos as Record<string, unknown>).kind;
    // Anunciante: misma tienda, tipo anunciante, no archivado.
    const { data: adv, error: adverr } = await db
      .from("crm_companies")
      .select("id,kind,name,deleted_at")
      .eq("store_id", t.storeId)
      .eq("id", advertiserRaw)
      .maybeSingle();
    if (adverr || !adv) return { ok: false, message: "Anunciante no encontrado en esta tienda." };
    {
      const { archivedBlockerMessage } = await import("@/lib/order-guards");
      const block = archivedBlockerMessage([
        {
          label: "anunciante",
          archived: (adv as Record<string, unknown>).deleted_at != null,
          name: (adv as Record<string, unknown>).name as string | null,
        },
      ]);
      if (block) return { ok: false, message: block };
    }
    // Reglas puras (testeadas): anunciante tipo anunciante; contratante =
    // el propio anunciante (directo) o una agencia.
    const { resolveOrderParties } = await import("@/lib/company-links");
    const parties = resolveOrderParties({
      billingId: company,
      billingKind: kind,
      advertiserId: advertiserRaw,
      advertiserKind: (adv as Record<string, unknown>).kind,
    });
    if (!parties.ok) return { ok: false, message: parties.error };
    const billing = parties.billingCompanyId;
    const advertiser = parties.advertiserCompanyId;
    // Intermediaria (Opción B): check "es el contratante" (default) o agencia
    // definida desde Empresas. Sin texto manual: todo sale de Empresas.
    const agencySelf = String(form.get("agency_is_self") ?? "") === "1";
    let agency_company_id: string | null = null;
    if (agencySelf) {
      agency_company_id = company;
    } else {
      const agencyRaw = String(form.get("agency_company_id") ?? "").trim() || null;
      if (!agencyRaw) return { ok: false, message: "Define la intermediaria o marca que es el contratante." };
      const { data: ag, error: agerr } = await db
        .from("crm_companies")
        .select("id,kind,name,deleted_at")
        .eq("store_id", t.storeId)
        .eq("id", agencyRaw)
        .maybeSingle();
      if (agerr || !ag) return { ok: false, message: "Agencia intermediaria no encontrada en esta tienda." };
      if ((ag as Record<string, unknown>).kind !== "agencia") {
        return { ok: false, message: "La agencia intermediaria debe ser una agencia de tu tienda." };
      }
      {
        const { archivedBlockerMessage } = await import("@/lib/order-guards");
        const block = archivedBlockerMessage([
          {
            label: "intermediaria",
            archived: (ag as Record<string, unknown>).deleted_at != null,
            name: (ag as Record<string, unknown>).name as string | null,
          },
        ]);
        if (block) return { ok: false, message: block };
      }
      agency_company_id = String((ag as Record<string, unknown>).id);
    }
    // Contactos por rol: existen en la tienda y pertenecen al contratante
    // o a la intermediaria (las únicas empresas del caso). null = sin definir.
    const contactIds: Record<string, string | null> = {
      billing_contact_id: String(form.get("billing_contact_id") ?? "").trim() || null,
      signer_contact_id: String(form.get("signer_contact_id") ?? "").trim() || null,
      payment_contact_id: String(form.get("payment_contact_id") ?? "").trim() || null,
      manager_contact_id: String(form.get("manager_contact_id") ?? "").trim() || null,
    };
    const contactLabels: Record<string, string> = {
      billing_contact_id: "POC",
      signer_contact_id: "firmante",
      payment_contact_id: "pago",
      manager_contact_id: "responsable",
    };
    const wanted = Object.values(contactIds).filter((x): x is string => !!x);
    if (!contactIds.billing_contact_id) return { ok: false, message: "Contacto contratante requerido." };
    if (!contactIds.signer_contact_id) return { ok: false, message: "Firmante requerido." };
    if (wanted.length > 0) {
      const { data: found, error: cterr } = await db
        .from("crm_contacts")
        .select("id,company_id,deleted_at,first_name,last_name,email")
        .eq("store_id", t.storeId)
        .in("id", [...new Set(wanted)]);
      if (cterr) return { ok: false, message: `DB read: ${cterr.message}` };
      const allowedCompanies = new Set([company, agency_company_id].filter((x): x is string => !!x));
      const byId = new Map(
        ((found ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), r]),
      );
      const { archivedBlockerMessage } = await import("@/lib/order-guards");
      const fullName = (r: Record<string, unknown>): string | null => {
        const n = [r.first_name, r.last_name].filter((v) => typeof v === "string" && (v as string).trim()).join(" ");
        if (n) return n;
        return typeof r.email === "string" && r.email ? r.email : null;
      };
      const archivedRefs: Array<{ label: string; archived: boolean; name: string | null }> = [];
      for (const [key, cid] of Object.entries(contactIds)) {
        if (!cid) continue;
        const r = byId.get(cid);
        if (!r) return { ok: false, message: `Contacto (${contactLabels[key]}) no encontrado en esta tienda.` };
        const owner = r.company_id != null ? String(r.company_id) : null;
        if (!owner) return { ok: false, message: `Contacto (${contactLabels[key]}) no encontrado en esta tienda.` };
        if (!allowedCompanies.has(owner)) {
          return { ok: false, message: `Contacto (${contactLabels[key]}) fuera del contratante y la intermediaria.` };
        }
        archivedRefs.push({ label: contactLabels[key], archived: r.deleted_at != null, name: fullName(r) });
      }
      const block = archivedBlockerMessage(archivedRefs);
      if (block) return { ok: false, message: block };
    }
    // Auditoría: quién crea (y primer editor). Todo update futuro de la orden
    // (editar, firmar, cancelar) debe sellar updated_by + updated_at.
    const actor = await resolveActor();
    const base = {
      store_id: t.storeId,
      advertiser_company_id: advertiser,
      billing_company_id: billing,
      brand,
      notes,
      agency_company_id,
      billing_contact_id: contactIds.billing_contact_id,
      signer_contact_id: contactIds.signer_contact_id,
      payment_contact_id: contactIds.payment_contact_id,
      manager_contact_id: contactIds.manager_contact_id,
      doc_orden_medios: billingDoc === "orden_medios",
      doc_orden_compra: billingDoc === "orden_compra",
      doc_contrato: billingDoc === "contrato",
      billing_detail,
      invoice_registration,
      billing_portal_email,
      status: "draft",
      currency: orderCurrency ?? "PEN",
      // Periodo de la OI = envolvente de sus líneas (fechas inclusivas).
      starts_at: inis.reduce((a, b) => (a < b ? a : b)),
      ends_at: fins.reduce((a, b) => (a > b ? a : b)),
      payment_terms_days,
      created_by: actor,
      updated_by: actor,
    };
    // Valida pantallas del tenant antes de insertar.
    const { data: scs, error: scerr } = await db
      .from("inv_screens")
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
        .from("io_orders")
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
      const { error: lerr } = await db.from("io_lines").insert(
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
          cant_slots: l.cant_slots,
          notes: null,
        })),
      );
      if (lerr) {
        await db.from("io_orders").delete().eq("store_id", t.storeId).eq("id", ioId);
        return { ok: false, message: `DB write líneas: ${lerr.message}` };
      }
      // Vínculo explícito agencia ↔ anunciante (origin='oi', best-effort):
      // la OI asegura el par para que Vínculos lo muestre aunque sea la
      // primera operación conjunta. Nunca bloquea la creación.
      try {
        const { linkPairForOrder } = await import("@/lib/company-links");
        const pair = linkPairForOrder({
          advertiserCompanyId: advertiser,
          billingCompanyId: billing,
          agencyCompanyId: agency_company_id,
        });
        if (pair) {
          const { error: linkErr } = await db.from("crm_company_links").insert({
            store_id: t.storeId,
            agency_company_id: pair.agencyCompanyId,
            advertiser_company_id: pair.advertiserCompanyId,
            origin: "oi",
            created_by: actor,
            updated_by: actor,
          });
          if (linkErr && linkErr.code !== "23505") throw linkErr;
        }
      } catch {
        // Best-effort: la red derivada de OIs sigue mostrando la contraparte.
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

/**
 * Edición inline de la ficha (drawer): marca, condición de pago y notas.
 * No toca líneas ni fechas (afectan disponibilidad/inventario).
 * Requiere rol vendedor o superior; solo borradores (firmada/autorizada
 * congela la NP: lo firmado vive en el snapshot inmutable).
 */
export async function updateOrderAction(input: {
  orderId: string;
  patch: {
    brand?: string | null;
    payment_terms_days?: number | string | null;
    notes?: string | null;
    doc_orden_medios?: boolean | null;
    doc_orden_compra?: boolean | null;
    doc_contrato?: boolean | null;
    billing_portal_email?: string | null;
    billing_detail?: string | null;
    invoice_registration?: string | null;
    agency_company_id?: string | null;
    commission_pct?: number | string | null;
    billing_contact_id?: string | null;
    signer_contact_id?: string | null;
    payment_contact_id?: string | null;
    manager_contact_id?: string | null;
  };
}): Promise<CrmState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, message: t.error };
  const { denyRole } = await import("@/lib/tenant");
  const denied = await denyRole(t.storeId, "seller");
  if (denied) return { ok: false, message: denied };
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  try {
    const db = getSupabase();
    const { data: existing, error: rerr } = await db
      .from("io_orders")
      .select("id,status,billing_company_id")
      .eq("store_id", t.storeId)
      .eq("id", orderId)
      .maybeSingle();
    if (rerr || !existing) return { ok: false, message: "Orden no encontrada en esta tienda." };
    const st = String((existing as Record<string, unknown>).status ?? "");
    if (st === "cancelled") {
      return { ok: false, message: "La orden está cancelada." };
    }
    if (st !== "draft") {
      return { ok: false, message: "La orden ya está firmada: la ficha ya no se edita." };
    }
    const p = (input.patch ?? {}) as Record<string, unknown>;
    const brand = p.brand !== undefined ? String(p.brand ?? "").trim() || null : undefined;
    let terms: number | null | undefined;
    if (p.payment_terms_days !== undefined) {
      const raw = p.payment_terms_days;
      terms = raw === null || raw === "" ? null : Number(raw);
      if (terms !== null && (!Number.isInteger(terms) || terms < 0)) {
        return { ok: false, message: "Condición de pago inválida." };
      }
    }
    const notes = p.notes !== undefined ? String(p.notes ?? "").trim() || null : undefined;
    // Ficha NP: topes espejo del cliente (`order-validation.ts`).
    let np: Record<string, string | boolean | number | null>;
    try {
      // Sección III: checkboxes + texto libre con topes espejo del cliente.
      const bool = (key: string): boolean | undefined =>
        p[key] === undefined ? undefined : String(p[key]) === "true" || p[key] === true;
      const text500 = (key: string, label: string): string | null | undefined => {
        if (p[key] === undefined) return undefined;
        const s = String(p[key] ?? "").trim() || null;
        if (s !== null && s.length > 500) throw new Error(`${label} muy largo (máx 500).`);
        return s;
      };
      const portal_raw = p.billing_portal_email === undefined ? undefined : String(p.billing_portal_email ?? "").trim() || null;
      if (portal_raw !== undefined && portal_raw !== null && portal_raw.length > 320) {
        throw new Error("Correo y/o portal muy largo (máx 320).");
      }
      const billing_detail = text500("billing_detail", "Detalle de facturación");
      const invoice_registration = text500("invoice_registration", "Registro de factura");
      // Opción B: intermediaria vinculada (empresa del tenant).
      // El contratante (billing) se acepta tal cual (check "es el contratante",
      // cualquier kind); otra empresa debe ser agencia de la tienda.
      // Sin texto manual: todo sale de Empresas.
      let agency_company_id: string | null | undefined;
      if (p.agency_company_id !== undefined) {
        const raw = String(p.agency_company_id ?? "").trim();
        if (!raw) {
          agency_company_id = null;
        } else {
          const billingId = (existing as Record<string, unknown> | null)?.billing_company_id != null
            ? String((existing as Record<string, unknown>).billing_company_id)
            : null;
          if (billingId !== null && raw === billingId) {
            agency_company_id = raw;
          } else {
            const { data: ag, error: agerr } = await db
              .from("crm_companies")
              .select("id,kind,name,deleted_at")
              .eq("store_id", t.storeId)
              .eq("id", raw)
              .maybeSingle();
            if (agerr || !ag) throw new Error("Agencia intermediaria no encontrada en esta tienda.");
            if ((ag as Record<string, unknown>).kind !== "agencia") {
              throw new Error("La agencia intermediaria debe ser una agencia de tu tienda.");
            }
            if ((ag as Record<string, unknown>).deleted_at != null) {
              throw new Error(
                `Intermediaria (${String((ag as Record<string, unknown>).name ?? "").trim() || "sin nombre"}) archivada: restáurala para operar con esta orden.`,
              );
            }
            agency_company_id = String((ag as Record<string, unknown>).id);
          }
        }
      }
      let commission_pct: number | null | undefined;
      if (p.commission_pct !== undefined) {
        const { normalizeCommissionPct } = await import("@/lib/agency-commission");
        const raw = p.commission_pct;
        const wantsClear = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
        if (wantsClear) {
          commission_pct = null;
        } else {
          const pct = normalizeCommissionPct(raw);
          if (pct === null) throw new Error("Comisión inválida (entero 0-100).");
          const { denyRole } = await import("@/lib/tenant");
          const denied = await denyRole(t.storeId, "admin", "La comisión por orden requiere rol admin o propietario.");
          if (denied) throw new Error(denied);
          commission_pct = pct;
        }
      }
      np = {
        doc_orden_medios: bool("doc_orden_medios") ?? false,
        doc_orden_compra: bool("doc_orden_compra") ?? false,
        doc_contrato: bool("doc_contrato") ?? false,
        billing_portal_email: portal_raw ?? null,
        billing_detail: billing_detail ?? null,
        invoice_registration: invoice_registration ?? null,
      };
      if (agency_company_id !== undefined) np.agency_company_id = agency_company_id;
      if (commission_pct !== undefined) np.commission_pct = commission_pct;
      // Contactos por rol (FK): existen en la tienda. null/vacío = desvincular.
      // El GUI ofrece solo contactos de las empresas del caso.
      const contactLink = async (key: string, label: string): Promise<string | null | undefined> => {
        if (p[key] === undefined) return undefined;
        const raw = String(p[key] ?? "").trim();
        if (!raw) return null;
        const { data: ct, error: cterr } = await db
          .from("crm_contacts")
          .select("id,deleted_at,first_name,last_name,email")
          .eq("store_id", t.storeId)
          .eq("id", raw)
          .maybeSingle();
        if (cterr || !ct) throw new Error(`Contacto (${label}) no encontrado en esta tienda.`);
        if ((ct as Record<string, unknown>).deleted_at != null) {
          throw new Error(`Contacto (${label}) archivado: restáuralo para operar con esta orden.`);
        }
        return String((ct as Record<string, unknown>).id);
      };
      const billing_contact_id = await contactLink("billing_contact_id", "POC");
      const signer_contact_id = await contactLink("signer_contact_id", "firmante");
      const payment_contact_id = await contactLink("payment_contact_id", "pago");
      const manager_contact_id = await contactLink("manager_contact_id", "responsable");
      if (billing_contact_id !== undefined) np.billing_contact_id = billing_contact_id;
      if (signer_contact_id !== undefined) np.signer_contact_id = signer_contact_id;
      if (payment_contact_id !== undefined) np.payment_contact_id = payment_contact_id;
      if (manager_contact_id !== undefined) np.manager_contact_id = manager_contact_id;
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Campo inválido." };
    }
    const patch: Record<string, unknown> = {};
    if (brand !== undefined) patch.brand = brand;
    if (terms !== undefined) patch.payment_terms_days = terms;
    if (notes !== undefined) patch.notes = notes;
    for (const [k, v] of Object.entries(np)) {
      if (p[k] !== undefined) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) return { ok: true, message: "Sin cambios." };
    const actor = await resolveActor();
    const { error } = await db
      .from("io_orders")
      .update({ ...patch, updated_at: new Date().toISOString(), updated_by: actor })
      .eq("store_id", t.storeId)
      .eq("id", orderId);
    if (error) return { ok: false, message: `DB write: ${error.message}` };
    // Si cambió la intermediaria, asegura el vínculo explícito (origin='oi').
    if (p.agency_company_id !== undefined) {
      try {
        const { data: after } = await db
          .from("io_orders")
          .select("advertiser_company_id,billing_company_id,agency_company_id")
          .eq("store_id", t.storeId)
          .eq("id", orderId)
          .maybeSingle();
        const r = (after ?? {}) as Record<string, unknown>;
        const { linkPairForOrder } = await import("@/lib/company-links");
        const pair = linkPairForOrder({
          advertiserCompanyId: typeof r.advertiser_company_id === "string" ? r.advertiser_company_id : null,
          billingCompanyId: typeof r.billing_company_id === "string" ? r.billing_company_id : null,
          agencyCompanyId: typeof r.agency_company_id === "string" ? r.agency_company_id : null,
        });
        if (pair) {
          const { error: linkErr } = await db.from("crm_company_links").insert({
            store_id: t.storeId,
            agency_company_id: pair.agencyCompanyId,
            advertiser_company_id: pair.advertiserCompanyId,
            origin: "oi",
            created_by: actor,
            updated_by: actor,
          });
          if (linkErr && linkErr.code !== "23505") throw linkErr;
        }
      } catch {
        // Best-effort: no bloquea la edición de la ficha.
      }
    }
    revalidatePath("/orders");
    return { ok: true, message: "Orden actualizada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export interface AvailabilityState {
  ok: boolean;
  conflicts: ScreenConflict[];
  /** screenId → día "yyyy-mm-dd" → slots libres (ventana pedida). */
  remaining: Record<string, Record<string, number>>;
  capacities: Record<string, number>;
  message: string;
}

/**
 * Reemplaza las líneas de una orden en borrador (editar pantallas).
 * Solo borradores sin facturas ni reservas: firmadas tienen bookings y
 * cobranza que no se rebookean aquí. Chequeo anti-sobreventa excluyendo la
 * propia orden + reemplazo atómico vía `io_replace_lines`.
 * Requiere rol vendedor o superior.
 */
export async function updateOrderLinesAction(input: {
  orderId: string;
  lines: Array<{
    screen_id: unknown;
    starts: unknown;
    ends: unknown;
    total: unknown;
    slots?: unknown;
    notes?: unknown;
  }>;
}): Promise<CrmState> {
  const t = await resolveTenantStore("seller");
  if ("error" in t) return { ok: false, message: t.error };
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  const { validateOrderLines, totalToMinor, findLineOverlaps, normalizeLineSlots } = await import("@/lib/order-lines");
  const lines = ((input.lines ?? []) as Array<Record<string, unknown>>).map((l) => ({
    screen_id: typeof l.screen_id === "string" ? l.screen_id.trim() : "",
    starts: typeof l.starts === "string" ? l.starts.trim() : "",
    ends: typeof l.ends === "string" ? l.ends.trim() : "",
    total: (l.total as string | number) ?? "",
    // Sin coalescer a "": ausente (legacy/API) = default 1, explícito vacío = inválido (fail-closed).
    slots: (l.slots as string | number | undefined) ?? undefined,
    notes: typeof l.notes === "string" ? l.notes : null,
  }));
  const problems = validateOrderLines(lines);
  if (problems.length > 0) return { ok: false, message: problems[0]?.message ?? "Líneas inválidas." };
  if (findLineOverlaps(lines).length > 0) {
    return { ok: false, message: "Dos líneas usan la misma pantalla en periodos que se cruzan." };
  }
  const slotsList = lines.map((l) => normalizeLineSlots(l.slots));
  if (slotsList.some((x) => x === null)) return { ok: false, message: "Línea con slots inválidos (1–100)." };
  try {
    const db = getSupabase();
    const { data: existing, error: rerr } = await db
      .from("io_orders")
      .select("id,status")
      .eq("store_id", t.storeId)
      .eq("id", orderId)
      .maybeSingle();
    if (rerr || !existing) return { ok: false, message: "Orden no encontrada en esta tienda." };
    if (String((existing as Record<string, unknown>).status ?? "") !== "draft") {
      return { ok: false, message: "Solo borradores: las líneas de una orden avanzada ya no se editan." };
    }
    // Pantallas del tenant.
    const screenIds = [...new Set(lines.map((l) => l.screen_id))];
    const { data: scs, error: scerr } = await db
      .from("inv_screens")
      .select("id")
      .eq("store_id", t.storeId)
      .in("id", screenIds);
    if (scerr) return { ok: false, message: `DB read: ${scerr.message}` };
    if ((scs ?? []).length !== screenIds.length) {
      return { ok: false, message: "Pantalla fuera de tu inventario." };
    }
    // Sin facturas ni reservas: el bruto y la ocupación ya corrieron.
    const [{ count: invCount }, { count: bookCount }] = await Promise.all([
      db.from("io_invoices").select("id", { count: "exact", head: true }).eq("store_id", t.storeId).eq("io_id", orderId),
      db.from("inv_bookings").select("id", { count: "exact", head: true }).eq("store_id", t.storeId).eq("insertion_order_id", orderId),
    ]);
    if ((invCount ?? 0) > 0) return { ok: false, message: "La orden tiene facturas: las líneas ya no se editan." };
    if ((bookCount ?? 0) > 0) return { ok: false, message: "La orden tiene reservas: las líneas ya no se editan." };
    // Anti-sobreventa por día (sin la propia orden): cada línea pide sus slots
    // (su periodo × su q, comparación inclusiva por días bloqueados).
    const { findLineConflicts } = await import("@/lib/availability");
    const hit = await findLineConflicts(
      t.storeId,
      lines.map((l, i) => ({ screen_id: l.screen_id, starts: l.starts, ends: l.ends, slots: slotsList[i] ?? 1 })),
      { excludeIoId: orderId },
    );
    if (hit) {
      const who = [hit.conflict.io_number, hit.conflict.brand].filter(Boolean).join(" · ");
      const days = (hit.conflict.blockedDays ?? []).map((d) => formatDate(d)).join(", ");
      return { ok: false, message: `Línea ${hit.index + 1}: sin slots en ese periodo${who ? ` por ${who}` : ""}${days ? ` (${days})` : ""}.` };
    }
    const totals = lines.map((l) => totalToMinor(l.total));
    if (totals.some((x) => x === null)) return { ok: false, message: "Línea con total inválido." };
    const actor = await resolveActor();
    const { error: rpcerr } = await db.rpc("io_replace_lines", {
      p_store: t.storeId,
      p_io: orderId,
      p_lines: lines.map((l, i) => ({
        screen_id: l.screen_id,
        starts: l.starts,
        ends: l.ends,
        total: (totals[i] as number) / 100,
        slots: slotsList[i] as number,
        notes: typeof l.notes === "string" && l.notes.trim() ? l.notes.trim().slice(0, 2000) : null,
      })),
      p_actor: actor,
    });
    if (rpcerr) return { ok: false, message: rpcerr.message };
    revalidatePath("/orders");
    return { ok: true, message: "Pantallas actualizadas." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

/** Disponibilidad por periodo para el formulario (el server action revalida al crear).
 *  `excludeIoId`: editar sin chocar consigo misma. `screenIds` + `slots`:
 *  pantallas evaluadas con su cupo pedido (resto visible); el resto del
 *  inventario se evalúa con 1 slot para los badges del picker. */
export async function checkAvailabilityAction(input: {
  starts: string;
  ends: string;
  excludeIoId?: string | null;
  screenIds?: string[];
  slots?: Record<string, number>;
}): Promise<AvailabilityState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, conflicts: [], remaining: {}, capacities: {}, message: t.error };
  if (!isISODateShape(input.starts) || !isISODateShape(input.ends) || input.ends < input.starts) {
    return { ok: false, conflicts: [], remaining: {}, capacities: {}, message: "Periodo inválido." };
  }
  try {
    const exclude = typeof input.excludeIoId === "string" && input.excludeIoId ? input.excludeIoId : null;
    const ids = [...new Set((input.screenIds ?? []).map(String).filter(Boolean))].slice(0, 200);
    const { getPeriodAvailability } = await import("@/lib/availability");
    const res = await getPeriodAvailability(t.storeId, ids.length > 0 ? ids : null, input.starts, input.ends, {
      excludeIoId: exclude,
      slots: input.slots ?? {},
    });
    return { ok: true, conflicts: res.conflicts, remaining: res.remaining, capacities: res.capacities, message: "" };
  } catch (e) {
    return { ok: false, conflicts: [], remaining: {}, capacities: {}, message: e instanceof Error ? e.message : "Error." };
  }
}

export interface OccupancyState {
  ok: boolean;
  occupancy: Record<string, Array<{ starts: string; ends: string }>>;
  capacities: Record<string, number>;
  message: string;
}

/** Rangos sin cupo por pantalla (calendarios de disponibilidad, próximo hueco).
 *  `slots`: cupo pedido por pantalla para rangos relativos a la reserva. */
export async function getScreenOccupancyAction(input: {
  screenIds: string[];
  from: string;
  excludeIoId?: string | null;
  slots?: Record<string, number>;
}): Promise<OccupancyState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, occupancy: {}, capacities: {}, message: t.error };
  const ids = [...new Set((input.screenIds ?? []).map(String).filter(Boolean))].slice(0, 200);
  if (ids.length === 0 || !isISODateShape(input.from)) {
    return { ok: false, occupancy: {}, capacities: {}, message: "Parámetros inválidos." };
  }
  try {
    const exclude = typeof input.excludeIoId === "string" && input.excludeIoId ? input.excludeIoId : null;
    const { getScreenCapacities } = await import("@/lib/availability");
    const [occupancy, caps] = await Promise.all([
      getScreenOccupancy(t.storeId, ids, input.from, { excludeIoId: exclude, slots: input.slots ?? {} }),
      getScreenCapacities(t.storeId, ids),
    ]);
    return { ok: true, occupancy, capacities: Object.fromEntries(caps.entries()), message: "" };
  } catch (e) {
    return { ok: false, occupancy: {}, capacities: {}, message: e instanceof Error ? e.message : "Error." };
  }
}

export interface ScreenDayLine {
  io_number: string | null;
  brand: string | null;
  slots: number;
  status: string;
  starts: string;
  ends: string;
  source: "order" | "booking";
}

export interface ScreenDayDetail {
  ok: boolean;
  screenId: string;
  screenName: string | null;
  day: string;
  capacity: number;
  reserved: number;
  lines: ScreenDayLine[];
  message: string;
}

/** Desglose de un día-pantalla para el drawer de la matriz (quién ocupa).
 *  Misma semántica vigente que lib/availability: excluye canceladas y
 *  borradores vencidos (el hold aparta 7 días). */
export async function getScreenDayDetailAction(input: {
  screenId: string;
  day: string;
}): Promise<ScreenDayDetail> {
  const fail = (message: string): ScreenDayDetail => ({
    ok: false, screenId: "", screenName: null, day: "", capacity: 0, reserved: 0, lines: [], message,
  });
  const t = await resolveTenantStore();
  if ("error" in t) return fail(t.error);
  const screenId = String(input.screenId ?? "").trim();
  const day = String(input.day ?? "").trim();
  if (!screenId || !isISODateShape(day)) return fail("Parámetros inválidos.");
  try {
    const db = getSupabase();
    const { data: scr } = await db
      .from("inv_screens")
      .select("id,name")
      .eq("store_id", t.storeId)
      .eq("id", screenId)
      .maybeSingle();
    if (!scr) return fail("Pantalla no encontrada en esta tienda.");
    const { getScreenCapacities, isHoldFresh, displayEndOf } = await import("@/lib/availability");
    const caps = await getScreenCapacities(t.storeId, [screenId]);
    const capacity = caps.get(screenId) ?? DEFAULT_SLOTS_PER_SCREEN;
    const qStart = limaDayStart(day);
    const qEnd = limaDayStart(addDays(day, 1));
    const lines: ScreenDayLine[] = [];
    const { data: olines, error: lerr } = await db
      .from("io_lines")
      .select("starts_at,ends_at,cant_slots,io_orders!insertion_order_lines_io_id_fkey!inner(io_number,brand,status,created_at)")
      .eq("store_id", t.storeId)
      .eq("screen_id", screenId)
      .lt("starts_at", qEnd)
      .gt("ends_at", qStart);
    if (lerr) return fail(`DB read: ${lerr.message}`);
    for (const l of (olines ?? []) as Array<Record<string, unknown>>) {
      const o = l.io_orders as unknown as Record<string, unknown> | null;
      if (!o || o.status === "cancelled") continue;
      if (o.status === "draft" && !isHoldFresh(typeof o.created_at === "string" ? o.created_at : null)) continue;
      const qty = Number(l.cant_slots ?? 1);
      lines.push({
        io_number: typeof o.io_number === "string" ? o.io_number : null,
        brand: typeof o.brand === "string" ? o.brand : null,
        slots: Number.isFinite(qty) && qty >= 1 ? Math.floor(qty) : 1,
        status: typeof o.status === "string" ? o.status : "—",
        starts: isoDayPart(l.starts_at) ?? "",
        ends: displayEndOf(String(l.ends_at)),
        source: "order",
      });
    }
    const { data: slotRows, error: slotErr } = await db
      .from("inv_slots")
      .select("id")
      .eq("store_id", t.storeId)
      .eq("screen_id", screenId);
    if (slotErr) return fail(`DB read: ${slotErr.message}`);
    const slotIds = ((slotRows ?? []) as Array<Record<string, unknown>>).map((s) => String(s.id));
    if (slotIds.length > 0) {
      const { data: books, error: bookErr } = await db
        .from("inv_bookings")
        .select("starts_at,ends_at,status,io_orders!bookings_insertion_order_id_fkey(io_number,brand)")
        .eq("store_id", t.storeId)
        .in("slot_id", slotIds)
        .neq("status", "cancelled")
        .lt("starts_at", qEnd)
        .gt("ends_at", qStart);
      if (bookErr) return fail(`DB read: ${bookErr.message}`);
      for (const b of ((books ?? []) as Array<Record<string, unknown>>)) {
        const o = b.io_orders as unknown as Record<string, unknown> | null;
        lines.push({
          io_number: o && typeof o.io_number === "string" ? o.io_number : null,
          brand: o && typeof o.brand === "string" ? o.brand : null,
          slots: 1,
          status: typeof b.status === "string" ? b.status : "—",
          starts: isoDayPart(b.starts_at) ?? "",
          ends: displayEndOf(String(b.ends_at)),
          source: "booking",
        });
      }
    }
    lines.sort((a, b) => (a.starts < b.starts ? -1 : a.starts > b.starts ? 1 : 0));
    const reserved = lines.reduce((a, l) => a + l.slots, 0);
    return {
      ok: true,
      screenId,
      screenName: typeof (scr as Record<string, unknown>).name === "string" ? String((scr as Record<string, unknown>).name) : null,
      day,
      capacity,
      reserved,
      lines,
      message: "",
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Error.");
  }
}
