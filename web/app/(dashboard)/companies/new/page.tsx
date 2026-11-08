import Link from "next/link";
import { CircleArrowLeft } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { NuevaEmpresaForm } from "./nueva-form";
import { connection } from "next/server";
import { getMyActiveStore } from "@/lib/tenant";

// Request-time: ver nota en app/(dashboard)/page.tsx.
export const instant = false;

export default async function NuevaEmpresaPage() {
  await connection();
  // La comisión solo la gestionan owner/admin: la page (server) resuelve el
  // rol y el form solo pinta el campo cuando corresponde. El server action
  // vuelve a exigirlo (nunca confiar solo en el gating de UI).
  let canManageCommission = true;
  let defaultCountry = "PE";
  try {
    const { active } = await getMyActiveStore(null).catch(() => ({ active: null as null }));
    const shopCountry = String(active?.shop_country ?? "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(shopCountry)) defaultCountry = shopCountry;
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
        description="Elige el tipo de empresa y completa sus datos. La marca se registra en la orden."
        right={<Button render={<Link href="/companies" />} nativeButton={false} size="sm" variant="outline"><CircleArrowLeft aria-hidden />Volver</Button>}
      />
      <AppCard title="Datos" description="Solo el nombre y el tipo son obligatorios.">
        <NuevaEmpresaForm canManageCommission={canManageCommission} defaultCountry={defaultCountry} />
      </AppCard>
    </div>
  );
}
