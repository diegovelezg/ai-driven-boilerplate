"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Building2, Archive, ArchiveRestore, Bot, FileText, Globe, Pencil, Plus, RotateCcw, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArchivedBadge } from "@/components/badges";
import { toast } from "@/components/ui/toast";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ComboboxField } from "@/components/combobox-field";
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
import { createContactAction, setCompanyArchivedAction, setContactArchivedAction, type CrmState } from "@/lib/crm-actions";
import { EMAIL_RE } from "@/lib/validation";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";
import { kindLabel } from "@/lib/crm";
import { CompanyCampaignBadge, CompanyIOBadge, CompanyKindBadge, CompanyPrincipalBadge } from "@/components/company-badges";
import { hasMinRole, isMemberRole, type MemberRole } from "@/lib/roles";
import { RestrictedVisibilityBadge } from "@/components/role-badges";
import { normalizeCommissionPct } from "@/lib/agency-commission";
import { toTitleCase } from "@/lib/format";
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

interface EmpresaDetail {
  company: Record<string, unknown>;
  contacts: DrawerContact[];
  campaigns: DrawerCampaign[];
  ios: DrawerIO[];
  myRole?: MemberRole | null;
}

type TabId = "ficha" | "perfil" | "contactos" | "pedidos" | "agentes";

function contactName(c: DrawerContact): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

