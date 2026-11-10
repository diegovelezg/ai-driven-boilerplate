// Seed inicial CRM/DOOH desde las 4 OIs de SMART MEDIA (Drive SMART MEDIA)
// + NP-2026-005 de continuidad (demo relevo/renovación).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/seed-ois-smartmedia.ts
// Re-ejecutable: por cada entidad busca antes de insertar (tax_id/email/
// io_number/código OM/nombre creative); lo existente se respeta.
// Las NP-2026-00x son la numeración del cliente: la migración
// 20261120 las renumera a numeración propia SM-2026-00x (se ignoran).
// Modelo: companies.kind (agencia|anunciante|proveedor, obligatorio en CRM);
// la fila "sm" (red propia / operadora) respalda venues.company_id y
// se excluye del listado de Empresas. La marca publicitada es metadato
// (io_orders.brand), no empresa.
// Fuentes:
//   NP-2026-001 Tottus Pre Navidad  <- "NP - Compra Nov - Navidad.pdf"
//   NP-2026-002 Toyota bz4x          <- "NP - Toyota Híbridos.xlsx"
//   NP-2026-003 Pacífico Vida       <- "NP PACIFICO - CON OMNET.xlsx"
//   NP-2026-004 Qroma Nov 2026 (CPP) <- "SMARTMEDIA NP - Qroma Noviembre 2026.pdf"
//   NP-2026-005 Toyota Corolla (continuidad, dummy coherente, sin fuente: es
//     el relevo de NP-2026-002 y el caso sin_facturar/renovación del inbox).
//
// CONTRATO DE COHERENCIA (set limpio):
//   - Pantallas intactas: MI001/MI004/MI007/MI009/MI010 (no se tocan).
//   - companies.domain único y = dominio mayoritario de sus contactos.
//   - Todo contacto tiene persona (nombre); los buzones portal viven en
//     io_orders.billing_portal_email, no en crm_contacts.
//   - Cada orden trae sus FKs (agency + contactos por rol), docs y portal:
//     el backfill-np-smartmedia queda como red de seguridad idempotente.
//   - OM / creatives / fotos sembrados para que el inbox derive hechos
//     exactos del snapshot (matriz verificada el 2026-11-09, hoy=09/11):
//       NP-001 sin OM            -> sin_om (du=-6)
//       NP-002 con OM, sin foto  -> por_certificar (terminó 20/10)
//       NP-003 con OM, sin foto  -> sin_evidencia (al aire ds=14)
//       NP-004 con OM+foto, sin material -> material (du=-8)
//       NP-005 con OM+material+foto -> termina_sin_relevo (vence 15/11)
//         + sin_facturar (firmada sin facturas); ocupación/huecos/relevo 30d
//         viven en el dashboard, no en el inbox
import { getSupabase } from "@/lib/supabase";
import { fail, loadStoreId } from "./lib/run-once";

const DRIVE_FOLDER = "https://drive.google.com/drive/folders/1JwGeCaPYT4qrLw-U6cfK6xprm3jABfE";

interface CompanySeed {
  key: string;
  name: string;
  tax_id?: string | null;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  domain?: string;
  kind?: "agencia" | "anunciante" | "proveedor" | null;
  agency_pct?: number | null;
  notes?: string;
}

const COMPANIES: CompanySeed[] = [
  {
    key: "sm",
    name: "STRONG MINDS PERU SAC",
    tax_id: "20600666488",
    email: "operaciones@smartmedia.pe",
    address: "Av. Paseo de la República 3565 Int. 301, San Isidro",
    city: "Lima",
    domain: "smartmedia.pe",
    phone: "986 634 800",
    notes: "Nombre comercial: SMART MEDIA. Red propia / operadora.",
  },
  {
    key: "tottus",
    name: "Hipermercados Tottus S.A.",
    tax_id: "20508565934",
    email: "facturacion@tottus.com.pe",
    address: "Av. Angamos Este Nro. 1805 Int. P10 (Piso 10 Of 5 y Piso 11 Of 6a), Surquillo",
    city: "Lima",
    domain: "tottus.com.pe",
    kind: "anunciante",
    notes: "Anunciante directo (compra y paga OI Tottus Pre Navidad).",
  },
  {
    key: "pubgroupe",
    name: "PUBLICIS GROUPE MEDIA PERU SAC",
    tax_id: "20476465614",
    email: "trafico@starcomww.com",
    domain: "starcomww.com",
    kind: "agencia",
    agency_pct: 15,
    notes: "Agencia intermediaria OI Tottus (no factura). Opera la cuenta desde Starcom.",
  },
  {
    key: "pubasoc",
    name: "PUBLICIS ASOCIADOS SAC",
    tax_id: "20100335604",
    email: "trafico@apxexchange.com",
    domain: "apxexchange.com",
    kind: "agencia",
    agency_pct: 15,
    notes: "Agencia (facturación OI Toyota, marca bz4x). Buzón operativo Apex.",
  },
  {
    key: "pacifico",
    name: "PACIFICO COMPAÑIA DE SEGUROS Y REASEGUROS",
    tax_id: "20332970411",
    email: "compras@pacifico.com.pe",
    domain: "pacifico.com.pe",
    kind: "anunciante",
    notes: "Anunciante (compra vía Media Dialogue). Campaña PACÍFICO VIDA - OCT/NOV.",
  },
  {
    key: "mdialogue",
    name: "MEDIA DIALOGUE S.A.C.",
    tax_id: "20609099888",
    email: "planning@targooh.com",
    domain: "targooh.com",
    kind: "agencia",
    agency_pct: 12,
    notes: "Agencia (facturación OI Pacífico, portal OMNET). Planning opera desde Targooh.",
  },
  {
    key: "havas",
    name: "ESPECIALIDADES DIGITALES INTERNACIONALES S.A.C",
    tax_id: "20600995031",
    email: "trafico@havasmn.com",
    domain: "havasmn.com",
    kind: "agencia",
    agency_pct: 18,
    notes: "Agencia Havas Media Network (facturación OI Qroma, marca CPP).",
  },
];

