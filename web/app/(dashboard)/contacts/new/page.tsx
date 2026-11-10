import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { listCrmCompanies, listDistinctJobTitles } from "@/lib/crm-db";
import { loadPageData } from "@/lib/page-data";
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

  const { data, connected, dbReady, error } = await loadPageData(
    async (storeId) => {
      const [cos, titles] = await Promise.all([
        listCrmCompanies(storeId, { pageSize: 200 }),
        listDistinctJobTitles(storeId).catch(() => [] as string[]),
      ]);
      return { companies: cos.rows.map((c) => ({ id: c.id, name: c.name })), jobTitles: titles };
    },
    { companies: [] as Array<{ id: string; name: string }>, jobTitles: [] as string[] },
  );
  const { companies, jobTitles } = data;

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
        <AppCard title="Datos">
          <NuevoContactoForm companies={companies} jobTitles={jobTitles} initialCompanyId={initialCompanyId} />
        </AppCard>
      )}
    </div>
  );
}
