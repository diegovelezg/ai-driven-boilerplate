// Backfill NP con datos de la ficha (red de seguridad idempotente).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/backfill-np-smartmedia.ts
// Solo rellena nulos: re-ejecutable y respeta ediciones manuales.
// El seed-ois-smartmedia ya inserta estos mismos valores; este script los
// verifica/repara en DBs sembradas con versiones anteriores del seed.
// Cubre: intermediaria vinculada, contactos por rol, docs,
// portal/pago/detalle/registro, % por agencia + override.
//   NP-2026-001: todo lleno (caso referencia Tottus/Publicis; POC y firma en
//     la agencia Starcom que opera la cuenta, pago en el anunciante).
//   NP-2026-002: agencia cliente + override 10 (precedencia vs default 15).
//   NP-2026-003: sin pago/responsable (prueba "Sin definir"); los buzones
//     OMNET viven en billing_portal_email, no en contactos.
//   NP-2026-004: sin responsable.
//   NP-2026-005: continuidad Corolla (agencia cliente, portal Apex).
import { getSupabase } from "@/lib/supabase";
import { fail, loadStoreId } from "./lib/run-once";

const AGENCY_PCT: Record<string, number> = {
  "20476465614": 15, // PUBLICIS GROUPE
  "20100335604": 15, // PUBLICIS ASOCIADOS
  "20609099888": 12, // MEDIA DIALOGUE
  "20600995031": 18, // HAVAS
};

interface OrderFill {
  io_number: string;
  agency_tax_id: string | null;
  poc_email?: string | null;
  signer_email?: string | null;
  payment_email?: string | null;
  manager_email?: string | null;
  doc_orden_medios?: boolean | null;
  doc_orden_compra?: boolean | null;
  doc_contrato?: boolean | null;
  billing_portal_email?: string | null;
  billing_detail?: string | null;
  invoice_registration?: string | null;
  commission_pct?: number | null;
}

const ORDERS: OrderFill[] = [
  {
    io_number: "NP-2026-001",
    agency_tax_id: "20476465614",
    poc_email: "milu.palacios@starcomww.com",
    signer_email: "milu.palacios@starcomww.com",
    payment_email: "lcabezas@tottus.com.pe",
    manager_email: "carla.espinoza@starcomww.com",
    doc_orden_medios: true,
    doc_orden_compra: true,
    billing_portal_email: "Hipermercados Tottus S.A. | dte_20508565934@paperless.pe",
    billing_detail: "Antes de facturar, debe esperar el número de recepción (HES) correspondiente. Emita solo una factura por cada Orden de Compra",
    invoice_registration: "Envíe su factura a más tardar el día 3 desde su fecha de emisión. Según detalle en adjunto y el Portal en el correo",
  },
  {
    io_number: "NP-2026-002",
    agency_tax_id: "20100335604",
    poc_email: "diego.pena@apxexchange.com",
    signer_email: "diego.pena@apxexchange.com",
    payment_email: "paola.alban@apxexchange.com",
    doc_orden_medios: true,
    billing_portal_email: "APEX EXCHANGE",
    billing_detail: "Se factura a inicios del mes siguiente, previa aprobación de estado de cuenta",
    commission_pct: 10,
  },
  {
    io_number: "NP-2026-003",
    agency_tax_id: "20609099888",
    poc_email: "itryon@targooh.com",
    signer_email: "itryon@targooh.com",
    doc_orden_medios: true,
    billing_portal_email: "Portal OMNET — recepcionfacturasmd@omnicommediagroup.com.pe; jtoyama@omnicommediagroup.com.pe",
    billing_detail: "Se factura a inicios del mes siguiente previa aprobación de estado de cuenta y RF",
  },
  {
    io_number: "NP-2026-004",
    agency_tax_id: "20600995031",
    poc_email: "francisco.garcia@havasmn.com",
    signer_email: "francisco.garcia@havasmn.com",
    payment_email: "catalina.villon@havasmn.com",
    doc_orden_medios: true,
    billing_detail: "Artes con 24h de anticipación en horario laboral",
  },
  {
    io_number: "NP-2026-005",
    agency_tax_id: "20100335604",
    poc_email: "diego.pena@apxexchange.com",
    signer_email: "diego.pena@apxexchange.com",
    payment_email: "paola.alban@apxexchange.com",
    doc_orden_medios: true,
    billing_portal_email: "APEX EXCHANGE",
    billing_detail: "Se factura a inicios del mes siguiente, previa aprobación de estado de cuenta",
  },
];

