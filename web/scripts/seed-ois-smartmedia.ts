// Seed inicial CRM/DOOH desde las 4 OIs de SMART MEDIA (Drive SMART MEDIA).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/seed-ois-smartmedia.ts
// Idempotente: si existe NP-2026-001, no inserta nada.
// Las NP-2026-00x son la numeración del cliente: la migración
// 20261120 las renumera a numeración propia SM-2026-00x (se ignoran).
// Modelo: companies.kind (agencia|anunciante|proveedor, obligatorio en CRM);
// la fila NULL ("sm", red propia / operadora) respalda venues.company_id y
// se excluye del listado de Empresas. La marca publicitada es metadato
// (io_orders.brand), no empresa.
// Fuentes:
//   NP-2026-001 Tottus Pre Navidad  <- "NP - Compra Nov - Navidad.pdf"
//   NP-2026-002 Toyota bz4x          <- "NP - Toyota Híbridos.xlsx"
//   NP-2026-003 Pacífico Vida       <- "NP PACIFICO - CON OMNET.xlsx"
//   NP-2026-004 Qroma Nov 2026 (CPP) <- "SMARTMEDIA NP - Qroma Noviembre 2026.pdf"
import { getSupabase } from "@/lib/supabase";
import { fail, loadStoreId } from "./lib/run-once";

const DRIVE_FOLDER = "https://drive.google.com/drive/folders/1JwGeCaPYT4qrLw-U0kkCF6xprm3jABfE";

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
  notes?: string;
}

const COMPANIES: CompanySeed[] = [
  {
    key: "sm",
    name: "STRONG MINDS PERU SAC",
    tax_id: "20600666488",
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
    address: "Av. Angamos Este Nro. 1805 Int. P10 (Piso 10 Of 5 y Piso 11 Of 6a), Surquillo",
    city: "Lima",
    kind: "anunciante",
    notes: "Anunciante directo (compra y paga OI Tottus Pre Navidad)."
  },
  {
    key: "pubgroupe",
    name: "PUBLICIS GROUPE MEDIA PERU SAC",
    tax_id: "20476465614",
    kind: "agencia",
    notes: "Agencia intermediaria OI Tottus (no factura).",
  },
  {
    key: "pubasoc",
    name: "PUBLICIS ASOCIADOS SAC",
    tax_id: "20100335604",
    kind: "agencia",
    notes: "Agencia (facturación OI Toyota, marca bz4x).",
  },
  {
    key: "pacifico",
    name: "PACIFICO COMPAÑIA DE SEGUROS Y REASEGUROS",
    tax_id: "20332970411",
    kind: "anunciante",
    notes: "Anunciante (compra vía Media Dialogue). Campaña PACÍFICO VIDA - OCT/NOV.",
  },
  {
    key: "mdialogue",
    name: "MEDIA DIALOGUE S.A.C.",
    tax_id: "20609099888",
    kind: "agencia",
    notes: "Agencia (facturación OI Pacífico, portal OMNET).",
  },
  {
    key: "havas",
    name: "ESPECIALIDADES DIGITALES INTERNACIONALES S.A.C",
    tax_id: "20600995031",
    kind: "agencia",
    notes: "Agencia Havas (facturación OI Qroma, marca CPP).",
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
  { company: "sm", first_name: "Giuliana Gentille", last_name: "Aybar", email: "ggentille@smartmedia.pe", phone: "986 634 800" },
  { company: "tottus", first_name: "Milu", last_name: "Palacios", email: "milu.palacios@starcomww.com", job_title: "Supervisor", is_primary: true, notes: "Firma por el cliente; email de agencia Starcom." },
  { company: "tottus", first_name: "Lázaro", last_name: "Cabezas", email: "lcabezas@tottus.com.pe", notes: "Contacto de pago." },
  { company: "pubgroupe", first_name: "Carla", last_name: "Espinoza", email: "carla.espinoza@starcomww.com", phone: "997004784", is_primary: true, notes: "Agencia facturación." },
  { company: "pubasoc", first_name: "Diego", last_name: "Peña", email: "diego.pena@apxexchange.com", job_title: "Supervisor", is_primary: true, notes: "Firmante OI Toyota." },
  { company: "pubasoc", first_name: "Paola", last_name: "Albán", email: "paola.alban@apxexchange.com", notes: "Contacto de pago." },
  { company: "mdialogue", first_name: "Ivana", last_name: "Tryon", email: "itryon@targooh.com", job_title: "Planning Lead - Targooh", is_primary: true, notes: "Firmante lado cliente OI Pacífico." },
  { company: "mdialogue", first_name: null, last_name: null, email: "jtoyama@omnicommediagroup.com.pe", notes: "Portal recepción facturas OMG." },
  { company: "mdialogue", first_name: null, last_name: null, email: "recepcionfacturasmd@omnicommediagroup.com.pe", notes: "Portal recepción facturas OMG." },
  { company: "havas", first_name: "Francisco", last_name: "García", email: "francisco.garcia@havasmn.com", job_title: "Planner Value", is_primary: true, notes: "Firmante OI Qroma." },
  { company: "havas", first_name: "Catalina", last_name: "Villon", email: "catalina.villon@havasmn.com", notes: "Contacto de pago." },
];

interface ScreenSeed {
  code: string;
  name: string;
  notes?: string;
}

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
  brand: string;
  starts_at: string;
  ends_at: string;
  payment_terms: string;
  signed_by_agency: string;
  signed_by_company: string;
  signed_at: string;
  campaign: string;
  campaign_status: "active" | "completed";
  booking_status: "confirmed" | "completed";
  notes: string;
  lines: LineSeed[];
}

