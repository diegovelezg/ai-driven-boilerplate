import Link from "next/link";
import { CopyCheck, Plus } from "lucide-react";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { listCrmCompanies, listCrmContacts } from "@/lib/crm-db";
import { isCrmStatusFilter, parseCompanyKinds, type CrmStatusFilter } from "@/lib/crm";
import { listContactDuplicateGroups } from "@/lib/contact-duplicates";
import { loadPageData } from "@/lib/page-data";
import { getMyStoreRole } from "@/lib/tenant";
import type { MemberRole } from "@/lib/roles";
import { connection } from "next/server";
import { ContactsList } from "./contacts-list";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

const VIEW_ALIASES: Record<string, "table" | "grid"> = {
  table: "table",
  tabla: "table",
  lista: "table",
  list: "table",
  grid: "grid",
  grilla: "grid",
  cards: "grid",
  tarjetas: "grid",
};

export default async function ContactosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string | string[]; tipo?: string | string[]; company?: string; empresa?: string; contact?: string; contacto?: string; view?: string; vista?: string; status?: string; estado?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  // Multiselect igual que empresas (?type / ?tipo): sin parámetro → default
  // (agencia + anunciante, sin proveedor).
  const kinds = parseCompanyKinds(sp.type ?? sp.tipo);
  const companyId = ((sp.company ?? sp.empresa) ?? "").trim() || null;
  const selectedId = ((sp.contact ?? sp.contacto) ?? "").trim() || null;
  const vista: "table" | "grid" = VIEW_ALIASES[sp.view ?? sp.vista ?? ""] ?? "table";
  const status: CrmStatusFilter = isCrmStatusFilter(sp.status ?? sp.estado) ? (sp.status ?? sp.estado) as CrmStatusFilter : "active";

  const { data, connected, dbReady, error } = await loadPageData(
    async (storeId) => {
      const myRole = await getMyStoreRole(storeId).catch(() => null);
      const [contactsRes, companiesRes, dupesRes] = await Promise.all([
        listCrmContacts(storeId, { q, companyId: companyId ?? undefined, status, kinds }),
        listCrmCompanies(storeId, { pageSize: 200 }),
        listContactDuplicateGroups(storeId).catch(() => ({ groups: [] })),
      ]);
      return {
        rows: contactsRes.rows,
        contactsTotal: contactsRes.total,
        contactsTruncated: contactsRes.truncated,
        companies: companiesRes.rows,
        dupeGroups: dupesRes.groups.length,
        myRole,
      };
    },
    {
      rows: [] as Awaited<ReturnType<typeof listCrmContacts>>["rows"],
      contactsTotal: 0,
      contactsTruncated: false,
      companies: [] as Awaited<ReturnType<typeof listCrmCompanies>>["rows"],
      dupeGroups: 0,
      myRole: null as MemberRole | null,
    },
  );
  const { rows, contactsTotal, contactsTruncated, companies, dupeGroups, myRole } = data;

  return (
    <div className="page-shell max-w-[1200px]">
      <PageHeader
        eyebrow="CRM"
        title="Contactos"
        description="Quién firma, quién paga y quién aprueba en cada empresa. También puedes agregarlos desde la ficha de la empresa."
        right={
          <span className="flex items-center gap-2">
            {dupeGroups > 0 && (
              <Button render={<Link href="/contacts/duplicates" />} nativeButton={false} variant="outline" size="sm">
                <CopyCheck aria-hidden />
                Revisar duplicados · {dupeGroups}
              </Button>
            )}
            <Button render={<Link href="/contacts/new" />} nativeButton={false} size="sm">
              <Plus aria-hidden />
              Nuevo contacto
            </Button>
          </span>
        }
      />

      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <ContactsList
          rows={rows}
          companies={companies.map((c) => ({ id: c.id, name: c.name }))}
          q={q}
          kinds={kinds}
          companyId={companyId}
          status={status}
          initialView={vista}
          initialSelectedId={selectedId}
          myRole={myRole}
          totalCount={contactsTotal}
          truncated={contactsTruncated}
        />
      )}
    </div>
  );
}
