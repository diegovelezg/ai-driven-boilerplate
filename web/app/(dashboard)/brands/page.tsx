import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { listBrands, parseBrandsSort } from "@/lib/brand-db";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { connection } from "next/server";
import { BrandsList } from "./brands-list";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

export default async function MarcasPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; dir?: string; brand?: string; marca?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const selectedBrand = ((sp.brand ?? sp.marca) ?? "").trim() || null;
  const { key: sortKey, dir: sortDir } = parseBrandsSort({ sort: sp.sort, dir: sp.dir });

  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let rows: Awaited<ReturnType<typeof listBrands>> = [];
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if (!storeId) error = "Sin tienda.";
      else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        rows = await listBrands(storeId, { q, sortKey, sortDir });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "No se pudieron cargar los datos.";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Marcas"
        description="Cuánto y con qué frecuencia pauta cada marca: pedidos, inversión, última pauta y agencias. Las marcas se crean al registrar una orden."
      />

      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <BrandsList rows={rows} q={q} sortKey={sortKey} sortDir={sortDir} initialSelectedBrand={selectedBrand} />
      )}
    </div>
  );
}
