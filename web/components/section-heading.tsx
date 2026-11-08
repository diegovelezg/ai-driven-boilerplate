import type { ReactNode } from "react";
import { cn } from "cn";

export type SectionTone =
  | "primary"
  | "emerald"
  | "amber"
  | "sky"
  | "violet"
  | "rose"
  | "cyan"
  | "orange";

const TONES: Record<SectionTone, string> = {
  primary: "bg-primary",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  rose: "bg-rose-500",
  cyan: "bg-cyan-500",
  orange: "bg-orange-500",
};

/** Encabezado de sección: barra de acento, título y bajada corta.
 *  Unifica Home, Review, Finanzas, Customers y Settings. */
export function SectionHeading({
  title,
  hint,
  tone = "primary",
  right,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  tone?: SectionTone;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-start justify-between gap-2", className)}>
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={cn("mt-1.5 h-4 w-1 shrink-0 rounded-full", TONES[tone])}
        />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {hint && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {hint}
            </p>
          )}
        </div>
      </div>
      {right}
    </div>
  );
}
