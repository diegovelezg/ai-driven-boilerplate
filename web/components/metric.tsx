import type { ComponentProps, ReactNode } from "react";
import { cn } from "cn";

/**
 * SSOT de métricas (KPIs) planas: etiqueta pequeña y en muted, valor grande
 * en foreground y contexto opcional. Nunca se envuelven en cajas: la
 * separación la da el espaciado de `MetricRow`.
 */
export type MetricTone = "default" | "primary" | "success" | "warning" | "danger";

const TONE_VALUE: Record<MetricTone, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
};

export function Metric({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: MetricTone;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span
        className={cn(
          "text-2xl leading-tight font-semibold tracking-tight tabular-nums",
          TONE_VALUE[tone],
        )}
      >
        {value}
      </span>
      {hint !== undefined && (
        <span className="text-xs leading-relaxed text-muted-foreground tabular-nums">{hint}</span>
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

/** Fila de métricas separadas por aire (sin bordes ni tarjetas). */
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
    <div className={cn("grid gap-x-8 gap-y-6", COLUMNS[columns], className)} {...rest}>
      {children}
    </div>
  );
}
