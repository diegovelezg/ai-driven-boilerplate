import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { readConnections } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/supabase";
import { resolveStoreId } from "@/lib/customers-db";
import { listProductsWithStats, type ProductWithStats } from "@/lib/product-stats";
import { ProductsList } from "./products-list";
import { SyncButton } from "../customers/sync-button";

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; estado?: string }>;
}) {
  const conn = await readConnections();
  const connected = Boolean(conn.medusaUrl && conn.medusaToken);
  const dbReady = isSupabaseConfigured();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().toLowerCase();
  const estado = sp.estado === "inactivos" ? "inactivos" : sp.estado === "activos" ? "activos" : "todos";

  let rows: ProductWithStats[] = [];
  let total = 0;
  let truncated = false;
  let error: string | null = null;
  let synced = false;

  if (connected && dbReady) {
    try {
      const storeId = await resolveStoreId(conn.medusaUrl);
      if (!storeId) {
        error = "Tienda aún sin sincronizar. Presiona Sincronizar.";
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

  // storeId para las acciones: se resuelve de nuevo (barato, cacheado por request).
  let actionStoreId: string | null = null;
  if (synced) {
    actionStoreId = await resolveStoreId(conn.medusaUrl).catch(() => null);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="Catálogo del tenant"
        title="Catálogo"
        description="Qué ofrece el negocio, qué se mueve y qué está apagado para el engine."
        right={
          <span className="flex flex-wrap items-center gap-2">
            {synced && <SyncButton />}
            <Link
              href={`/products?estado=todos${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`text-xs underline-offset-4 hover:underline ${estado === "todos" ? "font-semibold" : "text-muted-foreground"}`}
            >
              Todos
            </Link>
            <Link
              href={`/products?estado=activos${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`text-xs underline-offset-4 hover:underline ${estado === "activos" ? "font-semibold" : "text-muted-foreground"}`}
            >
              Activos
            </Link>
            <Link
              href={`/products?estado=inactivos${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`text-xs underline-offset-4 hover:underline ${estado === "inactivos" ? "font-semibold" : "text-muted-foreground"}`}
            >
              Inactivos
            </Link>
          </span>
        }
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
            Conecta Medusa con tu usuario admin para traer el catálogo.
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

      {synced && !error && actionStoreId && (
        <ProductsList storeId={actionStoreId} rows={filtered} total={total} truncated={truncated} />
      )}
    </div>
  );
}
