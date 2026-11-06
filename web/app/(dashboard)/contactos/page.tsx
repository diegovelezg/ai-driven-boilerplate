import Link from "next/link";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { listCrmCompanies, listCrmContacts } from "@/lib/crm-db";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { formatNumber, toTitleCase } from "@/lib/format";
import { connection } from "next/server";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

export default async function ContactosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; empresa?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const companyId = (sp.empresa ?? "").trim() || null;

  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let rows: Awaited<ReturnType<typeof listCrmContacts>> = [];
  let companies: Awaited<ReturnType<typeof listCrmCompanies>>["rows"] = [];
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if (!storeId) error = "Sin tienda.";
      else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        const [contactsRes, companiesRes] = await Promise.all([
          listCrmContacts(storeId, { q, companyId: companyId ?? undefined }),
          listCrmCompanies(storeId, { pageSize: 200 }),
        ]);
        rows = contactsRes;
        companies = companiesRes.rows;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Contactos"
        description="Personas de las empresas: quién firma, quién paga, quién aprueba. El detalle y la creación viven en cada empresa."
        right={<span className="text-xs text-muted-foreground">{formatNumber(rows.length)} en vista</span>}
      />

      {!connected && <AppCardState>Sin tienda. Importa inventario en /inventario.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <>
          <AppCard title="Buscar / filtrar" description="Por nombre, email, cargo o empresa.">
            <form method="get" className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs">
                Buscar
                <input name="q" defaultValue={q} placeholder="nombre, email, cargo…" className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm" />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Empresa
                <select name="empresa" defaultValue={companyId ?? ""} className="h-8 rounded-lg border border-border bg-background px-2 text-sm">
                  <option value="">Todas</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{toTitleCase(c.name)}</option>
                  ))}
                </select>
              </label>
              <Button type="submit" size="sm" variant="outline">Filtrar</Button>
              {(q || companyId) && <Button render={<Link href="/contactos" />} nativeButton={false} size="sm" variant="ghost">Limpiar</Button>}
            </form>
          </AppCard>

          {rows.length === 0 ? (
            <AppCardState>Aún no hay contactos. Se crean desde cada empresa.</AppCardState>
          ) : (
            <AppCard variant="table" title="Contactos" description={`${rows.length} en vista`}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2">Nombre</th>
                    <th className="px-4 py-2">Empresa</th>
                    <th className="px-4 py-2">Cargo</th>
                    <th className="px-4 py-2">Email</th>
                    <th className="px-4 py-2">Principal</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-2 font-medium">
                        {[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}
                      </td>
                      <td className="px-4 py-2">
                        {c.company_id ? (
                          <Link href={`/empresas?empresa=${c.company_id}`} className="underline-offset-4 hover:underline">
                            {c.company_name ? toTitleCase(c.company_name) : "—"}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">{c.job_title ?? "—"}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{c.email ?? c.phone ?? "—"}</td>
                      <td className="px-4 py-2 text-xs">{c.is_primary ? "Sí" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </AppCard>
          )}
        </>
      )}
    </div>
  );
}
