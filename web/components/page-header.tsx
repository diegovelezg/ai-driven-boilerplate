import type { ReactNode } from "react";
import { cn } from "cn";

/** Cabecera de página: eyebrow, título, descripción y acción opcional.
 *  Alinea la jerarquía de Home, Review, Finanzas, Customers y Settings. */
export function PageHeader({
  eyebrow,
  title,
  description,
  badge,
  right,
  pulse = false,
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  right?: ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="flex flex-col gap-1.5">
        <span className="inline-flex w-fit items-center gap-1.5 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full bg-primary", pulse && "animate-pulse")}
          />
          {eyebrow}
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="max-w-3xl text-2xl font-semibold tracking-tight text-balance md:text-3xl">
            {title}
          </h1>
          {badge}
        </div>
        {description && (
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {right}
    </header>
  );
}
