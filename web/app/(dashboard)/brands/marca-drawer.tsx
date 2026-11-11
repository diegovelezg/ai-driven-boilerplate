"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Bot, Building2, FileText, Globe, Megaphone } from "lucide-react";
import { AppCard, AppCardState } from "@/components/app-card";
import { RetryButton } from "@/components/buttons";
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
import { formatDate, formatMoney, formatNumber, toTitleCase } from "@/lib/format";
import type { BrandDetail } from "@/lib/brand-db";
import { BrandPautaBadge } from "@/components/badges";

// Carga diferida: chat y research solo se descargan al usarse (mismo
// patrón que orden-drawer: el drawer inicial no paga react-markdown).
function DrawerLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={label}>
      <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
    </div>
  );
}
const MarcaChat = dynamic(() => import("./marca-chat").then((m) => m.MarcaChat), {
  ssr: false,
  loading: () => <DrawerLoading label="Cargando chat" />,
});
const MarcaResearch = dynamic(() => import("./marca-research").then((m) => m.MarcaResearch), {
  ssr: false,
  loading: () => <DrawerLoading label="Cargando investigación" />,
});

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

  // Un solo loader abortable (reintento incluido): evita el doble fetch del
  // doble-montaje StrictMode (mismo patrón que orden-drawer).
  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const res = await fetch(`/api/brands/${encodeURIComponent(brandName)}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error("No se pudo cargar la marca.");
      if (signal?.aborted) return;
      setDetail((await res.json()) as MarcaDetail);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : "No se pudieron cargar los datos.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [brandName]);

  // Carga diferida: setState solo en callbacks async (patrón permitido por el lint).
  useEffect(() => {
    const ac = new AbortController();
    const h = setTimeout(() => {
      void load(ac.signal);
    }, 0);
    return () => {
      clearTimeout(h);
      ac.abort();
    };
  }, [load]);

  const reload = useCallback(() => {
    setLoading(true);
    setDetail(null);
    void load();
  }, [load]);

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
    { id: "pedidos", label: `Órdenes (${ios.length})`, icon: FileText },
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
            <BrandPautaBadge active={detail.active} />
            <span className="text-xs text-muted-foreground">
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
          <RetryButton onRetry={() => void reload()} />
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
          tone="sky"
          aria-label="Resumen de la marca"
        >
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">Pedidos</dt><dd className="mt-1 text-sm tabular-nums">{formatNumber(ios.length)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Inversión</dt><dd className="mt-1 text-sm tabular-nums">{formatMoney(detail.total_minor, "PEN")}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Pantallas</dt><dd className="mt-1 text-sm">{screens.length > 0 ? screens.join(" · ") : "—"}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Vigencia</dt><dd className="mt-1 text-sm tabular-nums">{[detail.first_start, detail.last_end].filter(Boolean).join(" → ") || "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Empresas</dt><dd className="mt-1 text-sm">{companies.length > 0 ? companies.map((c) => `${toTitleCase(c.name)} (${roleLabel(c.roles)})`).join(" · ") : "—"}</dd></div>
          </dl>
        </AppCard>
      )}

      {detail && tab === "perfil" && (
        <MarcaResearch brandName={detail.brand} canResearch={canEdit} />
      )}

      {detail && tab === "pedidos" && (
        <AppCard
          title={`Pedidos (${ios.length})`}
          description="Órdenes donde esta marca es la que se pauta."
          tone="primary"
          aria-label="Pedidos de la marca"
        >
          {ios.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
              <p className="text-sm text-muted-foreground">Sin pedidos para esta marca.</p>
            </div>
          ) : (
            <DrawerTable flush>
              <DrawerTableHeader flush>
                <DrawerTableTh>Orden</DrawerTableTh>
                <DrawerTableTh>Inicio</DrawerTableTh>
                <DrawerTableTh>Fin</DrawerTableTh>
                <DrawerTableTh>Estado</DrawerTableTh>
                <DrawerTableTh numeric>Inversión</DrawerTableTh>
              </DrawerTableHeader>
              <DrawerTableBody>
                {ios.map((o) => (
                  <DrawerTableRow key={o.id}>
                    <DrawerTableTd className="font-medium">{o.io_number}</DrawerTableTd>
                    <DrawerTableTd className="text-xs tabular-nums">{formatDate(o.starts_at)}</DrawerTableTd>
                    <DrawerTableTd className="text-xs tabular-nums">{formatDate(o.ends_at)}</DrawerTableTd>
                    <DrawerTableTd><CompanyIOBadge status={o.status} /></DrawerTableTd>
                    <DrawerTableTd numeric className="tabular-nums">{formatMoney(o.total_minor, "PEN")}</DrawerTableTd>
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
          description="Empresas que pautaron con esta marca y su rol en cada pedido."
          tone="emerald"
          aria-label="Empresas de la marca"
        >
          {companies.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
              <p className="text-sm text-muted-foreground">Sin empresas vinculadas.</p>
            </div>
          ) : (
            <DrawerTable flush>
              <DrawerTableHeader flush>
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
