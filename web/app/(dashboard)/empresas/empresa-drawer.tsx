"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Building2, Bot, FileText, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCardState } from "@/components/app-card";
import { SectionHeading } from "@/components/section-heading";
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
import { createContactAction, type CrmState } from "@/lib/crm-actions";
import { kindLabel } from "@/lib/crm";
import { hasMinRole, isMemberRole, type MemberRole } from "@/lib/roles";
import { normalizeCommissionPct } from "@/lib/agency-commission";
import { toTitleCase } from "@/lib/format";
import { KindForm } from "./kind-form";
import { AgencyCommissionForm } from "./agency-commission-form";
import { EmpresaChat } from "./empresa-chat";

interface DrawerContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  is_primary: boolean;
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

type TabId = "ficha" | "contactos" | "pedidos" | "agentes";

function contactName(c: DrawerContact): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

function NewContactForm({ companyId, onSaved }: { companyId: string; onSaved: () => void }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(form: FormData) {
    setMsg(null);
    startTransition(async () => {
      const res: CrmState = await createContactAction(form);
      setMsg(res.message);
      if (res.ok) onSaved();
    });
  }

  return (
    <form action={submit} className="flex flex-wrap items-end gap-3">
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
        <input name="email" maxLength={320} className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Teléfono
        <input name="phone" maxLength={40} className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Cargo
        <input name="job_title" maxLength={120} placeholder="Compras, Gerencia…" className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm" />
      </label>
      <label className="flex items-center gap-1.5 text-xs">
        <input type="checkbox" name="is_primary" /> Principal
      </label>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Agregando…" : "Agregar"}</Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
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

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/empresas/${companyId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("No se pudo cargar la empresa.");
      setDetail((await res.json()) as EmpresaDetail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "DB read failed");
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const contacts = detail?.contacts ?? [];
  const ios = detail?.ios ?? [];
  const campaigns = detail?.campaigns ?? [];
  const company = detail?.company;
  const kind = (company?.kind as string | null) ?? null;
  const rawRole = detail?.myRole ?? null;
  const myRole: MemberRole | null = isMemberRole(rawRole) ? rawRole : null;
  // Sin auth (dev: myRole null) se permite ver/gestionar; con sesión solo owner/admin.
  const canViewCommission = myRole === null || hasMinRole(myRole, "admin");
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
    { id: "contactos", label: `Contactos (${contacts.length})`, icon: UserRound },
    { id: "pedidos", label: `Pedidos (${ios.length})`, icon: FileText },
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
          ? [typeof company.domain === "string" && company.domain ? company.domain : null, typeof company.tax_id === "string" && company.tax_id ? `RUT ${company.tax_id}` : null].filter(Boolean).join(" · ") || "—"
          : "Cargando…"
      }
      badges={
        detail && (
          <>
            <Badge variant="secondary" className="font-normal">{kindLabel(kind)}</Badge>
            <span className="text-[11px] text-muted-foreground">
              {contacts.length} contacto{contacts.length === 1 ? "" : "s"} · {ios.length} pedido{ios.length === 1 ? "" : "s"}
            </span>
          </>
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
      {error && <AppCardState>{error}</AppCardState>}
      {!error && !detail && <AppCardState>Cargando ficha…</AppCardState>}

      {detail && tab === "ficha" && (
        <>
          <section className="flex flex-col gap-2">
            <SectionHeading title="Datos" />
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">RUT / tax_id</dt><dd>{typeof company?.tax_id === "string" && company.tax_id ? company.tax_id : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Dominio</dt><dd className="text-xs">{typeof company?.domain === "string" && company.domain ? company.domain : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="text-xs">{typeof company?.email === "string" && company.email ? company.email : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Teléfono</dt><dd className="text-xs">{typeof company?.phone === "string" && company.phone ? company.phone : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Ciudad / País</dt><dd className="text-xs">{[company?.city, company?.country].filter((v) => typeof v === "string" && v).join(" · ") || "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Dirección</dt><dd className="text-xs">{typeof company?.address === "string" && company.address ? company.address : "—"}</dd></div>
            </dl>
          </section>
          <section className="flex flex-col gap-2">
            <SectionHeading title="Tipo" hint="Naturaleza de la contraparte." />
            <KindForm companyId={companyId} initial={typeof company?.kind === "string" ? company.kind : null} onSaved={() => void load()} />
          </section>
          {isAgency && canViewCommission && (
            <section className="flex flex-col gap-2">
              <SectionHeading title="Comisión agencia" hint="Acuerdo por defecto (% sobre bruto). Solo owner/admin." />
              <AgencyCommissionForm companyId={companyId} initial={commissionInitial} onSaved={() => void load()} />
            </section>
          )}
        </>
      )}

      {detail && tab === "contactos" && (
        <section className="flex flex-col gap-4">
          <SectionHeading title={`Contactos (${contacts.length})`} hint="N contactos por empresa. Solo uno puede ser principal." />
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin contactos. Agrega el primero abajo.</p>
          ) : (
            <DrawerTable>
              <DrawerTableHeader>
                <DrawerTableTh>Nombre</DrawerTableTh>
                <DrawerTableTh>Email</DrawerTableTh>
                <DrawerTableTh>Teléfono</DrawerTableTh>
                <DrawerTableTh>Cargo</DrawerTableTh>
                <DrawerTableTh>Principal</DrawerTableTh>
              </DrawerTableHeader>
              <DrawerTableBody>
                {contacts.map((c) => (
                  <DrawerTableRow key={c.id}>
                    <DrawerTableTd className="font-medium">{contactName(c)}</DrawerTableTd>
                    <DrawerTableTd className="text-xs">{c.email ?? c.phone ?? "—"}</DrawerTableTd>
                    <DrawerTableTd className="text-xs">{c.phone ?? "—"}</DrawerTableTd>
                    <DrawerTableTd className="text-xs">{c.job_title ?? "—"}</DrawerTableTd>
                    <DrawerTableTd className="text-xs">{c.is_primary ? "Sí" : "—"}</DrawerTableTd>
                  </DrawerTableRow>
                ))}
              </DrawerTableBody>
            </DrawerTable>
          )}
          <NewContactForm companyId={companyId} onSaved={() => void load()} />
        </section>
      )}

      {detail && tab === "pedidos" && (
        <>
          <section className="flex flex-col gap-2">
            <SectionHeading title={`Pedidos (${ios.length})`} hint="IOs donde es anunciante o facturación. La marca va en el pedido." />
            {ios.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin pedidos: aún no es cliente.</p>
            ) : (
              <DrawerTable>
                <DrawerTableHeader>
                  <DrawerTableTh>IO</DrawerTableTh>
                  <DrawerTableTh>Marca</DrawerTableTh>
                  <DrawerTableTh>Estado</DrawerTableTh>
                </DrawerTableHeader>
                <DrawerTableBody>
                  {ios.map((o) => (
                    <DrawerTableRow key={o.id}>
                      <DrawerTableTd className="font-medium">{o.io_number}</DrawerTableTd>
                      <DrawerTableTd>{toTitleCase(o.brand ?? "—")}</DrawerTableTd>
                      <DrawerTableTd className="text-xs">{o.status}</DrawerTableTd>
                    </DrawerTableRow>
                  ))}
                </DrawerTableBody>
              </DrawerTable>
            )}
          </section>
          <section className="flex flex-col gap-2">
            <SectionHeading title={`Campañas (${campaigns.length})`} hint="Donde la empresa es anunciante." />
            {campaigns.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin campañas.</p>
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
                      <DrawerTableTd className="text-xs">{m.status}</DrawerTableTd>
                    </DrawerTableRow>
                  ))}
                </DrawerTableBody>
              </DrawerTable>
            )}
          </section>
        </>
      )}
        </>
      )}
    </DrawerShell>
  );
}
