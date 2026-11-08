"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "cn";
import { Input } from "@/components/ui/input";

/**
 * Puro: ¿qué debe mostrar el input ante un cambio de la URL?
 * Solo adopta `initialValue` si el usuario NO está escribiendo otra cosa
 * (`query === prevProp`, o sea, el input reflejaba la URL anterior).
 * Durante una navegación pendiente la URL sigue vieja y `query` es lo
 * tipeado → se conserva (sobrescribirlo era el parpadeo al término anterior).
 */
export function nextQueryOnProp(query: string, prevProp: string, initialValue: string): string {
  if (prevProp === initialValue) return query;
  return query === prevProp ? initialValue : query;
}

/** Puro: decisión del debounce ante (input, URL, último enviado). */
export function searchSendDecision(
  query: string,
  initialValue: string,
  lastSent: string,
): "synced" | "sent" | "send" {
  if (query === initialValue) return "synced";
  if (query === lastSent) return "sent";
  return "send";
}

/**
 * SSOT del buscador libre con debounce (filtros de Customers/Catálogo).
 * Estado interno + aviso a `onSearch` tras `delay` ms; el padre navega
 * (construye la URL con sus filtros). Sin acoplar a rutas: no reinventar
 * inputs con debounce por vista.
 *
 * Limpiar (X / Escape) navega de inmediato, sin esperar el debounce.
 * Sin efectos para sincronizar props→estado: ajuste durante el render
 * (patrón React "adjust state during render", sin cascadas).
 */
export function FilterSearch({
  initialValue,
  onSearch,
  placeholder,
  ariaLabel,
  delay = 300,
  className,
}: {
  initialValue: string;
  onSearch: (query: string) => void;
  placeholder: string;
  ariaLabel?: string;
  delay?: number;
  className?: string;
}) {
  const [query, setQuery] = useState(initialValue);
  // URL del render anterior. Si cambia y el input la reflejaba, se adopta
  // (Limpiar del padre, back/forward). Si el usuario tipeaba otra cosa
  // (navegación pendiente), NO se toca: evita el parpadeo y no pierde teclas.
  const [prevProp, setPrevProp] = useState(initialValue);
  if (prevProp !== initialValue) {
    setPrevProp(initialValue);
    setQuery(nextQueryOnProp(query, prevProp, initialValue));
  }
  const onSearchRef = useRef(onSearch);
  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);
  // Último valor enviado al padre. Frena el reenvío durante la navegación
  // pendiente (URL vieja, input ya enviado).
  const lastSent = useRef(initialValue);

  useEffect(() => {
    const decision = searchSendDecision(query, initialValue, lastSent.current);
    if (decision !== "send") {
      if (decision === "synced") lastSent.current = query;
      return;
    }
    const t = setTimeout(() => {
      lastSent.current = query;
      onSearchRef.current(query);
    }, delay);
    return () => clearTimeout(t);
  }, [query, initialValue, delay]);

  const clear = () => {
    if (query === "") return;
    lastSent.current = "";
    setQuery("");
    onSearchRef.current("");
  };

  return (
    <div className={cn("relative max-w-sm flex-1 basis-52", className)}>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) clear();
        }}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className="pr-8"
      />
      {query && (
        <button
          type="button"
          onClick={clear}
          aria-label="Limpiar búsqueda"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
