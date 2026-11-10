"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { resolveTenantStoreAction as resolveTenantStore } from "@/lib/tenant";
import { getScreenConflicts, getScreenOccupancy, type ScreenConflict } from "@/lib/availability";
import { resolveActor } from "@/lib/actor";
import { isValidCurrency, normalizeCurrency } from "@/lib/currency";
import { addDays, isISODateShape, limaDayStart } from "@/lib/format";
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
  const nextDayLima = (d: string): string => limaDayStart(addDays(d, 1));
  for (let i = 0; i < screens.length; i++) {
    if (!inis[i] || !fins[i]) return { ok: false, message: `Línea ${i + 1}: periodo requerido.` };
    if (fins[i] < inis[i]) return { ok: false, message: `Línea ${i + 1}: fin anterior al inicio.` };
    const total = Number(totals[i]);
    if (!Number.isFinite(total) || total <= 0) return { ok: false, message: `Línea ${i + 1}: total inválido.` };
    const cant = dias[i] ? Number(dias[i]) : NaN;
    parsedLines.push({
      screen: screens[i],
      starts: limaDayStart(inis[i]),
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
    // anunciante → anuncia y paga directo.
    const isAgency = (cos as Record<string, unknown>).kind === "agencia";
    const billing = company;
    const advertiser = isAgency ? null : company;
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
          notes: null,
        })),
      );
      if (lerr) {
        await db.from("io_orders").delete().eq("store_id", t.storeId).eq("id", ioId);
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

/**
 * Edición inline de la ficha (drawer): marca, condición de pago y notas.
 * No toca líneas ni fechas (afectan disponibilidad/inventario).
 * Requiere rol vendedor o superior; bloqueada si la orden está cancelada.
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
    if (String((existing as Record<string, unknown>).status ?? "") === "cancelled") {
      return { ok: false, message: "La orden está cancelada." };
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
    revalidatePath("/orders");
    return { ok: true, message: "Orden actualizada." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error." };
  }
}

export interface AvailabilityState {
  ok: boolean;
  conflicts: ScreenConflict[];
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
    notes?: unknown;
  }>;
}): Promise<CrmState> {
  const t = await resolveTenantStore("seller");
  if ("error" in t) return { ok: false, message: t.error };
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return { ok: false, message: "Falta la orden." };
  const { validateOrderLines, totalToMinor, findLineOverlaps } = await import("@/lib/order-lines");
  const { rangesOverlap } = await import("@/lib/availability");
  const lines = ((input.lines ?? []) as Array<Record<string, unknown>>).map((l) => ({
    screen_id: typeof l.screen_id === "string" ? l.screen_id.trim() : "",
    starts: typeof l.starts === "string" ? l.starts.trim() : "",
    ends: typeof l.ends === "string" ? l.ends.trim() : "",
    total: (l.total as string | number) ?? "",
    notes: typeof l.notes === "string" ? l.notes : null,
  }));
  const problems = validateOrderLines(lines);
  if (problems.length > 0) return { ok: false, message: problems[0]?.message ?? "Líneas inválidas." };
  if (findLineOverlaps(lines).length > 0) {
    return { ok: false, message: "Dos líneas usan la misma pantalla en periodos que se cruzan." };
  }
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
    // Anti-sobreventa (sin la propia orden).
    const inis = lines.map((l) => l.starts).reduce((a, b) => (a < b ? a : b));
    const fins = lines.map((l) => l.ends).reduce((a, b) => (a > b ? a : b));
    const conflicts = await getScreenConflicts(t.storeId, inis, fins, { excludeIoId: orderId });
    for (const l of lines) {
      const hit = conflicts.find(
        (c) => c.screen_id === l.screen_id && rangesOverlap(c.starts, c.ends, l.starts, l.ends),
      );
      if (hit) {
        const who = [hit.io_number, hit.brand].filter(Boolean).join(" · ");
        return { ok: false, message: `Pantalla ocupada en ese periodo${who ? ` por ${who}` : ""}.` };
      }
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

/** Disponibilidad por periodo para el formulario (el server action revalida al crear). */
export async function checkAvailabilityAction(input: {
  starts: string;
  ends: string;
}): Promise<AvailabilityState> {
  const t = await resolveTenantStore();
  if ("error" in t) return { ok: false, conflicts: [], message: t.error };
  if (!isISODateShape(input.starts) || !isISODateShape(input.ends) || input.ends < input.starts) {
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
  if (ids.length === 0 || !isISODateShape(input.from)) {
    return { ok: false, occupancy: {}, message: "Parámetros inválidos." };
  }
  try {
    return { ok: true, occupancy: await getScreenOccupancy(t.storeId, ids, input.from), message: "" };
  } catch (e) {
    return { ok: false, occupancy: {}, message: e instanceof Error ? e.message : "Error." };
  }
}
