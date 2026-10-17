"use client";

import { useEffect, useState, useTransition } from "react";
import { Building2, ExternalLink, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { updateCustomerAction } from "@/lib/customer-actions";
import { reenrichDomainAction } from "@/lib/enrich-actions";
import type { EditableCustomer, ManualField } from "@/lib/customers-db";
import { formatMoney } from "@/lib/medusa";
import type {
  CustomerOrder,
  CustomerRfm,
} from "@/app/api/customers/[id]/orders/route";
import type { CustomerFirmographics } from "@/app/api/customers/[id]/firmographics/route";
import { CustomerChat } from "./customer-chat";

const FIELDS: Array<{ key: ManualField; label: string; placeholder: string }> = [
  { key: "first_name", label: "Nombre", placeholder: "Nombre" },
  { key: "last_name", label: "Apellido", placeholder: "Apellido" },
  { key: "phone", label: "Teléfono", placeholder: "+51 …" },
  { key: "company_name", label: "Empresa", placeholder: "Empresa" },
];

function effStr(c: EditableCustomer, key: ManualField): string {
  switch (key) {
    case "first_name":
      return c.firstName ?? "";
    case "last_name":
      return c.lastName ?? "";
    case "phone":
      return c.phone ?? "";
    case "company_name":
      return c.companyName ?? "";
    case "customer_type":
      return c.customerType;
  }
}

function baseStr(c: EditableCustomer, key: ManualField): string {
  switch (key) {
    case "first_name":
      return c.base.firstName ?? "";
    case "last_name":
      return c.base.lastName ?? "";
    case "phone":
      return c.base.phone ?? "";
    case "company_name":
      return c.base.companyName ?? "";
    case "customer_type":
      return c.base.customerType;
  }
}

function FieldMeta({
  overridden,
  willRevert,
  onRevert,
  label,
}: {
  overridden: boolean;
  willRevert: boolean;
  onRevert: () => void;
  label: string;
}) {
  return (
    <span className="flex h-5 items-center">
      {overridden ? (
        <span className="flex items-center gap-1.5">
          <Badge variant="secondary" className="font-normal">
            Editado
          </Badge>
          <button
            type="button"
            onClick={onRevert}
            title="Volver al valor de Medusa"
            aria-label={`Revertir ${label} a valor de Medusa`}
            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Undo2 className="size-3.5" aria-hidden />
          </button>
        </span>
      ) : (
        willRevert && (
          <Badge variant="outline" className="font-normal">
            Revierte al guardar
          </Badge>
        )
      )}
    </span>
  );
}

function DatosTab({ customer, onClose }: { customer: EditableCustomer; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Record<ManualField, string>>({
    first_name: effStr(customer, "first_name"),
    last_name: effStr(customer, "last_name"),
    phone: effStr(customer, "phone"),
    company_name: effStr(customer, "company_name"),
    customer_type: effStr(customer, "customer_type"),
  });
  const [reverted, setReverted] = useState<ManualField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isOverridden = (key: ManualField) =>
    customer.manualFields.includes(key) && !reverted.includes(key);

  const markRevert = (key: ManualField) => {
    setReverted((r) => (r.includes(key) ? r : [...r, key]));
    setDrafts((d) => ({ ...d, [key]: baseStr(customer, key) }));
    setError(null);
  };

  const setDraft = (key: ManualField, v: string) => {
    setDrafts((d) => ({ ...d, [key]: v }));
    if (v !== baseStr(customer, key)) {
      setReverted((r) => r.filter((k) => k !== key));
    }
    setError(null);
  };

  const ALL_KEYS: ManualField[] = [...FIELDS.map((f) => f.key), "customer_type"];

  const diff = () => {
    const values: Partial<Record<ManualField, string>> = {};
    const reverts: ManualField[] = [];
    for (const key of ALL_KEYS) {
      if (drafts[key] === baseStr(customer, key)) {
        if (customer.manualFields.includes(key) || reverted.includes(key)) {
          reverts.push(key);
        }
      } else if (drafts[key] !== effStr(customer, key)) {
        values[key] = drafts[key];
      }
    }
    return { values, reverts };
  };

  const save = () => {
    const { values, reverts } = diff();
    if (Object.keys(values).length === 0 && reverts.length === 0) {
      onClose();
      return;
    }
    startTransition(async () => {
      const res = await updateCustomerAction({ id: customer.dbId, values, reverts });
      if (res.ok) onClose();
      else setError(res.message);
    });
  };

  const { values: pendingValues, reverts: pendingReverts } = diff();
  const dirty = Object.keys(pendingValues).length > 0 || pendingReverts.length > 0;

  const renderTextField = (
    key: (typeof FIELDS)[number]["key"],
    label: string,
    placeholder: string,
  ) => (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={`cm-${key}`} className="text-[13px]">
          {label}
        </Label>
        <FieldMeta
          overridden={isOverridden(key)}
          willRevert={reverted.includes(key)}
          onRevert={() => markRevert(key)}
          label={label}
        />
      </div>
      <Input
        id={`cm-${key}`}
        value={drafts[key]}
        onChange={(e) => setDraft(key, e.target.value)}
        placeholder={placeholder}
        disabled={isPending}
        className="h-10"
      />
      {isOverridden(key) && baseStr(customer, key) !== drafts[key] && (
        <p className="text-xs text-muted-foreground">Medusa: {baseStr(customer, key) || "—"}</p>
      )}
    </div>
  );

  return (
    <div className="grid gap-5 px-8 py-6">
      <div className="grid gap-4 sm:grid-cols-2">
        {renderTextField("first_name", "Nombre", "Nombre")}
        {renderTextField("last_name", "Apellido", "Apellido")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {renderTextField("phone", "Teléfono", "+51 …")}
        {renderTextField("company_name", "Empresa", "Empresa")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="cm-type" className="text-[13px]">
              Tipo
            </Label>
            <FieldMeta
              overridden={isOverridden("customer_type")}
              willRevert={reverted.includes("customer_type")}
              onRevert={() => markRevert("customer_type")}
              label="Tipo"
            />
          </div>
          <Select
            value={drafts.customer_type}
            onValueChange={(v) => {
              if (v) setDraft("customer_type", v);
            }}
            disabled={isPending}
          >
            <SelectTrigger id="cm-type" className="h-10 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="B2C">B2C · Consumidor final</SelectItem>
              <SelectItem value="B2B">B2B · Empresa</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="hidden items-end pb-1 text-xs text-muted-foreground sm:flex">
          Lo editado se conserva ante el sync de Medusa.
        </p>
      </div>

      <EnrichedCompany
        dbId={customer.dbId}
        onUseCompany={(name) => setDraft("company_name", name)}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-3 pt-1">
        <Button variant="outline" onClick={onClose} disabled={isPending} className="h-10 px-5">
          Cancelar
        </Button>
        <Button onClick={save} disabled={isPending || !dirty} className="h-10 px-6">
          {isPending ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </div>
  );
}

/** Empresa enriquecida por dominio (read-only). Solo se muestra si el dominio es de negocio. */
function EnrichedCompany({
  dbId,
  onUseCompany,
}: {
  dbId: string;
  onUseCompany: (name: string) => void;
}) {
  const [data, setData] = useState<CustomerFirmographics | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [reloading, startReenrich] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/customers/${dbId}/firmographics`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive) setData(j as CustomerFirmographics | null);
      })
      .catch(() => {
        if (alive) setData(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dbId, reloadKey]);

  if (loading || !data || !data.enrichable) return null;

  const runReenrich = () => {
    startReenrich(async () => {
      const r = await reenrichDomainAction(data.domain);
      if (r.ok) setReloadKey((k) => k + 1);
      else setMsg(r.message);
    });
  };

  const meta = [data.industry, data.location, data.size && `tamaño ${data.size}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[13px] font-medium">
          <Building2 className="size-3.5 text-primary" aria-hidden />
          Empresa (enriquecido)
        </p>
        {data.enriched && data.confidence !== null && (
          <span className="text-[11px] text-muted-foreground">
            confianza {Math.round(data.confidence * 100)}%
          </span>
        )}
      </div>

      {data.enriched ? (
        <div className="mt-3 grid gap-2">
          <p className="text-sm font-semibold">{data.companyName ?? "—"}</p>
          {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
          {data.description && <p className="text-[13px]">{data.description}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <a
              href={data.sourceUrl ?? `https://${data.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
            >
              {data.domain}
              <ExternalLink className="size-3" aria-hidden />
            </a>
            <span className="flex gap-2">
              {data.companyName && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onUseCompany(data.companyName as string)}
                >
                  Usar como Empresa
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={reloading}
                onClick={runReenrich}
              >
                {reloading ? "Re-enriqueciendo…" : "Re-enriquecer"}
              </Button>
            </span>
          </div>
          {msg && <p className="text-xs text-destructive">{msg}</p>}
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Dominio {data.domain} · sin enriquecer aún.
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={reloading}
            onClick={runReenrich}
          >
            {reloading ? "Enriqueciendo…" : "Enriquecer"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ScoreBadge({ axis, score }: { axis: "R" | "F" | "M"; score: number | null }) {
  if (score === null) return null;
  const label = axis === "R" ? "Recencia" : axis === "F" ? "Frecuencia" : "Monetario";
  return (
    <Badge
      variant="secondary"
      className="ml-2 align-middle font-normal tabular-nums"
      title={`${label}: ${score}/5 vs la tienda`}
    >
      {axis}
      {score}
    </Badge>
  );
}

function medianNum(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Tendencia del ticket: prom. segunda mitad vs primera mitad (%). null si <4 compras. */
function ticketTrendPct(chrono: CustomerOrder[]): number | null {
  if (chrono.length < 4) return null;
  const half = Math.floor(chrono.length / 2);
  const avg = (xs: CustomerOrder[]) =>
    xs.reduce((a, o) => a + o.total, 0) / Math.max(1, xs.length);
  const first = avg(chrono.slice(0, half));
  if (first <= 0) return null;
  const second = avg(chrono.slice(half));
  return ((second - first) / first) * 100;
}

/** Mediana del intervalo entre compras (días). null si <2 fechas. */
function medianGapDays(chrono: CustomerOrder[]): number | null {
  const ds = chrono
    .map((o) => (o.date ? new Date(o.date) : null))
    .filter((d): d is Date => !!d && !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (ds.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < ds.length; i += 1) {
    gaps.push(Math.max(1, Math.round((ds[i].getTime() - ds[i - 1].getTime()) / 86_400_000)));
  }
  return Math.round(medianNum(gaps));
}

type TierBounds = [number, number, number];

/** Cuartil del ticket medio vs la tienda (misma regla que filtros/dashboard). */
function ticketQuartileLabel(avg: number, bounds: TierBounds | null | undefined): string | null {
  if (!bounds) return null;
  const [q1, med, q3] = bounds;
  if (avg <= q1) return "Q1";
  if (avg <= med) return "Q2";
  if (avg <= q3) return "Q3";
  return "Q4 · top 25%";
}

/** Posicionamiento en gasto desde el quintil M (M5 ≈ top 20%). */
function monetaryReach(m: number | null): string | null {
  if (m === null || m <= 1) return null;
  return `supera al ~${(m - 1) * 20}% en gasto`;
}

/** Acción sugerida por segmento (Putler/DinMo: cada segmento → próxima acción). */
const SEGMENT_ACTION: Record<string, string> = {
  "Campeón": "Pedir reseña o referido · no sobre-ofertar",
  "Recurrente": "Upsell / programa de fidelidad",
  "Ocasional": "Oferta limitada para activar 2ª compra",
  "Nuevo": "Onboarding + seguimiento temprano",
  "En riesgo": "Winback personalizado antes de perderlo",
  "Inactivo": "Reactivar con descuento relevante",
  "Sin compras": "Convertir primera compra",
};

function CumulativeSpark({ chrono }: { chrono: CustomerOrder[] }) {
  if (chrono.length === 0) return null;
  let acc = 0;
  const cum = chrono.map((o) => (acc += o.total));
  const max = Math.max(...cum, 1);
  const w = 100;
  const h = 36;
  const pts = cum
    .map((v, i) => {
      const x = chrono.length === 1 ? w : (i / (chrono.length - 1)) * w;
      const y = h - 3 - (v / max) * (h - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-9 w-full"
      role="img"
      aria-label={`Gasto acumulado en ${chrono.length} compras`}
      preserveAspectRatio="none"
    >
      <polyline points={pts} fill="none" strokeWidth="1.5" className="stroke-primary" />
    </svg>
  );
}

function PurchaseBars({ orders }: { orders: CustomerOrder[] }) {
  if (orders.length === 0) return null;
  const chrono = [...orders].reverse();
  const max = Math.max(...chrono.map((o) => o.total), 1);
  const first = chrono[0].date?.slice(0, 10) ?? "";
  const last = chrono[chrono.length - 1].date?.slice(0, 10) ?? "";
  return (
    <div>
      <div
        className="flex h-32 items-end gap-1.5"
        role="img"
        aria-label={`Historial de ${orders.length} compras`}
      >
        {chrono.map((o, i) => (
          <div
            key={i}
            title={`${o.date ? o.date.slice(0, 10) : "s/f"}: ${formatMoney(o.total, o.currency)}`}
            style={{ height: `${Math.max(6, Math.round((o.total / max) * 100))}%` }}
            className="min-w-0 flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{first}</span>
        <span>
          {orders.length} compra{orders.length === 1 ? "" : "s"}
        </span>
        <span>{last}</span>
      </div>
    </div>
  );
}

function ComprasTab({
  dbId,
  customerLabel,
  tierBounds,
  onGoAgent,
}: {
  dbId: string;
  customerLabel: string;
  tierBounds?: TierBounds | null;
  onGoAgent?: (prompt: string) => void;
}) {
  const [orders, setOrders] = useState<CustomerOrder[] | null>(null);
  const [summary, setSummary] = useState<CustomerRfm | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/customers/${dbId}/orders`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { orders?: CustomerOrder[]; summary?: CustomerRfm };
        if (alive) {
          setOrders(j.orders ?? []);
          setSummary(j.summary ?? null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "No se pudo cargar.");
      });
    return () => {
      alive = false;
    };
  }, [dbId]);

  if (error) return <p className="px-8 py-6 text-sm text-destructive">{error}</p>;
  if (!orders || !summary)
    return <p className="px-8 py-6 text-sm text-muted-foreground">Cargando compras…</p>;

  const recencyLabel =
    summary.recencyDays === null
      ? "—"
      : summary.recencyDays === 0
        ? "hoy"
        : summary.recencyDays === 1
          ? "ayer"
          : `hace ${summary.recencyDays} días`;

  // Derivados integradores (solo con lo ya cargado: orders + summary).
  const chrono = [...orders].reverse();
  const totals = chrono.map((o) => o.total);
  const tMin = totals.length > 0 ? Math.min(...totals) : 0;
  const tMax = totals.length > 0 ? Math.max(...totals) : 0;
  const tMed = totals.length > 0 ? Math.round(medianNum(totals)) : 0;
  const trend = ticketTrendPct(chrono);
  const gapMed = medianGapDays(chrono);
  const cycleSrc =
    summary.cycleSource === "cliente"
      ? "su ritmo"
      : summary.cycleSource === "tienda"
        ? "ritmo tienda"
        : summary.cycleSource === "arquetipo"
          ? "arquetipo"
          : null;
  const dueLabel =
    summary.dueStatus === "vencido" && summary.overdueDays !== null
      ? `vencido hace ${summary.overdueDays}d`
      : summary.dueStatus === "por_vencer"
        ? "por vencer"
        : summary.dueStatus === "al_dia"
          ? "al día"
          : null;
  const trendLabel =
    trend === null
      ? null
      : `${trend >= 0 ? "↑" : "↓"} ${Math.abs(Math.round(trend))}% vs primeras`;
  const firstDate = chrono[0]?.date?.slice(0, 10) ?? null;
  const lastDate = chrono[chrono.length - 1]?.date?.slice(0, 10) ?? null;
  const quartile = ticketQuartileLabel(summary.avgTicket, tierBounds);
  const reach = monetaryReach(summary.m);
  const suggestion = SEGMENT_ACTION[summary.segment] ?? null;
  const resumen =
    summary.frequency === 0
      ? "Sin compras registradas."
      : [
          `${summary.frequency} compra${summary.frequency === 1 ? "" : "s"}`,
          summary.expectedCycleDays !== null ? `cada ~${summary.expectedCycleDays}d` : null,
          `ticket ${formatMoney(summary.avgTicket, summary.currency)}`,
          trendLabel ? `(${trendLabel})` : null,
          `última ${recencyLabel}${dueLabel ? ` · ${dueLabel}` : ""}`,
        ]
          .filter(Boolean)
          .join(" · ");
  // Prompt con la recomendación + contexto para el agente (auto-envío al abrirlo).
  const agentPrompt =
    suggestion !== null && summary.frequency > 0
      ? [
          `El análisis de datos recomienda para ${customerLabel} [${summary.segment}]: ${suggestion}.`,
          `Contexto: ${resumen}.`,
          `Detalle: R${summary.r ?? "–"}/F${summary.f ?? "–"}/M${summary.m ?? "–"} vs la tienda; ticket prom. ${formatMoney(summary.avgTicket, summary.currency)} (rango ${formatMoney(tMin, summary.currency)}–${formatMoney(tMax, summary.currency)}, mediana ${formatMoney(tMed, summary.currency)}${quartile ? `, ${quartile}` : ""}${trendLabel ? `, ${trendLabel}` : ""}); ritmo esperado ~${summary.expectedCycleDays ?? "–"}d${cycleSrc ? ` (${cycleSrc})` : ""}${gapMed !== null ? `, observado ~${gapMed}d` : ""}; última compra ${recencyLabel}${dueLabel ? ` (${dueLabel})` : ""}.`,
          "¿Qué acción concreta propones para este cliente y por qué? Básate en su historial real.",
        ].join(" ")
      : null;
  // Riesgo churn: progreso recencia → umbral (ciclo × multiplicador).
  const churnMult = summary.churnMultiplier ?? 1.25;
  const churnThreshold =
    summary.expectedCycleDays !== null ? summary.expectedCycleDays * churnMult : null;
  const churnRatio =
    summary.recencyDays !== null && churnThreshold !== null && churnThreshold > 0
      ? Math.min(1, summary.recencyDays / churnThreshold)
      : null;
  const churnRemaining =
    summary.recencyDays !== null && churnThreshold !== null
      ? Math.ceil(churnThreshold - summary.recencyDays)
      : null;

  return (
    <div className="grid gap-5 px-8 py-6">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Badge
            className="text-[13px] font-medium"
            title={`Segmento RFM: R${summary.r ?? "–"}/F${summary.f ?? "–"}/M${summary.m ?? "–"} vs la tienda`}
          >
            {summary.segment}
          </Badge>
          {summary.noLosPierdas && (
            <Badge
              variant="destructive"
              className="text-[13px] font-medium"
              title="Top 20% gasto histórico e inactivo: prioridad de recuperación personal, no descuento genérico"
            >
              No los pierdas
            </Badge>
          )}
          <p className="text-[13px] text-muted-foreground tabular-nums">{resumen}</p>
        </div>
        {suggestion && (
          <p className="text-[13px] text-muted-foreground">
            Sugerencia: <span className="text-foreground">{suggestion}</span>
            {onGoAgent && agentPrompt && (
              <button
                type="button"
                onClick={() => onGoAgent(agentPrompt)}
                className="ml-2 text-[13px] text-primary underline-offset-2 hover:underline"
              >
                Abrir agente
              </button>
            )}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card title={`Recencia ${summary.r ?? "–"}/5 · Frecuencia ${summary.f ?? "–"}/5 · Monetario ${summary.m ?? "–"}/5 vs la tienda`}>
          <CardContent className="px-4 py-3.5">
            <p className="text-xs text-muted-foreground">Segmento</p>
            <p className="mt-1 truncate text-xl font-semibold">{summary.segment}</p>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              R{summary.r ?? "–"} · F{summary.f ?? "–"} · M{summary.m ?? "–"}
            </p>
          </CardContent>
        </Card>
        <Card
          title={
            summary.expectedCycleDays !== null
              ? `Ciclo esperado cada ${summary.expectedCycleDays}d (fuente: ${summary.cycleSource ?? "—"}) × ${summary.churnMultiplier ?? 1.25}`
              : "Sin ciclo esperado"
          }
        >
          <CardContent className="px-4 py-3.5">
            <p className="text-xs text-muted-foreground">Ritmo</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {summary.expectedCycleDays !== null ? `~${summary.expectedCycleDays}d` : "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {gapMed !== null ? `observado ~${gapMed}d · ` : ""}
              última {recencyLabel}
              {dueLabel ? ` · ${dueLabel}` : ""}
            </p>
            {churnRatio !== null && churnRemaining !== null && (
              <div
                className="mt-2"
                title={`Umbral churn ~${Math.round(churnThreshold ?? 0)}d (ciclo × ${churnMult})`}
              >
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${
                      churnRatio >= 1
                        ? "bg-destructive"
                        : churnRatio >= 0.8
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                    }`}
                    style={{ width: `${Math.round(churnRatio * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {churnRemaining >= 0
                    ? `quedan ~${churnRemaining}d al churn`
                    : dueLabel ?? "vencido"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
        <Card title={totals.length > 0 ? `Tickets: min ${formatMoney(tMin, summary.currency)} · mediana ${formatMoney(tMed, summary.currency)} · max ${formatMoney(tMax, summary.currency)} (últimas ${orders.length})` : "Sin tickets"}>
          <CardContent className="px-4 py-3.5">
            <p className="text-xs text-muted-foreground">Ticket prom.</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {formatMoney(summary.avgTicket, summary.currency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {totals.length > 0
                ? `${formatMoney(tMin, summary.currency)}–${formatMoney(tMax, summary.currency)}${quartile ? ` · ${quartile}` : ""}${trendLabel ? ` · ${trendLabel}` : ""}`
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card title={`Acumulado en ${summary.frequency} compras`}>
          <CardContent className="px-4 py-3.5">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {formatMoney(summary.monetary, summary.currency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {summary.frequency} compra{summary.frequency === 1 ? "" : "s"}
              {reach ? ` · ${reach}` : cycleSrc ? ` · ${cycleSrc}` : ""}
            </p>
          </CardContent>
        </Card>
      </div>

      {orders.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardContent className="px-4 py-3.5">
              <p className="text-xs font-medium">Ticket en el tiempo</p>
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                {firstDate ?? "—"} → {lastDate ?? "—"}
                {trendLabel ? ` · ${trendLabel}` : ""}
              </p>
              <div className="mt-2">
                <PurchaseBars orders={orders} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                mediana {formatMoney(tMed, summary.currency)} · rango {formatMoney(tMin, summary.currency)}–
                {formatMoney(tMax, summary.currency)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="px-4 py-3.5">
              <p className="text-xs font-medium">Trayectoria acumulada</p>
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                {formatMoney(summary.monetary, summary.currency)} en {summary.frequency} compras
              </p>
              <div className="mt-2">
                <CumulativeSpark chrono={chrono} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                {gapMed !== null ? `compra cada ~${gapMed}d (observado)` : "1 sola compra"}
                {summary.expectedCycleDays !== null && gapMed !== null
                  ? ` · esperado ~${summary.expectedCycleDays}d`
                  : ""}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {orders.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin compras registradas.</p>
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[112px] px-3">Fecha</TableHead>
              <TableHead className="px-3">Detalle</TableHead>
              <TableHead className="w-[96px] px-3 text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o, i) => (
              <TableRow key={i}>
                <TableCell className="whitespace-nowrap py-2.5 pl-2 pr-4 text-[13px] tabular-nums">
                  {o.date ? o.date.slice(0, 10) : "—"}
                </TableCell>
                <TableCell
                  className="px-3 py-2.5 text-[13px] text-muted-foreground"
                  title={o.items.map((it) => `${it.title} x${it.quantity}`).join("; ")}
                >
                  {o.items.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {o.items.map((it, j) => (
                        <div key={j} className="min-w-0">
                          <div className="break-words">
                            {it.title} x{it.quantity}
                          </div>
                          {it.contiene && (
                            <div className="break-words text-[12px]">
                              {it.contiene}
                              {it.categoria && (
                                <Badge
                                  variant="secondary"
                                  className="ml-1.5 border-primary/30 bg-primary/10 align-middle text-[11px] font-normal text-primary"
                                >
                                  {it.categoria}
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap px-3 py-2.5 text-right text-[13px] tabular-nums">
                  {formatMoney(o.total, o.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function CustomerDrawer({
  customer,
  onClose,
  initialTab = "datos",
  tierBounds = null,
}: {
  customer: EditableCustomer;
  onClose: () => void;
  initialTab?: "datos" | "compras" | "chat";
  tierBounds?: TierBounds | null;
}) {
  const [tab, setTab] = useState<"datos" | "compras" | "chat">(initialTab);
  // Prompt con la recomendación del análisis: se auto-envía al abrir el tab Agente.
  const [agentSeed, setAgentSeed] = useState<string | null>(null);

  const displayName = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
  const initials = (displayName || customer.email)
    .replace(/[^a-zA-Záéíóúñü@. ]/g, "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 data-[side=right]:sm:max-w-[min(920px,94vw)]">
        <div className="flex items-center gap-4 px-8 pt-6 pb-5">
          <div
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold tracking-wide text-primary"
          >
            {initials || "—"}
          </div>
          <div className="min-w-0 pr-8">
            <SheetTitle className="truncate text-lg">{displayName || "Sin nombre"}</SheetTitle>
            <SheetDescription className="truncate">{customer.email}</SheetDescription>
          </div>
        </div>

        <div className="flex gap-6 border-b px-8" role="tablist" aria-label="Ficha del customer">
          {(["datos", "compras", "chat"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`relative py-3 text-sm transition-colors ${
                tab === t ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "datos" ? "Datos" : t === "compras" ? "Compras" : "Agente"}
              {tab === t && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {tab === "datos" ? (
            <DatosTab customer={customer} onClose={onClose} />
          ) : tab === "compras" ? (
            <ComprasTab
              dbId={customer.dbId}
              customerLabel={displayName || customer.email}
              tierBounds={tierBounds}
              onGoAgent={(prompt) => {
                setAgentSeed(prompt);
                setTab("chat");
              }}
            />
          ) : (
            <CustomerChat
              dbId={customer.dbId}
              customerName={displayName || customer.email}
              initialPrompt={agentSeed}
              onInitialSent={() => setAgentSeed(null)}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
