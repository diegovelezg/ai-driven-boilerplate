import Link from "next/link";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { listCrmCompanies, parseEmpresasSort } from "@/lib/crm-db";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { isCompanyKind } from "@/lib/crm";
import { connection } from "next/server";
import { EmpresasList } from "./empresas-list";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

export default async function EmpresasPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tipo?: string; vista?: string; sort?: string; dir?: string; page?: string; empresa?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const kind = isCompanyKind(sp.tipo) ? sp.tipo : null;
  const vista = sp.vista === "grilla" ? "grilla" : "tabla";
  const { key: sortKey, dir: sortDir } = parseEmpresasSort({ sort: sp.sort, dir: sp.dir });
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const selectedId = (sp.empresa ?? "").trim() || null;
  const PAGE_SIZE = 20;

  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let rows: Awaited<ReturnType<typeof listCrmCompanies>>["rows"] = [];
  let totalCount = 0;
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if (!storeId) error = "Sin tienda.";
      else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        const res = await listCrmCompanies(storeId, { q, kind, sortKey, sortDir, page, pageSize: PAGE_SIZE });
        rows = res.rows;
        totalCount = res.total;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Empresas"
        description="Cada empresa tiene un tipo obligatorio (agencia, anunciante o proveedor) y N contactos. La marca publicitada es dato del pedido, no una empresa."
        right={
          <Button render={<Link href="/empresas/nueva" />} nativeButton={false} size="sm">
            Nueva empresa
          </Button>
        }
      />

      {!connected && <AppCardState>Sin tienda. Importa inventario en /inventario.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <>
          {rows.length === 0 && !q && !kind ? (
            <AppCardState>
              Aún no hay empresas.{" "}
              <Link href="/empresas/nueva" className="underline underline-offset-4">
                Crea la primera
              </Link>
              .
            </AppCardState>
          ) : (
            <EmpresasList
              rows={rows}
              totalCount={totalCount}
              page={page}
              pageSize={PAGE_SIZE}
              q={q}
              kind={kind}
              sortKey={sortKey}
              sortDir={sortDir}
              initialView={vista}
              initialSelectedId={selectedId}
            />
          )}
        </>
      )}
    </div>
  );
}