async function main() {
  const storeId = await loadStoreId();
  const db = getSupabase();

  // 1. % por agencia (solo nulos).
  for (const [taxId, pct] of Object.entries(AGENCY_PCT)) {
    const { error } = await db
      .from("crm_companies")
      .update({ agency_commission_pct: pct })
      .eq("store_id", storeId)
      .eq("tax_id", taxId)
      .is("agency_commission_pct", null);
    if (error) throw new Error(`commission ${taxId}: ${error.message}`);
  }
  console.log("agency pct ok");

  // 2. Ids de empresas y contactos.
  const { data: cos } = await db
    .from("crm_companies")
    .select("id,tax_id")
    .eq("store_id", storeId);
  const coByTax = new Map(((cos ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.tax_id), String(c.id)]));
  const { data: cts } = await db
    .from("crm_contacts")
    .select("id,email")
    .eq("store_id", storeId);
  const ctByEmail = new Map(
    ((cts ?? []) as Array<Record<string, unknown>>)
      .filter((c) => typeof c.email === "string" && c.email)
      .map((c) => [String(c.email).toLowerCase(), String(c.id)]),
  );

  // 3. Órdenes: rellena nulos.
  for (const o of ORDERS) {
    const { data: row, error: rerr } = await db
      .from("io_orders")
      .select("*")
      .eq("store_id", storeId)
      .eq("io_number", o.io_number)
      .maybeSingle();
    if (rerr || !row) throw new Error(`${o.io_number}: no encontrada (${rerr?.message ?? "?"})`);
    const cur = row as Record<string, unknown>;
    const contactId = (email?: string | null): string | null => {
      if (!email) return null;
      return ctByEmail.get(email.toLowerCase()) ?? null;
    };
    const missingContact = [o.poc_email, o.signer_email, o.payment_email, o.manager_email]
      .filter(Boolean)
      .map((e) => e as string)
      .filter((e) => !ctByEmail.has(e.toLowerCase()));
    if (missingContact.length > 0) throw new Error(`${o.io_number}: contactos inexistentes: ${missingContact.join(", ")}`);
    const agencyId = o.agency_tax_id ? (coByTax.get(o.agency_tax_id) ?? null) : null;
    if (o.agency_tax_id && !agencyId) throw new Error(`${o.io_number}: agencia inexistente (${o.agency_tax_id})`);
    const patch: Record<string, unknown> = {
      agency_company_id: agencyId,
      billing_contact_id: contactId(o.poc_email),
      signer_contact_id: contactId(o.signer_email),
      payment_contact_id: contactId(o.payment_email),
      manager_contact_id: contactId(o.manager_email),
      doc_orden_medios: o.doc_orden_medios ?? false,
      doc_orden_compra: o.doc_orden_compra ?? false,
      doc_contrato: o.doc_contrato ?? false,
      billing_portal_email: o.billing_portal_email ?? null,
      billing_detail: o.billing_detail ?? null,
      invoice_registration: o.invoice_registration ?? null,
      commission_pct: o.commission_pct ?? null,
    };
    // Solo nulos (respeta ediciones manuales; false en docs cuenta como vacío).
    const fill: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      const isEmpty = cur[k] === null || cur[k] === undefined || cur[k] === false || cur[k] === "";
      if (isEmpty && v !== null && v !== undefined && v !== false) fill[k] = v;
    }
    if (Object.keys(fill).length === 0) {
      console.log(`${o.io_number}: completo, nada que hacer.`);
      continue;
    }
    const { error: uerr } = await db.from("io_orders").update(fill).eq("store_id", storeId).eq("id", cur.id);
    if (uerr) throw new Error(`${o.io_number}: ${uerr.message}`);
    console.log(`${o.io_number}: relleno ${Object.keys(fill).join(", ")}`);
  }

  // 4. Distrito del venue seed (columna DISTRITO del PDF).
  await db
    .from("inv_venues")
    .update({ district: "Miraflores" })
    .eq("store_id", storeId)
    .eq("external_ref", "venue-miraflores-01")
    .is("district", null);
  console.log("venue district ok");
}

main().catch((e) => fail("BACKFILL-NP", e));