const L = (d: string) => `${d}T00:00:00-05:00`;

const ORDERS: OrderSeed[] = [
  {
    io_number: "NP-2026-001",
    advertiser: "tottus",
    billing: "tottus",
    brand: "Tottus",
    starts_at: "2026-11-03",
    ends_at: "2026-11-23",
    payment_terms: "Crédito a 30 días",
    signed_by_agency: "Milu Palacios (Supervisor)",
    signed_by_company: "Smart Media",
    signed_at: "2026-11-04",
    campaign: "Pre Navidad — Tottus",
    campaign_status: "active",
    booking_status: "confirmed",
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
    brand: "Toyota",
    starts_at: "2026-09-24",
    ends_at: "2026-10-20",
    payment_terms: "60 días",
    signed_by_agency: "Diego Peña",
    signed_by_company: "Giuliana Gentille Aybar",
    signed_at: "2026-11-06",
    campaign: "bz4x Eléctrico — Toyota",
    campaign_status: "completed",
    booking_status: "completed",
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
    brand: "PACÍFICO",
    starts_at: "2026-10-26",
    ends_at: "2026-11-22",
    payment_terms: "45 días",
    signed_by_agency: "Ivana Tryon (Planning Lead - Targooh)",
    signed_by_company: "Santiago Llaury (Gerente General)",
    signed_at: "2026-11-06",
    campaign: "PACÍFICO VIDA OCT/NOV",
    campaign_status: "active",
    booking_status: "confirmed",
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
    brand: "CPP",
    starts_at: "2026-11-01",
    ends_at: "2026-11-30",
    payment_terms: "60 días",
    signed_by_agency: "Francisco García (Planner Value)",
    signed_by_company: "Giuliana Gentille Aybar",
    signed_at: "2026-10-14",
    campaign: "Qroma — Noviembre 2026 (CPP)",
    campaign_status: "active",
    booking_status: "confirmed",
    notes: "Fuente: SMARTMEDIA NP - Qroma Noviembre 2026.pdf. Marca publicitada: CPP. Total S/ 8,800 + IGV S/ 1,584. Doc. facturación: Orden de Medios. Artes con 24h de anticipación en horario laboral. Obs. OI: pantallas de San Isidro sin fecha de encendido a la firma.",
    lines: [
      { screen: "MI001", starts_at: L("2026-11-01"), ends_at: L("2026-12-01"), rate_regular: 5500, total: 4400, cant_meses: 1 },
      { screen: "MI004", starts_at: L("2026-11-01"), ends_at: L("2026-12-01"), rate_regular: 5500, total: 4400, cant_meses: 1 },
    ],
  },
];

