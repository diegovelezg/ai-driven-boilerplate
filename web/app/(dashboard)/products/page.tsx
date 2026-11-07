import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { AutoRefresh } from "@/components/auto-refresh";
import { isSupabaseConfigured } from "@/lib/supabase";
import { resolveActiveStoreId } from "@/lib/tenant";
import { listProductsWithStats, type ProductWithStats } from "@/lib/product-stats";
import { requireMyStoreAccess } from "@/lib/tenant";
import { ProductsList } from "./products-list";
import { ProductsSearch } from "./products-search";
import { ProductsEstadoSelect } from "./products-estado-select";
import { connection } from "next/server";

export const instant = false;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; estado?: string }>;
}) {
  // Request-time: usa Date.now() en el render (Cache Components no lo
  // difiere con `instant = false`; ver nota en app/(dashboard)/page.tsx).
  await connection();
  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().toLowerCase();
  const estado = sp.estado === "inactivos" ? "inactivos" : sp.estado === "todos" ? "todos" : "activos";

  let rows: ProductWithStats[] = [];
  let total = 0;
  let truncated = false;
  let error: string | null = null;
  let synced = false;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if (!storeId) {
        error = "Sin tienda.";
      } else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda. Pide a tu admin que te agregue en merchant_users.";
      } else {
        synced = true;
        const res = await listProductsWithStats(storeId);
        rows = res.rows;
        total = res.total;
        truncated = res.truncated;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  // Filtro en servidor (simple, sin Matches raros): texto + estado.
  const filtered = rows.filter(
    (r) =>
      (!q || r.title.toLowerCase().includes(q)) &&
      (estado === "todos" || (estado === "activos" ? r.is_active : !r.is_active)),
  );
  // Conteos globales (sin filtro): la línea de resumen no depende del filtro.
  const activeTotal = rows.filter((r) => r.is_active).length;

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-8 p-6 md:p-8">
      <AutoRefresh ms={60_000} />
      <PageHeader
        eyebrow="Catálogo del tenant"
        title="Catálogo"
        description="Qué ofrece el negocio y qué se mueve. Solo lectura: sin gestión de catálogo."

      />

      {!connected && (
        <AppCard
          footer={
            <Button
              render={<Link href="/settings" />}
              nativeButton={false}
              variant="outline"
              size="sm"
            >
              Ir a Settings
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            Sin tienda. Importa inventario en /screens.
          </p>
        </AppCard>
      )}

      {connected && !dbReady && (
        <AppCardState>
          Supabase no configurado. Levanta el stack local (`supabase start`) y define
          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en `web/.env.local`.
        </AppCardState>
      )}

      {error && <AppCard><p className="text-sm text-muted-foreground">{error}</p></AppCard>}

      {synced && !error && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <ProductsSearch q={sp.q ?? ""} estado={estado} />
            <ProductsEstadoSelect estado={estado} q={sp.q ?? ""} />
          </div>
          <ProductsList rows={filtered} total={total} truncated={truncated} activeTotal={activeTotal} inactiveTotal={rows.length - activeTotal} />
        </div>
      )}
    </div>
  );
}
