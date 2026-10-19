import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { CustomerFilters, CustomerPredictionLite, EditableCustomer } from "@/lib/customers-db";
import {
  getPredictionsMap,
  getVentana7Summary,
  parseCustomerFilters,
  parseCustomersSort,
  queryStoreCustomers,
  resolveStoreId,
} from "@/lib/customers-db";
import { readConnections } from "@/lib/store";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { pendingDomains } from "@/lib/enrich";
import { countDuplicateEmails } from "@/lib/duplicates";
import { displayMarket, resolveMarketScope, withMarketParam } from "@/lib/markets";
import { CustomersView } from "./customers-view";
import { EnrichmentControls } from "./enrichment-controls";
import { SyncButton } from "./sync-button";

export const instant = false;

const PAGE_SIZE = 20;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; sort?: string; dir?: string; decision?: string; vista?: string; ritmo?: string; tipo?: string; customer_type?: string; market?: string }>;
}) {
  const conn = await readConnections();
  const connected = Boolean(conn.medusaUrl && conn.medusaToken);
  const dbReady = isSupabaseConfigured();

  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const sort = parseCustomersSort({ sort: sp.sort, dir: sp.dir });
  const filters: CustomerFilters = parseCustomerFilters({
    decision: sp.decision,
    vista: sp.vista,
    ritmo: sp.ritmo,
    tipo: sp.tipo,
    customer_type: sp.customer_type,
  });

  let rows: EditableCustomer[] = [];
  let totalCount = 0;
  let error: string | null = null;
  let page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  let synced = false;
  let pendingCount = 0;
  let duplicateCount = 0;
  let shopCurrency: string | null = null;
  let marketId: string | null = null;
  let marketLabel: string | null = null;
  let preds: Record<string, CustomerPredictionLite> = {};
  let ventana7: { n: number; sumaMinor: number } | null = null;

  if (connected && dbReady) {
    try {
      const storeId = await resolveStoreId(conn.medusaUrl);
      if (!storeId) {
        error = "Tienda aún sin sincronizar. Presiona Sincronizar.";
      } else {
        synced = true;
        // Filtro global por país/mercado (?market= del header).
        // NULL-comodín: los sin compras se ven en todo filtro.
        const scope = await resolveMarketScope(storeId, sp.market).catch(() => null);
        marketId = scope?.market?.id ?? null;
        marketLabel = scope?.market ? displayMarket(scope.market) : null;
        pendingCount = (await pendingDomains(storeId, scope).catch(() => [])).length;
        duplicateCount = await countDuplicateEmails(storeId, scope).catch(() => 0);
        const fetchPage = (p: number) =>
          queryStoreCustomers(storeId, q, p, PAGE_SIZE, sort, filters, scope);
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
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">
          Customers{marketLabel ? ` · ${marketLabel}` : ""}
        </h1>
        <span className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {!connected ? "sin conexión" : !dbReady ? "sin BD" : `${totalCount} en BD`}
          </span>
          {connected && dbReady && (
            <>
              {synced && <EnrichmentControls pending={pendingCount} />}
              {synced && duplicateCount > 0 && (
                <Button
                  render={<Link href={withMarketParam("/customers/duplicates", marketId)} />}
                  nativeButton={false}
                  variant="outline"
                  size="sm"
                >
                  Duplicados ({duplicateCount})
                </Button>
              )}
              <SyncButton />
            </>
          )}
        </span>
      </header>

      {!connected && (
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <p className="text-[13px] text-muted-foreground">
              Conecta Medusa con tu usuario admin para traer customers.
            </p>
            <Button
              render={<Link href="/settings" />}
              nativeButton={false}
              variant="outline"
              size="sm"
            >
              Ir a Settings
            </Button>
          </CardContent>
        </Card>
      )}

      {connected && !dbReady && (
        <Card>
          <CardContent className="p-4">
            <p className="text-[13px] text-muted-foreground">
              Supabase no configurado. Levanta el stack local (`supabase start`) y define
              SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en `web/.env.local`.
            </p>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <p className="text-[13px] text-muted-foreground">{error}</p>
            {connected && dbReady && !synced && <SyncButton />}
          </CardContent>
        </Card>
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
          marketId={marketId}
          preds={preds}
          ventana7={ventana7}
        />
      )}
    </div>
  );
}
