import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "cn";
import { Button } from "./ui/button";

/** Cabecera de página: eyebrow, título, descripción y acción opcional.
 *  Alinea la jerarquía de Home, Review, Finanzas, Customers y Settings.
 *  `backHref` pinta un "Volver" siempre en el mismo sitio (arriba-izquierda,
 *  encima del eyebrow): las vistas de creación lo usan en vez del slot `right`,
 *  que hace wrap según el viewport y movía el botón de sitio. */
export function PageHeader({
  eyebrow,
  title,
  description,
  badge,
  right,
  backHref,
  backLabel = "Volver",
  pulse = false,
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  right?: ReactNode;
  backHref?: string;
  backLabel?: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {backHref && (
        <Button
          render={<Link href={backHref} />}
          nativeButton={false}
          size="sm"
          variant="ghost"
          className="w-fit -ml-2 text-muted-foreground"
        >
          <ArrowLeft aria-hidden />
          {backLabel}
        </Button>
      )}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-72 flex-col gap-2">
          <span className="inline-flex w-fit items-center gap-2 text-xs font-medium tracking-[0.12em] text-primary uppercase">
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full bg-primary", pulse && "animate-pulse")}
            />
            {eyebrow}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="max-w-3xl text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
              {title}
            </h1>
            {badge}
          </div>
          {description && (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {right}
      </header>
    </div>
  );
}
