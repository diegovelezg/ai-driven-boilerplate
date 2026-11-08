import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { listContactDuplicateGroups } from "@/lib/contact-duplicates";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { connection } from "next/server";
import { DuplicatesList } from "./duplicates-list";

export const instant = false;

export default async function ContactDuplicatesPage() {
  await connection();
  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let groups: Awaited<ReturnType<typeof listContactDuplicateGroups>>["groups"] = [];
  let truncated = false;
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if (!storeId) error = "Sin tienda.";
      else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        const res = await listContactDuplicateGroups(storeId);
        groups = res.groups;
        truncated = res.truncated;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Contactos duplicados"
        description="Mismo email o mismo teléfono: elige quién queda y fusiona. Las campañas se re-apuntan al que queda."
      />

      {!connected && <AppCardState>Sin tienda. Importa inventario en /screens.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
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
