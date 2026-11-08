import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { InsightsWall } from "@/components/insights-wall";
import { PageHeader } from "@/components/page-header";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import type { WallInsight } from "@/lib/insights";

export const instant = false;

/** Muro de insights (issue #11): página propia, navegable con el icono
 *  Inbox debajo de Dashboard. Mismo feed persistido que el inserto en Hoy. */
export default async function MuroPage() {
  await connection();
  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let wall: WallInsight[] = [];
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        const { getWallAction } = await import("@/lib/insights-actions");
        wall = await getWallAction().catch(() => []);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "No se pudieron cargar los datos.";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="DOOH"
        title="Muro"
        description="Qué importa hoy y qué hacer. Un solo muro por tenant; lo personal es el filtro Mis pendientes. Sin novedad = silencio."
      />

      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && wall.length === 0 && (
        <AppCardState>Sin avisos. Cuando el muro diario genere posts, aparecen aquí.</AppCardState>
      )}
      {wall.length > 0 && <InsightsWall initial={wall} />}
    </div>
  );
}
