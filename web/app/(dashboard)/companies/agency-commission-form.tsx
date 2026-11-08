"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { normalizeCommissionPct } from "@/lib/agency-commission";
import { setAgencyCommissionAction } from "@/lib/crm-actions";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";

/** Comisión de agencia: solo visible/gestionable por owner/admin (el padre hace gating). */
export function AgencyCommissionForm({
  companyId,
  initial,
  onSaved,
}: {
  companyId: string;
  initial: number | null;
  onSaved?: () => void;
}) {
  const [value, setValue] = useState<string>(initial !== null ? String(initial) : "");
  const [pending, startTransition] = useTransition();
  const { invalid, mark, clear, bad } = useInvalidFields<"commission">();

  function save() {
    const trimmed = value.trim();
    if (trimmed !== "" && normalizeCommissionPct(trimmed) === null) {
      mark(["commission"]);
      toastFormError("Revisa el campo marcado", "Comisión inválida (entero 0-100).");
      return;
    }
    startTransition(async () => {
      const res = await setAgencyCommissionAction({
        companyId,
        pct: trimmed === "" ? null : trimmed,
      });
      if (!res.ok) {
        mark(["commission"]);
        toastFormError("No se pudo guardar la comisión", res.message);
        return;
      }
      onSaved?.();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="flex items-center gap-1">
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value.replace(/[^0-9]/g, ""));
                clear("commission");
              }}
              inputMode="numeric"
              placeholder="p. ej. 15"
              aria-label="Comisión agencia en porcentaje"
              aria-invalid={invalid.has("commission")}
              className={`h-9 w-28 rounded-lg border border-border bg-background px-2.5 text-center text-sm tabular-nums${bad("commission")}`}
            />
            <span className="text-muted-foreground">%</span>
          </span>
        </label>
        <Button onClick={save} disabled={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Vacío = sin acuerdo (0% efectivo).
      </p>
    </div>
  );
}
