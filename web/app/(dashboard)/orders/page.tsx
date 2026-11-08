import Link from "next/link";
import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId, getMyStoreRole } from "@/lib/tenant";
import type { MemberRole } from "@/lib/roles";
import type { OrderStageKey } from "@/lib/order-stage";
import type { BillingStatusKey } from "@/lib/billing-status";
import { listOrders } from "@/lib/orders-db";
import { OrdersList } from "./orders-list";

export const instant = false;

const STAGES: OrderStageKey[] = [
  "firmada",
  "materiales",
  "al_aire",
  "por_certificar",
  "cerrada",
  "cancelada",
];

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

  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let rows: Awaited<ReturnType<typeof listOrders>> = [];
  let myRole: MemberRole | null = null;
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        myRole = await getMyStoreRole(storeId).catch(() => null);
        rows = await listOrders(storeId, { q, stage, billing });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "DB read failed";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="DOOH"
        title="Órdenes"
        description="Etapa operativa: Firmada → Materiales → Al aire → Por certificar → Cerrada. Cobro en carril paralelo (sin facturar → facturado → parcial → pagado / vencido): admite upfront y abonos a mitad de pauta."
        right={
          <Button render={<Link href="/orders/new" />} nativeButton={false} size="sm">
            Nueva orden
          </Button>
        }
      />

      {!connected && <AppCardState>Sin tienda. Importa inventario en /screens.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <OrdersList rows={rows} q={q} stage={stage} billing={billing} initialSelectedId={selectedId} myRole={myRole} />
      )}
    </div>
  );
}
