import Link from "next/link";
import { CircleArrowLeft } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
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
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Nuevo contacto"
        description="Una persona, una empresa. La marca que publicita va en el pedido, no acá."
        right={<Button render={<Link href="/contacts" />} nativeButton={false} size="sm" variant="outline"><CircleArrowLeft />Volver</Button>}
      />

      {!connected && <AppCardState>Sin tienda. Importa inventario en /screens.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <AppCard title="Datos" description="Empresa y una vía de contacto (email o teléfono).">
          <NuevoContactoForm companies={companies} jobTitles={jobTitles} initialCompanyId={initialCompanyId} />
        </AppCard>
      )}
    </div>
  );
}
