"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "cn";

export interface AppSelectOption {
  value: string;
  label: string;
}

/** Select SSOT del proyecto: las etiquetas del trigger (`items`) y las
 *  opciones del popup (`children`) salen de la MISMA lista, así el trigger
 *  jamás muestra un id/uuid crudo. Vacío (`""`) = placeholder, nunca texto
 *  técnico. El popup hereda el auto-ancho de `SelectContent`.
 *  `allowClear` pinta la opción vacía con etiqueta (para limpiar opcionales);
 *  sin ella, el vacío solo muestra el placeholder. Ids huérfanos (empresa o
 *  contacto eliminado): el caller los agrega como opción con su etiqueta. */
export function AppSelect({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  name,
  disabled,
  invalid,
  allowClear = true,
  clearLabel = "Sin definir",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: AppSelectOption[];
  placeholder: string;
  ariaLabel: string;
  name?: string;
  disabled?: boolean;
  invalid?: boolean;
  allowClear?: boolean;
  clearLabel?: string;
  className?: string;
}) {
  const items = Object.fromEntries(options.filter((o) => o.value !== "").map((o) => [o.value, o.label]));
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "")} items={items} disabled={disabled}>
      <SelectTrigger name={name} aria-label={ariaLabel} aria-invalid={invalid} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowClear && <SelectItem value="">{clearLabel}</SelectItem>}
        {options
          .filter((o) => o.value !== "")
          .map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
