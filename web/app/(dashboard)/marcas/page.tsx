import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { listBrands, parseBrandsSort } from "@/lib/brand-db";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { connection } from "next/server";
import { MarcasList } from "./marcas-list";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

export default async function MarcasPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; dir?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
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
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Marcas"
        description="La recurrencia se mide por marca: pedidos, inversión, última pauta, pantallas y agencias. La marca nace del pedido, no se crea acá."
      />

      {!connected && <AppCardState>Sin tienda. Importa inventario en /inventario.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <MarcasList rows={rows} q={q} sortKey={sortKey} sortDir={sortDir} />
      )}
    </div>
  );
}
