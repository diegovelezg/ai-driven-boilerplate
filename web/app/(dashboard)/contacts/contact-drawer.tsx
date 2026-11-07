"use client";

import Link from "next/link";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { DrawerShell } from "@/components/drawer-shell";
import { CompanyPrincipalBadge } from "@/components/company-badges";
import { toTitleCase } from "@/lib/format";
import type { CrmContactListItem } from "@/lib/crm-db";

function fullName(c: CrmContactListItem): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

/** Ficha de un contacto: quién es + su empresa. Solo lectura
 *  (la creación y edición viven en el drawer de cada empresa). */
export function ContactDrawer({
  contact,
  onClose,
}: {
  contact: CrmContactListItem;
  onClose: () => void;
}) {
  const name = fullName(contact);
  return (
    <DrawerShell
      onClose={onClose}
      avatar={<UserRound className="size-5" aria-hidden />}
      title={name === "—" ? "Contacto" : toTitleCase(name)}
      description={contact.job_title ?? "—"}
      badges={
        contact.is_primary ? (
          <span className="flex flex-wrap items-center gap-1.5" aria-label="Contacto principal">
            <CompanyPrincipalBadge isPrimary />
          </span>
        ) : undefined
      }
      tabListLabel="Ficha del contacto"
    >
      <AppCard
        title="Ficha"
        description="Datos de la persona de contacto."
        aria-label="Ficha del contacto"
      >
        <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">Nombre</dt><dd className="mt-0.5 text-[13px] font-medium">{name === "—" ? "—" : toTitleCase(name)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Cargo</dt><dd className="mt-0.5 text-[13px]">{contact.job_title ?? "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="mt-0.5 text-[13px]">{contact.email ?? "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Teléfono</dt><dd className="mt-0.5 text-[13px] tabular-nums">{contact.phone ?? "—"}</dd></div>
        </dl>
      </AppCard>

      <AppCard
        title="Empresa"
        description="La contraparte a la que pertenece."
        aria-label="Empresa del contacto"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] font-medium">
            {contact.company_name ? toTitleCase(contact.company_name) : "Sin empresa"}
          </p>
          {contact.company_id && (
            <Button render={<Link href={`/companies?company=${contact.company_id}`} />} nativeButton={false} size="sm" variant="outline">
              Ver empresa
            </Button>
          )}
        </div>
      </AppCard>
    </DrawerShell>
  );
}