interface ContactSeed {
  company: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone?: string;
  job_title?: string;
  is_primary?: boolean;
  notes?: string;
}

const CONTACTS: ContactSeed[] = [
  { company: "sm", first_name: "Santiago", last_name: "Llaury", email: "sllaury@smartmedia.pe", phone: "998 139 849", job_title: "Gerente General", is_primary: true },
  { company: "sm", first_name: "Giuliana", last_name: "Gentille Aybar", email: "ggentille@smartmedia.pe", phone: "986 634 800" },
  // POC de pago del anunciante directo (único contacto de Tottus).
  { company: "tottus", first_name: "Lázaro", last_name: "Cabezas", email: "lcabezas@tottus.com.pe", is_primary: true, notes: "Contacto de pago OI Tottus." },
  // Opera la cuenta Tottus desde Starcom: cuelga de la agencia, no del anunciante.
  { company: "pubgroupe", first_name: "Milu", last_name: "Palacios", email: "milu.palacios@starcomww.com", job_title: "Supervisor", is_primary: true, notes: "Firma NP-2026-001 (opera cuenta Tottus desde Starcom)." },
  { company: "pubgroupe", first_name: "Carla", last_name: "Espinoza", email: "carla.espinoza@starcomww.com", phone: "997004784", notes: "Tráfico agencia." },
  { company: "pubasoc", first_name: "Diego", last_name: "Peña", email: "diego.pena@apxexchange.com", job_title: "Supervisor", is_primary: true, notes: "Firmante OI Toyota." },
  { company: "pubasoc", first_name: "Paola", last_name: "Albán", email: "paola.alban@apxexchange.com", notes: "Contacto de pago." },
  { company: "mdialogue", first_name: "Ivana", last_name: "Tryon", email: "itryon@targooh.com", job_title: "Planning Lead - Targooh", is_primary: true, notes: "Firmante lado cliente OI Pacífico. Buzones OMNET van en billing_portal_email de la orden, no aquí." },
  { company: "havas", first_name: "Francisco", last_name: "García", email: "francisco.garcia@havasmn.com", job_title: "Planner Value", is_primary: true, notes: "Firmante OI Qroma." },
  { company: "havas", first_name: "Catalina", last_name: "Villon", email: "catalina.villon@havasmn.com", notes: "Contacto de pago." },
];

interface ScreenSeed {
  code: string;
  name: string;
  notes?: string;
}

// Pantallas INTACTAS: no agregar, quitar ni renombrar (el inbox y la
// ocupación derivan de estas 5).
const SCREENS: ScreenSeed[] = [
  { code: "MI001", name: "Pantalla LED — Av. Ejército / Estadio Bonilla", notes: "La OI Pacífico la referencia como MI01 (cara A)." },
  { code: "MI004", name: "Pantalla LED — Av. Paseo de la República / Spción Llona" },
  { code: "MI007", name: "Pantalla LED — Av. Pardo / Av. Comandante Espinar" },
  { code: "MI009", name: "Pantalla LED — Av. Reducto / Av. Balboa" },
  { code: "MI010", name: "Pantalla LED — Av. 28 de Julio / Av. Reducto" },
];

interface LineSeed {
  screen: string;
  starts_at: string;
  ends_at: string; // exclusivo: medianoche siguiente a FECHA FIN (rango '[)')
  rate_regular: number;
  total: number;
  cant_meses?: number | null;
  cant_dias?: number | null;
  note?: string;
}

