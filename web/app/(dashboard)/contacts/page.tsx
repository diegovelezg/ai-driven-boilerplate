import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { listCrmCompanies, listCrmContacts } from "@/lib/crm-db";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { connection } from "next/server";
import { ContactsList } from "./contacts-list";

// Request-time: usa el cliente Supabase (timers/Date internos) en el render.
// Cache Components no lo difiere con `instant = false`; ver nota en
// app/(dashboard)/page.tsx.
export const instant = false;

export default async function ContactosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; company?: string; empresa?: string; contact?: string; contacto?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const companyId = ((sp.company ?? sp.empresa) ?? "").trim() || null;
  const selectedId = ((sp.contact ?? sp.contacto) ?? "").trim() || null;

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
      />

      {!connected && <AppCardState>Sin tienda. Importa inventario en /screens.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <ContactsList
          rows={rows}
          companies={companies.map((c) => ({ id: c.id, name: c.name }))}
          q={q}
          companyId={companyId}
          initialSelectedId={selectedId}
        />
      )}
    </div>
  );
}
