// Dashboard Hoy v1 — solo desde la OI (sin facturación).
// Fuente: io_orders + lines + io_agency_orders + creatives + io_photo_checks.
// Sin prorrateo inventado más allá de lineal por tiempo solapado; sin
// impresiones/GRP (io_play_logs del CMS vive fuera).
// El snapshot alimenta dos superficies con propósitos distintos, sin
// redundancia: la página Hoy pinta solo KPIs de negocio (comprometido con
// delta, cobranza con delta, ocupación, al aire con delta, relevo, huecos);
// los bloqueos (alerts) y por_certificar viven solo en el Inbox vía
// buildBriefFacts.
import { orderStage, orderTiming } from "@/lib/order-stage";
import { getSupabase } from "@/lib/supabase";
import { normalizeCurrency } from "@/lib/currency";
import { aggregateCobranza, toBillingInvoice, type BillingInvoice, type CobranzaTotals } from "@/lib/billing-status";
import { DAY_MS, startOfDayUTC, startOfMonthUTC } from "@/lib/format";
import { DEFAULT_SLOTS_PER_SCREEN } from "@/lib/store-slots";

export type AlertKind = "sin_om" | "material" | "sin_evidencia" | "termina_sin_relevo";

export interface DashboardAlert {
  kind: AlertKind;
  ioId: string;
  ioNumber: string;
  brand: string | null;
  company: string | null;
  detail: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface Hueco {
  screenId: string;
  screenName: string;
  /** Días totalmente libres en la ventana (sin slots vendidos). */
  diasLibres: number;
  /** Slots-día libres en la ventana (capacidad − vendidos). */
  slotsLibres: number;
}

export interface CurrencyTotals {
  comprometidoMesMinor: number;
  firmadoMesMinor: number;
  draftMesMinor: number;
}

export interface DashboardSnapshot {
  currency: string;
  comprometidoMesMinor: number;
  firmadoMesMinor: number;
  draftMesMinor: number;
  /** Totales por moneda de IO (nunca sumar mixto). */
  byCurrency: Record<string, CurrencyTotals>;
  /** Cartera abierta (facturas emitidas no anuladas/borrador). */
  cobranza: CobranzaTotals;
  /** Cobranza por moneda de factura (nunca sumar mixto). */
  cobranzaByCurrency: Record<string, CobranzaTotals>;
  /** Cobranza por moneda de factura (nunca sumar mixto). */
  /** Variación en puntos (base 100, como MetricDelta) vs periodo previo.
   *  null = sin base. Deltas honestos: se calculan con la data actual,
   *  sin historia almacenada. */
  deltas: {
    /** Comprometido mes actual vs mes anterior (moneda de la tienda). */
    comprometido: number | null;
    /** Pendiente de cobro (cartera) vs cierre del mes anterior
     *  (bajar es bueno: la UI lo muestra invertido). */
    cobranzaPendiente: number | null;
    /** OIs al aire hoy vs ayer. */
    alAireOis: number | null;
  };
  /** Bases de comparación de los deltas (misma moneda/unidad que el KPI). */
  prev: { comprometidoMinor: number; cobranzaPendingMinor: number; alAireOis: number };
  ocupacion14d: { ratio: number | null; slotsVendidos: number; slotsDisponibles: number };
  alAire: { ois: number; pantallas: number };
  porCertificar: number;
  renovacion30d: { conRelevo: number; total: number; ratio: number | null };
  alerts: DashboardAlert[];
  huecos: Hueco[];
  counts: { ois: number; screens: number; truncated: boolean };
  /** true si alguna fuente se truncó por límite (muestra parcial, no total exacto). */
  truncated: boolean;
}

// SSOT: primitivos de fecha en lib/format.ts.

function parseMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function fmtCorta(v: string | null): string {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  return m ? `${m[3]}/${m[2]}` : "—";
}

export async function getDashboardSnapshot(storeId: string): Promise<DashboardSnapshot> {
  const db = getSupabase();
  const now = Date.now();
  const today00 = startOfDayUTC(now);

  const [{ data: store, count: screensTotal }, { data: screens }, { data: ois, count: oisTotal }, { data: invoices, error: invoiceError }] = await Promise.all([
    db.from("sys_stores").select("shop_currency").eq("id", storeId).maybeSingle(),
    db.from("inv_screens").select("id,name", { count: "exact" }).eq("store_id", storeId).eq("is_active", true).limit(500),
    db
      .from("io_orders")
      .select("id,io_number,brand,status,starts_at,ends_at,created_at,advertiser_company_id,billing_company_id,currency", { count: "exact" })
      .eq("store_id", storeId)
      .neq("status", "cancelled")
      .order("starts_at", { ascending: true })
      .limit(500),
    db
      .from("io_invoices")
      .select("amount_minor,currency,status,issue_date,due_date,payments:io_invoice_payments!io_invoice_payments_same_store_fk(*)")
      .eq("store_id", storeId)
      .limit(2000),
  ]);
  if (invoiceError) throw new Error(`Cobranza: ${invoiceError.message}`);
  const truncated = (screensTotal ?? 0) > 500 || (oisTotal ?? 0) > 500;

  const currency = normalizeCurrency((store as Record<string, unknown> | null)?.shop_currency ?? "PEN");
  const screenRows = ((screens ?? []) as Array<Record<string, unknown>>).map((s) => ({
    id: String(s.id),
    name: String(s.name ?? "—"),
  }));
  const oiRows = ((ois ?? []) as Array<Record<string, unknown>>).map((o) => ({
    id: String(o.id),
    io_number: String(o.io_number ?? "—"),
    brand: (o.brand as string | null) ?? null,
    status: String(o.status ?? ""),
    created_at: (o.created_at as string | null) ?? null,
    starts_at: (o.starts_at as string | null) ?? null,
    ends_at: (o.ends_at as string | null) ?? null,
    currency: normalizeCurrency(o.currency, currency),
    key: String(o.advertiser_company_id ?? o.billing_company_id ?? ""),
    advertiser_id: (o.advertiser_company_id as string | null) ?? null,
    billing_id: (o.billing_company_id as string | null) ?? null,
  }));
  const oiIds = oiRows.map((o) => o.id);

  let lineRows: Array<{
    io_id: string;
    screen_id: string;
    rate_minor: number;
    cant_slots: number;
    starts_at: string;
    ends_at: string;
    starts_ms: number | null;
    ends_ms: number | null;
  }> = [];
  let omBy = new Set<string>();
  const creaBy = new Map<string, { any: boolean; pending: boolean }>();
  let photoBy = new Set<string>();
  let nameBy = new Map<string, string>();

  if (oiIds.length > 0) {
    const [lines, oms, creas, photos] = await Promise.all([
      db
        .from("io_lines")
        .select("io_id,screen_id,rate_minor,cant_slots,starts_at,ends_at")
        .eq("store_id", storeId)
        .in("io_id", oiIds)
        .limit(2000),
      db.from("io_agency_orders").select("io_id").eq("store_id", storeId).in("io_id", oiIds).limit(1000),
      db
        .from("io_creatives")
        .select("io_id,qc_status,legal_status")
        .eq("store_id", storeId)
        .in("io_id", oiIds)
        .limit(1000),
      db.from("io_photo_checks").select("io_id").eq("store_id", storeId).in("io_id", oiIds).limit(1000),
    ]);
    lineRows = ((lines.data ?? []) as Array<Record<string, unknown>>).map((l) => ({
      io_id: String(l.io_id),
      screen_id: String(l.screen_id),
      rate_minor: Number(l.rate_minor ?? 0),
      cant_slots: (() => {
        const n = Number(l.cant_slots ?? 1);
        return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
      })(),
      starts_at: String(l.starts_at),
      ends_at: String(l.ends_at),
      starts_ms: parseMs(l.starts_at),
      ends_ms: parseMs(l.ends_at),
    }));
    omBy = new Set(
      ((oms.data ?? []) as Array<Record<string, unknown>>).map((o) => String(o.io_id)),
    );
    for (const c of (creas.data ?? []) as Array<Record<string, unknown>>) {
      const k = String(c.io_id);
      const prev = creaBy.get(k) ?? { any: false, pending: false };
      prev.any = true;
      if (c.qc_status !== "approved" || c.legal_status !== "approved") prev.pending = true;
      creaBy.set(k, prev);
    }
    photoBy = new Set(
      ((photos.data ?? []) as Array<Record<string, unknown>>).map((p) => String(p.io_id)),
    );
    const coIds = [...new Set(oiRows.flatMap((o) => [o.advertiser_id, o.billing_id]).filter(Boolean))] as string[];
    if (coIds.length > 0) {
      const { data: cos } = await db
        .from("crm_companies")
        .select("id,name")
        .eq("store_id", storeId)
        .in("id", coIds)
        .limit(500);
      nameBy = new Map(
        ((cos ?? []) as Array<Record<string, unknown>>).map((c) => [
          String(c.id),
          String(c.name ?? "—"),
        ]),
      );
    }
  }

  const oiById = new Map(oiRows.map((o) => [o.id, o]));
  const companyOf = (o: (typeof oiRows)[number]): string | null => {
    const id = o.advertiser_id ?? o.billing_id;
    return id ? (nameBy.get(id) ?? null) : null;
  };
  const materialsOk = (ioId: string): boolean => {
    const c = creaBy.get(ioId);
    return Boolean(c?.any && !c.pending);
  };

  // 1. Comprometido mes (prorrateo lineal por tiempo solapado, por moneda)
  // + base mes anterior para el delta (mismo método, ventana previa).
  const monthStart = startOfMonthUTC(today00);
  const monthEnd = startOfMonthUTC(monthStart + 32 * DAY_MS);
  const prevStart = startOfMonthUTC(monthStart - DAY_MS);
  let comprometido = 0;
  let firmado = 0;
  let draft = 0;
  let prevComprometido = 0;
  const byCurrency: Record<string, CurrencyTotals> = {};
  const bump = (cur: string, part: number, signed: boolean) => {
    const c = normalizeCurrency(cur, currency);
    const t = (byCurrency[c] ??= { comprometidoMesMinor: 0, firmadoMesMinor: 0, draftMesMinor: 0 });
    // Comprometido = solo firmado (el draft va aparte en draftMesMinor, no infla KPI).
    if (signed) t.firmadoMesMinor += part;
    else t.draftMesMinor += part;
    t.comprometidoMesMinor = t.firmadoMesMinor;
    if (c === currency) {
      if (signed) {
        comprometido += part;
        firmado += part;
      } else draft += part;
    }
  };
  for (const l of lineRows) {
    if (l.starts_ms === null || l.ends_ms === null || l.ends_ms <= l.starts_ms) continue;
    if (!(l.rate_minor > 0)) continue;
    const io = oiById.get(l.io_id);
    const st = io?.status;
    const overlap = Math.max(0, Math.min(l.ends_ms, monthEnd) - Math.max(l.starts_ms, monthStart));
    if (overlap > 0) {
      const part = (overlap / (l.ends_ms - l.starts_ms)) * l.rate_minor;
      bump(io?.currency ?? currency, part, st === "signed");
    }
    // Delta honesto con la data actual (sin historia almacenada): misma
    // fórmula sobre el mes previo. Solo moneda de la tienda.
    const overlapPrev = Math.max(0, Math.min(l.ends_ms, monthStart) - Math.max(l.starts_ms, prevStart));
    if (overlapPrev > 0 && st === "signed" && normalizeCurrency(io?.currency, currency) === currency) {
      prevComprometido += (overlapPrev / (l.ends_ms - l.starts_ms)) * l.rate_minor;
    }
  }

  // 1b. Cobranza: cartera abierta (emitidas no anuladas/borrador con
  // issue_date <= corte). Sin due_date no se presume vencido (los términos
  // viven en la orden). Base del delta: misma cartera al cierre del mes
  // anterior (issue_date < monthStart, corte = monthStart).
  const issuedBy = (iso: unknown): number | null => {
    if (typeof iso !== "string" || !iso) return null;
    const t = Date.parse(iso.slice(0, 10));
    return Number.isFinite(t) ? t : null;
  };
  const invRows = ((invoices ?? []) as Array<Record<string, unknown>>).map((v) => ({
    inv: toBillingInvoice(v),
    currency: normalizeCurrency(v.currency, currency),
  }));
  const curGroups = new Map<string, BillingInvoice[]>();
  const prevGroups = new Map<string, BillingInvoice[]>();
  for (const v of invRows) {
    const issued = issuedBy(v.inv.issue_date);
    if (issued === null) continue;
    if (issued <= Math.min(now, monthEnd)) {
      const g = curGroups.get(v.currency) ?? [];
      g.push(v.inv);
      curGroups.set(v.currency, g);
    }
    if (issued < monthStart) {
      const g = prevGroups.get(v.currency) ?? [];
      g.push(v.inv);
      prevGroups.set(v.currency, g);
    }
  }
  const cobranzaByCurrency: Record<string, CobranzaTotals> = {};
  for (const [c, list] of curGroups) cobranzaByCurrency[c] = aggregateCobranza(list, Math.min(now, monthEnd));
  const prevByCurrency: Record<string, CobranzaTotals> = {};
  // Corte al cierre del mes anterior: lo vencido después no contaba aún.
  for (const [c, list] of prevGroups) prevByCurrency[c] = aggregateCobranza(list, monthStart);

  // 2. Ocupación 14d en slots-día (capacidad por pantalla × ventana).
  // Pondera cada línea por su cant_slots; la capacidad es slots propios
  // activos o el default del tenant (SSOT lib/availability).
  // Misma vigencia que la matriz: excluye borradores vencidos (el hold aparta
  // 7 días); bookings no entran al KPI (ver matriz).
  const WIN = 14;
  const winEnd = today00 + WIN * DAY_MS;
  let holdFresh: (createdAt: string | null) => boolean = () => true;
  try {
    const { isHoldFresh } = await import("@/lib/availability");
    holdFresh = (c) => isHoldFresh(c);
  } catch {
    // sin filtro de frescura
  }
  let capacities: Map<string, number> = new Map();
  try {
    const { getScreenCapacities } = await import("@/lib/availability");
    capacities = await getScreenCapacities(storeId, screenRows.map((s) => s.id));
  } catch {
    capacities = new Map();
  }
  const capOf = (id: string): number => capacities.get(id) ?? DEFAULT_SLOTS_PER_SCREEN;
  const perScreen = new Map<string, Set<number>>();
  const soldByScreen = new Map<string, number>();
  for (const l of lineRows) {
    if (l.starts_ms === null || l.ends_ms === null || l.ends_ms <= l.starts_ms) continue;
    const io = oiById.get(l.io_id);
    if (io?.status === "draft" && !holdFresh(io.created_at ?? null)) continue;
    const s = Math.max(l.starts_ms, today00);
    const e = Math.min(l.ends_ms, winEnd);
    if (e <= s) continue;
    for (let d = 0; d < WIN; d++) {
      const dayStart = today00 + d * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      if (s < dayEnd && dayStart < e) {
        let set = perScreen.get(l.screen_id);
        if (!set) {
          set = new Set();
          perScreen.set(l.screen_id, set);
        }
        set.add(d);
        soldByScreen.set(l.screen_id, (soldByScreen.get(l.screen_id) ?? 0) + l.cant_slots);
      }
    }
  }
  let slotsDisponibles = 0;
  for (const s of screenRows) slotsDisponibles += capOf(s.id) * WIN;
  let slotsVendidos = 0;
  for (const v of soldByScreen.values()) slotsVendidos += v;
  const ocupacionRatio = slotsDisponibles > 0 ? slotsVendidos / slotsDisponibles : null;

  // 3. Al aire hoy (y ayer, para el delta; misma data, corte distinto).
  const stageAt = (o: (typeof oiRows)[number], ref: number) => orderStage({
    status: o.status, signed: o.status === "signed", hasOm: omBy.has(o.id),
    materialsOk: materialsOk(o.id), certified: photoBy.has(o.id),
    ...orderTiming(o, lineRows.filter((l) => l.io_id === o.id), ref),
  }).stage;
  const alAireAt = (ref: number): typeof oiRows => oiRows.filter((o) => stageAt(o, ref) === "al_aire");
  const alAireOis = alAireAt(now);
  const prevAlAireOis = alAireAt(now - DAY_MS).length;
  const alAireScreens = new Set(lineRows.filter((l) =>
    alAireOis.some((o) => o.id === l.io_id) && l.starts_ms !== null && l.ends_ms !== null
    && l.starts_ms <= now && now < l.ends_ms,
  ).map((l) => l.screen_id));
  const porCertificar = oiRows.filter((o) => stageAt(o, now) === "por_certificar").length;

  // 5. Renovación 30d por anunciante (advertiser ?? billing).
  const in30 = oiRows.filter((o) => {
    const e = parseMs(o.ends_at);
    return e !== null && e >= today00 && e <= today00 + 30 * DAY_MS;
  });
  const hasRelevo = (o: (typeof oiRows)[number]): boolean => {
    if (!o.key) return false;
    const e = parseMs(o.ends_at);
    if (e === null) return false;
    return oiRows.some((other) => {
      if (other.id === o.id || !other.key || other.key !== o.key) return false;
      const s2 = parseMs(other.starts_at);
      return s2 !== null && s2 > e;
    });
  };
  const conRelevo = in30.filter(hasRelevo).length;

  const daysUntil = (iso: string | null): number | null => {
    const t = parseMs(iso);
    if (t === null) return null;
    return Math.floor((startOfDayUTC(t) - today00) / DAY_MS);
  };
  const daysSinceStart = (iso: string | null): number | null => {
    const t = parseMs(iso);
    if (t === null) return null;
    return Math.floor((today00 - startOfDayUTC(t)) / DAY_MS);
  };

  const alerts: DashboardAlert[] = [];
  for (const o of oiRows) {
    const du = daysUntil(o.starts_at);
    const ds = daysSinceStart(o.starts_at);
    const co = companyOf(o);
    if (o.status === "signed" && !omBy.has(o.id) && du !== null && du <= 7) {
      alerts.push({
        kind: "sin_om",
        ioId: o.id,
        ioNumber: o.io_number,
        brand: o.brand,
        company: co,
        detail:
          du < 0
            ? `Empezó hace ${Math.abs(du)}d y sigue sin OM — no se puede facturar.`
            : du === 0
              ? `Empieza hoy y no tiene OM registrado.`
              : `Empieza en ${du}d y no tiene OM registrado.`,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      });
    }
    const ended = orderTiming(o, lineRows.filter((l) => l.io_id === o.id), now).ended;
    if (o.status === "signed" && !materialsOk(o.id) && !ended && du !== null && du <= 5) {
      alerts.push({
        kind: "material",
        ioId: o.id,
        ioNumber: o.io_number,
        brand: o.brand,
        company: co,
        detail:
          du < 0
            ? `Salida atrasada: material sin aprobar (QC/legal); revisa la emisión con el operador.`
            : `Empieza en ${du}d sin material aprobado.`,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      });
    }
    const alAire = alAireOis.some((a) => a.id === o.id);
    if (alAire && !photoBy.has(o.id) && ds !== null && ds >= 3) {
      alerts.push({
        kind: "sin_evidencia",
        ioId: o.id,
        ioNumber: o.io_number,
        brand: o.brand,
        company: co,
        detail: `Al aire hace ${ds}d sin foto-check — riesgo de disputa al cobrar.`,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      });
    }
    const due = daysUntil(o.ends_at);
    if (o.status === "signed" && due !== null && due >= 0 && due <= 7 && !hasRelevo(o)) {
      alerts.push({
        kind: "termina_sin_relevo",
        ioId: o.id,
        ioNumber: o.io_number,
        brand: o.brand,
        company: co,
        detail: `Termina ${fmtCorta(o.ends_at)} sin relevo del mismo anunciante.`,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      });
    }
  }
  const KIND_ORDER: Record<AlertKind, number> = {
    sin_om: 0,
    material: 1,
    sin_evidencia: 2,
    termina_sin_relevo: 3,
  };
  alerts.sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || String(a.startsAt).localeCompare(String(b.startsAt)),
  );

