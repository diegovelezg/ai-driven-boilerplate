import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableRow,
  DataTableTd,
  DataTableTh,
} from "@/components/data-table";
import { findDuplicateGroups } from "@/lib/duplicates";
import { formatMoney, formatNumber } from "@/lib/format";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import { MergeButton } from "./merge-button";
import { MergeAllBar } from "./merge-all-button";

export const instant = false;

export default async function DuplicatesPage() {
  const activeStoreId = await resolveActiveStoreId();
  const ready = Boolean(activeStoreId) && isSupabaseConfigured();

  let groups: Awaited<ReturnType<typeof findDuplicateGroups>> = [];
  let error: string | null = null;
  if (ready) {
    try {
      const storeId = activeStoreId!;
      if (!storeId) error = "Sin tienda.";
      else if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda. Pide a tu admin que te agregue en merchant_users.";
      } else {
        groups = await findDuplicateGroups(storeId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Error al leer duplicados.";
    }
  }

  const extraRows = groups.reduce((s, g) => s + (g.rows.length - 1), 0);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="Calidad de datos"
        title="Posibles duplicados"
        description={`${formatNumber(groups.length)} email${groups.length === 1 ? "" : "s"} con más de una ficha${extraRows > 0 ? ` · ${formatNumber(extraRows)} fila${extraRows === 1 ? "" : "s"} extra` : ""}. Solo lectura.`}
        right={
          <Button
            render={<Link href="/customers" />}
            nativeButton={false}
            variant="outline"
            size="sm"
          >
            <ArrowLeft aria-hidden />
            Volver a Customers
          </Button>
        }
      />

      {error && <AppCardState>{error}</AppCardState>}

      {!error && <MergeAllBar totalGroups={groups.length} />}

      {!error && groups.length === 0 && (
        <AppCardState>No se encontraron emails repetidos.</AppCardState>
      )}

      {groups.map((g) => (
        <AppCard
          key={g.email}
          tone="amber"
          variant="table"
          title={<span className="font-medium text-primary">{g.email}</span>}
          action={
            <span className="flex items-center gap-3">
              <Badge variant="secondary" className="font-normal">
                {formatNumber(g.rows.length)} fichas
              </Badge>
              <MergeButton dbIds={g.rows.map((r) => r.dbId)} />
            </span>
          }
        >
          <DataTable>
            <DataTableHeader>
              <DataTableTh>Nombre</DataTableTh>
              <DataTableTh>Teléfono</DataTableTh>
              <DataTableTh>Empresa</DataTableTh>
              <DataTableTh numeric>Compras</DataTableTh>
              <DataTableTh numeric>Total</DataTableTh>
              <DataTableTh>Origen</DataTableTh>
            </DataTableHeader>
            <DataTableBody>
              {g.rows.map((r) => (
                <DataTableRow key={r.dbId}>
                  <DataTableTd>
                    {[r.firstName, r.lastName].filter(Boolean).join(" ") || "—"}
                  </DataTableTd>
                  <DataTableTd className="text-muted-foreground">{r.phone ?? "—"}</DataTableTd>
                  <DataTableTd className="text-muted-foreground">{r.companyName ?? "—"}</DataTableTd>
                  <DataTableTd numeric className="tabular-nums">{formatNumber(r.ordersCount)}</DataTableTd>
                  <DataTableTd numeric className="tabular-nums">
                    {formatMoney(r.totalSpent, r.currency)}
                  </DataTableTd>
                  <DataTableTd>
                    <Badge variant={r.source === "local" ? "default" : "outline"} className="font-normal">
                      {r.source === "local" ? "local" : "ecommerce"}
                    </Badge>
                  </DataTableTd>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </AppCard>
      ))}
    </div>
  );
}
