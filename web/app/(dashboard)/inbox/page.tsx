import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { InsightsWall } from "@/components/insights-wall";
import { PageHeader } from "@/components/page-header";
import { loadPageData } from "@/lib/page-data";
import type { WallInsight } from "@/lib/insights";
import { BriefRunButton } from "./brief-run-button";

export const instant = false;

/** Inbox de insights (issue #11): página propia, navegable con el icono
 *  Inbox debajo de Dashboard. Mismo feed persistido que el inserto en Hoy. */
export default async function InboxPage() {
  await connection();
  const { data, connected, dbReady, error } = await loadPageData(
    async () => {
      const { getWallAction } = await import("@/lib/insights-actions");
      const wall = await getWallAction().catch(() => []);
      return { wall };
    },
    { wall: [] as WallInsight[] },
  );
  const { wall } = data;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="DOOH"
        title="Inbox"
        description="Qué importa hoy y qué hacer. Una sola bandeja por tenant; lo personal es el filtro Mías. Sin novedad = silencio."
        right={<BriefRunButton />}
      />

      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && wall.length === 0 && (
        <AppCardState>Sin avisos. Cuando el brief diario genere posts, aparecen aquí.</AppCardState>
      )}
      {wall.length > 0 && <InsightsWall initial={wall} />}
    </div>
  );
}
