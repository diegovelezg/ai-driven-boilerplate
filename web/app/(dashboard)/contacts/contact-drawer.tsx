"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Bot, Building2, FileText, Mail, Phone, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EditButton, RetryButton } from "@/components/buttons";
import { AppCard, AppCardState } from "@/components/app-card";
import {
  DrawerShell,
  type DrawerTabDef,
} from "@/components/drawer-shell";
import {
  DrawerTable,
  DrawerTableBody,
  DrawerTableHeader,
  DrawerTableRow,
  DrawerTableTd,
  DrawerTableTh,
} from "@/components/drawer-table";
import { CompanyIOBadge, CompanyPrincipalBadge } from "@/components/company-badges";
import { hasMinRole, type MemberRole } from "@/lib/roles";
import { toTitleCase } from "@/lib/format";
import type { CrmContactListItem } from "@/lib/crm-db";
import { ContactAccountsForm } from "@/components/contact-accounts-form";
import { ContactEditForm } from "./contact-edit-form";

// Carga diferida: el chat solo se descarga al usarse (mismo patrón que
// orden-drawer: el drawer inicial no paga react-markdown).
function DrawerLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={label}>
      <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
    </div>
  );
}
const ContactChat = dynamic(() => import("./contact-chat").then((m) => m.ContactChat), {
  ssr: false,
  loading: () => <DrawerLoading label="Cargando chat" />,
});

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
  const [companyKind, setCompanyKind] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Array<{ contact_id: string; advertiser_company_id: string }>>([]);
  const [advertisers, setAdvertisers] = useState<Array<{ id: string; name: string }>>([]);
  const [editingAccounts, setEditingAccounts] = useState(false);
  // Sin auth (dev: myRole null) se permite editar; viewer = solo lectura.
  const canEdit = myRole === null || hasMinRole(myRole, "seller");

  const name = fullName(contact);
  const displayName = name === "—" ? "Contacto" : toTitleCase(name);

  const loadIos = useCallback((signal?: AbortSignal) => {
    setIosError(null);
    if (!contact.company_id) {
      setIos([]);
      return;
    }
    fetch(`/api/companies/${contact.company_id}`, { cache: "no-store", signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("No se pudieron cargar los pedidos.");
        const j = (await res.json()) as {
          ios?: CompanyIO[];
          company?: Record<string, unknown>;
          network?: { advertisers?: Array<{ id: string; name: string }> };
          contact_accounts?: Array<{ contact_id: string; advertiser_company_id: string }>;
        };
        setIos(j.ios ?? []);
        setCompanyKind(typeof j.company?.kind === "string" ? j.company.kind : null);
        setAdvertisers((j.network?.advertisers ?? []).map((a) => ({ id: String(a.id), name: String(a.name ?? "—") })));
        setAccounts(
          (j.contact_accounts ?? [])
            .filter((a) => a.contact_id === contact.id)
            .map((a) => ({ contact_id: String(a.contact_id), advertiser_company_id: String(a.advertiser_company_id) })),
        );
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setIosError(e instanceof Error ? e.message : "No se pudieron cargar.");
      });
  }, [contact.company_id, contact.id]);

  // Carga diferida: setState solo en callbacks async (patrón permitido por el lint).
  useEffect(() => {
    const ac = new AbortController();
    const h = setTimeout(() => {
      setTab("resumen");
      setIos(null);
      setIosError(null);
      setEditingFicha(false);
      setCompanyKind(null);
      setAccounts([]);
      setAdvertisers([]);
      setEditingAccounts(false);
      loadIos(ac.signal);
    }, 0);
    return () => {
      clearTimeout(h);
      ac.abort();
    };
  }, [contact.id, loadIos]);

  const drawerTabs: DrawerTabDef[] = [
    { id: "resumen", label: "Resumen", icon: UserRound },
    { id: "pedidos", label: `Órdenes${ios ? ` (${ios.length})` : ""}`, icon: FileText },
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
              <RetryButton onRetry={() => loadIos()} />
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
              description="Órdenes donde su empresa es anunciante o responsable de facturación."
              tone="primary"
              aria-label="Pedidos de su empresa"
            >
              {ios.length === 0 ? (
                <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                  <p className="text-sm text-muted-foreground">
                    {contact.company_id
                      ? "Su empresa aún no tiene pedidos."
                      : "Sin empresa asociada: no hay pedidos que mostrar."}
                  </p>
                </div>
              ) : (
                <DrawerTable flush>
                  <DrawerTableHeader flush>
                    <DrawerTableTh>Orden</DrawerTableTh>
                    <DrawerTableTh>Marca</DrawerTableTh>
                    <DrawerTableTh>Estado</DrawerTableTh>
                    <DrawerTableTh>Acciones</DrawerTableTh>
                  </DrawerTableHeader>
                  <DrawerTableBody>
                    {ios.map((o) => (
                      <DrawerTableRow key={o.id}>
                        <DrawerTableTd className="font-medium">{o.io_number}</DrawerTableTd>
                        <DrawerTableTd className="text-sm">{o.brand ? toTitleCase(o.brand) : "—"}</DrawerTableTd>
                        <DrawerTableTd><CompanyIOBadge status={o.status} /></DrawerTableTd>
                        <DrawerTableTd>
                          <Link
                            href={`/orders?order=${o.id}`}
                            className="shrink-0 text-xs font-medium text-primary underline-offset-4 hover:underline"
                          >
                            Ver orden
                          </Link>
                        </DrawerTableTd>
                      </DrawerTableRow>
                    ))}
                  </DrawerTableBody>
                </DrawerTable>
              )}
            </AppCard>
          )}
        </>
      ) : (
        <>
          <AppCard variant="hero" tone="sky" title={displayName} aria-label="Portada del contacto">
            <div className="flex items-center gap-4">
              <span
                aria-hidden
                className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold tracking-wide text-primary ring-1 ring-primary/15"
              >
                {initialsOf(displayName) || "—"}
              </span>
              <div className="min-w-0">
                <p className="text-sm leading-relaxed break-words text-muted-foreground">
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
            tone="sky"
            aria-label="Ficha del contacto"
            action={
              canEdit && !editingFicha ? (
                <EditButton onEdit={() => setEditingFicha(true)} />
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
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Nombre</dt><dd className="mt-1 text-sm font-medium">{displayName}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Cargo</dt><dd className="mt-1 text-sm">{contact.job_title ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="mt-1 text-sm">{contact.email ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Teléfono</dt><dd className="mt-1 text-sm tabular-nums">{contact.phone ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Agregado por</dt><dd className="mt-1 text-sm">{typeof contact.created_by === "string" && contact.created_by ? contact.created_by : "—"}</dd></div>
              {typeof contact.updated_by === "string" && contact.updated_by && contact.updated_by !== contact.created_by && (
                <div><dt className="text-xs text-muted-foreground">Editado por</dt><dd className="mt-1 text-sm">{contact.updated_by}</dd></div>
              )}
            </dl>
            )}
          </AppCard>

          <AppCard
            title="Empresa"
            description="Dónde trabaja esta persona."
            tone="emerald"
            aria-label="Empresa del contacto"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium">
                {contact.company_name ? toTitleCase(contact.company_name) : "Sin empresa"}
              </p>
              {contact.company_id && (
                <Button render={<Link href={`/companies?company=${contact.company_id}`} />} nativeButton={false} size="sm" variant="outline">
                  <Building2 aria-hidden />
                  Ver empresa
                </Button>
              )}
            </div>
          </AppCard>

          {companyKind === "agencia" && (
            <AppCard
              title="Cuentas que atiende"
              description="Anunciantes vinculados a su agencia que este contacto atiende."
              tone="emerald"
              aria-label="Cuentas que atiende"
              action={
                canEdit && !editingAccounts ? (
                  <EditButton onEdit={() => setEditingAccounts(true)} />
                ) : undefined
              }
            >
              {editingAccounts ? (
                <ContactAccountsForm
                  contactId={contact.id}
                  advertiserOptions={advertisers}
                  initialAdvertiserIds={accounts.map((a) => a.advertiser_company_id)}
                  contactLabel={displayName}
                  onSaved={() => {
                    setEditingAccounts(false);
                    router.refresh();
                    loadIos();
                  }}
                  onCancel={() => setEditingAccounts(false)}
                />
              ) : accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin cuentas asignadas.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {accounts.map((a) => (
                    <span key={a.advertiser_company_id} className="rounded-full bg-muted px-2.5 py-1 text-xs">
                      {toTitleCase(advertisers.find((x) => x.id === a.advertiser_company_id)?.name ?? "—")}
                    </span>
                  ))}
                </div>
              )}
            </AppCard>
          )}
        </>
      )}
    </DrawerShell>
  );
}
