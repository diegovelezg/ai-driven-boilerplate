"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Briefcase, Cpu, Mail, Store, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { AppCard, AppCardState } from "@/components/app-card";
import { SectionHeading } from "@/components/section-heading";
import { EmailSettingsForm, SettingsForm } from "@/components/settings-form";
import { TenantProfileForm } from "@/components/tenant-profile-form";
import { ProfileProposalsPanel } from "@/components/profile-proposals";
import { formatNumber } from "@/lib/format";
import type { StoreConnections } from "@/lib/store";
import type { StoreProfile, Suggestion } from "@/lib/store-profiles";
import type { ProfileProposal } from "@/lib/profile-recalibrate/service";

/** Tab de settings: un grupo por trabajo (conectar vs calibrar vs motor). */
export type SettingsTab = "tienda" | "email" | "negocio" | "motor";

export interface MotorSummary {
  declarado: number | null;
  observado: number | null;
  archetypeLabel: string;
  h: number;
  firmes: number;
  total: number;
}

/** Settings en tabs con el mismo patrón visual que el inbox (/review):
 *  tablist compacto + sección con SectionHeading y cards con tono. */
export function SettingsTabs({
  defaults,
  secretsInDb,
  storeId,
  profile,
  suggestion,
  motor,
  proposal,
  initialTab = "tienda",
}: {
  defaults: StoreConnections;
  secretsInDb?: boolean;
  storeId: string | null;
  profile: StoreProfile | null;
  suggestion: Suggestion;
  motor: MotorSummary | null;
  proposal: ProfileProposal | null;
  initialTab?: SettingsTab;
}) {
  const router = useRouter();
  const tabs: Array<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
    { id: "tienda", label: "Tienda", icon: Store },
    { id: "email", label: "Email", icon: Mail },
    { id: "negocio", label: "Negocio", icon: Briefcase },
    { id: "motor", label: "Motor", icon: Cpu },
  ];
  const [active, setActive] = useState<SettingsTab>(
    tabs.some((t) => t.id === initialTab) ? initialTab : "tienda",
  );
  const selectTab = (id: SettingsTab) => {
    setActive(id);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", id);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="Secciones de configuración"
        className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-muted/60 p-1.5"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            onClick={() => selectTab(t.id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors",
              active === t.id
                ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
            )}
          >
            <t.icon className="size-4 shrink-0" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>

      {active === "tienda" && (
        <section role="tabpanel" aria-label="Tienda" className="flex w-full max-w-2xl flex-col gap-4">
          <SectionHeading
            title="Conecta tu tienda"
            hint="Medusa como origen de clientes y pedidos. Solo se guarda el token, nunca el password."
            tone="primary"
          />
          <SettingsForm defaults={defaults} secretsInDb={secretsInDb} />
        </section>
      )}

      {active === "email" && (
        <section role="tabpanel" aria-label="Email" className="flex w-full max-w-2xl flex-col gap-4">
          <SectionHeading
            title="Email transaccional"
            hint="Canal por defecto y proveedor de envío. Solo se guarda la key, nunca se muestra completa."
            tone="sky"
          />
          <EmailSettingsForm defaults={defaults} secretsInDb={secretsInDb} />
        </section>
      )}

      {active === "negocio" && (
        <section role="tabpanel" aria-label="Negocio" className="flex w-full max-w-2xl flex-col gap-4">
          <SectionHeading
            title="Perfil del negocio"
            hint="Qué vendes, a quién y cada cuánto vuelven. El motor calibra con esto."
            tone="violet"
          />
          <TenantProfileForm storeId={storeId} profile={profile} suggestion={suggestion} />
        </section>
      )}

      {active === "motor" && (
        <section role="tabpanel" aria-label="Motor" className="flex w-full max-w-2xl flex-col gap-4">
          <SectionHeading
            title="Qué aprendió el motor"
            hint={`Patrón ${motor?.archetypeLabel ?? "—"} · ventana de decisión: ${motor ? formatNumber(motor.h) : "—"} días.`}
            tone="emerald"
          />
          {motor ? (
            <AppCard
              tone="emerald"
              title="Lectura de tus datos"
              description="Ciclo declarado vs observado en tus pedidos reales."
              contentClassName="flex flex-col gap-4"
              footer={
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {motor.observado !== null
                    ? `Tus clientes vuelven cada ~${formatNumber(motor.observado)}d. `
                    : "Aún sin suficiente historial para medir el ritmo real. "}
                  {motor.total > 0
                    ? `Estimaciones firmes en ${formatNumber(motor.firmes)} de ${formatNumber(motor.total)} clientes (el resto aún afina con más datos). `
                    : ""}
                  Si cambias el ciclo en Negocio, las predicciones de mañana ya usan este ciclo.
                </p>
              }
            >
              <dl className="grid grid-cols-3 gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    Declarado
                  </dt>
                  <dd className="truncate text-lg font-semibold tabular-nums">
                    {motor.declarado !== null ? `~${formatNumber(motor.declarado)}d` : "Auto"}
                  </dd>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    Observado
                  </dt>
                  <dd className="truncate text-lg font-semibold tabular-nums">
                    {motor.observado !== null ? `~${formatNumber(motor.observado)}d` : "—"}
                  </dd>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    Firmes
                  </dt>
                  <dd className="truncate text-lg font-semibold tabular-nums">
                    {motor.total > 0
                      ? `${formatNumber(motor.firmes)}/${formatNumber(motor.total)}`
                      : "—"}
                  </dd>
                </div>
              </dl>
            </AppCard>
          ) : (
            <AppCardState tone="emerald">
              {storeId
                ? "Aún sin datos del motor: vuelve tras la primera sincronización."
                : "Conecta Medusa en Tienda para activar el motor."}
            </AppCardState>
          )}
          {storeId && <ProfileProposalsPanel proposal={proposal} />}
        </section>
      )}
    </>
  );
}
