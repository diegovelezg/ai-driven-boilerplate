import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { AutoRefresh } from "@/components/auto-refresh";
import type { CustomerFilters, CustomerPredictionLite, EditableCustomer } from "@/lib/customers-db";
import {
  getPredictionsMap,
  getSeguimientoSummary,
  getValorByType,
  getVentana7Summary,
  parseCustomerFilters,
  parseCustomersSort,
  queryStoreCustomers,
} from "@/lib/customers-db";
import { resolveActiveStoreId } from "@/lib/tenant";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { pendingDomains } from "@/lib/enrich";
import { countDuplicateEmails } from "@/lib/duplicates";
import { requireMyStoreAccess } from "@/lib/tenant";
import { formatNumber } from "@/lib/format";
import { CustomersView } from "./customers-view";
import { EnrichmentControls } from "./enrichment-controls";
import { connection } from "next/server";

export const instant = false;

const PAGE_SIZE = 20;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; sort?: string; dir?: string; decision?: string; vista?: string; view?: string; ritmo?: string; tipo?: string; type?: string; customer_type?: string; ventana?: string; banda?: string; elegibilidad?: string; decil?: string }>;
}) {
  // Request-time: la page usa Date.now() y Cache Components no lo difiere
  // con `instant = false` — sin esto, el prerender falla con
  // blocking-prerender-current-time. El connection() del layout no cubre
  // a la page (cada segmento se valida por separado).
  await connection();
  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const sort = parseCustomersSort({ sort: sp.sort, dir: sp.dir });
  const filters: CustomerFilters = parseCustomerFilters({
    decision: sp.decision,
    vista: sp.vista,
    view: sp.view,
    ritmo: sp.ritmo,
    tipo: sp.tipo,
    type: sp.type,
    customer_type: sp.customer_type,
    ventana: sp.ventana,
    banda: sp.banda,
    elegibilidad: sp.elegibilidad,
    decil: sp.decil,
  });

  let rows: EditableCustomer[] = [];
  let totalCount = 0;
  let error: string | null = null;
  let page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  let synced = false;
  let pendingCount = 0;
  let duplicateCount = 0;
  let shopCurrency: string | null = null;
  let preds: Record<string, CustomerPredictionLite> = {};
  let ventana7: { n: number; sumaMinor: number } | null = null;
  let seguimiento: { n: number; sumaMinor: number } | null = null;
  let valorByType: { b2b: { n: number; minor: number }; b2c: { n: number; minor: number }; otherCurrency: number; truncated: boolean } | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if (!storeId) {
        error = "Sin tienda.";
      } else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda. Pide a tu admin que te agregue en merchant_users.";
      } else {
        synced = true;
        pendingCount = (await pendingDomains(storeId).catch(() => [])).length;
        duplicateCount = await countDuplicateEmails(storeId).catch(() => 0);
        const { resolveCloseWatchP } = await import("@/lib/store-profiles");
        const closeWatchCutoff = await resolveCloseWatchP(storeId).catch(() => 0.1);
        const fetchPage = (p: number) =>
          queryStoreCustomers(storeId, q, p, PAGE_SIZE, sort, filters, undefined, closeWatchCutoff);
        let res = await fetchPage(page);
        totalCount = res.totalCount;
        const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
        if (page > totalPages) {
          page = totalPages;
          res = await fetchPage(page);
        }
        rows = res.rows;
        totalCount = res.totalCount;
        const { data: storeRes } = await getSupabase()
          .from("stores")
          .select("shop_currency")
          .eq("id", storeId)
          .maybeSingle();
        shopCurrency = (storeRes?.shop_currency as string | null) ?? null;
        // Foto del día para las columnas del motor (un join en JS, sin N+1).
        const predMap = await getPredictionsMap(storeId).catch(() => new Map());
        preds = {};
        for (const r of rows) {
          const p = predMap.get(r.dbId);
          if (p) preds[r.dbId] = p;
        }
        if (filters.vista === "ventana7") {
          ventana7 = await getVentana7Summary(storeId).catch(() => null);
        }
        if (filters.vista === "seguimiento") {
          seguimiento = await getSeguimientoSummary(storeId, closeWatchCutoff).catch(() => null);
        }
        // Agregado B2B por valor: facturación bruta de empresas.
        valorByType = await getValorByType(
          storeId,
          shopCurrency,
        ).catch(() => null);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-8 p-6 md:p-8">
      <AutoRefresh ms={60_000} />
      <PageHeader
        eyebrow="Cartera de clientes"
        title="Customers"
        description="Cada cliente, su ritmo de recompra y el valor en juego."
        right={
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {!connected ? "sin conexión" : !dbReady ? "sin BD" : `${formatNumber(totalCount)} en BD`}
            </span>
            {connected && dbReady && (
              <>
                <EnrichmentControls pending={pendingCount} />
                {synced && duplicateCount > 0 && (
                  <Button
                    render={<Link href="/customers/duplicates" />}
                    nativeButton={false}
                    variant="outline"
                    size="sm"
                  >
                    Duplicados ({formatNumber(duplicateCount)})
                  </Button>
                )}
              </>
            )}
          </span>
        }
      />

      {!connected && (
        <AppCard>
          <p className="text-sm text-muted-foreground">
            Sin tienda. Importa inventario en /screens.
          </p>
        </AppCard>
      )}

      {connected && !dbReady && (
        <AppCardState>
          Supabase no configurado. Levanta el stack local (`supabase start`) y define
          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en `web/.env.local`.
        </AppCardState>
      )}

      {error && (
        <AppCard

        >
          <p className="text-sm text-muted-foreground">{error}</p>
        </AppCard>
      )}

      {synced && !error && (
        <CustomersView
          rows={rows}
          totalCount={totalCount}
          q={q}
          page={page}
          pageSize={PAGE_SIZE}
          sortKey={sort.key}
          sortDir={sort.dir}
          filters={filters}
          shopCurrency={shopCurrency}
          preds={preds}
          ventana7={ventana7}
          seguimiento={seguimiento}
          valorByType={valorByType}
        />
      )}
    </div>
  );
}
