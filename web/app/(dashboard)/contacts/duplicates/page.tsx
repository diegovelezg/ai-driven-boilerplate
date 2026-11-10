import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { listContactDuplicateGroups } from "@/lib/contact-duplicates";
import { loadPageData } from "@/lib/page-data";
import { connection } from "next/server";
import { DuplicatesList } from "./duplicates-list";

export const instant = false;

export default async function ContactDuplicatesPage() {
  await connection();
  const { data, connected, dbReady, error } = await loadPageData(
    async (storeId) => {
      const res = await listContactDuplicateGroups(storeId);
      return { groups: res.groups, truncated: res.truncated };
    },
    { groups: [] as Awaited<ReturnType<typeof listContactDuplicateGroups>>["groups"], truncated: false },
  );
  const { groups, truncated } = data;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Contactos duplicados"
        description="Mismo email o teléfono en varias fichas: elige cuál conservar y fusiona el resto."
      />

      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <>
          {truncated && (
            <AppCardState>
              Hay más de 2000 contactos: se revisaron los primeros. Fusiona por tandas.
            </AppCardState>
          )}
          {groups.length === 0 ? (
            <AppCardState>Sin duplicados: cada email y teléfono aparece una sola vez.</AppCardState>
          ) : (
            <DuplicatesList groups={groups} />
          )}
        </>
      )}
    </div>
  );
}
