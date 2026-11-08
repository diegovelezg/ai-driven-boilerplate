import Link from "next/link";
import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { ScreensList } from "./screens-list";
import { listScreenFilterOptions, listScreens, parseScreensSort } from "@/lib/screens-db";

// Ruta autenticada multi-tenant (lee Supabase por request a través del
// layout): se permite el render bloqueante como el resto del dashboard.
export const instant = false;

const VIEW_ALIASES: Record<string, "table" | "grid"> = {
  table: "table",
  tabla: "table",
  grid: "grid",
  grilla: "grid",
};

const ACTIVE_ALIASES: Record<string, "all" | "active" | "inactive"> = {
  all: "all",
  todas: "all",
  active: "active",
  activas: "active",
  inactive: "inactive",
  inactivas: "inactive",
};

export default async function InventarioPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    proveedor?: string;
    ciudad?: string;
    estado?: string;
    view?: string;
    vista?: string;
    sort?: string;
    dir?: string;
    page?: string;
    pantalla?: string;
    screen?: string;
  }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const supplierId = (sp.proveedor ?? "").trim() || null;
  const city = (sp.ciudad ?? "").trim() || null;
  const active = ACTIVE_ALIASES[sp.estado ?? ""] ?? "all";
  const vista: "table" | "grid" = VIEW_ALIASES[sp.view ?? sp.vista ?? ""] ?? "table";
  const { key: sortKey, dir: sortDir } = parseScreensSort({ sort: sp.sort, dir: sp.dir });
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const selectedId = ((sp.pantalla ?? sp.screen) ?? "").trim() || null;
  const PAGE_SIZE = 20;

  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let rows: Awaited<ReturnType<typeof listScreens>>["rows"] = [];
  let totalCount = 0;
  let suppliers: Array<{ id: string; name: string }> = [];
  let cities: string[] = [];
  let counts: Record<string, number> = {};
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        const [list, opts] = await Promise.all([
          listScreens(storeId, { q, supplierId, city, active, sortKey, sortDir, page, pageSize: PAGE_SIZE }),
          listScreenFilterOptions(storeId),
        ]);
        rows = list.rows;
        totalCount = list.total;
        suppliers = opts.suppliers;
        cities = opts.cities;
        const db = getSupabase();
        const tables = ["inv_venues", "inv_screens", "inv_slots"] as const;
        const settled = await Promise.all(
          tables.map((t) => db.from(t).select("id", { count: "exact", head: true }).eq("store_id", storeId)),
        );
        counts = Object.fromEntries(tables.map((t, i) => [t, settled[i]?.count ?? 0]));
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="DOOH"
        title="Inventario publicitario"
        description="Espacios publicitarios: ubicaciones → pantallas → slots → reservas. Cada pantalla pertenece a un proveedor."
        right={
          connected && dbReady && !error ? (
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {counts.inv_venues ?? 0} ubicaciones · {counts.inv_screens ?? 0} pantallas · {counts.inv_slots ?? 0} slots
              </span>
              <Button render={<Link href="/screens/new" />} nativeButton={false} size="sm">
                Nueva pantalla
              </Button>
            </div>
          ) : undefined
        }
      />

      {!connected && <AppCardState>Sin tienda.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <>
          {totalCount === 0 && !q && !supplierId && !city && active === "all" ? (
            <AppCardState>
              Aún no hay pantallas.{" "}
              <Link href="/screens/new" className="underline underline-offset-4">
                Crea la primera
              </Link>
              .
            </AppCardState>
          ) : (
            <ScreensList
              rows={rows}
              totalCount={totalCount}
              page={page}
              pageSize={PAGE_SIZE}
              q={q}
              supplierId={supplierId}
              suppliers={suppliers}
              city={city}
              cities={cities}
              active={active}
              sortKey={sortKey}
              sortDir={sortDir}
              initialView={vista}
              initialSelectedId={selectedId}
            />
          )}
        </>
      )}
    </div>
  );
}
