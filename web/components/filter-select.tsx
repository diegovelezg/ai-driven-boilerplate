"use client";

import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export { SelectItem };

/**
 * SSOT del select de filtro (filtros de Customers/Catálogo).
 * Trigger default sin overrides + items por
 * children. `display` personaliza la etiqueta (ver filtros de Customers).
 */
export function FilterSelect({
  value,
  onChange,
  ariaLabel,
  placeholder,
  display,
  items,
  disabled,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  display?: (value: string) => ReactNode;
  /** Mapa id→etiqueta para Base UI (trigger) cuando el popup aún no montó items. */
  items?: Record<string, ReactNode>;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v);
      }}
      items={items}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder}>{display}</SelectValue>
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
