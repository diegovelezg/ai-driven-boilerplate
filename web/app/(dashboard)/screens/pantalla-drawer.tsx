"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { BarChart3, Bot, CalendarDays, CircleCheckBig, CircleOff, MapPin, Monitor, Pencil, Save, Trash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DangerButton, RetryButton, RowIconButton, SubmitButton, CancelButton } from "@/components/buttons";
import {
  Dialog,
  DrawerDialogContent as DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { AttributeBadge, GeneratingBadge, ScreenActiveBadge } from "@/components/badges";
import { toast } from "@/components/ui/toast";
import { deleteScreenAction, setScreenActiveAction, updateScreenPlaybackAction } from "@/lib/screens-actions";
import { hasMinRole, type MemberRole } from "@/lib/roles";
import { AppCard, AppCardState } from "@/components/app-card";
import { DrawerShell, type DrawerTabDef } from "@/components/drawer-shell";
import { formatDecimal, formatNumber, toTitleCase } from "@/lib/format";
import { cn } from "cn";

type TabId = "ficha" | "comercial" | "ocupacion" | "geo" | "agentes";

interface ScreenDetail {
  screen: Record<string, unknown>;
  venue: Record<string, unknown> | null;
  supplier_name: string | null;
  has_embedding: boolean;
  embedding_model: string | null;
  bookings_count: number;
  lines_count: number;
  myRole?: MemberRole | null;
}

function str(v: unknown): string {
  return typeof v === "string" && v.trim() !== "" ? v : "—";
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtInt(v: unknown): string {
  const n = toNum(v);
  return n === null ? "—" : formatNumber(Math.round(n));
}

/** 0–10 o 0–100 → 0–100 para barras. null si no hay dato. */
function toBar(v: unknown): number | null {
  const n = toNum(v);
  if (n === null) return null;
  if (n <= 0) return 0;
  // Heurística: geo_* y score viven en 0–10; tráfico/intensidad en 0–100.
  const scaled = n <= 10 ? n * 10 : n;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

/* ---------------------------------- UI ---------------------------------- */

/** Campo de ficha: etiqueta pequeña mayúscula + valor legible. */
function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 text-[13px] leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}

/** KPI compacto: valor grande + etiqueta. */
function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">{hint}</p>}
    </div>
  );
}

/** Indicador tipo score: etiqueta + valor + barra fina. */
function ScoreBar({ label, hint, value, bar }: { label: string; hint?: string; value: string; bar: number | null }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-[13px] font-medium">
          {label}
          {hint && <span className="ml-1.5 font-normal text-muted-foreground">{hint}</span>}
        </p>
        <span className="shrink-0 text-[13px] font-semibold tabular-nums">{value}</span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={bar ?? undefined}
        aria-label={label}
      >
        <div
          className={cn("h-full rounded-full bg-primary/80 transition-[width]", bar === null && "bg-transparent")}
          style={{ width: `${bar ?? 0}%` }}
        />
      </div>
    </div>
  );
}