interface OrderSeed {
  io_number: string;
  advertiser: string | null;
  billing: string;
  agency: string | null;
  brand: string;
  starts_at: string;
  ends_at: string;
  payment_terms: string;
  poc_email: string;
  signer_email: string;
  payment_email?: string | null;
  manager_email?: string | null;
  doc_orden_medios?: boolean;
  doc_orden_compra?: boolean;
  billing_portal_email?: string | null;
  billing_detail?: string | null;
  invoice_registration?: string | null;
  commission_pct?: number | null;
  signed_by_agency: string;
  signed_by_company: string;
  signed_at: string;
  campaign: string;
  campaign_status: "active" | "completed";
  booking_status: "confirmed" | "completed";
  om: { code: string; portal?: string | null; issued_at: string } | null;
  creative: { name: string } | null;
  photo_screen: string | null;
  photo_taken_at: string | null;
  notes: string;
  lines: LineSeed[];
}

const L = (d: string): string => `${d}T00:00:00-05:00`;

const ORDERS: OrderSeed[] = [
  {
    io_number: "NP-2026-001",
    advertiser: "tottus",
    billing: "tottus",
    agency: "pubgroupe",
    brand: "Tottus",
    starts_at: "2026-11-03",
    ends_at: "2026-11-23",
    payment_terms: "Crédito a 30 días",
    poc_email: "milu.palacios@starcomww.com",
    signer_email: "milu.palacios@starcomww.com",
    payment_email: "lcabezas@tottus.com.pe",
    manager_email: "carla.espinoza@starcomww.com",
    doc_orden_medios: true,
    doc_orden_compra: true,
    billing_portal_email: "Hipermercados Tottus S.A. | dte_20508565934@paperless.pe",
    billing_detail: "Antes de facturar, debe esperar el número de recepción (HES) correspondiente. Emita solo una factura por cada Orden de Compra",
    invoice_registration: "Envíe su factura a más tardar el día 3 desde su fecha de emisión. Según detalle en adjunto y el Portal en el correo",
    signed_by_agency: "Milu Palacios (Supervisor)",
    signed_by_company: "Smart Media",
    signed_at: "2026-11-04",
    campaign: "Pre Navidad — Tottus",
    campaign_status: "active",
    booking_status: "confirmed",
    om: null, // demo sin_om: sigue sin OM registrado
    creative: { name: "Pre Navidad 10s" },
    photo_screen: "MI010",
    photo_taken_at: "2026-11-05",
    notes: "Fuente: NP - Compra Nov - Navidad.pdf. Total S/ 5,000 + IGV S/ 900. Docs facturación: Orden de Medios + Orden de Compra (ambos marcados). Intermediario (no factura): PUBLICIS GROUPE MEDIA PERU SAC. HES requerido antes de facturar; una factura por OC; registro de factura máx. día 3.",
    lines: [
      { screen: "MI010", starts_at: L("2026-11-03"), ends_at: L("2026-11-24"), rate_regular: 3000, total: 2000, cant_dias: 4, note: "OI: CANT. DÍAS 4. Tarifa regular S/ 3,000; total línea S/ 2,000." },
      { screen: "MI001", starts_at: L("2026-11-03"), ends_at: L("2026-11-24"), rate_regular: 4500, total: 3000, cant_dias: 4, note: "OI: CANT. DÍAS 4. Tarifa regular S/ 4,500; total línea S/ 3,000." },
    ],
  },
  {
    io_number: "NP-2026-002",
    advertiser: null,
    billing: "pubasoc",
    agency: "pubasoc",
    brand: "Toyota",
    starts_at: "2026-09-24",
    ends_at: "2026-10-20",
    payment_terms: "60 días",
    poc_email: "diego.pena@apxexchange.com",
    signer_email: "diego.pena@apxexchange.com",
    payment_email: "paola.alban@apxexchange.com",
    doc_orden_medios: true,
    billing_portal_email: "APEX EXCHANGE",
    billing_detail: "Se factura a inicios del mes siguiente, previa aprobación de estado de cuenta",
    commission_pct: 10,
    signed_by_agency: "Diego Peña",
    signed_by_company: "Giuliana Gentille Aybar",
    signed_at: "2026-11-06",
    campaign: "bz4x Eléctrico — Toyota",
    campaign_status: "completed",
    booking_status: "completed",
    om: { code: "OM-2026-102", portal: "APEX EXCHANGE", issued_at: "2026-09-25" },
    creative: { name: "bz4x 20s" },
    photo_screen: null, // demo por_certificar: terminó sin foto-check
    photo_taken_at: null,
    notes: "Fuente: NP - Toyota Híbridos.xlsx. Marca publicitada: Toyota (marca OI: 'bz4x - Eléctrico'). Total S/ 16,758 + IGV S/ 3,016.44. Doc. facturación: Orden de Medios. Se factura a inicios del mes siguiente, previa aprobación de estado de cuenta; portal APEX EXCHANGE. FECHA del documento 6/11/2026, posterior a la pauta; se usa como fecha de firma por ser la única fecha del documento.",
    lines: [
      { screen: "MI001", starts_at: L("2026-09-24"), ends_at: L("2026-10-01"), rate_regular: 5460, total: 1274, cant_dias: 7 },
      { screen: "MI007", starts_at: L("2026-09-24"), ends_at: L("2026-10-01"), rate_regular: 3850, total: 898.33, cant_dias: 7 },
      { screen: "MI010", starts_at: L("2026-09-24"), ends_at: L("2026-10-01"), rate_regular: 3850, total: 898.33, cant_dias: 7 },
      { screen: "MI004", starts_at: L("2026-09-24"), ends_at: L("2026-10-01"), rate_regular: 5460, total: 1274, cant_dias: 7 },
      { screen: "MI001", starts_at: L("2026-10-01"), ends_at: L("2026-10-21"), rate_regular: 5460, total: 3640, cant_dias: 20 },
      { screen: "MI007", starts_at: L("2026-10-01"), ends_at: L("2026-10-21"), rate_regular: 3850, total: 2566.67, cant_dias: 20 },
      { screen: "MI010", starts_at: L("2026-10-01"), ends_at: L("2026-10-21"), rate_regular: 3850, total: 2566.67, cant_dias: 20 },
      { screen: "MI004", starts_at: L("2026-10-01"), ends_at: L("2026-10-21"), rate_regular: 5460, total: 3640, cant_dias: 20 },
    ],
  },
  {
    io_number: "NP-2026-003",
    advertiser: "pacifico",
    billing: "mdialogue",
    agency: "mdialogue",
    brand: "PACÍFICO",
    starts_at: "2026-10-26",
    ends_at: "2026-11-22",
    payment_terms: "45 días",
    poc_email: "itryon@targooh.com",
    signer_email: "itryon@targooh.com",
    doc_orden_medios: true,
    billing_portal_email: "Portal OMNET — recepcionfacturasmd@omnicommediagroup.com.pe; jtoyama@omnicommediagroup.com.pe",
    billing_detail: "Se factura a inicios del mes siguiente previa aprobación de estado de cuenta y RF",
    signed_by_agency: "Ivana Tryon (Planning Lead - Targooh)",
    signed_by_company: "Santiago Llaury (Gerente General)",
    signed_at: "2026-11-06",
    campaign: "PACÍFICO VIDA OCT/NOV",
    campaign_status: "active",
    booking_status: "confirmed",
    om: { code: "OM-2026-103", portal: "OMNET", issued_at: "2026-10-27" },
    creative: { name: "Vida 15s" },
    photo_screen: null, // demo sin_evidencia: al aire sin foto-check
    photo_taken_at: null,
    notes: "Fuente: NP PACIFICO - CON OMNET.xlsx. Total S/ 10,080 + IGV S/ 1,814.40. Doc. facturación: OM (registro OMNET). Se factura a inicios del mes siguiente previa aprobación de estado de cuenta y RF. FECHA del documento 6/11/2026, posterior a la pauta; se usa como fecha de firma por ser la única fecha del documento.",
    lines: [
      { screen: "MI001", starts_at: L("2026-10-26"), ends_at: L("2026-11-23"), rate_regular: 6000, total: 5600, cant_meses: 1, cant_dias: 28, note: "En la OI figura como MI01 (cara A): Av. Del Ejército/Estadio Bonilla (A). CANT MES 1, CANT. DÍAS 28." },
      { screen: "MI009", starts_at: L("2026-10-26"), ends_at: L("2026-11-23"), rate_regular: 4800, total: 4480, cant_meses: 1, cant_dias: 28 },
    ],
  },
  {
    io_number: "NP-2026-004",
    advertiser: null,
    billing: "havas",
    agency: "havas",
    brand: "CPP",
    starts_at: "2026-11-01",
    ends_at: "2026-11-30",
    payment_terms: "60 días",
    poc_email: "francisco.garcia@havasmn.com",
    signer_email: "francisco.garcia@havasmn.com",
    payment_email: "catalina.villon@havasmn.com",
    doc_orden_medios: true,
    billing_detail: "Artes con 24h de anticipación en horario laboral",
    signed_by_agency: "Francisco García (Planner Value)",
    signed_by_company: "Giuliana Gentille Aybar",
    signed_at: "2026-10-14",
    campaign: "Qroma — Noviembre 2026 (CPP)",
    campaign_status: "active",
    booking_status: "confirmed",
    om: { code: "OM-2026-104", issued_at: "2026-11-02" },
    creative: null, // demo material: al aire sin material aprobado
    photo_screen: "MI001",
    photo_taken_at: "2026-11-03",
    notes: "Fuente: SMARTMEDIA NP - Qroma Noviembre 2026.pdf. Marca publicitada: CPP. Total S/ 8,800 + IGV S/ 1,584. Doc. facturación: Orden de Medios. Artes con 24h de anticipación en horario laboral. Obs. OI: pantallas de San Isidro sin fecha de encendido a la firma.",
    lines: [
      { screen: "MI001", starts_at: L("2026-11-01"), ends_at: L("2026-12-01"), rate_regular: 5500, total: 4400, cant_meses: 1 },
      { screen: "MI004", starts_at: L("2026-11-01"), ends_at: L("2026-12-01"), rate_regular: 5500, total: 4400, cant_meses: 1 },
    ],
  },
  {
    io_number: "NP-2026-005",
    advertiser: null,
    billing: "pubasoc",
    agency: "pubasoc",
    brand: "Toyota",
    starts_at: "2026-11-01",
    ends_at: "2026-11-15",
    payment_terms: "60 días",
    poc_email: "diego.pena@apxexchange.com",
    signer_email: "diego.pena@apxexchange.com",
    payment_email: "paola.alban@apxexchange.com",
    doc_orden_medios: true,
    billing_portal_email: "APEX EXCHANGE",
    billing_detail: "Se factura a inicios del mes siguiente, previa aprobación de estado de cuenta",
    signed_by_agency: "Diego Peña (Supervisor)",
    signed_by_company: "Giuliana Gentille Aybar",
    signed_at: "2026-11-02",
    campaign: "Corolla Cross — Toyota",
    campaign_status: "active",
    booking_status: "confirmed",
    om: { code: "OM-2026-105", portal: "APEX EXCHANGE", issued_at: "2026-11-02" },
    creative: { name: "Corolla 10s" },
    photo_screen: "MI007",
    photo_taken_at: "2026-11-03",
    notes: "Continuidad dummy coherente (sin fuente): relevo de NP-2026-002 con la misma agencia facturadora. Firmada sin facturas: caso sin_facturar + termina_sin_relevo del inbox (relevo 30d agregado vive en el dashboard).",
    lines: [
      { screen: "MI007", starts_at: L("2026-11-01"), ends_at: L("2026-11-16"), rate_regular: 5600, total: 2800, cant_dias: 15, note: "Continuidad Corolla: 15 días en MI007." },
    ],
  },
];

