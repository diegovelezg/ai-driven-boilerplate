// Dashboard Hoy v1 — solo desde la OI (sin facturación).
// Fuente: io_orders + lines + io_agency_orders + creatives + io_photo_checks.
// Sin prorrateo inventado más allá de lineal por tiempo solapado; sin
// impresiones/GRP (io_play_logs del CMS vive fuera).
import { getSupabase } from "@/lib/supabase";
import { normalizeCurrency } from "@/lib/currency";
import { startOfDayUTC } from "@/lib/dates";

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
  diasLibres: number;
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
  ocupacion14d: { ratio: number | null; diasVendidos: number; diasDisponibles: number };
  alAire: { ois: number; pantallas: number };
  porCertificar: number;
  renovacion30d: { conRelevo: number; total: number; ratio: number | null };
  alerts: DashboardAlert[];
  huecos: Hueco[];
  counts: { ois: number; screens: number; truncated: boolean };
  /** true si alguna fuente se truncó por límite (muestra parcial, no total exacto). */
  truncated: boolean;
}

const DAY_MS = 86_400_000;

// SSOT: startOfDayUTC vive en lib/dates.ts (issue #8 P2).

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

  const [{ data: store, count: screensTotal }, { data: screens }, { data: ois, count: oisTotal }] = await Promise.all([
    db.from("sys_stores").select("shop_currency").eq("id", storeId).maybeSingle(),
    db.from("inv_screens").select("id,name", { count: "exact" }).eq("store_id", storeId).eq("is_active", true).limit(500),
    db
      .from("io_orders")
      .select("id,io_number,brand,status,starts_at,ends_at,advertiser_company_id,billing_company_id,currency", { count: "exact" })
      .eq("store_id", storeId)
      .neq("status", "cancelled")
      .order("starts_at", { ascending: true })
      .limit(500),
  ]);
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
        .select("io_id,screen_id,rate_minor,starts_at,ends_at")
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

  // 1. Comprometido mes (prorrateo lineal por tiempo solapado, por moneda).
  const dNow = new Date(today00);
  const monthStart = Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth(), 1);
  const monthEnd = Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth() + 1, 1);
  let comprometido = 0;
  let firmado = 0;
  let draft = 0;
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
    const overlap = Math.max(0, Math.min(l.ends_ms, monthEnd) - Math.max(l.starts_ms, monthStart));
    if (overlap <= 0) continue;
    const part = (overlap / (l.ends_ms - l.starts_ms)) * l.rate_minor;
    const io = oiById.get(l.io_id);
    const st = io?.status;
    bump(io?.currency ?? currency, part, st === "signed");
  }

  // 2. Ocupación 14d (pantalla-día por líneas, no por bookings hold).
  const WIN = 14;
  const winEnd = today00 + WIN * DAY_MS;
  const occupied = new Set<string>();
  const perScreen = new Map<string, Set<number>>();
  for (const l of lineRows) {
    if (l.starts_ms === null || l.ends_ms === null || l.ends_ms <= l.starts_ms) continue;
    const s = Math.max(l.starts_ms, today00);
    const e = Math.min(l.ends_ms, winEnd);
    if (e <= s) continue;
    for (let d = 0; d < WIN; d++) {
      const dayStart = today00 + d * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      if (s < dayEnd && dayStart < e) {
        occupied.add(`${l.screen_id}:${d}`);
        let set = perScreen.get(l.screen_id);
        if (!set) {
          set = new Set();
          perScreen.set(l.screen_id, set);
        }
        set.add(d);
      }
    }
  }
  const diasDisponibles = screenRows.length * WIN;
  const diasVendidos = occupied.size;
  const ocupacionRatio = diasDisponibles > 0 ? diasVendidos / diasDisponibles : null;

  // 3. Al aire hoy.
  const alAireOis = oiRows.filter((o) => {
    const s = parseMs(o.starts_at);
    const e = parseMs(o.ends_at);
    if (s === null || e === null) return false;
    return s <= now && now <= e + DAY_MS; // ends_at es fecha: incluye el día
  });
  const alAireScreens = new Set(
    lineRows.filter((l) => alAireOis.some((o) => o.id === l.io_id)).map((l) => l.screen_id),
  );

  // 4. Por certificar: terminó y sin foto.
  const porCertificar = oiRows.filter((o) => {
    const e = parseMs(o.ends_at);
    return e !== null && e < today00 && !photoBy.has(o.id);
  }).length;

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
    const e = parseMs(o.ends_at);
    const ended = e !== null && e < today00;
    if (o.status === "signed" && !materialsOk(o.id) && !ended && du !== null && du <= 5) {
      alerts.push({
        kind: "material",
        ioId: o.id,
        ioNumber: o.io_number,
        brand: o.brand,
        company: co,
        detail:
          du < 0
            ? `Al aire con material sin aprobar (QC/legal).`
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
    .map((s) => ({
      screenId: s.id,
      screenName: s.name,
      diasLibres: WIN - (perScreen.get(s.id)?.size ?? 0),
    }))
    .sort((a, b) => b.diasLibres - a.diasLibres)
    .slice(0, 5);

  for (const k of Object.keys(byCurrency)) {
    byCurrency[k] = {
      comprometidoMesMinor: Math.round(byCurrency[k].comprometidoMesMinor),
      firmadoMesMinor: Math.round(byCurrency[k].firmadoMesMinor),
      draftMesMinor: Math.round(byCurrency[k].draftMesMinor),
    };
  }

  return {
    currency,
    comprometidoMesMinor: Math.round(comprometido),
    firmadoMesMinor: Math.round(firmado),
    draftMesMinor: Math.round(draft),
    byCurrency,
    ocupacion14d: { ratio: ocupacionRatio, diasVendidos, diasDisponibles },
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
