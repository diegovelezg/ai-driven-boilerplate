"use client";

import type { ReactNode } from "react";
import { cn } from "cn";
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
 * Trigger estándar (`bg-background`, ancho configurable) + items por
 * children. `display` personaliza la etiqueta (ver filtros de Customers).
 */
export function FilterSelect({
  value,
  onChange,
  ariaLabel,
  widthClass = "w-44",
  placeholder,
  display,
  items,
  disabled,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  widthClass?: string;
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
      <SelectTrigger
        size="sm"
        className={cn(widthClass, "bg-background text-[0.8rem]")}
        aria-label={ariaLabel}
      >
        <SelectValue placeholder={placeholder}>{display}</SelectValue>
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
