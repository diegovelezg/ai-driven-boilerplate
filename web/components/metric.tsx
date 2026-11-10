import type { ComponentProps, ReactNode } from "react";
import { Minus, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { formatPercentPoints } from "@/lib/format";

/**
 * SSOT de métricas (KPIs): cada métrica es una mini-card (borde + fondo
 * propios) con ícono, valor grande y contexto opcional (variación + hint).
 * La fila superior de cada vista usa este componente dentro de un `AppCard`
 * con `MetricRow`: mismo tamaño, mismos colores y mismos íconos en Hoy,
 * Finanzas, Órdenes y Contactos. No inventar otro estilo de KPI fuera de aquí.
 */
export type MetricTone = "default" | "primary" | "success" | "warning" | "danger";

const TONE_VALUE: Record<MetricTone, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
};

const TONE_ICON_BOX: Record<MetricTone, string> = {
  default: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  danger: "bg-destructive/10 text-destructive",
};

/**
 * Variación estándar de una métrica (vs periodo previo). Verde = mejora,
 * rojo = empeora; `invert` cuando bajar es bueno (vencido, por certificar).
 * null = sin base previa, 0 = estable.
 */
function MetricDelta({
  pct,
  label = "vs 30d previos",
  invert = false,
  className,
}: {
  pct: number | null;
  label?: ReactNode;
  invert?: boolean;
  className?: string;
}) {
  if (pct === null) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        sin base previa
      </span>
    );
  }
  if (pct === 0) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums", className)}>
        <Minus aria-hidden className="size-3.5" />
        igual que antes
      </span>
    );
  }
  const up = pct > 0;
  const good = invert ? !up : up;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium tabular-nums",
        good ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
        className,
      )}
      aria-label={`${up ? "+" : "−"}${formatPercentPoints(Math.abs(pct))} ${typeof label === "string" ? label : ""}`.trim()}
    >
      <Icon aria-hidden className="size-3.5" />
      {up ? "+" : "−"}
      {formatPercentPoints(Math.abs(pct))} {label}
    </span>
  );
}

export function Metric({
  label,
  value,
  hint,
  tone = "default",
  icon,
  delta,
  deltaLabel,
  invertDelta = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: MetricTone;
  icon?: LucideIcon;
  delta?: number | null;
  deltaLabel?: ReactNode;
  invertDelta?: boolean;
  className?: string;
}) {
  const Icon = icon;
  const showFoot = delta !== undefined || hint !== undefined;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl bg-muted/40 p-4 ring-1 ring-foreground/10",
        className,
      )}
    >
      <span className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {Icon && (
          <span
            aria-hidden
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              TONE_ICON_BOX[tone],
            )}
          >
            <Icon className="size-4" />
          </span>
        )}
        <span className="min-w-0 truncate">{label}</span>
      </span>
      <span
        className={cn(
          "text-2xl leading-tight font-semibold tracking-tight break-words tabular-nums",
          TONE_VALUE[tone],
        )}
      >
        {value}
      </span>
      {showFoot && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-relaxed text-muted-foreground tabular-nums">
          {delta !== undefined && (
            <MetricDelta pct={delta} label={deltaLabel} invert={invertDelta} />
          )}
          {hint !== undefined && <span className="min-w-0 break-words">{hint}</span>}
        </span>
      )}
    </div>
  );
}

const COLUMNS: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
};

/** Fila de mini-cards de métricas: gutter compacto y columnas por breakpoint. */
export function MetricRow({
  columns = 4,
  className,
  children,
  ...rest
}: {
  columns?: 2 | 3 | 4 | 5;
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<"div">, "className" | "children">) {
  return (
    <div className={cn("grid items-stretch gap-3 sm:gap-4", COLUMNS[columns], className)} {...rest}>
      {children}
    </div>
  );
}
