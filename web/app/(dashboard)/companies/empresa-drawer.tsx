"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Building2, Bot, FileText, Globe, Network, Plus, UserRound, X } from "lucide-react";
import { ArchiveToggleButton, EditButton, RetryButton, RowIconButton } from "@/components/buttons";
import { Button } from "@/components/ui/button";
import { VinculoForm } from "./vinculo-form";
import { ArchivedBadge, AttributeBadge } from "@/components/badges";
import { toast } from "@/components/ui/toast";
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
import { setCompanyArchivedAction, setContactArchivedAction, deleteCompanyLinkAction, type CrmState } from "@/lib/crm-actions";
import { ContactAccountsForm } from "@/components/contact-accounts-form";
import { AccountAttendantsForm } from "@/components/account-attendants-form";
import { kindLabel } from "@/lib/crm";
import { CompanyCampaignBadge, CompanyIOBadge, CompanyKindBadge, CompanyPrincipalBadge } from "@/components/company-badges";
import { hasMinRole, isMemberRole, type MemberRole } from "@/lib/roles";
import { RestrictedVisibilityBadge } from "@/components/role-badges";
import { normalizeCommissionPct } from "@/lib/agency-commission";
import { toTitleCase } from "@/lib/format";
import { taxIdLabel } from "@/lib/tax-id";
import { KindForm } from "./kind-form";
import { AgencyCommissionForm } from "./agency-commission-form";

// Carga diferida: chat, research y editor solo se descargan al usarse
// (mismo patrón que orden-drawer: el drawer inicial no paga
// react-markdown ni el catálogo de países).
function DrawerLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={label}>
      <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
    </div>
  );
}
const CompanyEditForm = dynamic(() => import("./company-edit-form").then((m) => m.CompanyEditForm), {
  ssr: false,
  loading: () => <DrawerLoading label="Cargando formulario" />,
});
const EmpresaChat = dynamic(() => import("./empresa-chat").then((m) => m.EmpresaChat), {
  ssr: false,
  loading: () => <DrawerLoading label="Cargando chat" />,
});
const EmpresaResearch = dynamic(() => import("./empresa-research").then((m) => m.EmpresaResearch), {
  ssr: false,
  loading: () => <DrawerLoading label="Cargando investigación" />,
});

interface DrawerContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  is_primary: boolean;
  created_by?: string | null;
  deleted_at?: string | null;
}

interface DrawerIO {
  id: string;
  io_number: string;
  brand: string | null;
  status: string;
}

interface DrawerCampaign {
  id: string;
  name: string;
  status: string;
}

interface NetworkBrand {
  brand: string;
  ios: number;
}

interface NetworkCompany {
  id: string;
  name: string;
  kind: string | null;
  ios: number;
  explicit?: boolean;
  origin?: "manual" | "oi" | null;
}

interface EmpresaDetail {
  company: Record<string, unknown>;
  contacts: DrawerContact[];
  campaigns: DrawerCampaign[];
  ios: DrawerIO[];
  network?: { brands: NetworkBrand[]; agencies: NetworkCompany[]; advertisers: NetworkCompany[] };
  contact_accounts?: Array<{ contact_id: string; advertiser_company_id: string }>;
  incoming_accounts?: Array<{ contact_id: string; agency_company_id: string }>;
  agency_team?: Array<{ id: string; agency_company_id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; job_title: string | null; is_primary: boolean }>;
  myRole?: MemberRole | null;
}

type TabId = "ficha" | "perfil" | "contactos" | "pedidos" | "vinculos" | "agentes";

function contactName(c: DrawerContact): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