  const huecos: Hueco[] = screenRows
    .map((s) => {
      const cap = capOf(s.id);
      const sold = soldByScreen.get(s.id) ?? 0;
      return {
        screenId: s.id,
        screenName: s.name,
        diasLibres: WIN - (perScreen.get(s.id)?.size ?? 0),
        slotsLibres: cap * WIN - sold,
      };
    })
    .sort((a, b) => b.slotsLibres - a.slotsLibres)
    .slice(0, 5);

  for (const k of Object.keys(byCurrency)) {
    byCurrency[k] = {
      comprometidoMesMinor: Math.round(byCurrency[k].comprometidoMesMinor),
      firmadoMesMinor: Math.round(byCurrency[k].firmadoMesMinor),
      draftMesMinor: Math.round(byCurrency[k].draftMesMinor),
    };
  }
  for (const k of Object.keys(cobranzaByCurrency)) {
    const t = cobranzaByCurrency[k];
    cobranzaByCurrency[k] = {
      invoicedMinor: Math.round(t.invoicedMinor),
      paidMinor: Math.round(t.paidMinor),
      pendingMinor: Math.round(t.pendingMinor),
      overdueMinor: Math.round(t.overdueMinor),
    };
  }
  const cobranza = cobranzaByCurrency[currency] ?? { invoicedMinor: 0, paidMinor: 0, pendingMinor: 0, overdueMinor: 0 };
  const prevCobranzaPending = Math.round(prevByCurrency[currency]?.pendingMinor ?? 0);
  prevComprometido = Math.round(prevComprometido);

