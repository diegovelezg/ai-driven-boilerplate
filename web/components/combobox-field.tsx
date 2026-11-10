"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

/** Autocomplete estándar reutilizable (Base UI Combobox vía ui/combobox).
 *  Escribe para filtrar, elige de la lista o fija texto libre.
 *  - X limpia lo escrito/seleccionado y reabre la lista (reselect).
 *  - El valor solo se propaga al elegir, con Enter, con el botón
 *    Usar "..." o al perder foco. Escribir no contamina al padre.
 *  - Escape revierte al valor confirmado. Sin `allowCustom` el texto
 *    ajeno a la lista se revierte al perder foco o cerrar.
 *  - `displayItem` solo cambia cómo se ve la sugerencia en la lista. */
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  // El padre puede resetear/fijar `value` (p. ej. limpiar el form):
  // ajuste durante el render, sin efecto (patrón del proyecto, sin cascadas).
  // Mientras el usuario escribe, `value` no cambia y no se toca el texto.
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setQuery(value);
  }

  const allItems = useMemo(() => {
    const base = [...items];
    for (const c of customs) if (!base.includes(c)) base.push(c);
    return base;
  }, [items, customs]);

  const trimmed = query.trim();
  const isKnown = trimmed !== "" && allItems.includes(trimmed);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allItems;
    return allItems.filter((b) => b.toLowerCase().includes(needle));
  }, [allItems, query]);

  const showItem = displayItem ?? ((b: string) => b);

  function commit(v: string) {
    const t = v.trim();
    if (!t) {
      setQuery("");
      if (value !== "") onChange("");
      setOpen(false);
      return;
    }
    if (!allItems.includes(t)) {
      if (!allowCustom) {
        setQuery(value);
        setOpen(false);
        return;
      }
      setCustoms((prev) => (prev.includes(t) ? prev : [...prev, t]));
    }
    setQuery(t);
    if (t !== value) onChange(t);
    setOpen(false);
  }

  function handleClear() {
    setQuery("");
    if (value !== "") onChange("");
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleBlur() {
    if (!trimmed) {
      if (value !== "") {
        setQuery("");
        onChange("");
      }
      return;
    }
    // Click en "Usar ..." hace mousedown preventDefault: no hay blur.
    if (allItems.includes(trimmed)) {
      if (trimmed !== value) {
        setQuery(trimmed);
        onChange(trimmed);
      } else if (query !== trimmed) {
        setQuery(trimmed);
      }
      return;
    }
    if (allowCustom) commit(trimmed);
    else setQuery(value);
  }

  return (
    <Combobox
      items={matches}
      value={isKnown ? trimmed : null}
      onValueChange={(v) => {
        if (typeof v !== "string") return;
        setQuery(v);
        if (v !== value) onChange(v);
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      onItemHighlighted={(v) => setHighlighted(typeof v === "string" ? v : null)}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && !allowCustom && !allItems.includes(query.trim())) {
          setQuery(value);
        }
      }}
      autoHighlight
    >
      <ComboboxInput
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        className="w-full"
        inputRef={inputRef}
        onClear={handleClear}
        clearVisible={query !== "" && !disabled}
        onBlur={handleBlur}
        onFocus={(e) => {
          if (disabled) return;
          setOpen(true);
          // Texto seleccionado: escribir reemplaza, borrar muestra todo.
          e.currentTarget.select();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (query !== value) {
              e.preventDefault();
              setQuery(value);
            }
            setOpen(false);
            return;
          }
          if (!allowCustom || e.key !== "Enter" || highlighted) return;
          if (!trimmed || allItems.includes(trimmed)) return;
          e.preventDefault();
          commit(trimmed);
        }}
      />
      <ComboboxContent>
        <ComboboxEmpty>
          {allowCustom && trimmed !== "" && !isKnown ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start font-normal"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                commit(trimmed);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              {customLabel ? customLabel(trimmed) : <>Usar “{trimmed}”</>}
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
