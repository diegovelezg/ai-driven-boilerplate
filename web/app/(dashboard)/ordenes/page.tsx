import Link from "next/link";
import { connection } from "next/server";
import { AppCardState } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured } from "@/lib/supabase";
import { requireMyStoreAccess, resolveActiveStoreId } from "@/lib/tenant";
import type { OrderStageKey } from "@/lib/order-stage";
import { listOrders } from "@/lib/orders-db";
import { OrdenesList } from "./ordenes-list";

export const instant = false;

const STAGES: OrderStageKey[] = [
  "firmada",
  "materiales",
  "al_aire",
  "por_certificar",
  "por_cobrar",
  "cerrada",
  "cancelada",
];

export default async function OrdenesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; etapa?: string; orden?: string }>;
}) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const stage = STAGES.includes(sp.etapa as OrderStageKey) ? (sp.etapa as OrderStageKey) : null;
  const selectedId = (sp.orden ?? "").trim() || null;

  const dbReady = isSupabaseConfigured();
  const activeStoreId = await resolveActiveStoreId();
  const connected = Boolean(activeStoreId);

  let rows: Awaited<ReturnType<typeof listOrders>> = [];
  let error: string | null = null;

  if (connected && dbReady) {
    try {
      const storeId = activeStoreId!;
      if ((await requireMyStoreAccess(storeId).catch(() => null)) === false) {
        error = "Sin acceso a esta tienda.";
      } else {
        rows = await listOrders(storeId, { q, stage });
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
        description="Cada OI avanza Firmada → Materiales → Al aire → Por certificar → Por cobrar → Cerrada. La etapa se deriva de sus documentos, no se marca a mano."
        right={
          <Button render={<Link href="/ordenes/nueva" />} nativeButton={false} size="sm">
            Nueva orden
          </Button>
        }
      />

      {!connected && <AppCardState>Sin tienda. Importa inventario en /inventario.</AppCardState>}
      {connected && !dbReady && <AppCardState>Supabase no configurado.</AppCardState>}
      {error && <AppCardState>{error}</AppCardState>}

      {connected && dbReady && !error && (
        <OrdenesList rows={rows} q={q} stage={stage} initialSelectedId={selectedId} />
      )}
    </div>
  );
}
