import Link from "next/link";
import { Plus } from "lucide-react";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { listCrmCompanies, parseCompaniesSort } from "@/lib/crm-db";
import { loadPageData } from "@/lib/page-data";
import { isCrmStatusFilter, parseCompanyKinds, isDefaultCompanyKinds, type CrmStatusFilter } from "@/lib/crm";
import { connection } from "next/server";
import { CompaniesList } from "./companies-list";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

const VIEW_ALIASES: Record<string, "table" | "grid"> = {
  table: "table",
  tabla: "table",
  grid: "grid",
  grilla: "grid",
};

export default async function EmpresasPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string | string[]; tipo?: string | string[]; view?: string; vista?: string; sort?: string; dir?: string; page?: string; company?: string; empresa?: string; status?: string; estado?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  // Multiselect: ?type=a&type=b, ?type=a,b o ?tipo=. Sin parámetro → default
  // (agencia + anunciante, sin proveedor). Acepta legacy ?type=agencia.
  const kinds = parseCompanyKinds(sp.type ?? sp.tipo);
  const status: CrmStatusFilter = isCrmStatusFilter(sp.status ?? sp.estado) ? (sp.status ?? sp.estado) as CrmStatusFilter : "active";
  const vista: "table" | "grid" = VIEW_ALIASES[sp.view ?? sp.vista ?? ""] ?? "table";
  const { key: sortKey, dir: sortDir } = parseCompaniesSort({ sort: sp.sort, dir: sp.dir });
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const selectedId = ((sp.company ?? sp.empresa) ?? "").trim() || null;
  const PAGE_SIZE = 20;

  const { data, connected, dbReady, error } = await loadPageData(
    async (storeId) => {
      const res = await listCrmCompanies(storeId, { q, kinds, sortKey, sortDir, page, pageSize: PAGE_SIZE, status });
      return { rows: res.rows, totalCount: res.total };
    },
    { rows: [] as Awaited<ReturnType<typeof listCrmCompanies>>["rows"], totalCount: 0 },
  );
  const { rows, totalCount } = data;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Empresas"
        description="Agencias, anunciantes y proveedores con sus contactos. La marca que se pauta se registra en la orden."
        right={
          <Button render={<Link href="/companies/new" />} nativeButton={false} size="sm">
            <Plus aria-hidden />
            Nueva empresa
          </Button>
        }
      />

      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <>
          {rows.length === 0 && !q && isDefaultCompanyKinds(kinds) && status === "active" ? (
            <AppCardState>
              Aún no hay empresas.{" "}
              <Link href="/companies/new" className="underline underline-offset-4">
                Crea la primera
              </Link>
              .
            </AppCardState>
          ) : (
            <CompaniesList
              rows={rows.map((r) => ({
                id: r.id,
                name: r.name,
                kind: r.kind,
                tax_id: r.tax_id,
                domain: r.domain,
                email: r.email,
                city: r.city,
                contacts_count: r.contacts_count,
                deleted_at: r.deleted_at,
              }))}
              totalCount={totalCount}
              page={page}
              pageSize={PAGE_SIZE}
              q={q}
              kinds={kinds}
              status={status}
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
