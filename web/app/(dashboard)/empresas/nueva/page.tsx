import Link from "next/link";
import { AppCard } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { NuevaEmpresaForm } from "./nueva-form";
import { getMyActiveStore } from "@/lib/tenant";

// Request-time: ver nota en app/(dashboard)/page.tsx.
export const instant = false;

export default async function NuevaEmpresaPage() {
  // La comisión solo la gestionan owner/admin: la page (server) resuelve el
  // rol y el form solo pinta el campo cuando corresponde. El server action
  // vuelve a exigirlo (nunca confiar solo en el gating de UI).
  let canManageCommission = true;
  try {
    const { active } = await getMyActiveStore(null).catch(() => ({ active: null as null }));
    if (active?.id) {
      const { getMyStoreRole } = await import("@/lib/tenant");
      const { hasMinRole } = await import("@/lib/roles");
      const role = await getMyStoreRole(active.id).catch(() => null);
      canManageCommission = role === null || hasMinRole(role, "admin");
    }
  } catch {
    canManageCommission = true;
  }
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        eyebrow="CRM"
        title="Nueva empresa"
        description="Una empresa, un tipo. La marca que publicita va en el pedido, no acá."
        right={<Button render={<Link href="/empresas" />} nativeButton={false} size="sm" variant="outline">Volver</Button>}
      />
      <AppCard title="Datos" description="Nombre y tipo; el resto es opcional.">
        <NuevaEmpresaForm canManageCommission={canManageCommission} />
      </AppCard>
    </div>
  );
}
