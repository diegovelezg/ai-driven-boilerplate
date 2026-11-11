"use client";

// SSOT de listas por entidad (issue #8 P2 + drawer↔URL issue #9).
//
// Las 5 listas (companies/contacts/orders/screens/brands) comparten chrome:
// selección con deep-link en la URL, conteo honesto (truncated), vacíos y
// paginación. Lo que difiere por dominio (columnas, filtros, tarjetas, drawers)
// vive en cada archivo de lista; este módulo es el único dueño de:
// - `useEntitySelection`: selectedId ↔ ?param=. Abrir escribe el param,
//   cerrar lo borra, y un cambio externo de URL (back/forward, deep-link)
//   sincroniza el estado. Nunca `setSelectedId` suelto.
// - `EntityCount`: "N resultados" + "muestra parcial" cuando truncated.
// - `EntityEmpty`: vacío con SearchX + acción Limpiar.
// - `EntityPagination`: Anterior/Siguiente con "Página x de y".
// - `useListNav`: navegación de lista (replace con transition para no
//   bloquear el render). Recibe la query ya construida por el `buildParams`
//   de cada lista; los params que existen difieren por dominio y se quedan
//   en cada archivo.
import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, FilterX, SearchX } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";

/** Selección con deep-link: `param` es el canónico que se escribe en la URL,
 *  `aliases` son los que también se borran al cerrar (p. ej. marca/brand). */
export function useEntitySelection(
  basePath: string,
  param: string,
  initialId: string | null,
  aliases: string[] = [],
): {
  selectedId: string | null;
  open: (id: string) => void;
  close: () => void;
} {
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  // La URL manda: deep-link, back/forward o navegación del servidor.
  useEffect(() => {
    setSelectedId(initialId);
  }, [initialId]);
  const router = useRouter();
  const [, startTransition] = useTransition();

  const open = useCallback(
    (id: string) => {
      setSelectedId(id);
      startTransition(() => {
        const params = new URLSearchParams(window.location.search);
        params.set(param, id);
        router.replace(`${basePath}?${params.toString()}`, { scroll: false });
      });
    },
    [basePath, param, router],
  );

  const close = useCallback(() => {
    setSelectedId(null);
    startTransition(() => {
      const params = new URLSearchParams(window.location.search);
      params.delete(param);
      for (const a of aliases) params.delete(a);
      const qs = params.toString();
      router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
    });
  }, [aliases, basePath, param, router]);

  return { selectedId, open, close };
}

/** Navegación de lista: `router.replace` con transition para no bloquear el
 *  render (botones deshabilitados vía `isPending`). Recibe la query ya
 *  construida por el `buildParams` de cada lista. */
export function useListNav(basePath: string): {
  go: (qs: string, opts?: { scroll?: boolean }) => void;
  isPending: boolean;
} {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const go = useCallback(
    (qs: string, opts?: { scroll?: boolean }) => {
      startTransition(() => {
        router.replace(`${basePath}?${qs}`, opts);
      });
    },
    [router, basePath],
  );
  return { go, isPending };
}

/** "N resultados" (+ "· muestra parcial" si la fuente se truncó). */
export function EntityCount({
  total,
  truncated = false,
  pending = false,
  pendingLabel = "Buscando…",
  singular = "resultado",
  plural = "resultados",
}: {
  total: number;
  truncated?: boolean;
  pending?: boolean;
  pendingLabel?: string;
  singular?: string;
  plural?: string;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="ms-auto text-xs text-muted-foreground tabular-nums"
      title={truncated ? "Muestra parcial: la fuente se truncó por límite" : undefined}
    >
      {pending
        ? pendingLabel
        : `${formatNumber(total)} ${total === 1 ? singular : plural}${truncated ? " · muestra parcial" : ""}`}
    </span>
  );
}

/** Estado vacío con SearchX: mismo en tabla y grilla.
 *  `inline` evita la Card cuando ya se está dentro de una (p. ej. celda
 *  vacía de una tabla): nunca anidar tarjetas. */
export function EntityEmpty({
  filtered,
  emptyTitle,
  emptyHint,
  filteredTitle = "Sin resultados para ese filtro",
  filteredHint = "Prueba con otro término.",
  onClear,
  inline = false,
}: {
  filtered: boolean;
  emptyTitle: string;
  emptyHint: string;
  filteredTitle?: string;
  filteredHint?: string;
  onClear?: () => void;
  inline?: boolean;
}) {
  const body = (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-3 py-10 text-center">
      <span
        className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-hidden
      >
        <SearchX className="size-5" />
      </span>
      <p className="text-sm font-medium">{filtered ? filteredTitle : emptyTitle}</p>
      <p className="text-sm leading-relaxed text-muted-foreground">{filtered ? filteredHint : emptyHint}</p>
      {filtered && onClear && (
        <Button variant="outline" size="sm" className="mt-1" onClick={onClear}>
          <FilterX aria-hidden />
          Limpiar filtros
        </Button>
      )}
    </div>
  );
  return inline ? body : <AppCard>{body}</AppCard>;
}

/** Paginador Anterior/Siguiente ("Página x de y"). */
export function EntityPagination({
  page,
  totalPages,
  pending = false,
  onGo,
}: {
  page: number;
  totalPages: number;
  pending?: boolean;
  onGo: (next: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground tabular-nums">
        Página {formatNumber(page)} de {formatNumber(totalPages)}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1 || pending} onClick={() => onGo(page - 1)}>
          <ChevronLeft aria-hidden />
          Anterior
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages || pending}
          onClick={() => onGo(page + 1)}
        >
          Siguiente
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </div>
  );
}
