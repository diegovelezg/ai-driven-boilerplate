import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { getScreenConflicts } from "@/lib/availability";
import { todayLima } from "@/lib/availability-utils";
import { resolveActor } from "@/lib/actor";
import { listScreens, listScreenFilterOptions } from "@/lib/screens-db";
import { OccupancyTimeline } from "./occupancy-timeline";

export const instant = false;

function validDay(v: string | undefined, fallback: string): string {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v))) return v;
  return fallback;
}

export default async function OcupacionPage({
  searchParams,
}: {
  searchParams: Promise<{ desde?: string; dias?: string; q?: string; ciudad?: string; proveedor?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const today = todayLima();
  const desde = validDay(sp.desde?.trim(), today);
  const diasRaw = Number.parseInt(sp.dias ?? "14", 10);
  const dias = [7, 14, 28].includes(diasRaw) ? diasRaw : 14;
  const q = (sp.q ?? "").trim();
  const ciudad = (sp.ciudad ?? "").trim() || null;
  // Explícito manda: uuid, "own" (red propia) o "all". Sin param, default =
  // red propia si la tienda tiene casa (kind NULL), si no todos.
  const rawProveedor = (sp.proveedor ?? "").trim().toLowerCase();
  const explicitProveedor = rawProveedor === "" || rawProveedor === "all" ? null : rawProveedor;

  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  if (!connected || !dbReady) {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
        <PageHeader
          eyebrow="Operación"
          title="Ocupación"
          description="Qué pantalla está ocupada cada día y dónde hay hueco para vender."
        />
        <AppCardState>{!connected ? "Sin tienda conectada." : "Base de datos no disponible."}</AppCardState>
      </div>
    );
  }

  const storeId = activeStoreId!;
  if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
        <PageHeader eyebrow="Operación" title="Ocupación" description="Qué pantalla está ocupada cada día." />
        <AppCardState>Sin acceso a esta tienda.</AppCardState>
      </div>
    );
  }

  // Ventana [desde, desde + dias - 1] (días inclusivos, formato del lector).

  let screens: Array<{ id: string; name: string; city: string | null; venue_name: string | null }> = [];
  let cities: string[] = [];
  let suppliers: Array<{ id: string; name: string }> = [];
  // "own" = red propia (supplier_company_id NULL); la casa (kind NULL) le da nombre.
  let supplierValue = "all";
  let casaName: string | null = null;
  let truncated = false;
  let error: string | null = null;
  let conflicts: Awaited<ReturnType<typeof getScreenConflicts>> = [];

  try {
    const db = getSupabase();
    // Empresa de la cuenta logueada: email de sesión → contacto → compañía.
    // (Sin match: se degrada a casa → todos, nunca inventa.)
    const actorEmail = (await resolveActor().catch(() => null))?.trim() || null;
    let myCompany: { id: string; kind: string | null } | null = null;
    if (actorEmail) {
      const variants = [...new Set([actorEmail, actorEmail.toLowerCase()])];
      const { data: contacts } = await db
        .from("crm_contacts")
        .select("company_id,email")
        .eq("store_id", storeId)
        .in("email", variants)
        .limit(5);
      const hit = ((contacts ?? []) as Array<Record<string, unknown>>).find(
        (c) =>
          typeof c.email === "string" &&
          c.email.toLowerCase() === actorEmail.toLowerCase() &&
          typeof c.company_id === "string" &&
          c.company_id !== "",
      );
      if (hit) {
        const { data: co } = await db
          .from("crm_companies")
          .select("id,kind")
          .eq("store_id", storeId)
          .eq("id", String(hit.company_id))
          .maybeSingle();
        const row = co as Record<string, unknown> | null;
        if (row) myCompany = { id: String(row.id), kind: (row.kind as string | null) ?? null };
      }
    }
    const { data: casa } = await db
      .from("crm_companies")
      .select("id,name")
      .eq("store_id", storeId)
      .is("kind", null)
      .limit(1)
      .maybeSingle();
    casaName = typeof (casa as Record<string, unknown> | null)?.name === "string"
      ? String((casa as Record<string, unknown>).name)
      : null;
    // Vínculo tienda→empresa propia: dato configurado (sys_stores.home_company_id),
    // no heurística. Si la migración aún no corrió, el select falla y data es
    // null → se degrada a casa → todos.
    let homeCompany: { id: string; kind: string | null } | null = null;
    {
      const { data: storeRow } = await db
        .from("sys_stores")
        .select("home_company_id")
        .eq("id", storeId)
        .maybeSingle();
      const homeId = (storeRow as Record<string, unknown> | null)?.home_company_id;
      if (typeof homeId === "string" && homeId !== "") {
        const { data: hc } = await db
          .from("crm_companies")
          .select("id,kind")
          .eq("store_id", storeId)
          .eq("id", homeId)
          .maybeSingle();
        const hrow = hc as Record<string, unknown> | null;
        if (hrow) homeCompany = { id: String(hrow.id), kind: (hrow.kind as string | null) ?? null };
      }
    }
    // Default: explícito > empresa de la cuenta (contacto) > empresa
    // configurada de la tienda > casa (red propia) > todos. Solo aplican
    // proveedor (su id) y casa (own); otros kinds no filtran.
    const pick = (co: { id: string; kind: string | null } | null): string | null =>
      !co ? null : co.kind === "proveedor" ? co.id : co.kind === null ? "own" : null;
    supplierValue =
      explicitProveedor ?? pick(myCompany) ?? pick(homeCompany) ?? (casaName ? "own" : "all");
    const listSupplierId = supplierValue !== "own" && supplierValue !== "all" ? supplierValue : null;
    const [list, opts] = await Promise.all([
      listScreens(storeId, { q, city: ciudad, supplierId: listSupplierId, active: "active", sortKey: "name", sortDir: "asc", page: 1, pageSize: 100 }),
      listScreenFilterOptions(storeId).catch(() => ({ cities: [] as string[], suppliers: [] as Array<{ id: string; name: string }>, truncated: false })),
    ]);
    // Red propia = pantallas sin proveedor (ownership own); el RPC no lo
    // expresa (NULL = sin filtro), así que se filtra sobre la muestra.
    const ownOnly = supplierValue === "own";
    const rows = ownOnly ? list.rows.filter((r) => !r.supplier_id) : list.rows;
    screens = rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      venue_name: r.venue_name,
    }));
    cities = opts.cities;
    suppliers = opts.suppliers;
    truncated = Boolean(list.truncated) || (list.total ?? 0) > screens.length;
    // Fin inclusivo = último día visible (desde + dias - 1).
    const [y, m, d] = desde.split("-").map(Number);
    const p = (n: number) => String(n).padStart(2, "0");
    const last = new Date(Date.UTC(y, m - 1, d) + (dias - 1) * 86_400_000);
    const lastStr = `${last.getUTCFullYear()}-${p(last.getUTCMonth() + 1)}-${p(last.getUTCDate())}`;
    conflicts = await getScreenConflicts(storeId, desde, lastStr);
  } catch (e) {
    error = e instanceof Error ? e.message : "No se pudieron cargar los datos.";
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="Operación"
        title="Ocupación"
        description="Filas = pantallas, columnas = días. Rojo ocupado, verde libre. Clic en la pantalla para su ficha."
      />
      {error && <AppCardState>{error}</AppCardState>}
      {!error && (
        <OccupancyTimeline
          screens={screens}
          conflicts={conflicts}
          desde={desde}
          dias={dias}
          q={q}
          ciudad={ciudad}
          cities={cities}
          supplierValue={supplierValue}
          suppliers={suppliers}
          casaName={casaName}
          truncated={truncated}
        />
      )}
    </div>
  );
}
