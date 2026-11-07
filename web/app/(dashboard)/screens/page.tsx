import { PageHeader } from "@/components/page-header";
import { AppCard, AppCardState } from "@/components/app-card";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { IMPORT_TEMPLATES, type ImportKind } from "@/lib/sheet-import";
import { ImportForm } from "./import-form";

const KIND_LABEL: Record<ImportKind, string> = {
  companies: "Empresas (cliente / proveedor)",
  contacts: "Contactos",
  venues: "Recintos (venues)",
  screens: "Pantallas (screens + loop)",
  slots: "Slots sueltos",
};

// Ruta autenticada multi-tenant (lee Supabase por request a través del
// layout): se permite el render bloqueante como el resto del dashboard.
export const instant = false;

async function getSummary() {
  if (!isSupabaseConfigured()) return null;
  const db = getSupabase();
  const counts: Record<string, number> = {};
  for (const t of ["venues", "screens", "inventory_slots", "bookings", "campaigns", "companies", "contacts", "import_runs"]) {
    const { count } = await db.from(t).select("id", { count: "exact", head: true });
    counts[t] = count ?? 0;
  }
  const { data: venues } = await db
    .from("venues")
    .select("id,name,venue_type,city,ownership")
    .order("created_at", { ascending: false })
    .limit(20);
  const { data: runs } = await db
    .from("import_runs")
    .select("kind,source,rows_seen,rows_ok,rows_failed,created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  return { counts, venues: (venues ?? []) as Array<Record<string, unknown>>, runs: (runs ?? []) as Array<Record<string, unknown>> };
}

export default async function InventarioPage() {
  const summary = await getSummary().catch(() => null);
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="DOOH"
        title="Inventario publicitario"
        description="Gestión comercial de espacios: Empresas (cliente/proveedor) + Contactos + Recintos → Pantallas → Loop → Slots → Reservas. Ingesta solo desde Google Sheet URL o CSV. Solo Sheet/CSV."
        right={
          summary ? (
            <span className="text-xs text-muted-foreground">
              {summary.counts.venues ?? 0} recintos · {summary.counts.screens ?? 0} pantallas ·{" "}
              {summary.counts.inventory_slots ?? 0} slots
            </span>
          ) : undefined
        }
      />

      <AppCard
        title="Importar desde Google Sheet o CSV"
        description="Pega el link del Sheet (cualquier pestaña: se exporta a CSV) o pega el CSV. kinds: companies → contacts → venues → screens → slots (en ese orden, por dependencias)."
      >
        <ImportForm templates={IMPORT_TEMPLATES} labels={KIND_LABEL} />
      </AppCard>

      {!summary && <AppCardState>Supabase no configurado.</AppCardState>}

      {summary && (
        <>
          <AppCard title="Recintos recientes" description="Venue → pantallas. ownership own = red propia, supplier = proveedor.">
            {summary.venues.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin recintos. Importa venues primero.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {summary.venues.map((v) => (
                  <li key={String(v.id)} className="flex items-center justify-between gap-3 py-2">
                    <span className="font-medium">{String(v.name)}</span>
                    <span className="text-xs text-muted-foreground">
                      {[v.venue_type, v.city, v.ownership].filter(Boolean).map(String).join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </AppCard>

          <AppCard title="Últimas importaciones" description="Auditoría en import_runs.">
            {summary.runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aún no hay importaciones.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {summary.runs.map((r, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2">
                    <span>
                      {String(r.kind)} ({String(r.source)}): {String(r.rows_ok)}/{String(r.rows_seen)} ok
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {Number(r.rows_failed) > 0 ? `${String(r.rows_failed)} errores · ` : ""}
                      {new Date(String(r.created_at)).toISOString().slice(0, 16).replace("T", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </AppCard>
        </>
      )}
    </div>
  );
}
