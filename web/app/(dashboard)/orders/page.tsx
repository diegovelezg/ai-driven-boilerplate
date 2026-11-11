import Link from "next/link";
import { Plus } from "lucide-react";
import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { loadPageData } from "@/lib/page-data";
import { getMyStoreRole } from "@/lib/tenant";
import type { MemberRole } from "@/lib/roles";
import { ORDER_STAGES as STAGES, type OrderStageKey } from "@/lib/order-stage";
import type { BillingStatusKey } from "@/lib/billing-status";
import { listOrders } from "@/lib/orders-db";
import { OrdersList } from "./orders-list";

export const instant = false;



const BILLINGS: BillingStatusKey[] = [
  "sin_facturar",
  "facturado",
  "parcial",
  "pagado",
  "vencido",
];

export default async function OrdenesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; stage?: string; etapa?: string; billing?: string; cobro?: string; order?: string; orden?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const stageRaw = sp.stage ?? sp.etapa;
  const stage = STAGES.includes(stageRaw as OrderStageKey) ? (stageRaw as OrderStageKey) : null;
  // Compat: ?stage=por_cobrar (etapa vieja) ahora mapea al carril de cobro.
  const legacyBilling = stageRaw === "por_cobrar" ? "facturado" : null;
  const billingRaw = sp.billing ?? sp.cobro ?? legacyBilling;
  const billing = BILLINGS.includes(billingRaw as BillingStatusKey) ? (billingRaw as BillingStatusKey) : null;
  const selectedId = ((sp.order ?? sp.orden) ?? "").trim() || null;

  const { data, connected, dbReady, error } = await loadPageData(
    async (storeId) => {
      const myRole = await getMyStoreRole(storeId).catch(() => null);
      const rows = await listOrders(storeId, { q, stage, billing });
      return { rows, myRole };
    },
    { rows: [] as Awaited<ReturnType<typeof listOrders>>, myRole: null as MemberRole | null },
  );
  const { rows, myRole } = data;

  return (
    <div className="page-shell max-w-[1200px]">
      <PageHeader
        eyebrow="DOOH"
        title="Órdenes"
        description="Sigue cada orden desde la firma hasta el cierre. El cobro avanza por separado y admite pagos parciales."
        right={
          <Button render={<Link href="/orders/new" />} nativeButton={false} size="sm">
            <Plus aria-hidden />
            Nueva orden
          </Button>
        }
      />

      {!connected && <AppCardState>Sin tienda conectada.</AppCardState>}
      {connected && !dbReady && <AppCardState>Base de datos no disponible.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <OrdersList rows={rows} q={q} stage={stage} billing={billing} initialSelectedId={selectedId} myRole={myRole} />
      )}
    </div>
  );
}