function NewContactForm({ companyId, siblingJobTitles, onSaved }: { companyId: string; siblingJobTitles: string[]; onSaved: () => void }) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const { invalid, mark, clear, bad } = useInvalidFields<"email" | "phone">();
  const [jobTitle, setJobTitle] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [globalTitles, setGlobalTitles] = useState<string[]>([]);
  // Cargos globales ya usados: evita repetir el mismo cargo con otra escritura.
  // setState solo en el callback async del fetch (patrón permitido por el lint).
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    const h = setTimeout(() => {
      fetch("/api/contacts/job-titles", { cache: "no-store", signal: ac.signal })
        .then(async (res) => (res.ok ? ((await res.json()) as { job_titles?: string[] }) : null))
        .then((j) => {
          if (!alive || !j || !Array.isArray(j.job_titles)) return;
          setGlobalTitles(j.job_titles.filter((t): t is string => typeof t === "string" && t.trim() !== ""));
        })
        .catch(() => {});
    }, 0);
    return () => {
      alive = false;
      clearTimeout(h);
      ac.abort();
    };
  }, []);
  const jobTitles = useMemo(() => {
    const merged: string[] = [];
    for (const t of [...siblingJobTitles, ...globalTitles]) {
      const v = t.trim();
      if (v && !merged.some((m) => m.toLowerCase() === v.toLowerCase())) merged.push(v);
    }
    return merged.sort((a, b) => a.localeCompare(b, "es"));
  }, [siblingJobTitles, globalTitles]);

  async function submit(form: FormData) {
    const em = String(form.get("email") ?? "").trim();
    const ph = String(form.get("phone") ?? "").trim();
    if (!em && !ph) {
      mark(["email", "phone"]);
      toastFormError("Revisa los campos marcados", "Email o teléfono requerido.");
      return;
    }
    if (em && !EMAIL_RE.test(em)) {
      mark(["email"]);
      toastFormError("Revisa el campo marcado", "Email inválido.");
      return;
    }
    startTransition(async () => {
      const res: CrmState = await createContactAction(form);
      if (!res.ok) {
        const keys: Array<"email" | "phone"> = /teléfono|telefono/i.test(res.message) && /email/i.test(res.message)
          ? ["email", "phone"]
          : /email/i.test(res.message)
            ? ["email"]
            : /teléfono|telefono/i.test(res.message)
              ? ["phone"]
              : [];
        mark(keys);
        toastFormError("No se pudo agregar el contacto", res.message);
        return;
      }
      onSaved();
    });
  }

  const ready = email.trim() !== "" || phone.trim() !== "";

  return (
    <form action={submit} noValidate className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="company_id" value={companyId} />
      <label className="flex flex-col gap-1 text-xs">
        Nombre
        <input name="first_name" maxLength={120} className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Apellido
        <input name="last_name" maxLength={120} className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Email
        <input name="email" maxLength={320} value={email} onChange={(e) => { setEmail(e.target.value); clear("email"); }} aria-invalid={invalid.has("email")} className={`h-8 rounded-lg border border-border bg-background px-2.5 text-sm${bad("email")}`} />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Teléfono
        <input name="phone" maxLength={40} value={phone} onChange={(e) => { setPhone(e.target.value); clear("phone"); }} aria-invalid={invalid.has("phone")} className={`h-8 rounded-lg border border-border bg-background px-2.5 text-sm${bad("phone")}`} />
      </label>
      <div className="flex min-w-36 flex-col gap-1 text-xs">
        Cargo
        <input type="hidden" name="job_title" value={jobTitle} />
        <ComboboxField
          items={jobTitles}
          value={jobTitle}
          onChange={setJobTitle}
          placeholder="Compras, Gerencia…"
          emptyText={jobTitle.trim() ? "Enter para usar este cargo." : "Sin cargos registrados."}
          customLabel={(q) => <>Usar “{q}”</>}
          ariaLabel="Cargo"
          disabled={pending}
        />
      </div>
      <div className="flex h-8 items-center gap-2">
        <input type="hidden" name="is_primary" value={isPrimary ? "on" : ""} />
        <Checkbox
          id="new-contact-is-primary"
          checked={isPrimary}
          onCheckedChange={(v) => setIsPrimary(v === true)}
          disabled={pending}
          aria-label="Contacto principal"
        />
        <Label htmlFor="new-contact-is-primary" className="text-xs font-normal">
          Principal
        </Label>
      </div>
      <Button type="submit" disabled={pending || !ready} title={!ready ? "Agrega email o teléfono" : undefined}>
        <Plus aria-hidden />
        {pending ? "Agregando…" : "Agregar"}
      </Button>
    </form>
  );
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
  const siblingJobTitles = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of contacts) {
      const raw = (c.job_title ?? "").trim();
      if (raw && !seen.has(raw.toLowerCase())) seen.set(raw.toLowerCase(), raw);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, "es"));
  }, [contacts]);
  const ios = detail?.ios ?? [];
  const campaigns = detail?.campaigns ?? [];
  const company = detail?.company;
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

  const tabs: DrawerTabDef[] = [
    { id: "ficha", label: "Ficha", icon: Building2 },
    { id: "perfil", label: "Perfil", icon: Globe },
    { id: "contactos", label: `Contactos (${contacts.length})`, icon: UserRound },
    { id: "pedidos", label: `Órdenes (${ios.length})`, icon: FileText },
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
          ? [typeof company.domain === "string" && company.domain ? company.domain : null, typeof company.tax_id === "string" && company.tax_id ? `ID fiscal ${company.tax_id}` : null].filter(Boolean).join(" · ") || "—"
          : "Cargando…"
      }
      badges={
        detail && (
          <span className="flex flex-wrap items-center gap-1.5" aria-label={`Empresa ${kindLabel(kind)}, ${contacts.length} contactos, ${ios.length} pedidos`}>
            <CompanyKindBadge kind={kind} />
            {isArchived && <ArchivedBadge fem />}
            <span className="text-[11px] text-muted-foreground">
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
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void load()}>
            <RotateCcw aria-hidden />
            Reintentar
          </Button>
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
            description="Nombre, identificación y datos de contacto."
            aria-label="Datos de la empresa"
            action={
              <span className="flex flex-wrap items-center gap-2">
                {canAdmin && !editingDatos && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      runArchive(isArchived ? "Empresa restaurada" : "Empresa archivada", () =>
                        setCompanyArchivedAction({ companyId, archived: !isArchived }),
                      )
                    }
                    disabled={archiving}
                    aria-label={isArchived ? "Restaurar empresa" : "Archivar empresa"}
                    title={isArchived ? "Restaurar empresa" : "Archivar empresa (las órdenes conservan sus datos)"}
                  >
                    {isArchived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
                    {isArchived ? "Restaurar" : "Archivar"}
                  </Button>
                )}
                {canEdit && !editingDatos && !isArchived && (
                  <Button variant="outline" size="sm" onClick={() => setEditingDatos(true)}>
                    <Pencil aria-hidden />
                    Editar
                  </Button>
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
            <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">ID fiscal</dt><dd className="mt-0.5 text-[13px]">{typeof company?.tax_id === "string" && company.tax_id ? company.tax_id : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Web</dt><dd className="mt-0.5 text-[13px]">{typeof company?.domain === "string" && company.domain ? company.domain : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Teléfono</dt><dd className="mt-0.5 text-[13px] tabular-nums">{typeof company?.phone === "string" && company.phone ? company.phone : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Dirección</dt><dd className="mt-0.5 text-[13px]">{typeof company?.address === "string" && company.address ? company.address : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Ciudad / País</dt><dd className="mt-0.5 text-[13px]">{[company?.city, company?.country].filter((v) => typeof v === "string" && v).join(" · ") || "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Creada</dt><dd className="mt-0.5 text-[13px] tabular-nums">{typeof company?.created_by === "string" && company.created_by ? company.created_by : "—"}</dd></div>
              {typeof company?.updated_by === "string" && company.updated_by && company.updated_by !== company.created_by && (
                <div><dt className="text-xs text-muted-foreground">Editada por</dt><dd className="mt-0.5 text-[13px]">{String(company.updated_by)}</dd></div>
              )}
            </dl>
            )}
          </AppCard>
          <AppCard
            title="Tipo"
            aria-label="Tipo de empresa"
          >
            {canEdit ? (
              <KindForm key={companyId} companyId={companyId} initial={typeof company?.kind === "string" ? company.kind : null} onSaved={() => { router.refresh(); void load(); }} />
            ) : (
              <p className="text-[13px] font-medium">{kindLabel(typeof company?.kind === "string" ? company.kind : null)}</p>
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
              aria-label="Comisión de agencia (restringida)"
            >
              <p className="text-[13px] text-muted-foreground">
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
          description="Varios contactos por empresa. Solo uno puede ser principal."
          aria-label="Contactos de la empresa"
        >
          {contacts.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
              <p className="text-[13px] text-muted-foreground">Sin contactos. Agrega el primero abajo.</p>
            </div>
          ) : (
            <DrawerTable>
              <DrawerTableHeader>
                <DrawerTableTh>Nombre</DrawerTableTh>
                <DrawerTableTh>Email</DrawerTableTh>
                <DrawerTableTh>Teléfono</DrawerTableTh>
                <DrawerTableTh>Cargo</DrawerTableTh>
                <DrawerTableTh>Principal</DrawerTableTh>
                <DrawerTableTh>Agregado por</DrawerTableTh>
                {canEdit && <DrawerTableTh>Acciones</DrawerTableTh>}
              </DrawerTableHeader>
              <DrawerTableBody>
                {contacts.map((c) => {
                  const archived = typeof c.deleted_at === "string" && !!c.deleted_at;
                  return (
                  <DrawerTableRow key={c.id}>
                    <DrawerTableTd className="font-medium">
                      {contactName(c)}
                      {archived && <ArchivedBadge className="ml-2" />}
                    </DrawerTableTd>
                    <DrawerTableTd className="text-xs">{c.email ?? c.phone ?? "—"}</DrawerTableTd>
                    <DrawerTableTd className="text-xs tabular-nums">{c.phone ?? "—"}</DrawerTableTd>
                    <DrawerTableTd className="text-xs">{c.job_title ?? "—"}</DrawerTableTd>
                    <DrawerTableTd><CompanyPrincipalBadge isPrimary={c.is_primary} /></DrawerTableTd>
                    <DrawerTableTd className="text-xs text-muted-foreground" title={typeof c.created_by === "string" && c.created_by ? `Agregado por ${c.created_by}` : undefined}>{typeof c.created_by === "string" && c.created_by ? c.created_by : "—"}</DrawerTableTd>
                    {canEdit && (
                      <DrawerTableTd>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            runArchive(archived ? "Contacto restaurado" : "Contacto archivado", () =>
                              setContactArchivedAction({ contactId: c.id, archived: !archived }),
                            )
                          }
                          disabled={archiving}
                          aria-label={archived ? `Restaurar contacto ${contactName(c)}` : `Archivar contacto ${contactName(c)}`}
                          title={archived ? "Restaurar contacto" : "Archivar contacto (las órdenes conservan sus datos)"}
                        >
                          {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
                          {archived ? "Restaurar" : "Archivar"}
                        </Button>
                      </DrawerTableTd>
                    )}
                  </DrawerTableRow>
                  );
                })}
              </DrawerTableBody>
            </DrawerTable>
          )}
          {canEdit && (
            <>
              <Separator className="mt-1" />
              <div className="mt-1">
                <NewContactForm companyId={companyId} siblingJobTitles={siblingJobTitles} onSaved={() => { router.refresh(); void load(); }} />
              </div>
            </>
          )}
        </AppCard>
      )}

      {detail && tab === "pedidos" && (
        <>
          <AppCard
            title={`Pedidos (${ios.length})`}
            description="Órdenes donde aparece como anunciante o responsable de facturación."
            aria-label="Pedidos de la empresa"
          >
            {ios.length === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-[13px] text-muted-foreground">Sin pedidos: aún no es cliente.</p>
              </div>
            ) : (
              <DrawerTable>
                <DrawerTableHeader>
                  <DrawerTableTh>Orden</DrawerTableTh>
                  <DrawerTableTh>Marca</DrawerTableTh>
                  <DrawerTableTh>Estado</DrawerTableTh>
                </DrawerTableHeader>
                <DrawerTableBody>
                  {ios.map((o) => (
                    <DrawerTableRow key={o.id}>
                      <DrawerTableTd className="font-medium">{o.io_number}</DrawerTableTd>
                      <DrawerTableTd className="text-[13px]">{toTitleCase(o.brand ?? "—")}</DrawerTableTd>
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
            aria-label="Campañas de la empresa"
          >
            {campaigns.length === 0 ? (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="text-[13px] text-muted-foreground">Sin campañas.</p>
              </div>
            ) : (
              <DrawerTable>
                <DrawerTableHeader>
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
        </>
      )}
    </DrawerShell>
  );
}