/** Reparto vehicular / peatonal como barra dividida. */
function SplitBar({ vehicular, peatonal }: { vehicular: number | null; peatonal: number | null }) {
  if (vehicular === null && peatonal === null) {
    return <p className="text-[13px] text-muted-foreground">Sin datos de reparto.</p>;
  }
  const v = vehicular ?? 0;
  const p = peatonal ?? 0;
  const total = v + p > 0 ? v + p : 1;
  const vPct = Math.round((v / total) * 100);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-label={`Vehicular ${v}% / Peatonal ${p}%`}>
        <div className="h-full bg-primary/80" style={{ width: `${vPct}%` }} />
        <div className="h-full bg-emerald-500/60" style={{ width: `${100 - vPct}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs tabular-nums">
        <span>
          <span className="mr-1.5 inline-block size-2 rounded-full bg-primary/80 align-middle" aria-hidden />
          Vehicular <strong className="font-semibold">{v}%</strong>
        </span>
        <span>
          <span className="mr-1.5 inline-block size-2 rounded-full bg-emerald-500/60 align-middle" aria-hidden />
          Peatonal <strong className="font-semibold">{p}%</strong>
        </span>
      </div>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <AttributeBadge title="Atributo de pantalla">{children}</AttributeBadge>;
}

import { ScreenMap } from "./screen-map";

// Carga diferida: chat y ocupación solo se descargan al usarse (mismo
// patrón que orden-drawer: el drawer inicial no paga react-markdown ni
// react-day-picker).
function DrawerLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={label}>
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
      <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
    </div>
  );
}
const PantallaChat = dynamic(() => import("./pantalla-chat").then((m) => m.PantallaChat), {
  ssr: false,
  loading: () => <DrawerLoading label="Cargando chat" />,
});
const PantallaOcupacion = dynamic(
  () => import("./pantalla-ocupacion").then((m) => m.PantallaOcupacion),
  {
    ssr: false,
    loading: () => <DrawerLoading label="Cargando ocupación" />,
  },
);

/** Entero > 0 o null (vacío); undefined = inválido. */
function parsePlaybackInt(raw: string): number | null | undefined {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Form de pauta con estado LOCAL: escribir aquí ya NO re-renderiza el
 * drawer (perf 2026-11-09: antes cada tecla reconciliaba el drawer entero
 * de 700+ líneas, con JSON.parse + geoItems reconstruidos por render).
 */
function ScreenPlaybackForm({
  initial,
  pending,
  serverError,
  onSave,
  onCancel,
}: {
  initial: { duration: string; plays: string; impact: string };
  pending: boolean;
  serverError: string | null;
  onSave: (v: { duration: number | null; plays: number | null; impact: number | null }) => void;
  onCancel: () => void;
}) {
  const [durInput, setDurInput] = useState(initial.duration);
  const [playsInput, setPlaysInput] = useState(initial.plays);
  const [impactInput, setImpactInput] = useState(initial.impact);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const duration = parsePlaybackInt(durInput);
    const plays = parsePlaybackInt(playsInput);
    const impact = parsePlaybackInt(impactInput);
    if (duration === undefined || plays === undefined || impact === undefined) {
      setError("Enteros > 0 (vacío = sin dato).");
      return;
    }
    setError(null);
    onSave({ duration, plays, impact });
  };
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs">
          Duración spot (s)
          <input
            value={durInput}
            onChange={(e) => setDurInput(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="10"
            disabled={pending}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Reproducciones / día
          <input
            value={playsInput}
            onChange={(e) => setPlaysInput(e.target.value.replace(/\D/g, "").slice(0, 7))}
            inputMode="numeric"
            placeholder="900"
            disabled={pending}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Impactos / día
          <input
            value={impactInput}
            onChange={(e) => setImpactInput(e.target.value.replace(/\D/g, "").slice(0, 9))}
            inputMode="numeric"
            placeholder="150000"
            disabled={pending}
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm tabular-nums"
          />
        </label>
      </div>
      {(error ?? serverError) && <p className="text-xs text-destructive">{error ?? serverError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" onClick={save} pending={pending}>
          <Save aria-hidden />
          Guardar
        </SubmitButton>
        <CancelButton size="sm" onCancel={onCancel} disabled={pending} />
      </div>
    </div>
  );
}

export function PantallaDrawer({ screenId, onClose }: { screenId: string; onClose: () => void }) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("ficha");
  const [detail, setDetail] = useState<ScreenDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingPlayback, setEditingPlayback] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [savingPlayback, startPlayback] = useTransition();
  const [delOpen, setDelOpen] = useState(false);
  const [working, startWork] = useTransition();

  const canManage = detail?.myRole ? hasMinRole(detail.myRole, "seller") : false;
  const canDelete = detail?.myRole ? hasMinRole(detail.myRole, "owner") : false;

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const res = await fetch(`/api/screens/${screenId}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error("No se pudo cargar la pantalla.");
      setDetail((await res.json()) as ScreenDetail);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : "No se pudieron cargar los datos.");
    }
  }, [screenId]);

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
  }, [screenId, load]);

  const retry = () => {
    setError(null);
    setDetail(null);
    void load();
  };

  const s = detail?.screen;
  const v = detail?.venue;
  // El enriquecimiento corre en segundo plano tras crear la pantalla: mientras
  // siga pendiente, la ficha bloquea ediciones (el job escribe esas columnas).
  const enriching = s?.enrichment_status === "pending";

  // Releer mientras siga pendiente: el job termina solo y la ficha se actualiza
  // sin reabrir (tope ~2 min; si el job murió, la guarda server ya liberó).
  useEffect(() => {
    if (!enriching) return;
    let alive = true;
    const ac = new AbortController();
    let tries = 0;
    const h = setInterval(() => {
      tries++;
      if (tries > 15) {
        clearInterval(h);
        return;
      }
      fetch(`/api/screens/${screenId}`, { cache: "no-store", signal: ac.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error("No se pudo cargar la pantalla.");
          return (await res.json()) as ScreenDetail;
        })
        .then((j) => {
          if (!alive) return;
          setDetail(j);
          if ((j.screen as Record<string, unknown> | null)?.enrichment_status !== "pending") clearInterval(h);
        })
        .catch(() => {});
    }, 8000);
    return () => {
      alive = false;
      clearInterval(h);
      ac.abort();
    };
  }, [screenId, enriching]);

  // Pauta editable: duración del spot + reproducciones/día.
  const startEditPlayback = () => {
    setPlaybackError(null);
    setEditingPlayback(true);
  };

  const savePlayback = (v: { duration: number | null; plays: number | null; impact: number | null }) => {
    setPlaybackError(null);
    startPlayback(async () => {
      const res = await updateScreenPlaybackAction({ screenId, duration_sec: v.duration, plays_per_day: v.plays, impact_day: v.impact });
      if (!res.ok) {
        setPlaybackError(res.message);
        return;
      }
      setDetail((d) => (d ? { ...d, screen: { ...d.screen, duration_sec: v.duration, plays_per_day: v.plays, impact_day: v.impact } } : d));
      setEditingPlayback(false);
      toast.add({ title: "Pauta actualizada", description: res.message, type: "success" });
    });
  };  const tags = Array.isArray(s?.tags) ? (s.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
  const media = Array.isArray(s?.media_images)
    ? (s.media_images as unknown[]).filter((m): m is string => typeof m === "string" && m !== "")
    : [];
  let pois: Array<{ name?: string; category?: string; distance_meters?: number }> = [];
  try {
    const raw = s?.pois_list_json;
    if (Array.isArray(raw)) pois = raw as typeof pois;
    else if (typeof raw === "string" && raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) pois = parsed as typeof pois;
    }
  } catch {
    pois = [];
  }

  const tabs: DrawerTabDef[] = [
    { id: "ficha", label: "Ficha", icon: Monitor },
    { id: "comercial", label: "Comercial", icon: BarChart3 },
    { id: "ocupacion", label: "Ocupación", icon: CalendarDays },
    { id: "geo", label: "Entorno", icon: MapPin },
    { id: "agentes", label: "Agentes", icon: Bot },
  ];

  // Derivados comerciales
  const price = toNum(s?.price_pen);
  const impact = toNum(s?.impact_day);
  const active = s?.is_active === true;

  // Habilitar / deshabilitar (seller+) / eliminar (solo owner).
  const toggleActive = (next: boolean) => {
    startWork(async () => {
      const res = await setScreenActiveAction({ screenId, isActive: next });
      if (!res.ok) {
        toast.add({ title: "No se pudo actualizar", description: res.message, type: "error" });
        return;
      }
      setDetail((d) => (d ? { ...d, screen: { ...d.screen, is_active: next } } : d));
      toast.add({ title: next ? "Pantalla habilitada" : "Pantalla deshabilitada", description: res.message, type: "success" });
    });
  };

  const doDelete = () => {
    startWork(async () => {
      const res = await deleteScreenAction({ screenId });
      if (!res.ok) {
        toast.add({ title: "No se pudo eliminar", description: res.message, type: "error" });
        return;
      }
      setDelOpen(false);
      toast.add({ title: "Pantalla eliminada", description: res.message, type: "success" });
      onClose();
      router.replace("/screens");
      router.refresh();
    });
  };
  const cpm = price !== null && impact !== null && impact > 0 ? (price / impact) * 1000 : null;
  const scoreBar = s ? toBar(s.score) : null;
  const scoreTxt = (() => {
    const n = s ? toNum(s.score) : null;
    if (n === null) return "—";
    return n <= 10 ? formatDecimal(n, 1) : formatNumber(Math.round(n));
  })();

  const address = str((v?.full_address as string) ?? (v?.address as string));
  const place = [v?.district, v?.city].filter((x) => typeof x === "string" && x).join(" · ");
  const regionPostal = [v?.region, v?.postal_code].filter((x) => typeof x === "string" && x).join(" · ");
  const coords =
    toNum(v?.latitude) !== null && toNum(v?.longitude) !== null
      ? `${String(v?.latitude)}, ${String(v?.longitude)}`
      : null;
  const vialidad: string[] = [];
  if (typeof s?.road_tier_label === "string" && s.road_tier_label) vialidad.push(s.road_tier_label);
  if (typeof s?.congestion_level === "string" && s.congestion_level) vialidad.push(s.congestion_level);
  if (toNum(s?.average_speed_kmh) !== null) vialidad.push(`${formatNumber(toNum(s?.average_speed_kmh))} km/h`);
  if (s?.is_major_corridor === true) vialidad.push("Corredor principal");

  const geoItems: Array<{ key: string; label: string; hint: string; bar: number | null; text: string }> = s
    ? [
        {
          key: "mov",
          label: "Movilidad",
          hint: "paso y flujo",
          bar: toBar(s.traffic_mobility_score),
          text: fmtInt(s.traffic_mobility_score),
        },
        {
          key: "com",
          label: "Intensidad comercial",
          hint: "densidad de oferta",
          bar: toBar(s.commercial_intensity_score),
          text: fmtInt(s.commercial_intensity_score),
        },
        {
          key: "vida",
          label: "Vida diaria",
          hint: "cotidianidad",
          bar: toBar(s.geo_daily_life),
          text: s.geo_daily_life != null && s.geo_daily_life !== "" ? formatDecimal(Number(s.geo_daily_life), 1) : "—",
        },
        {
          key: "transito",
          label: "Tránsito y viajes",
          hint: "corredores",
          bar: toBar(s.geo_travel_transit),
          text:
            s.geo_travel_transit != null && s.geo_travel_transit !== ""
              ? formatDecimal(Number(s.geo_travel_transit), 1)
              : "—",
        },
        {
          key: "genz",
          label: "Gen Z",
          hint: "afinidad joven",
          bar: toBar(s.geo_gen_z_lifestyle),
          text:
            s.geo_gen_z_lifestyle != null && s.geo_gen_z_lifestyle !== ""
              ? formatDecimal(Number(s.geo_gen_z_lifestyle), 1)
              : "—",
        },
        {
          key: "salud",
          label: "Salud y bienestar",
          hint: "estilo de vida",
          bar: toBar(s.geo_health_wellness),
          text:
            s.geo_health_wellness != null && s.geo_health_wellness !== ""
              ? formatDecimal(Number(s.geo_health_wellness), 1)
              : "—",
        },
        {
          key: "lujo",
          label: "Lujo",
          hint: "poder adquisitivo",
          bar: toBar(s.geo_high_end_luxury),
          text:
            s.geo_high_end_luxury != null && s.geo_high_end_luxury !== ""
              ? formatDecimal(Number(s.geo_high_end_luxury), 1)
              : "—",
        },
        {
          key: "ejec",
          label: "Ejecutivo",
          hint: "negocios",
          bar: toBar(s.geo_business_executive),
          text:
            s.geo_business_executive != null && s.geo_business_executive !== ""
              ? formatDecimal(Number(s.geo_business_executive), 1)
              : "—",
        },
      ]
    : [];

  return (
    <DrawerShell
      onClose={onClose}
      size="wide"
      avatar={<Monitor className="size-5" aria-hidden />}
      title={s ? toTitleCase(String(s.name ?? "Pantalla")) : "Pantalla"}
      description={
        s
          ? [detail?.supplier_name, typeof s.external_ref === "string" && s.external_ref ? s.external_ref : null]
              .filter(Boolean)
              .join(" · ") || "—"
          : "Cargando…"
      }
      badges={
        s && (
          <span className="flex flex-wrap items-center gap-1.5">
            <ScreenActiveBadge isActive={s.is_active === true} />
            {enriching && <GeneratingBadge />}
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {formatNumber(detail?.bookings_count ?? 0)} reservas · {formatNumber(detail?.lines_count ?? 0)} líneas en órdenes
            </span>
            {canManage && (
              <span className="ms-auto flex items-center gap-1">
                <AppTooltip tip={active ? "Deshabilitar pantalla" : "Pantalla ya inactiva"}>
                  <RowIconButton
                    icon={CircleOff}
                    label="Deshabilitar pantalla"
                    title={enriching ? "Generando resumen inteligente…" : "Deshabilitar"}
                    disabled={!active || working || enriching}
                    pending={working}
                    onClick={() => toggleActive(false)}
                  />
                </AppTooltip>
                <AppTooltip tip={active ? "Pantalla ya activa" : "Habilitar pantalla"}>
                  <RowIconButton
                    icon={CircleCheckBig}
                    label="Habilitar pantalla"
                    title={enriching ? "Generando resumen inteligente…" : "Habilitar"}
                    disabled={active || working || enriching}
                    pending={working}
                    onClick={() => toggleActive(true)}
                  />
                </AppTooltip>
                <AppTooltip tip="Eliminar pantalla (solo propietario)">
                  <RowIconButton
                    icon={Trash}
                    label="Eliminar pantalla"
                    title={enriching ? "Generando resumen inteligente…" : "Eliminar (solo propietario)"}
                    danger
                    disabled={working || enriching || !canDelete}
                    pending={working}
                    onClick={() => setDelOpen(true)}
                  />
                </AppTooltip>
              </span>
            )}
          </span>
        )
      }
      tabs={tabs}
      tab={tab}
      onTabChange={(id) => setTab(id as TabId)}
      tabListLabel="Detalle de pantalla"
      fill={tab === "agentes"}
    >
      {tab === "agentes" ? (
        <PantallaChat screenId={screenId} screenLabel={s ? toTitleCase(String(s.name ?? "Pantalla")) : "Pantalla"} />
      ) : (
      <>
      {error && (
        <div className="flex flex-col gap-3">
          <AppCardState>{error}</AppCardState>
          <RetryButton onRetry={retry} />
        </div>
      )}
      {!error && !detail && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando pantalla">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
        </div>
      )}

      {detail && s && tab === "ficha" && (
        <>
          <AppCard title="Formato" description="Soporte, medidas y tecnología." aria-label="Formato de la pantalla">
            {media.length > 0 && (
              <div className="relative mb-4 aspect-[16/9] w-full overflow-hidden rounded-lg ring-1 ring-border">
                <Image
                  src={media[0]}
                  alt={`Foto de ${s ? toTitleCase(String(s.name ?? "Pantalla")) : "la pantalla"}`}
                  fill
                  sizes="(max-width: 920px) 90vw, 800px"
                  className="object-cover"
                />
              </div>
            )}
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
              <Kpi
                label="Medidas"
                value={
                  toNum(s.width_m) !== null || toNum(s.height_m) !== null
                    ? `${s.width_m ?? "—"} × ${s.height_m ?? "—"} m`
                    : "—"
                }
                hint={
                  toNum(s.width_px) !== null || toNum(s.height_px) !== null
                    ? `${fmtInt(s.width_px)} × ${fmtInt(s.height_px)} px`
                    : undefined
                }
              />
              <Kpi label="Orientación" value={<span className="text-base font-medium">{str(s.orientation)}</span>} />
              <Kpi label="Tecnología" value={<span className="text-base font-medium">{str(s.technology)}</span>} />
            </div>
          </AppCard>

          <AppCard title="Ubicación" description="Dónde está y cómo llegar." aria-label="Ubicación de la pantalla">
            <ScreenMap
              lat={toNum(v?.latitude)}
              lng={toNum(v?.longitude)}
              name={s ? toTitleCase(String(s.name ?? "Pantalla")) : "Pantalla"}
              code={typeof s?.external_ref === "string" ? (s.external_ref as string) : null}
            />
            <div className="mt-4">
              <p className="text-[15px] leading-snug font-medium tracking-tight">{address}</p>
              {(place || regionPostal) && (
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {[place || null, regionPostal || null].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-border/60 pt-4 sm:grid-cols-2">
              <Field label="Proveedor">{detail.supplier_name ?? "—"}</Field>
              <Field label="Ref. externa">
                <span className="font-mono text-[12px]">{str(s.external_ref)}</span>
              </Field>
              {coords && (
                <Field label="Coordenadas">
                  <span className="text-muted-foreground tabular-nums">{coords}</span>
                </Field>
              )}
              {typeof s.url === "string" && s.url.trim() !== "" ? (
                <Field label="Ficha pública">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Ver ficha del proveedor ↗
                  </a>
                </Field>
              ) : null}
            </dl>
          </AppCard>

          {typeof s.restrictions === "string" && s.restrictions.trim() !== "" && (
            <AppCard
              title="Restricciones"
              description="Condiciones de uso a validar antes de vender."
              tone="amber"
              aria-label="Restricciones"
            >
              <p className="text-[13px] leading-relaxed">{str(s.restrictions)}</p>
            </AppCard>
          )}
        </>
      )}

      {detail && s && tab === "comercial" && (
        <>
          <AppCard variant="hero" title="Precio de catálogo" description="Base para cotizar esta pantalla.">
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
              <Kpi
                label="Precio"
                value={price !== null ? `S/ ${formatNumber(price)}` : "—"}
                hint={typeof s.currency === "string" && s.currency ? `${s.currency} · catálogo` : "Catálogo"}
              />
              <Kpi label="Impactos / día" value={impact !== null ? formatNumber(impact) : "—"} hint="Alcance diario" />
              <Kpi
                label="CPM estimado"
                value={cpm !== null ? `S/ ${formatNumber(Math.round(cpm))}` : "—"}
                hint="Costo por mil impactos"
              />
            </div>
          </AppCard>

          <AppCard title="Rendimiento" description="Qué entrega por día y su calificación global.">
            <div className="flex flex-col gap-4">
              <ScoreBar label="Score global" hint="0–10" value={scoreTxt} bar={scoreBar} />
              {!editingPlayback ? (
                <>
                  <dl className="grid gap-x-6 gap-y-3 border-t border-border/60 pt-4 sm:grid-cols-3">
                    <Field label="Impresiones / día">
                      <span className="font-semibold tabular-nums">{fmtInt(s.impressions_day)}</span>
                    </Field>
                    <Field label="Vistas efectivas / día">
                      <span className="font-semibold tabular-nums">{fmtInt(s.effective_daily_views)}</span>
                    </Field>
                    <Field label="Reproducciones / día">
                      <span className="font-semibold tabular-nums">{fmtInt(s.plays_per_day)}</span>
                    </Field>
                    <Field label="Duración spot">
                      <span className="tabular-nums">
                        {toNum(s.duration_sec) !== null ? `${formatNumber(toNum(s.duration_sec))} s` : "—"}
                      </span>
                    </Field>
                    <Field label="Vistas por spot">
                      <span className="tabular-nums">{fmtInt(s.views_per_spot)}</span>
                    </Field>
                  </dl>
                  <div>
                    <Button variant="outline" size="sm" onClick={startEditPlayback} disabled={enriching} title={enriching ? "Generando resumen inteligente…" : undefined}>
                      <Pencil aria-hidden />
                      Editar pauta
                    </Button>
                  </div>
                </>
              ) : (
                <ScreenPlaybackForm
                  key={`${String(s?.duration_sec ?? "")}-${String(s?.plays_per_day ?? "")}-${String(s?.impact_day ?? "")}`}
                  initial={{
                    duration: s?.duration_sec != null && s.duration_sec !== "" ? String(s.duration_sec) : "",
                    plays: s?.plays_per_day != null && s.plays_per_day !== "" ? String(s.plays_per_day) : "",
                    impact: s?.impact_day != null && s.impact_day !== "" ? String(s.impact_day) : "",
                  }}
                  pending={savingPlayback}
                  serverError={playbackError}
                  onSave={savePlayback}
                  onCancel={() => setEditingPlayback(false)}
                />
              )}
            </div>
          </AppCard>

          <AppCard title="Argumento comercial" description="Cómo venderla: a quién le sirve y por qué.">
            <div className="flex flex-col gap-4">
              {str(s.audience_target) !== "—" && (
                <div>
                  <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Audiencia</p>
                  <p className="mt-1 text-[15px] leading-snug font-medium tracking-tight">{str(s.audience_target)}</p>
                </div>
              )}
              {str(s.sales_pitch) !== "—" && (
                <blockquote className="border-l-2 border-primary/40 pl-3 text-[13px] leading-relaxed text-foreground/90 italic">
                  {str(s.sales_pitch)}
                </blockquote>
              )}
              {str(s.description) !== "—" && (
                <p className="text-[13px] leading-relaxed text-muted-foreground">{str(s.description)}</p>
              )}
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5" aria-label="Etiquetas">
                  {tags.map((t) => (
                    <AttributeBadge key={t} label={t} title="Etiqueta" className="tabular-nums" />
                  ))}
                </div>
              )}
            </div>
          </AppCard>
        </>
      )}

      {detail && s && tab === "ocupacion" && <PantallaOcupacion screenId={screenId} />}

      {detail && s && tab === "geo" && (
        <>
          <AppCard title="Perfil de la zona" description="Afinidades del entorno, de mayor a menor." aria-label="Perfil">
            <div className="flex flex-col gap-4">
              {geoItems.map((g) => (
                <ScoreBar key={g.key} label={g.label} hint={g.hint} value={g.text} bar={g.bar} />
              ))}
            </div>
          </AppCard>

          <AppCard title="Tránsito" description="Cómo se mueve la gente frente a la pantalla." aria-label="Tránsito">
            <SplitBar vehicular={toNum(s.vehicular_pct)} peatonal={toNum(s.pedestrian_pct)} />
            {vialidad.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {vialidad.map((chip) => (
                  <Chip key={chip}>{chip}</Chip>
                ))}
              </div>
            )}
            {(str(s.landuse_zones) !== "—" || str(s.building_types) !== "—") && (
              <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-border/60 pt-4 sm:grid-cols-2">
                <Field label="Uso de suelo">{str(s.landuse_zones)}</Field>
                <Field label="Edificios">{str(s.building_types)}</Field>
              </dl>
            )}
            {(() => {
              const rawBiz = str(s.suggested_local_businesses);
              if (rawBiz === "—") return null;
              const biz = [...new Set(rawBiz.split("|").map((t) => t.trim()).filter(Boolean))].sort((a, b) =>
                a.localeCompare(b, "es"),
              );
              if (biz.length === 0) return null;
              return (
                <div className="mt-4 border-t border-border/60 pt-4">
                  <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    Negocios afines ({formatNumber(biz.length)})
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Negocios afines">
                    {biz.map((b) => (
                      <Chip key={b}>{b}</Chip>
                    ))}
                  </div>
                </div>
              );
            })()}
          </AppCard>

          <AppCard
            title={`Puntos de interés${toNum(s.pois_total_count) !== null ? ` (${formatNumber(toNum(s.pois_total_count))})` : ""}`}
            description="Anclas cercanas que explican el flujo."
            aria-label="Puntos de interés"
          >
            {pois.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border/60">
                {pois.map((p, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="min-w-0 truncate text-[13px] font-medium">{p.name ?? "—"}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {[p.category, typeof p.distance_meters === "number" ? `${formatNumber(p.distance_meters)} m` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">Sin detalle de POIs.</p>
            )}
          </AppCard>

          <p className="px-1 text-xs text-muted-foreground">
            Resumen inteligente: {enriching ? "generándose…" : detail.has_embedding ? "listo" : "no disponible"}.
          </p>
        </>
      )}
      </>
      )}
      <Dialog open={delOpen} onOpenChange={(v) => !v && setDelOpen(false)}>
        <DialogContent className="w-auto max-w-[calc(100%-2rem)] sm:min-w-[420px]">
          <DialogHeader>
            <DialogTitle>Eliminar pantalla</DialogTitle>
            <DialogDescription>
              {s ? `Se eliminará "${toTitleCase(String(s.name ?? "esta pantalla"))}" y su ubicación. Esta acción no se puede deshacer.` : "Esta acción no se puede deshacer."}
              {(detail && (detail.bookings_count > 0 || detail.lines_count > 0)) && " Tiene reservas o líneas en órdenes, por eso no se puede eliminar."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDelOpen(false)} disabled={working}>
              <CircleOff aria-hidden />Volver
            </Button>
            <DangerButton onClick={doDelete} pending={working} pendingLabel="Eliminando…">
              <Trash aria-hidden />
              Confirmar eliminación
            </DangerButton>
          </div>
        </DialogContent>
      </Dialog>
    </DrawerShell>
  );
}