  /** Variación en puntos (base 100); null = sin base previa (mes anterior en 0). */
  const pct = (cur: number, prev: number): number | null =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? null : 0;

  return {
    currency,
    comprometidoMesMinor: Math.round(comprometido),
    firmadoMesMinor: Math.round(firmado),
    draftMesMinor: Math.round(draft),
    byCurrency,
    cobranza,
    cobranzaByCurrency,
    deltas: {
      comprometido: pct(Math.round(comprometido), prevComprometido),
      cobranzaPendiente: pct(cobranza.pendingMinor, prevCobranzaPending),
      alAireOis: pct(alAireOis.length, prevAlAireOis),
    },
    prev: {
      comprometidoMinor: prevComprometido,
      cobranzaPendingMinor: prevCobranzaPending,
      alAireOis: prevAlAireOis,
    },
    ocupacion14d: { ratio: ocupacionRatio, slotsVendidos, slotsDisponibles },
    alAire: { ois: alAireOis.length, pantallas: alAireScreens.size },
    porCertificar,
    renovacion30d: {
      conRelevo,
      total: in30.length,
      ratio: in30.length > 0 ? conRelevo / in30.length : null,
    },
    alerts: alerts.slice(0, 20),
    huecos,
    counts: { ois: oiRows.length, screens: screenRows.length, truncated },
    truncated,
  };
}
