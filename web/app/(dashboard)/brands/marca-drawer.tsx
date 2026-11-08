"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Building2, FileText, Globe, Megaphone } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { Button } from "@/components/ui/button";
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
import { CompanyIOBadge } from "@/components/company-badges";
import { hasMinRole, isMemberRole, type MemberRole } from "@/lib/roles";
import { formatMoney, formatNumber, toTitleCase } from "@/lib/format";
import type { BrandDetail } from "@/lib/brand-db";
import { MarcaChat } from "./marca-chat";
import { MarcaResearch } from "./marca-research";

interface MarcaDetail extends BrandDetail {
  myRole?: MemberRole | null;
}

type TabId = "ficha" | "perfil" | "pedidos" | "empresas" | "agentes";

function roleLabel(roles: Array<"anunciante" | "facturación">): string {
  const parts = [];
  if (roles.includes("anunciante")) parts.push("Anunciante");
  if (roles.includes("facturación")) parts.push("Facturación");
  return parts.join(" · ") || "—";
}

/** Drawer de una marca: mismo patrón que EmpresaDrawer (ficha + perfil + pedidos + agentes). */
export function MarcaDrawer({
  brandName,
  onClose,
}: {
  brandName: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("ficha");
  const [detail, setDetail] = useState<MarcaDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/brands/${encodeURIComponent(brandName)}`, { cache: "no-store" });
        if (!res.ok) throw new Error("No se pudo cargar la marca.");
        if (!alive) return;
        setDetail((await res.json()) as MarcaDetail);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "DB read failed");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [brandName]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/brands/${encodeURIComponent(brandName)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("No se pudo cargar la marca.");
      setDetail((await res.json()) as MarcaDetail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "DB read failed");
    } finally {
      setLoading(false);
    }
  }, [brandName]);

  const ios = detail?.ios ?? [];
  const companies = detail?.companies ?? [];
  const screens = detail?.screens ?? [];
  const rawRole = detail?.myRole ?? null;
  const myRole: MemberRole | null = isMemberRole(rawRole) ? rawRole : null;
  // Sin auth (dev: myRole null) se permite investigar; viewer = solo lectura.
  const canEdit = myRole === null || hasMinRole(myRole, "seller");

  const tabs: DrawerTabDef[] = [
    { id: "ficha", label: "Ficha", icon: Megaphone },
    { id: "perfil", label: "Perfil", icon: Globe },
    { id: "pedidos", label: `Pedidos (${ios.length})`, icon: FileText },
    { id: "empresas", label: `Empresas (${companies.length})`, icon: Building2 },
    { id: "agentes", label: "Agentes", icon: Bot },
  ];

  return (
    <DrawerShell
      onClose={onClose}
      size="wide"
      avatar={<Megaphone className="size-5" aria-hidden />}
      title={detail ? toTitleCase(detail.brand) : "Marca"}
      description={
        detail
          ? `${formatNumber(ios.length)} pedido${ios.length === 1 ? "" : "s"} · ${formatMoney(detail.total_minor, "PEN")}`
          : "Cargando…"
      }
      badges={
        detail && (
          <span className="flex flex-wrap items-center gap-1.5" aria-label={`${detail.brand}, ${ios.length} pedidos`}>
            <span
              className={
                detail.active
                  ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                  : "rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
              }
            >
              {detail.active ? "En pauta" : "Sin pauta"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {companies.length} empresa{companies.length === 1 ? "" : "s"} · {screens.length} pantalla{screens.length === 1 ? "" : "s"}
            </span>
          </span>
        )
      }
      tabs={tabs}
      tab={tab}
      onTabChange={(id) => setTab(id as TabId)}
      tabListLabel="Detalle de marca"
      fill={tab === "agentes"}
    >
      {tab === "agentes" ? (
        <MarcaChat brandName={detail ? detail.brand : brandName} />
      ) : (
        <>
      {error && (
        <div className="flex flex-col gap-3">
          <AppCardState>{error}</AppCardState>
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void reload()}>
            Reintentar
          </Button>
        </div>
      )}
      {!error && !detail && loading && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando marca">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
        </div>
      )}

      {detail && tab === "ficha" && (
        <AppCard
          title="Resumen"
          description="Recurrencia de la marca: pauta, inversión, pantallas y vigencia."
          aria-label="Resumen de la marca"
        >
          <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">Pedidos</dt><dd className="mt-0.5 text-[13px] tabular-nums">{formatNumber(ios.length)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Inversión</dt><dd className="mt-0.5 text-[13px] tabular-nums">{formatMoney(detail.total_minor, "PEN")}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Pantallas</dt><dd className="mt-0.5 text-[13px]">{screens.length > 0 ? screens.join(" · ") : "—"}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Vigencia</dt><dd className="mt-0.5 text-[13px] tabular-nums">{[detail.first_start, detail.last_end].filter(Boolean).join(" → ") || "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Empresas</dt><dd className="mt-0.5 text-[13px]">{companies.length > 0 ? companies.map((c) => `${toTitleCase(c.name)} (${roleLabel(c.roles)})`).join(" · ") : "—"}</dd></div>
          </dl>
        </AppCard>
      )}

      {detail && tab === "perfil" && (
        <MarcaResearch key={detail.brand} brandName={detail.brand} canResearch={canEdit} />
      )}

      {detail && tab === "pedidos" && (
        <AppCard
          title={`Pedidos (${ios.length})`}
          description="IOs donde esta es la marca publicitada."
          aria-label="Pedidos de la marca"
        >
          {ios.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3">
              <p className="text-[13px] text-muted-foreground">Sin pedidos para esta marca.</p>
            </div>
          ) : (
            <DrawerTable>
              <DrawerTableHeader>
                <DrawerTableTh>IO</DrawerTableTh>
                <DrawerTableTh>Inicio</DrawerTableTh>
                <DrawerTableTh>Fin</DrawerTableTh>
                <DrawerTableTh>Estado</DrawerTableTh>
                <DrawerTableTh>Inversión</DrawerTableTh>
              </DrawerTableHeader>
              <DrawerTableBody>
                {ios.map((o) => (
                  <DrawerTableRow key={o.id}>
                    <DrawerTableTd className="font-medium">{o.io_number}</DrawerTableTd>
                    <DrawerTableTd className="text-xs tabular-nums">{o.starts_at ?? "—"}</DrawerTableTd>
                    <DrawerTableTd className="text-xs tabular-nums">{o.ends_at ?? "—"}</DrawerTableTd>
                    <DrawerTableTd><CompanyIOBadge status={o.status} /></DrawerTableTd>
                    <DrawerTableTd className="text-xs tabular-nums">{formatMoney(o.total_minor, "PEN")}</DrawerTableTd>
                  </DrawerTableRow>
                ))}
              </DrawerTableBody>
            </DrawerTable>
          )}
        </AppCard>
      )}

      {detail && tab === "empresas" && (
        <AppCard
          title={`Empresas (${companies.length})`}
          description="Vinculadas por los pedidos de la marca (una fila por empresa, con sus roles)."
          aria-label="Empresas de la marca"
        >
          {companies.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3">
              <p className="text-[13px] text-muted-foreground">Sin empresas vinculadas.</p>
            </div>
          ) : (
            <DrawerTable>
              <DrawerTableHeader>
                <DrawerTableTh>Empresa</DrawerTableTh>
                <DrawerTableTh>Rol</DrawerTableTh>
              </DrawerTableHeader>
              <DrawerTableBody>
                {companies.map((c) => (
                  <DrawerTableRow key={c.id}>
                    <DrawerTableTd className="font-medium">{toTitleCase(c.name)}</DrawerTableTd>
                    <DrawerTableTd className="text-xs">{roleLabel(c.roles)}</DrawerTableTd>
                  </DrawerTableRow>
                ))}
              </DrawerTableBody>
            </DrawerTable>
          )}
        </AppCard>
      )}
        </>
      )}
    </DrawerShell>
  );
}
