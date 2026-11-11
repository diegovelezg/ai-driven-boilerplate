"use client";

import { useState, useTransition } from "react";
import { SubmitButton } from "@/components/buttons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COMPANY_KINDS, COMPANY_KIND_LABELS, isCompanyKind, type CompanyKind } from "@/lib/crm";
import { setCompanyKindAction } from "@/lib/crm-actions";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";

export function KindForm({ companyId, initial, onSaved }: { companyId: string; initial: string | null; onSaved?: () => void }) {
  // Legacy con kind null llega como "": se fuerza a elegir un tipo válido.
  const [kind, setKind] = useState<string>(initial ?? "");
  const [pending, startTransition] = useTransition();
  const { invalid, mark, clear, bad } = useInvalidFields<"kind">();

  const ready = isCompanyKind(kind);

  function save() {
    if (!ready) {
      mark(["kind"]);
      toastFormError("Revisa el campo marcado", "Elige un tipo: agencia, anunciante o proveedor.");
      return;
    }
    const next: CompanyKind = kind;
    startTransition(async () => {
      const res = await setCompanyKindAction({ companyId, kind: next });
      if (!res.ok) {
        mark(["kind"]);
        toastFormError("No se pudo guardar el tipo", res.message);
        return;
      }
      onSaved?.();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="form-field">
          Tipo
          <Select
            value={kind}
            onValueChange={(v) => {
              if (v) {
                setKind(v);
                clear("kind");
              }
            }}
            items={Object.fromEntries(
              COMPANY_KINDS.map((k) => [k, COMPANY_KIND_LABELS[k]]),
            )}
            disabled={pending}
          >
            <SelectTrigger aria-label="Tipo" aria-invalid={invalid.has("kind")} className={invalid.has("kind") ? bad("kind").trim() : undefined}>
              <SelectValue placeholder="Elegir tipo…" />
            </SelectTrigger>
            <SelectContent>
              {COMPANY_KINDS.map((k) => (
                <SelectItem key={k} value={k}>{COMPANY_KIND_LABELS[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <SubmitButton onClick={save} pending={pending} disabled={!ready} title={!ready ? "Elige un tipo para continuar" : undefined}>Guardar</SubmitButton>
      </div>
    </div>
  );
}