async function main() {
  const storeId = await loadStoreId();
  const db = getSupabase();

  const existing = await db
    .from("io_orders")
    .select("io_number")
    .eq("store_id", storeId)
    .in("io_number", ORDERS.map((o) => o.io_number));
  if ((existing.data ?? []).length > 0) {
    const nums = (existing.data ?? []).map((r) => r.io_number as string).join(",");
    console.log(`Seed ya aplicado o parcial (${nums}). Nada que hacer.`);
    return;
  }

  // 1. Empresas (un tipo por empresa; la fila "sm" con NULL es la casa:
  // respalda venues.company_id y el listado CRM la excluye).
  const companyIds = new Map<string, string>();
  for (const c of COMPANIES) {
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
        notes: c.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`companies ${c.key}: ${error.message}`);
    companyIds.set(c.key, data.id as string);
  }
  console.log(`companies: ${companyIds.size}`);

  // 2. Contactos.
  for (const c of CONTACTS) {
    const { error } = await db.from("crm_contacts").insert({
      store_id: storeId,
      company_id: companyIds.get(c.company) ?? null,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      phone: c.phone ?? null,
      job_title: c.job_title ?? null,
      is_primary: c.is_primary ?? false,
      notes: c.notes ?? null,
    });
    if (error) throw new Error(`contacts ${c.email}: ${error.message}`);
  }
  console.log(`contacts: ${CONTACTS.length}`);

  // 3. Venue + pantallas + 1 slot por pantalla.
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
          notes: "Seed OIs Smart Media (nov-2026): todas las pantallas de las 4 OIs están en Miraflores.",
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
    screenIds.set(s.code, data.id as string);
    const ids: string[] = [];
    for (let i = 1; i <= SLOTS_PER_SCREEN; i++) {
      const { data: slot, error: serr } = await db
        .from("inv_slots")
        .insert({
          store_id: storeId,
          screen_id: data.id,
          slot_index: i,
          external_ref: `slot-${s.code}-0${i}`,
        })
        .select("id")
        .single();
      if (serr) throw new Error(`slots ${s.code}#${i}: ${serr.message}`);
      ids.push(slot.id as string);
      slotBusy.set(slot.id as string, []);
    }
    slotIds.set(s.code, ids);
  }
  console.log(`venues: 1, screens: ${screenIds.size}, slots: ${screenIds.size * SLOTS_PER_SCREEN}`);

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

  // 4. IOs + líneas + campañas + bookings (hard hold).
  const termsDays = (t: string): number | null => {
    if (/contado/i.test(t)) return 0;
    const m = t.match(/\d+/);
    return m ? Number(m[0]) : null;
  };
  for (const o of ORDERS) {
    const { data: io, error: ioerr } = await db
      .from("io_orders")
      .insert({
        store_id: storeId,
        io_number: o.io_number,
        advertiser_company_id: o.advertiser ? (companyIds.get(o.advertiser) ?? null) : null,
        billing_company_id: companyIds.get(o.billing) ?? null,
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
        insertion_order_id: io.id,
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
        io_id: io.id,
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
        insertion_order_id: io.id,
        starts_at: l.starts_at,
        ends_at: l.ends_at,
        status: o.booking_status,
      });
      if (berr) throw new Error(`bookings ${o.io_number}/${l.screen}: ${berr.message}`);
    }
    console.log(`${o.io_number}: ${o.lines.length} líneas, budget S/ ${(budget / 100).toFixed(2)}`);
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
  console.log(`seed OK: ${companyIds.size} empresas, ${CONTACTS.length} contactos, 4 OIs, 14 líneas, 4 campañas, 14 bookings.`);
}

main().catch((e) => {
  fail("SEED-OIS", e);
});