async function main(): Promise<void> {
  const storeId = await loadStoreId();
  const db = getSupabase();

  // 1. Empresas (una por empresa; la fila "sm" con kind NULL es la casa:
  // respalda venues.company_id y el listado CRM la excluye).
  // Re-ejecutable: reutiliza por tax_id.
  const companyIds = new Map<string, string>();
  for (const c of COMPANIES) {
    const found = c.tax_id
      ? await db.from("crm_companies").select("id").eq("store_id", storeId).eq("tax_id", c.tax_id).maybeSingle()
      : { data: null };
    if (found.data) {
      companyIds.set(c.key, (found.data as { id: string }).id);
      // Rellena domain/email/pct solo si faltan (respeta ediciones manuales).
      const patch: Record<string, unknown> = {};
      if (c.domain) {
        const cur = await db.from("crm_companies").select("domain").eq("id", companyIds.get(c.key)).maybeSingle();
        if (!(cur.data as { domain?: string } | null)?.domain) patch.domain = c.domain;
      }
      if (c.email) {
        const cur = await db.from("crm_companies").select("email").eq("id", companyIds.get(c.key)).maybeSingle();
        if (!(cur.data as { email?: string } | null)?.email) patch.email = c.email;
      }
      if (c.agency_pct !== undefined && c.agency_pct !== null) {
        const cur = await db.from("crm_companies").select("agency_commission_pct").eq("id", companyIds.get(c.key)).maybeSingle();
        if ((cur.data as { agency_commission_pct?: number } | null)?.agency_commission_pct == null) {
          patch.agency_commission_pct = c.agency_pct;
        }
      }
      if (Object.keys(patch).length > 0) {
        const { error } = await db.from("crm_companies").update(patch).eq("id", companyIds.get(c.key));
        if (error) throw new Error(`companies ${c.key}: ${error.message}`);
      }
      continue;
    }
    const { data, error } = await db
      .from("crm_companies")
      .insert({
        store_id: storeId,
        name: c.name,
        kind: c.kind ?? null,
        tax_id: c.tax_id ?? null,
        email: c.email ?? null,
        phone: c.phone ?? null,
        address: c.address ?? null,
        city: c.city ?? null,
        country: "PE",
        domain: c.domain ?? null,
        agency_commission_pct: c.agency_pct ?? null,
        notes: c.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`companies ${c.key}: ${error.message}`);
    companyIds.set(c.key, data.id as string);
  }
  console.log(`companies: ${companyIds.size}`);

  // 2. Contactos. Re-ejecutable: reutiliza por email.
  const contactIds = new Map<string, string>();
  for (const c of CONTACTS) {
    const found = await db
      .from("crm_contacts")
      .select("id")
      .eq("store_id", storeId)
      .eq("email", c.email)
      .maybeSingle();
    if (found.data) {
      contactIds.set(c.email.toLowerCase(), (found.data as { id: string }).id);
      continue;
    }
    const { data, error } = await db
      .from("crm_contacts")
      .insert({
        store_id: storeId,
        company_id: companyIds.get(c.company) ?? null,
        first_name: c.first_name,
        last_name: c.last_name,
        email: c.email,
        phone: c.phone ?? null,
        job_title: c.job_title ?? null,
        is_primary: c.is_primary ?? false,
        notes: c.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`contacts ${c.email}: ${error.message}`);
    contactIds.set(c.email.toLowerCase(), data.id as string);
  }
  console.log(`contacts: ${contactIds.size}`);

  // 3. Venue + pantallas + 1 slot por pantalla (INTACTAS).
  // Reutiliza el venue si ya existe (reintento tras fallo parcial).
  let venueId: string;
  {
    const found = await db
      .from("inv_venues")
      .select("id")
      .eq("store_id", storeId)
      .eq("external_ref", "venue-miraflores-01")
      .maybeSingle();
    if (found.data) {
      venueId = found.data.id as string;
      await db.from("inv_venues").update({ company_id: companyIds.get("sm") ?? null }).eq("id", venueId);
    } else {
      const { data: venue, error: verr } = await db
        .from("inv_venues")
        .insert({
          store_id: storeId,
          company_id: companyIds.get("sm") ?? null,
          ownership: "own",
          name: "Miraflores — Red Smart Media",
          venue_type: "street_furniture",
          city: "Lima",
          country: "PE",
          timezone: "America/Lima",
          source: "manual",
          external_ref: "venue-miraflores-01",
          notes: "Seed OIs Smart Media (nov-2026): todas las pantallas de las OIs están en Miraflores.",
        })
        .select("id")
        .single();
      if (verr) throw new Error(`venues: ${verr.message}`);
      venueId = venue.id as string;
    }
  }

  const screenIds = new Map<string, string>();
  // Slots por pantalla: el loop comparte pantalla entre anunciantes; cada
  // línea ocupa el primer slot libre en su periodo (greedy en memoria).
  const SLOTS_PER_SCREEN = 4;
  const slotIds = new Map<string, string[]>(); // code -> slot ids por slot_index
  const slotBusy = new Map<string, Array<{ s: number; e: number }>>(); // slot id -> rangos ms
  for (const s of SCREENS) {
    const found = await db
      .from("inv_screens")
      .select("id")
      .eq("store_id", storeId)
      .eq("external_ref", s.code)
      .maybeSingle();
    let screenId: string;
    if (found.data) {
      screenId = (found.data as { id: string }).id;
    } else {
      const { data, error } = await db
        .from("inv_screens")
        .insert({
          store_id: storeId,
          venue_id: venueId,
          name: s.name,
          ownership: "own",
          technology: "LED",
          orientation: "landscape",
          placement: "fixed",
          is_active: true,
          source: "manual",
          external_ref: s.code,
        })
        .select("id")
        .single();
      if (error) throw new Error(`screens ${s.code}: ${error.message}`);
      screenId = data.id as string;
    }
    screenIds.set(s.code, screenId);
    const ids: string[] = [];
    const { data: existingSlots } = await db
      .from("inv_slots")
      .select("id")
      .eq("store_id", storeId)
      .eq("screen_id", screenId)
      .order("slot_index", { ascending: true });
    const rows = ((existingSlots ?? []) as Array<{ id: string }>);
    for (let i = rows.length; i < SLOTS_PER_SCREEN; i++) {
      const { data: slot, error: serr } = await db
        .from("inv_slots")
        .insert({
          store_id: storeId,
          screen_id: screenId,
          slot_index: i + 1,
          external_ref: `slot-${s.code}-0${i + 1}`,
        })
        .select("id")
        .single();
      if (serr) throw new Error(`slots ${s.code}#${i + 1}: ${serr.message}`);
      rows.push({ id: slot.id as string });
    }
    for (const r of rows) {
      ids.push(r.id);
      slotBusy.set(r.id, []);
    }
    slotIds.set(s.code, ids);
  }
  console.log(`venues: 1, screens: ${screenIds.size}, slots: ${screenIds.size * SLOTS_PER_SCREEN}`);
  // Ocupa en memoria los bookings ya persistidos para no re-pisar slots.
  {
    const { data: bookings } = await db
      .from("inv_bookings")
      .select("slot_id,starts_at,ends_at")
      .eq("store_id", storeId)
      .limit(2000);
    for (const b of ((bookings ?? []) as Array<Record<string, unknown>>)) {
      const id = String(b.slot_id ?? "");
      if (!slotBusy.has(id)) continue;
      const s = Date.parse(String(b.starts_at ?? ""));
      const e = Date.parse(String(b.ends_at ?? ""));
      if (Number.isFinite(s) && Number.isFinite(e)) slotBusy.get(id)?.push({ s, e });
    }
  }

  function pickSlot(code: string, startsIso: string, endsIso: string): string {
    const s = Date.parse(startsIso);
    const e = Date.parse(endsIso);
    for (const id of slotIds.get(code) ?? []) {
      const busy = slotBusy.get(id) ?? [];
      if (!busy.some((r) => s < r.e && r.s < e)) {
        busy.push({ s, e });
        return id;
      }
    }
    throw new Error(`sin slot libre en ${code} para ${startsIso}/${endsIso}`);
  }

  // 4. IOs + líneas + campañas + bookings (hard hold) + OM + material + foto.
  const termsDays = (t: string): number | null => {
    if (/contado/i.test(t)) return 0;
    const m = t.match(/\d+/);
    return m ? Number(m[0]) : null;
  };
  const cid = (email: string | null | undefined): string | null =>
    email ? (contactIds.get(email.toLowerCase()) ?? null) : null;
  for (const o of ORDERS) {
    let ioId: string;
    let isNew = false;
    const existing = await db
      .from("io_orders")
      .select("id")
      .eq("store_id", storeId)
      .eq("io_number", o.io_number)
      .maybeSingle();
    if (existing.data) {
      ioId = (existing.data as { id: string }).id;
    } else {
      isNew = true;
      const { data: io, error: ioerr } = await db
        .from("io_orders")
        .insert({
          store_id: storeId,
          io_number: o.io_number,
          advertiser_company_id: o.advertiser ? (companyIds.get(o.advertiser) ?? null) : null,
          billing_company_id: companyIds.get(o.billing) ?? null,
          agency_company_id: o.agency ? (companyIds.get(o.agency) ?? null) : null,
          billing_contact_id: cid(o.poc_email),
          signer_contact_id: cid(o.signer_email),
          payment_contact_id: cid(o.payment_email),
          manager_contact_id: cid(o.manager_email),
          doc_orden_medios: o.doc_orden_medios ?? false,
          doc_orden_compra: o.doc_orden_compra ?? false,
          doc_contrato: false,
          billing_portal_email: o.billing_portal_email ?? null,
          billing_detail: o.billing_detail ?? null,
          invoice_registration: o.invoice_registration ?? null,
          commission_pct: o.commission_pct ?? null,
          brand: o.brand,
          status: "signed",
          starts_at: o.starts_at,
          ends_at: o.ends_at,
          payment_terms: o.payment_terms,
          payment_terms_days: termsDays(o.payment_terms),
          service_clauses:
            "Smart Media podrá reubicar la pauta por fuerza mayor, siempre y cuando el cliente esté conforme con la reubicación. Todo arte pasa por aprobación de SM.",
          signed_by_agency: o.signed_by_agency,
          signed_by_company: o.signed_by_company,
          signed_at: L(o.signed_at),
          notes: o.notes,
        })
        .select("id")
        .single();
      if (ioerr) throw new Error(`io_orders ${o.io_number}: ${ioerr.message}`);
      ioId = io.id as string;

      const budget = o.lines.reduce((a, l) => a + Math.round(l.total * 100), 0);
      const { data: camp, error: cerr } = await db
        .from("io_campaigns")
        .insert({
          store_id: storeId,
          advertiser_company_id: o.advertiser ? (companyIds.get(o.advertiser) ?? null) : null,
          name: o.campaign,
          status: o.campaign_status,
          starts_at: o.starts_at,
          ends_at: o.ends_at,
          budget_minor: budget,
          insertion_order_id: ioId,
          notes: `Seed ${o.io_number}.`,
        })
        .select("id")
        .single();
      if (cerr) throw new Error(`campaigns ${o.io_number}: ${cerr.message}`);

      for (const l of o.lines) {
        const screenId = screenIds.get(l.screen);
        if (!screenId) throw new Error(`pantalla desconocida: ${l.screen}`);
        const slotId = pickSlot(l.screen, l.starts_at, l.ends_at);
        const { error: lerr } = await db.from("io_lines").insert({
          store_id: storeId,
          io_id: ioId,
          screen_id: screenId,
          slot_id: slotId,
          starts_at: l.starts_at,
          ends_at: l.ends_at,
          rate_minor: Math.round(l.total * 100),
          tarifa_regular_minor: Math.round(l.rate_regular * 100),
          cant_meses: l.cant_meses ?? null,
          cant_dias: l.cant_dias ?? null,
          notes: l.note ?? `Tarifa regular S/ ${l.rate_regular}; total línea S/ ${l.total}.`,
        });
        if (lerr) throw new Error(`lines ${o.io_number}/${l.screen}: ${lerr.message}`);
        const { error: berr } = await db.from("inv_bookings").insert({
          store_id: storeId,
          slot_id: slotId,
          campaign_id: camp.id,
          insertion_order_id: ioId,
          starts_at: l.starts_at,
          ends_at: l.ends_at,
          status: o.booking_status,
        });
        if (berr) throw new Error(`bookings ${o.io_number}/${l.screen}: ${berr.message}`);
      }
      console.log(`${o.io_number}: ${o.lines.length} líneas, budget S/ ${(budget / 100).toFixed(2)}`);
    }

    // Hijos idempotentes (también para órdenes que ya existían sin ellos).
    if (o.om) {
      const found = await db
        .from("io_agency_orders")
        .select("id")
        .eq("store_id", storeId)
        .eq("kind", "OM")
        .eq("code", o.om.code)
        .maybeSingle();
      if (!found.data) {
        const { error } = await db.from("io_agency_orders").insert({
          store_id: storeId,
          io_id: ioId,
          kind: "OM",
          code: o.om.code,
          portal: o.om.portal ?? null,
          issued_at: o.om.issued_at,
          notes: `Seed ${o.io_number}.`,
        });
        if (error) throw new Error(`om ${o.io_number}: ${error.message}`);
      }
    }
    if (o.creative) {
      const found = await db
        .from("io_creatives")
        .select("id")
        .eq("store_id", storeId)
        .eq("io_id", ioId)
        .eq("name", o.creative.name)
        .maybeSingle();
      if (!found.data) {
        const { error } = await db.from("io_creatives").insert({
          store_id: storeId,
          io_id: ioId,
          name: o.creative.name,
          qc_status: "approved",
          legal_status: "approved",
          qc_notes: `Seed ${o.io_number}: QC aprobado.`,
          legal_notes: `Seed ${o.io_number}: legal aprobado.`,
        });
        if (error) throw new Error(`creatives ${o.io_number}: ${error.message}`);
      }
    }
    if (o.photo_screen && o.photo_taken_at) {
      const screenId = screenIds.get(o.photo_screen);
      const found = await db
        .from("io_photo_checks")
        .select("id")
        .eq("store_id", storeId)
        .eq("io_id", ioId)
        .limit(1)
        .maybeSingle();
      if (!found.data && screenId) {
        const { error } = await db.from("io_photo_checks").insert({
          store_id: storeId,
          io_id: ioId,
          screen_id: screenId,
          taken_at: L(o.photo_taken_at),
          photo_url: `seed://photo-check/${o.io_number}/${o.photo_screen}`,
          notes: `Seed ${o.io_number}: foto-check.`,
        });
        if (error) throw new Error(`photos ${o.io_number}: ${error.message}`);
      }
    }
    void isNew;
  }

  // 5. Auditoría de carga.
  const audits: Array<{ kind: string; rows: number }> = [
    { kind: "companies", rows: COMPANIES.length },
    { kind: "contacts", rows: CONTACTS.length },
    { kind: "venues", rows: 1 },
    { kind: "screens", rows: SCREENS.length },
    { kind: "slots", rows: SCREENS.length * 4 },
  ];
  for (const a of audits) {
    const { error } = await db.from("sys_runs").insert({
      store_id: storeId,
      kind: "import",
      label: `import:${a.kind}`,
      total: a.rows,
      processed: a.rows,
      failed: 0,
      current: null,
      status: "done",
      summary: `seed ${a.kind}: ${a.rows}/${a.rows} ok`,
      finished_at: new Date().toISOString(),
    });
    if (error) throw new Error(`seed audit ${a.kind}: ${error.message}`);
  }
  const orderCount = ORDERS.length;
  const lineCount = ORDERS.reduce((a, o) => a + o.lines.length, 0);
  console.log(`seed OK: ${companyIds.size} empresas, ${contactIds.size} contactos, ${orderCount} OIs, ${lineCount} líneas.`);
}

main().catch((e) => {
  fail("SEED-OIS", e);
});
