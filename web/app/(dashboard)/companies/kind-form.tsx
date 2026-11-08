"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COMPANY_KINDS, COMPANY_KIND_LABELS, isCompanyKind, type CompanyKind } from "@/lib/crm";
import { setCompanyKindAction } from "@/lib/crm-actions";

export function KindForm({ companyId, initial, onSaved }: { companyId: string; initial: string | null; onSaved?: () => void }) {
  // Legacy con kind null llega como "": se fuerza a elegir un tipo válido.
  const [kind, setKind] = useState<string>(initial ?? "");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    setMsg(null);
    if (!isCompanyKind(kind)) {
      setMsg("Elige un tipo: agencia, anunciante o proveedor.");
      return;
    }
    const next: CompanyKind = kind;
    startTransition(async () => {
      const res = await setCompanyKindAction({ companyId, kind: next });
      setMsg(res.message);
      if (res.ok) onSaved?.();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs">
          Tipo
          <Select
            value={kind}
            onValueChange={(v) => {
              if (v) setKind(v);
            }}
            items={Object.fromEntries(
              COMPANY_KINDS.map((k) => [k, COMPANY_KIND_LABELS[k]]),
            )}
            disabled={pending}
          >
            <SelectTrigger aria-label="Tipo">
              <SelectValue placeholder="Elegir tipo…" />
            </SelectTrigger>
            <SelectContent>
              {COMPANY_KINDS.map((k) => (
                <SelectItem key={k} value={k}>{COMPANY_KIND_LABELS[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={save} disabled={pending}>{pending ? "Guardando…" : "Guardar"}</Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}
