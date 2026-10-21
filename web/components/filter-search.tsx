"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "cn";
import { Input } from "@/components/ui/input";

/**
 * SSOT del buscador libre con debounce (filtros de Customers/Catálogo).
 * Estado interno + aviso a `onSearch` tras `delay` ms; el padre navega
 * (construye la URL con sus filtros). Sin acoplar a rutas: no reinventar
 * inputs con debounce por vista.
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
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  // Sincroniza si el valor commiteado cambia por navegación externa.
  useEffect(() => {
    const t = setTimeout(() => setQuery((prev) => (prev === initialValue ? prev : initialValue)), 0);
    return () => clearTimeout(t);
  }, [initialValue]);

  useEffect(() => {
    if (query === initialValue) return;
    const t = setTimeout(() => onSearchRef.current(query), delay);
    return () => clearTimeout(t);
  }, [query, initialValue, delay]);

  return (
    <div className={cn("relative max-w-sm flex-1 basis-52", className)}>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) setQuery("");
        }}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className="bg-background pr-8"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery("")}
          aria-label="Limpiar búsqueda"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