export function EmpresaDrawer({
  companyId,
  initialTab = "ficha",
  onClose,
}: {
  companyId: string;
  initialTab?: TabId;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [detail, setDetail] = useState<EmpresaDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingDatos, setEditingDatos] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [accountsFor, setAccountsFor] = useState<string | null>(null);
  const [attendantsFor, setAttendantsFor] = useState<string | null>(null);
  const router = useRouter();

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error("No se pudo cargar la empresa.");
      setDetail((await res.json()) as EmpresaDetail);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : "No se pudieron cargar los datos.");
    }
  }, [companyId]);

  // Carga diferida: setState solo en callbacks async (patrón permitido por el lint).
  useEffect(() => {
    const ac = new AbortController();
    const h = setTimeout(() => {
      setTab("ficha");
      setDetail(null);
      setEditingDatos(false);
      setLinkOpen(false);
      setAccountsFor(null);
      setAttendantsFor(null);
      void load(ac.signal);
    }, 0);
    return () => {
      clearTimeout(h);
      ac.abort();
    };
  }, [load]);

  // Estable por identidad de `detail`: evita que `?? []` cree un array
  // nuevo en cada render y rompa el useMemo de abajo.
  const contacts = useMemo(() => detail?.contacts ?? [], [detail]);
  const accountsByContact = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of detail?.contact_accounts ?? []) {
      const list = m.get(a.contact_id) ?? [];
      m.set(a.contact_id, [...list, a.advertiser_company_id]);
    }
    return m;
  }, [detail]);
  const teamByAgency = useMemo(() => {
    const m = new Map<string, Array<{ id: string; name: string; email: string | null; phone: string | null; jobTitle: string | null; isPrimary: boolean }>>();
    for (const t of detail?.agency_team ?? []) {
      const list = m.get(t.agency_company_id) ?? [];
      const name = [t.first_name, t.last_name].filter(Boolean).join(" ") || "—";
      m.set(t.agency_company_id, [...list, { id: t.id, name, email: t.email, phone: t.phone, jobTitle: t.job_title, isPrimary: t.is_primary }]);
    }
    for (const [k, v] of m) m.set(k, [...v].sort((a, b) => a.name.localeCompare(b.name, "es")));
    return m;
  }, [detail]);
  const attendantsByAgency = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of detail?.incoming_accounts ?? []) {
      const list = m.get(a.agency_company_id) ?? [];
      m.set(a.agency_company_id, [...list, a.contact_id]);
    }
    return m;
  }, [detail]);
  const ios = detail?.ios ?? [];
  const campaigns = detail?.campaigns ?? [];
  const company = detail?.company;
  const fiscalLabel = taxIdLabel(
    typeof company === "object" && company !== null && "country" in company
      ? (company as { country?: unknown }).country
      : null,
  );
  const kind = (company?.kind as string | null) ?? null;
  const rawRole = detail?.myRole ?? null;
  const myRole: MemberRole | null = isMemberRole(rawRole) ? rawRole : null;
  // Sin auth (dev: myRole null) se permite ver/gestionar; viewer = solo lectura.
  const canEdit = myRole === null || hasMinRole(myRole, "seller");
  const canViewCommission = myRole === null || hasMinRole(myRole, "admin");
  const canAdmin = myRole === null || hasMinRole(myRole, "admin");
  const [archiving, startArchiving] = useTransition();
  const isArchived = typeof company?.deleted_at === "string" && !!company.deleted_at;

  const runArchive = (
    title: string,
    fn: () => Promise<CrmState>,
  ) => {
    startArchiving(() => {
      void (async () => {
        const res = await fn();
        toast.add({ title, description: res.message, type: res.ok ? "success" : "error" });
        if (res.ok) {
          router.refresh();
          await load();
        }
      })();
    });
  };
  const isAgency = kind === "agencia";
  const commissionRaw = company?.agency_commission_pct;
  const commissionInitial =
    typeof commissionRaw === "number"
      ? (normalizeCommissionPct(commissionRaw) ?? null)
      : typeof commissionRaw === "string" && commissionRaw.trim() !== ""
        ? (normalizeCommissionPct(commissionRaw) ?? null)
        : null;

  const isAdvertiser = kind === "anunciante";
  const isProvider = kind === "proveedor";
  const network = detail?.network;
  const counterparties = isAdvertiser ? (network?.agencies ?? []) : (network?.advertisers ?? []);
  const counterLabel = isAdvertiser ? "Agencias" : "Anunciantes";
  const counterEmpty = isAdvertiser
    ? "Sin agencias vinculadas: vincula una o crea la primera orden."
    : "Sin anunciantes vinculados: vincula uno o crea la primera orden.";
  // Agencia en gestión de atendidos (vista anunciante): panel sobre la tabla.
  const managingAgency = isAdvertiser ? (counterparties.find((c) => c.id === attendantsFor) ?? null) : null;
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleting, startDeleting] = useTransition();
  const canLink = canEdit && !isArchived && (isAdvertiser || isAgency);

  const removeLink = (counterId: string) => {
    setDeletingId(counterId);
    startDeleting(() => {
      void (async () => {
        const res = await deleteCompanyLinkAction(
          isAdvertiser
            ? { agencyCompanyId: counterId, advertiserCompanyId: companyId }
            : { agencyCompanyId: companyId, advertiserCompanyId: counterId },
        );
        setDeletingId(null);
        toast.add({
          title: res.ok ? "Vínculo eliminado" : "No se pudo eliminar",
          description: res.message,
          type: res.ok ? "success" : "error",
        });
        if (res.ok) {
          router.refresh();
          await load();
        }
      })();
    });
  };

  const tabs: DrawerTabDef[] = [
    { id: "ficha", label: "Ficha", icon: Building2 },
    { id: "perfil", label: "Perfil", icon: Globe },
    { id: "contactos", label: `Contactos (${contacts.length})`, icon: UserRound },
    { id: "pedidos", label: `Órdenes (${ios.length})`, icon: FileText },
    // Proveedor: sin red comercial (su vínculo es inventario, no órdenes).
    ...(!isProvider ? [{ id: "vinculos", label: "Vínculos", icon: Network } as DrawerTabDef] : []),
    { id: "agentes", label: "Agentes", icon: Bot },
  ];

  return (
    <DrawerShell
      onClose={onClose}
      size="wide"
      avatar={<Building2 className="size-5" aria-hidden />}
      title={company ? toTitleCase(String(company.name ?? "Empresa")) : "Empresa"}
      description={
        company
          ? [typeof company.domain === "string" && company.domain ? company.domain : null, typeof company.tax_id === "string" && company.tax_id ? `${fiscalLabel} ${company.tax_id}` : null].filter(Boolean).join(" · ") || "—"
          : "Cargando…"
      }
      badges={
        detail && (
          <span className="flex flex-wrap items-center gap-1.5" aria-label={`Empresa ${kindLabel(kind)}, ${contacts.length} contactos, ${ios.length} pedidos`}>
            <CompanyKindBadge kind={kind} />
            {isArchived && <ArchivedBadge fem />}
            <span className="text-xs text-muted-foreground">
              {contacts.length} contacto{contacts.length === 1 ? "" : "s"} · {ios.length} pedido{ios.length === 1 ? "" : "s"}
            </span>
          </span>
        )
      }
      tabs={tabs}
      tab={tab}
      onTabChange={(id) => setTab(id as TabId)}
      tabListLabel="Detalle de empresa"
      fill={tab === "agentes"}
    >
      {tab === "agentes" ? (
        <EmpresaChat
          companyId={companyId}
          companyName={company ? toTitleCase(String(company.name ?? "Empresa")) : "Empresa"}
        />
      ) : (
        <>
      {error && (
        <div className="flex flex-col gap-3">
          <AppCardState>{error}</AppCardState>
          <RetryButton onRetry={() => void load()} />
        </div>
      )}
      {!error && !detail && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando empresa">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
        </div>
      )}

      {detail && tab === "ficha" && (
        <>
          <AppCard
            title="Datos"
            description="Nombre comercial, razón social y datos de contacto."
            tone="sky"
            aria-label="Datos de la empresa"
            action={
              <span className="flex flex-wrap items-center gap-2">
                {canAdmin && !editingDatos && (
                  <ArchiveToggleButton
                    placement="header"
                    archived={isArchived}
                    noun="empresa"
                    pending={archiving}
                    onToggle={() =>
                      runArchive(isArchived ? "Empresa restaurada" : "Empresa archivada", () =>
                        setCompanyArchivedAction({ companyId, archived: !isArchived }),
                      )
                    }
                  />
                )}
                {canEdit && !editingDatos && !isArchived && (
                  <EditButton onEdit={() => setEditingDatos(true)} />
                )}
              </span>
            }
          >
            {editingDatos ? (
              <CompanyEditForm
                key={companyId}
                companyId={companyId}
                initial={{
                  name: typeof company?.name === "string" ? company.name : "",
                  legal_name: typeof company?.legal_name === "string" ? company.legal_name : "",
                  tax_id: typeof company?.tax_id === "string" ? company.tax_id : "",
                  domain: typeof company?.domain === "string" ? company.domain : "",
                  phone: typeof company?.phone === "string" ? company.phone : "",
                  city: typeof company?.city === "string" ? company.city : "",
                  country: typeof company?.country === "string" ? company.country : "",
                  address: typeof company?.address === "string" ? company.address : "",
                }}
                onSaved={() => {
                  setEditingDatos(false);
                  router.refresh();
                  void load();
                }}
                onCancel={() => setEditingDatos(false)}
              />
            ) : (
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Razón social</dt><dd className="mt-1 text-sm">{typeof company?.legal_name === "string" && company.legal_name ? company.legal_name : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{fiscalLabel}</dt><dd className="mt-1 text-sm">{typeof company?.tax_id === "string" && company.tax_id ? company.tax_id : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Web</dt><dd className="mt-1 text-sm">{typeof company?.domain === "string" && company.domain ? company.domain : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Teléfono</dt><dd className="mt-1 text-sm tabular-nums">{typeof company?.phone === "string" && company.phone ? company.phone : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Dirección</dt><dd className="mt-1 text-sm">{typeof company?.address === "string" && company.address ? company.address : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Ciudad / País</dt><dd className="mt-1 text-sm">{[company?.city, company?.country].filter((v) => typeof v === "string" && v).join(" · ") || "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Creada</dt><dd className="mt-1 text-sm tabular-nums">{typeof company?.created_by === "string" && company.created_by ? company.created_by : "—"}</dd></div>
              {typeof company?.updated_by === "string" && company.updated_by && company.updated_by !== company.created_by && (
                <div><dt className="text-xs text-muted-foreground">Editada por</dt><dd className="mt-1 text-sm">{String(company.updated_by)}</dd></div>
              )}
            </dl>
            )}
          </AppCard>
          <AppCard
            title="Tipo"
            tone="sky"
            aria-label="Tipo de empresa"
          >
            {canEdit ? (
              <KindForm key={companyId} companyId={companyId} initial={typeof company?.kind === "string" ? company.kind : null} onSaved={() => { router.refresh(); void load(); }} />
            ) : (
              <p className="text-sm font-medium">{kindLabel(typeof company?.kind === "string" ? company.kind : null)}</p>
            )}
          </AppCard>
          {isAgency && canViewCommission && (
            <AppCard
              title={
                <span className="flex flex-wrap items-center gap-2">
                  Comisión agencia
                  <RestrictedVisibilityBadge minRole="admin" />
                </span>
              }
              description="Acuerdo por defecto (% sobre bruto)."
              tone="violet"
              aria-label="Comisión de agencia"
            >
              <AgencyCommissionForm companyId={companyId} initial={commissionInitial} onSaved={() => void load()} />
            </AppCard>
          )}
          {isAgency && !canViewCommission && (
            <AppCard
              title={
                <span className="flex flex-wrap items-center gap-2">
                  Comisión agencia
                  <RestrictedVisibilityBadge minRole="admin" />
                </span>
              }
              description="Acuerdo por defecto (% sobre bruto)."
              tone="violet"
              aria-label="Comisión de agencia (restringida)"
            >
              <p className="text-sm text-muted-foreground">
                El acuerdo de comisión existe pero solo es visible para Propietario y Administrador.
                Si necesitas revisarlo, pide a un admin que lo confirme.
              </p>
            </AppCard>
          )}
        </>
      )}

      {detail && tab === "perfil" && (
        <EmpresaResearch key={companyId} companyId={companyId} canResearch={canEdit} />
      )}

      {detail && tab === "contactos" && (
        <AppCard
          title={`Contactos (${contacts.length})`}
          description={
            isAgency
              ? "Varios contactos por agencia. Declara a qué anunciantes atiende cada uno (Cuentas)."
              : "Varios contactos por empresa. Solo uno puede ser principal."
          }
          tone="sky"
          aria-label="Contactos de la empresa"
        >
          {accountsFor && isAgency && (
            <div className="mb-3">
              <ContactAccountsForm
                contactId={accountsFor}
                advertiserOptions={counterparties.map((c) => ({ id: c.id, name: c.name }))}
                initialAdvertiserIds={accountsByContact.get(accountsFor) ?? []}
                contactLabel={contactName(contacts.find((c) => c.id === accountsFor) ?? { first_name: null, last_name: null } as DrawerContact)}
                onSaved={() => {
                  setAccountsFor(null);
                  router.refresh();
                  void load();
                }}
                onCancel={() => setAccountsFor(null)}
              />
            </div>
          )}
          {contacts.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
              <p className="text-sm text-muted-foreground">
                Sin contactos.
              </p>
            </div>
          ) : (
            <DrawerTable flush>
              <DrawerTableHeader flush>
                <DrawerTableTh>Nombre</DrawerTableTh>
                <DrawerTableTh>Email</DrawerTableTh>
                <DrawerTableTh>Teléfono</DrawerTableTh>
                <DrawerTableTh>Cargo</DrawerTableTh>
                {isAgency && <DrawerTableTh>Cuentas que atiende</DrawerTableTh>}
                <DrawerTableTh>Principal</DrawerTableTh>
                <DrawerTableTh>Agregado por</DrawerTableTh>
                <DrawerTableTh>Acciones</DrawerTableTh>
              </DrawerTableHeader>
              <DrawerTableBody>
                {contacts.map((c) => {
                  const archived = typeof c.deleted_at === "string" && !!c.deleted_at;
                  const accountIds = accountsByContact.get(c.id) ?? [];
                  return (
                  <DrawerTableRow key={c.id}>
                    <DrawerTableTd className="font-medium">
                      {contactName(c)}
                      {archived && <ArchivedBadge className="ml-2" />}
                    </DrawerTableTd>
                    <DrawerTableTd className="text-xs">{c.email ?? c.phone ?? "—"}</DrawerTableTd>
                    <DrawerTableTd className="text-xs tabular-nums">{c.phone ?? "—"}</DrawerTableTd>
                    <DrawerTableTd className="text-xs">{c.job_title ?? "—"}</DrawerTableTd>
                    {isAgency && (
                      <DrawerTableTd className="text-xs">
                        {accountIds.length === 0 ? (
                          <span className="text-muted-foreground">Sin asignar</span>
                        ) : (
                          accountIds.map((id) => (
                            <span key={id} className="mr-1 mb-1 inline-block rounded-full bg-muted px-2 py-0.5 text-xs">
                              {toTitleCase(counterparties.find((x) => x.id === id)?.name ?? "—")}
                            </span>
                          ))
                        )}
                      </DrawerTableTd>
                    )}
                    <DrawerTableTd><CompanyPrincipalBadge isPrimary={c.is_primary} /></DrawerTableTd>
                    <DrawerTableTd className="text-xs text-muted-foreground" title={typeof c.created_by === "string" && c.created_by ? `Agregado por ${c.created_by}` : undefined}>{typeof c.created_by === "string" && c.created_by ? c.created_by : "—"}</DrawerTableTd>
                    <DrawerTableTd>
                      <span className="flex flex-wrap items-center gap-2">
                      {canEdit && isAgency && !archived && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setAccountsFor(accountsFor === c.id ? null : c.id)}
                          disabled={archiving}
                        >
                          Cuentas
                        </Button>
                      )}
                      {canEdit ? (
                        <ArchiveToggleButton
                          archived={archived}
                          noun="contacto"
                          itemName={contactName(c)}
                          pending={archiving}
                          onToggle={() =>
                            runArchive(archived ? "Contacto restaurado" : "Contacto archivado", () =>
                              setContactArchivedAction({ contactId: c.id, archived: !archived }),
                            )
                          }
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                      </span>
                    </DrawerTableTd>
                  </DrawerTableRow>
                  );
                })}
              </DrawerTableBody>
            </DrawerTable>
          )}
        </AppCard>
      )}

      {detail && tab === "pedidos" && (
        <>
          <AppCard
            title={`Pedidos (${ios.length})`}
            description="Órdenes donde aparece como anunciante o responsable de facturación."
            tone="primary"
            aria-label="Pedidos de la empresa"
          >
            {ios.length === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-sm text-muted-foreground">
                  Sin pedidos: aún no es cliente.
                </p>
              </div>
            ) : (
              <DrawerTable flush>
                <DrawerTableHeader flush>
                  <DrawerTableTh>Orden</DrawerTableTh>
                  <DrawerTableTh>Marca</DrawerTableTh>
                  <DrawerTableTh>Estado</DrawerTableTh>
                </DrawerTableHeader>
                <DrawerTableBody>
                  {ios.map((o) => (
                    <DrawerTableRow key={o.id}>
                      <DrawerTableTd className="font-medium">{o.io_number}</DrawerTableTd>
                      <DrawerTableTd className="text-sm">{toTitleCase(o.brand ?? "—")}</DrawerTableTd>
                      <DrawerTableTd><CompanyIOBadge status={o.status} /></DrawerTableTd>
                    </DrawerTableRow>
                  ))}
                </DrawerTableBody>
              </DrawerTable>
            )}
          </AppCard>
          <AppCard
            title={`Campañas (${campaigns.length})`}
            description="Pautas registradas en las que participa."
            tone="primary"
            aria-label="Campañas de la empresa"
          >
            {campaigns.length === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-sm text-muted-foreground">
                  Sin campañas.
                </p>
              </div>
            ) : (
              <DrawerTable flush>
                <DrawerTableHeader flush>
                  <DrawerTableTh>Campaña</DrawerTableTh>
                  <DrawerTableTh>Estado</DrawerTableTh>
                </DrawerTableHeader>
                <DrawerTableBody>
                  {campaigns.map((m) => (
                    <DrawerTableRow key={m.id}>
                      <DrawerTableTd className="font-medium">{m.name}</DrawerTableTd>
                      <DrawerTableTd><CompanyCampaignBadge status={m.status} /></DrawerTableTd>
                    </DrawerTableRow>
                  ))}
                </DrawerTableBody>
              </DrawerTable>
            )}
          </AppCard>
        </>
      )}

      {detail && tab === "vinculos" && !isProvider && (
        <>
          <AppCard
            title={`Marcas (${network?.brands.length ?? 0})`}
            tone="emerald"
            aria-label="Marcas vinculadas"
          >
            {(network?.brands.length ?? 0) === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-sm text-muted-foreground">
                  Sin marcas vinculadas: aún no hay órdenes.
                </p>
              </div>
            ) : (
              <DrawerTable flush>
                <DrawerTableHeader flush>
                  <DrawerTableTh>Marca</DrawerTableTh>
                  <DrawerTableTh numeric>Órdenes</DrawerTableTh>
                </DrawerTableHeader>
                <DrawerTableBody>
                  {(network?.brands ?? []).map((b) => (
                    <DrawerTableRow key={b.brand.toUpperCase()}>
                      <DrawerTableTd className="font-medium">{toTitleCase(b.brand)}</DrawerTableTd>
                      <DrawerTableTd numeric>{b.ios}</DrawerTableTd>
                    </DrawerTableRow>
                  ))}
                </DrawerTableBody>
              </DrawerTable>
            )}
          </AppCard>
          <AppCard
            title={`${counterLabel} (${counterparties.length})`}
            tone="emerald"
            aria-label={counterLabel}
            action={
              canLink && !linkOpen ? (
                <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
                  <Plus aria-hidden />
                  Vincular
                </Button>
              ) : undefined
            }
          >
            {linkOpen && canLink && (
              <div className="mb-3">
                <VinculoForm
                  companyId={companyId}
                  kind={isAdvertiser ? "anunciante" : "agencia"}
                  linkedIds={counterparties.map((c) => c.id)}
                  onSaved={() => {
                    setLinkOpen(false);
                    router.refresh();
                    void load();
                  }}
                  onCancel={() => setLinkOpen(false)}
                />
              </div>
            )}
            {managingAgency && canEdit && (
              <div className="mb-3">
                <AccountAttendantsForm
                  agencyCompanyId={managingAgency.id}
                  agencyName={managingAgency.name}
                  advertiserCompanyId={companyId}
                  team={teamByAgency.get(managingAgency.id) ?? []}
                  initialContactIds={attendantsByAgency.get(managingAgency.id) ?? []}
                  onSaved={() => {
                    setAttendantsFor(null);
                    router.refresh();
                    void load();
                  }}
                  onCancel={() => setAttendantsFor(null)}
                />
              </div>
            )}
            {counterparties.length === 0 && !linkOpen ? (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-sm text-muted-foreground">
                  {counterEmpty}
                </p>
              </div>
            ) : counterparties.length === 0 ? null : isAdvertiser ? (
              <div className="flex flex-col gap-3">
                {counterparties.map((c) => {
                  const team = teamByAgency.get(c.id) ?? [];
                  const byId = new Map(team.map((t) => [t.id, t]));
                  const attendantIds = [...(attendantsByAgency.get(c.id) ?? [])].sort((a, b) =>
                    (byId.get(a)?.name ?? "—").localeCompare(byId.get(b)?.name ?? "—", "es"),
                  );
                  const managing = attendantsFor === c.id;
                  const originLabel = c.explicit ? (c.origin === "oi" ? "De OI + manual" : "Manual") : c.ios > 0 ? "De OI" : null;
                  return (
                    <section key={c.id} aria-label={`Agencia ${c.name}`} className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium">{toTitleCase(c.name)}</span>
                          {originLabel && <AttributeBadge title="Origen del vínculo">{originLabel}</AttributeBadge>}
                          <span className="text-xs text-muted-foreground">
                            {c.ios === 0 ? "Sin órdenes" : `${c.ios} ${c.ios === 1 ? "orden" : "órdenes"}`}
                          </span>
                        </div>
                        {canLink && (
                          <span className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setAttendantsFor(managing ? null : c.id)}
                              disabled={archiving || deleting}
                            >
                              {managing ? "Cerrar" : "Gestionar"}
                            </Button>
                            {c.explicit && c.origin === "manual" ? (
                              <RowIconButton
                                icon={X}
                                label={`Quitar vínculo con ${toTitleCase(c.name)}`}
                                title="Quitar vínculo manual (las órdenes se conservan)"
                                onClick={() => removeLink(c.id)}
                                disabled={deleting}
                                pending={deleting && deletingId === c.id}
                                danger
                              />
                            ) : null}
                          </span>
                        )}
                      </div>
                      {managing && canEdit && (
                        <AccountAttendantsForm
                          agencyCompanyId={c.id}
                          agencyName={c.name}
                          advertiserCompanyId={companyId}
                          team={team}
                          initialContactIds={attendantIds}
                          onSaved={() => {
                            setAttendantsFor(null);
                            router.refresh();
                            void load();
                          }}
                          onCancel={() => setAttendantsFor(null)}
                        />
                      )}
                      {attendantIds.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Sin ejecutivos asignados.</p>
                      ) : (
                        <DrawerTable flush>
                          <DrawerTableHeader flush>
                            <DrawerTableTh>Ejecutivo</DrawerTableTh>
                            <DrawerTableTh>Cargo</DrawerTableTh>
                            <DrawerTableTh>Email</DrawerTableTh>
                            <DrawerTableTh>Teléfono</DrawerTableTh>
                          </DrawerTableHeader>
                          <DrawerTableBody>
                            {attendantIds.map((id) => {
                              const t = byId.get(id);
                              return (
                                <DrawerTableRow key={id}>
                                  <DrawerTableTd className="font-medium">
                                    <span className="flex flex-wrap items-center gap-2">
                                      {toTitleCase(t?.name ?? "—")}
                                      {t?.isPrimary && <CompanyPrincipalBadge isPrimary />}
                                    </span>
                                  </DrawerTableTd>
                                  <DrawerTableTd className="text-xs">{t?.jobTitle ?? "—"}</DrawerTableTd>
                                  <DrawerTableTd className="text-xs">{t?.email ?? "—"}</DrawerTableTd>
                                  <DrawerTableTd className="text-xs tabular-nums">{t?.phone ?? "—"}</DrawerTableTd>
                                </DrawerTableRow>
                              );
                            })}
                          </DrawerTableBody>
                        </DrawerTable>
                      )}
                    </section>
                  );
                })}
              </div>
            ) : (
              <DrawerTable flush>
                <DrawerTableHeader flush>
                  <DrawerTableTh>Anunciante</DrawerTableTh>
                  <DrawerTableTh>Origen</DrawerTableTh>
                  <DrawerTableTh numeric>Órdenes</DrawerTableTh>
                  {canLink && <DrawerTableTh aria-label="Acciones" />}
                </DrawerTableHeader>
                <DrawerTableBody>
                  {counterparties.map((c) => (
                    <DrawerTableRow key={c.id}>
                      <DrawerTableTd className="font-medium">{toTitleCase(c.name)}</DrawerTableTd>
                      <DrawerTableTd className="text-xs text-muted-foreground">
                        {c.explicit ? (c.origin === "oi" ? "De OI + manual" : "Manual") : c.ios > 0 ? "De OI" : "—"}
                      </DrawerTableTd>
                      <DrawerTableTd numeric>{c.ios === 0 ? "—" : c.ios}</DrawerTableTd>
                      {canLink && (
                        <DrawerTableTd>
                          <span className="flex flex-wrap items-center gap-2">
                          {c.explicit && c.origin === "manual" ? (
                            <RowIconButton
                              icon={X}
                              label={`Quitar vínculo con ${toTitleCase(c.name)}`}
                              title="Quitar vínculo manual (las órdenes se conservan)"
                              onClick={() => removeLink(c.id)}
                              disabled={deleting}
                              pending={deleting && deletingId === c.id}
                              danger
                            />
                          ) : null}
                          </span>
                        </DrawerTableTd>
                      )}
                    </DrawerTableRow>
                  ))}
                </DrawerTableBody>
              </DrawerTable>
            )}
          </AppCard>
        </>
      )}
        </>
      )}
    </DrawerShell>
  );
}
