import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { listCrmCompanies, listDistinctJobTitles } from "@/lib/crm-db";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { connection } from "next/server";
import { NuevoContactoForm } from "./nuevo-form";

// Request-time: ver nota en app/(dashboard)/page.tsx.
export const instant = false;

export default async function NuevoContactoPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; empresa?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const initialCompanyId = ((sp.company ?? sp.empresa) ?? "").trim();

  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let companies: Array<{ id: string; name: string }> = [];
  let jobTitles: string[] = [];
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if (!storeId) error = "Sin tienda.";
      else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        const [cos, titles] = await Promise.all([
          listCrmCompanies(storeId, { pageSize: 200 }),
          listDistinctJobTitles(storeId).catch(() => [] as string[]),
        ]);
        companies = cos.rows.map((c) => ({ id: c.id, name: c.name }));
        jobTitles = titles;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "No se pudieron cargar los datos.";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Nuevo contacto"
        description="Datos de la persona y de la empresa a la que pertenece."
        backHref="/contacts"
      />

      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <AppCard title="Datos" description="Indica la empresa y al menos un canal: email o teléfono.">
          <NuevoContactoForm companies={companies} jobTitles={jobTitles} initialCompanyId={initialCompanyId} />
        </AppCard>
      )}
    </div>
  );
}
