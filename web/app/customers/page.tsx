import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { CanonicalCustomer } from "@/lib/medusa";
import { queryStoreCustomers, resolveStoreId } from "@/lib/customers-db";
import { readConnections } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/supabase";
import { CustomersView } from "./customers-view";
import { SyncButton } from "./sync-button";

export const instant = false;

const PAGE_SIZE = 20;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const conn = await readConnections();
  const connected = Boolean(conn.medusaUrl && conn.medusaToken);
  const dbReady = isSupabaseConfigured();

  const sp = await searchParams;
  const q = (sp.q ?? "").trim();

  let rows: CanonicalCustomer[] = [];
  let totalCount = 0;
  let error: string | null = null;
  let page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  let synced = false;

  if (connected && dbReady) {
    try {
      const storeId = await resolveStoreId(conn.medusaUrl);
      if (!storeId) {
        error = "Tienda aún sin sincronizar. Presiona Sincronizar.";
      } else {
        synced = true;
        const fetchPage = (p: number) => queryStoreCustomers(storeId, q, p, PAGE_SIZE);
        let res = await fetchPage(page);
        totalCount = res.totalCount;
        const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
        if (page > totalPages) {
          page = totalPages;
          res = await fetchPage(page);
        }
        rows = res.rows;
        totalCount = res.totalCount;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Customers</h1>
        <span className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {!connected ? "sin conexión" : !dbReady ? "sin BD" : `${totalCount} en BD`}
          </span>
          {connected && dbReady && <SyncButton />}
        </span>
      </header>

      {!connected && (
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <p className="text-[13px] text-muted-foreground">
              Conecta Medusa con tu usuario admin para traer customers.
            </p>
            <Button render={<Link href="/settings" />} variant="outline" size="sm">
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
        <CustomersView rows={rows} totalCount={totalCount} q={q} page={page} pageSize={PAGE_SIZE} />
      )}
    </div>
  );
}
