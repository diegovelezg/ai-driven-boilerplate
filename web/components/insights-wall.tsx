"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  Camera,
  ClipboardCheck,
  FileText,
  FilterX,
  Gauge,
  Inbox,
  LayoutGrid,
  Loader2,
  Package,
  RefreshCw,
  Repeat,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { FilterSearch } from "@/components/filter-search";
import { FilterSelect, SelectItem } from "@/components/filter-select";
import { EntityCount, EntityEmpty } from "@/components/entity-list";
import { toast } from "@/components/ui/toast";
import { formatTimeAgo } from "@/lib/format";
import { matchScore, normalizeSearch, tokenizeSearch } from "@/lib/search-text";
import { dismissInsightAction, restoreInsightAction } from "@/lib/insights-actions";
import { audienceMentions, buildDrawerHref, contextItems, insightCta, insightHaystack } from "@/lib/insight-mentions";
import type { WallInsight } from "@/lib/insights";

/** Icono + tinte por kind (mismo lenguaje que las alertas de Hoy). */
const KIND_META: Record<string, { label: string; icon: LucideIcon; tint: string }> = {
  sin_om: { label: "Sin OM", icon: FileText, tint: "bg-rose-500/10 text-rose-600 dark:text-rose-400" },
  material: { label: "Material", icon: Package, tint: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  sin_evidencia: { label: "Sin evidencia", icon: Camera, tint: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  por_certificar: { label: "Por certificar", icon: ClipboardCheck, tint: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  termina_sin_relevo: { label: "Sin relevo", icon: RefreshCw, tint: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  renovacion: { label: "Relevo", icon: Repeat, tint: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  ocupacion: { label: "Ocupación", icon: Gauge, tint: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  huecos: { label: "Huecos", icon: LayoutGrid, tint: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
};

function metaOf(kind: string): { label: string; icon: LucideIcon; tint: string } {
  return (
    KIND_META[kind] ?? {
      label: kind.replace(/_/g, " "),
      icon: Inbox,
      tint: "bg-muted text-muted-foreground",
    }
  );
}

type Vista = "todas" | "mias" | "descartadas";

const VISTA_LABEL: Record<Vista, string> = {
  todas: "Todas",
  mias: "Mías",
  descartadas: "Descartadas",
};

/** Un aviso = una card independiente. Leer (o descartar) es el cierre. */
function InsightCard({ insight }: { insight: WallInsight }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "dismiss" | "restore">(null);
  const meta = metaOf(insight.kind);
  const Icon = meta.icon;
  // Taggeo visible (issue #11): a quién va dirigido, nunca implícito.
  const mentions = audienceMentions(insight.audience);
  // Contexto humano exacto: items estructurados (cliente… o métricas de
  // urgencia por kind global). Mismo panel, distintas métricas.
  const items = contextItems(insight.context);
  // CTA primario con deep-link a drawer (?order= abre OrdenDrawer en
  //  /orders; globales van a lista filtrada). Nunca "Abrir" genérico.
  const cta = insightCta({ kind: insight.kind, scopeKind: insight.scopeKind, scopeId: insight.scopeId, links: insight.links });
  // Drawer = misma página (el DrawerHost del layout monta la ficha encima;
  // al cerrar sigues en el inbox). Page = navegación real a la vista.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const href =
    cta.target === "drawer" && cta.param && cta.id
      ? buildDrawerHref(pathname, searchParams.toString(), cta.param, cta.id)
      : cta.href;
  const extraLinks = (insight.links ?? []).filter((l) => l !== cta.href).slice(0, 1);

  async function dismiss() {
    setBusy("dismiss");
    try {
      const r = await dismissInsightAction(insight.id);
      if (!r.ok) {
        toast.add({ title: "No se pudo descartar", description: r.message, type: "error" });
        return;
      }
      window.dispatchEvent(new CustomEvent("inbox:update"));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy("restore");
    try {
      const r = await restoreInsightAction(insight.id);
      if (!r.ok) {
        toast.add({ title: "No se pudo restaurar", description: r.message, type: "error" });
        return;
      }
      window.dispatchEvent(new CustomEvent("inbox:update"));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppCard className="w-full" contentClassName="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", meta.tint)} aria-hidden>
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {meta.label} · <span className="tabular-nums normal-case">{formatTimeAgo(insight.createdAt)}</span>
          </p>
          <p className="mt-0.5 text-[15px] leading-snug font-semibold tracking-tight">{insight.title}</p>
        </div>
        {insight.dismissed ? (
          <AppTooltip tip="Volver a mostrar este aviso">
            <span className="inline-flex shrink-0">
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={restore}
              >
                {busy === "restore" ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Restaurar
              </Button>
            </span>
          </AppTooltip>
        ) : (
          <AppTooltip tip="Descartar (solo para ti)">
            <span className="inline-flex shrink-0">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Descartar aviso (solo para ti)"
                disabled={busy !== null}
                onClick={dismiss}
                className="text-muted-foreground hover:text-foreground"
              >
                {busy === "dismiss" ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />}
              </Button>
            </span>
          </AppTooltip>
        )}
      </div>

      {items && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 sm:grid-cols-4">
          {items.map((it) => (
            <div key={it.label} className="min-w-0">
              <dt className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{it.label}</dt>
              <dd className="truncate text-sm font-normal text-foreground tabular-nums" title={it.value}>
                {it.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <p className="text-sm leading-relaxed text-foreground/90">{insight.body}</p>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          render={<Link href={href} aria-label={`${cta.label}: ${insight.title}`} />}
          nativeButton={false}
        >
          {cta.label}
          <ArrowUpRight className="size-3" aria-hidden />
        </Button>
        {extraLinks.map((l) => (
          <Link
            key={l}
            href={l}
            className="inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground hover:underline hover:underline-offset-4"
          >
            Ver lista
          </Link>
        ))}
        <span className="ms-auto" />
        {mentions.length > 0 ? (
          <AppTooltip tip={mentions.join("  ")}>
            <span
              className={cn(
                "inline-flex max-w-full items-center gap-1 truncate text-xs tabular-nums",
                insight.mine ? "font-medium text-primary" : "text-muted-foreground",
              )}
              aria-label={`Dirigido a ${mentions.join(", ")}${insight.mine ? " (te incluye)" : ""}`}
            >
              <span className="truncate">{mentions.join("  ")}</span>
              {insight.mine && <span className="shrink-0">(tú)</span>}
            </span>
          </AppTooltip>
        ) : (
          insight.mine && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
              Para ti
            </span>
          )
        )}
        {insight.dismissed && (
          <span className="text-xs text-muted-foreground">Descartada por ti.</span>
        )}
      </div>
    </AppCard>
  );
}

/** Inbox de insights (issue #11): feed de lectura, no red social.
//  Filtros en bloque propio (como todas las vistas); cada aviso es una card
//  independiente con abrir + descartar/restaurar. Sin likes ni comentarios:
//  leer (o descartar) es el cierre; si el hecho persiste, el inbox lo regenera. */
export function InsightsWall({ initial }: { initial: WallInsight[] }) {
  const [q, setQ] = useState("");
  const [vista, setVista] = useState<Vista>("todas");

  const live = useMemo(() => {
    // Fuzzy como screens/órdenes/marcas: normalización ES + AND de tokens
    // + ranking. El haystack cruza título, cuerpo, kind, empresa/marca,
    // métricas y menciones (mismo recall que `screenHaystack`).
    const tokens = tokenizeSearch(q);
    const qNorm = normalizeSearch(q);
    const scored = initial
      .filter((i) => {
        if (vista === "mias" && !i.mine) return false;
        if (vista === "descartadas" && !i.dismissed) return false;
        if (vista !== "descartadas" && i.dismissed) return false;
        return true;
      })
      .map((i) => ({ i, score: tokens.length === 0 ? 0 : matchScore(insightHaystack(i), tokens, qNorm) }))
      .filter((s) => s.score >= 0);
    // Con búsqueda: relevancia primero (estable: conserva recencia dentro del score).
    if (tokens.length > 0) scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.i);
  }, [initial, q, vista]);

  const hasFilter = q.trim() !== "" || vista !== "todas";
  const clear = () => {
    setQ("");
    setVista("todas");
  };

  if (initial.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5" role="search" aria-label="Filtros del inbox">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar en el inbox…"
          ariaLabel="Buscar en el inbox"
          onSearch={(value) => setQ(value)}
        />
        <FilterSelect
          value={vista}
          onChange={(v) => setVista(v as Vista)}
          ariaLabel="Filtrar avisos del inbox"
          placeholder="Vista"
          display={(value) => `Vista: ${VISTA_LABEL[value as Vista] ?? value}`}
          items={{ todas: "Todas", mias: "Mías", descartadas: "Descartadas" }}
        >
          <SelectItem value="todas">Todas</SelectItem>
          <SelectItem value="mias">Mías</SelectItem>
          <SelectItem value="descartadas">Descartadas</SelectItem>
        </FilterSelect>
        {hasFilter && (
          <Button variant="ghost" size="sm" onClick={clear}>
            <FilterX aria-hidden />
            Limpiar
          </Button>
        )}
        <EntityCount total={live.length} singular="aviso" plural="avisos" />
      </div>

      {live.length === 0 ? (
        <EntityEmpty
          filtered
          emptyTitle="Sin resultados para ese filtro"
          emptyHint="Prueba con otro término u otra vista."
          onClear={clear}
        />
      ) : (
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          {live.map((i) => (
            <InsightCard key={i.id} insight={i} />
          ))}
        </div>
      )}
    </div>
  );
}
