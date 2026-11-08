import Link from "next/link";
import { CopyCheck, Plus } from "lucide-react";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { listCrmCompanies, listCrmContacts } from "@/lib/crm-db";
import { listContactDuplicateGroups } from "@/lib/contact-duplicates";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId, getMyStoreRole } from "@/lib/tenant";
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
  searchParams: Promise<{ q?: string; company?: string; empresa?: string; contact?: string; contacto?: string; view?: string; vista?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const companyId = ((sp.company ?? sp.empresa) ?? "").trim() || null;
  const selectedId = ((sp.contact ?? sp.contacto) ?? "").trim() || null;
  const vista: "table" | "grid" = VIEW_ALIASES[sp.view ?? sp.vista ?? ""] ?? "table";

  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let rows: Awaited<ReturnType<typeof listCrmContacts>>["rows"] = [];
  let contactsTotal = 0;
  let contactsTruncated = false;
  let companies: Awaited<ReturnType<typeof listCrmCompanies>>["rows"] = [];
  let dupeGroups = 0;
  let myRole: MemberRole | null = null;
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if (!storeId) error = "Sin tienda.";
      else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        myRole = await getMyStoreRole(storeId).catch(() => null);
        const [contactsRes, companiesRes, dupesRes] = await Promise.all([
          listCrmContacts(storeId, { q, companyId: companyId ?? undefined }),
          listCrmCompanies(storeId, { pageSize: 200 }),
          listContactDuplicateGroups(storeId).catch(() => ({ groups: [] })),
        ]);
        rows = contactsRes.rows;
        contactsTotal = contactsRes.total;
        contactsTruncated = contactsRes.truncated;
        companies = companiesRes.rows;
        dupeGroups = dupesRes.groups.length;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "No se pudieron cargar los datos.";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
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
          companyId={companyId}
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
