import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getMyActiveStore, requireMyStoreAccess } from "@/lib/tenant";
import { listScreenFilterOptions } from "@/lib/screens-db";
import { NuevaPantallaForm } from "./nueva-form";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

export default async function NuevaPantallaPage() {
  await connection();
  const { active } = await getMyActiveStore(null).catch(() => ({ active: null as null }));
  const storeId = active?.id ?? null;
  const connected = Boolean(storeId);
  const dbReady = isSupabaseConfigured();

  let suppliers: Array<{ id: string; name: string }> = [];
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      if ((await requireMyStoreAccess(storeId!).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        suppliers = (await listScreenFilterOptions(storeId!)).suppliers;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "No se pudieron cargar los datos.";
    }
  }

  const shopCountry = String(active?.shop_country ?? "").trim().toUpperCase();
  const defaultCountry = /^[A-Z]{2}$/.test(shopCountry) ? shopCountry : "PE";

  return (
    <div className="page-shell max-w-[860px]">
      <PageHeader
        eyebrow="DOOH"
        title="Nueva pantalla"
        description="Marca el punto en el mapa, completa la ubicación y registra la pantalla con sus medidas y precio."
        backHref="/screens"
      />
      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}
      {connected && dbReady && !error && (
        <NuevaPantallaForm suppliers={suppliers} defaultCountry={defaultCountry} />
      )}
    </div>
  );
}
