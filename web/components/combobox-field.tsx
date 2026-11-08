"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

/** Campo autocomplete reutilizable (Combobox nativo shadcn).
 *  Escribe para filtrar, elige sugerencia o fija texto libre. El texto libre
 *  confirmado se vuelve item real: si no, Base UI lo borra al cerrar
 *  (sincroniza el input al valor seleccionado = null → "").
 *  `displayItem` solo cambia cómo se ve la sugerencia; el valor guardado es el
 *  original. `allowCustom={false}` lo vuelve selección estricta de la lista. */
export function ComboboxField({
  items,
  value,
  onChange,
  placeholder,
  emptyText = "Sin resultados.",
  customLabel,
  allowCustom = true,
  displayItem,
  disabled,
  ariaLabel,
}: {
  items: string[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  emptyText?: string;
  customLabel?: (query: string) => ReactNode;
  allowCustom?: boolean;
  displayItem?: (item: string) => ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [customs, setCustoms] = useState<string[]>([]);

  // El padre puede resetear/fijar `value` (p. ej. limpiar el form):
  // el texto visible lo sigue. Sin esto el input queda stale.
  useEffect(() => {
    setQuery(value);
  }, [value]);

  const allItems = useMemo(() => {
    const base = [...items];
    for (const c of customs) if (!base.includes(c)) base.push(c);
    return base;
  }, [items, customs]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allItems;
    return allItems.filter((b) => b.toLowerCase().includes(needle));
  }, [allItems, query]);

  const showItem = displayItem ?? ((b: string) => b);

  const commitCustom = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (!items.includes(v)) setCustoms((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setQuery(v);
    onChange(v);
    setOpen(false);
  };

  return (
    <Combobox
      items={matches}
      value={allItems.includes(query) ? query : null}
      onValueChange={(v) => {
        if (typeof v === "string") {
          setQuery(v);
          onChange(v);
        }
      }}
      inputValue={query}
      onInputValueChange={(v) => {
        setQuery(v);
        onChange(v);
      }}
      onItemHighlighted={(v) => setHighlighted(typeof v === "string" ? v : null)}
      open={open}
      onOpenChange={setOpen}
      autoHighlight
    >
      <ComboboxInput
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        className="w-full"
        onBlur={() => {
          if (allowCustom && query.trim() && !allItems.includes(query.trim())) commitCustom(query);
        }}
        onKeyDown={(e) => {
          if (!allowCustom || e.key !== "Enter" || highlighted) return;
          const q = query.trim();
          if (!q || allItems.includes(q)) return;
          e.preventDefault();
          commitCustom(q);
        }}
      />
      <ComboboxContent>
        <ComboboxEmpty>
          {allowCustom && query.trim() !== "" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start font-normal"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commitCustom(query)}
            >
              {customLabel ? customLabel(query.trim()) : <>Usar “{query.trim()}”</>}
            </Button>
          ) : (
            emptyText
          )}
        </ComboboxEmpty>
        <ComboboxList>
          {(b: string) => (
            <ComboboxItem key={b} value={b}>
              <span className="flex-1 truncate">{showItem(b)}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
