import { Skeleton } from "@/components/ui/skeleton";

/**
 * Regla global: sección vacía + trabajo en bg en curso → skeleton +
 * "Generando…", nunca un vacío engañoso ("sin resultados", "todo al día").
 * Úsalo en cualquier sección alimentada por agentes de fondo.
 */
export function SectionLoading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={`Generando ${label}`} className="flex flex-col gap-2">
      <p className="text-[13px] text-muted-foreground">Generando {label}…</p>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}
