"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, FileText, Mail, Pencil, Phone, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppCard, AppCardState } from "@/components/app-card";
import {
  DrawerShell,
  type DrawerTabDef,
} from "@/components/drawer-shell";
import { CompanyIOBadge, CompanyPrincipalBadge } from "@/components/company-badges";
import { hasMinRole, type MemberRole } from "@/lib/roles";
import { toTitleCase } from "@/lib/format";
import type { CrmContactListItem } from "@/lib/crm-db";
import { ContactChat } from "./contact-chat";
import { ContactEditForm } from "./contact-edit-form";

type Tab = "resumen" | "pedidos" | "agentes";

function fullName(c: Pick<CrmContactListItem, "first_name" | "last_name">): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

function initialsOf(name: string): string {
  return name
    .replace(/[^a-zA-Záéíóúñü@. ]/g, "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

interface CompanyIO {
  id: string;
  io_number: string;
  brand: string | null;
  status: string;
}

/** Ficha de un contacto: portada + datos + empresa, pedidos de su empresa
 *  y agentes. La creación y edición viven en el drawer de cada empresa. */
export function ContactDrawer({
  contact,
  myRole,
  onClose,
}: {
  contact: CrmContactListItem;
  myRole: MemberRole | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("resumen");
  const [ios, setIos] = useState<CompanyIO[] | null>(null);
  const [iosError, setIosError] = useState<string | null>(null);
  const [editingFicha, setEditingFicha] = useState(false);
  // Sin auth (dev: myRole null) se permite editar; viewer = solo lectura.
  const canEdit = myRole === null || hasMinRole(myRole, "seller");

  const name = fullName(contact);
  const displayName = name === "—" ? "Contacto" : toTitleCase(name);

  const loadIos = useCallback(() => {
    setIosError(null);
    if (!contact.company_id) {
      setIos([]);
      return;
    }
    fetch(`/api/companies/${contact.company_id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("No se pudieron cargar los pedidos.");
        const j = (await res.json()) as { ios?: CompanyIO[] };
        setIos(j.ios ?? []);
      })
      .catch((e: unknown) => {
        setIosError(e instanceof Error ? e.message : "No se pudieron cargar.");
      });
  }, [contact.company_id]);

  useEffect(() => {
    setTab("resumen");
    setIos(null);
    setIosError(null);
    setEditingFicha(false);
    loadIos();
  }, [contact.id, loadIos]);

  const drawerTabs: DrawerTabDef[] = [
    { id: "resumen", label: "Resumen", icon: UserRound },
    { id: "pedidos", label: `Pedidos${ios ? ` (${ios.length})` : ""}`, icon: FileText },
    { id: "agentes", label: "Agentes", icon: Bot },
  ];

  return (
    <DrawerShell
      onClose={onClose}
      size="wide"
      avatar={<UserRound className="size-5" aria-hidden />}
      title={displayName}
      description={contact.job_title ?? "—"}
      badges={
        contact.is_primary ? (
          <span className="flex flex-wrap items-center gap-1.5" aria-label="Contacto principal">
            <CompanyPrincipalBadge isPrimary />
          </span>
        ) : undefined
      }
      tabs={drawerTabs}
      tab={tab}
      onTabChange={(id) => setTab(id as Tab)}
      tabListLabel="Ficha del contacto"
      fill={tab === "agentes"}
    >
      {tab === "agentes" ? (
        <ContactChat contactId={contact.id} contactLabel={displayName} />
      ) : tab === "pedidos" ? (
        <>
          {iosError && (
            <div className="flex flex-col gap-3">
              <AppCardState>{iosError}</AppCardState>
              <Button variant="outline" size="sm" className="w-fit" onClick={loadIos}>
                Reintentar
              </Button>
            </div>
          )}
          {!iosError && ios === null && (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando pedidos">
              <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
              <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
            </div>
          )}
          {!iosError && ios !== null && (
            <AppCard
              title={`Pedidos de ${contact.company_name ? toTitleCase(contact.company_name) : "su empresa"} (${ios.length})`}
              description="IOs donde su empresa es anunciante o facturación."
              aria-label="Pedidos de su empresa"
            >
              {ios.length === 0 ? (
                <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3">
                  <p className="text-[13px] text-muted-foreground">
                    {contact.company_id
                      ? "Su empresa aún no tiene pedidos."
                      : "Sin empresa asociada: no hay pedidos que mostrar."}
                  </p>
                </div>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {ios.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                      <span className="flex min-w-0 items-center gap-2 text-[13px]">
                        <span className="truncate font-medium">{o.io_number}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{o.brand ? toTitleCase(o.brand) : "—"}</span>
                        <CompanyIOBadge status={o.status} />
                      </span>
                      <Link
                        href={`/orders?order=${o.id}`}
                        className="shrink-0 text-xs font-medium text-primary underline-offset-4 hover:underline"
                      >
                        Ver orden
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </AppCard>
          )}
        </>
      ) : (
        <>
          <AppCard variant="hero" aria-label="Portada del contacto">
            <div className="flex items-center gap-4">
              <span
                aria-hidden
                className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold tracking-wide text-primary ring-1 ring-primary/15"
              >
                {initialsOf(displayName) || "—"}
              </span>
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold tracking-tight">{displayName}</p>
                <p className="truncate text-[13px] text-muted-foreground">
                  {[contact.job_title, contact.company_name ? toTitleCase(contact.company_name) : null].filter(Boolean).join(" · ") || "—"}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {contact.email && (
                    <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                      <Mail className="size-3.5" aria-hidden /> {contact.email}
                    </a>
                  )}
                  {contact.phone && (
                    <a href={`tel:${contact.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                      <Phone className="size-3.5" aria-hidden /> <span className="tabular-nums">{contact.phone}</span>
                    </a>
                  )}
                </div>
              </div>
            </div>
          </AppCard>

          <AppCard
            title="Ficha"
            description="Datos de la persona de contacto."
            aria-label="Ficha del contacto"
            action={
              canEdit && !editingFicha ? (
                <Button variant="outline" size="sm" onClick={() => setEditingFicha(true)}>
                  <Pencil className="size-3.5" aria-hidden /> Editar
                </Button>
              ) : undefined
            }
          >
            {editingFicha ? (
              <ContactEditForm
                key={contact.id}
                contactId={contact.id}
                initial={{
                  first_name: contact.first_name ?? "",
                  last_name: contact.last_name ?? "",
                  email: contact.email ?? "",
                  phone: contact.phone ?? "",
                  job_title: contact.job_title ?? "",
                  is_primary: contact.is_primary,
                }}
                onSaved={() => {
                  setEditingFicha(false);
                  router.refresh();
                }}
                onCancel={() => setEditingFicha(false)}
              />
            ) : (
            <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Nombre</dt><dd className="mt-0.5 text-[13px] font-medium">{displayName}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Cargo</dt><dd className="mt-0.5 text-[13px]">{contact.job_title ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="mt-0.5 text-[13px]">{contact.email ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Teléfono</dt><dd className="mt-0.5 text-[13px] tabular-nums">{contact.phone ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Agregado por</dt><dd className="mt-0.5 text-[13px]">{typeof contact.created_by === "string" && contact.created_by ? contact.created_by : "—"}</dd></div>
              {typeof contact.updated_by === "string" && contact.updated_by && contact.updated_by !== contact.created_by && (
                <div><dt className="text-xs text-muted-foreground">Editado por</dt><dd className="mt-0.5 text-[13px]">{contact.updated_by}</dd></div>
              )}
            </dl>
            )}
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
        </>
      )}
    </DrawerShell>
  );
}
