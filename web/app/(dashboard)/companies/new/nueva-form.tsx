"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COMPANY_KINDS, COMPANY_KIND_LABELS } from "@/lib/crm";
import { createCompanyRedirectAction, type CrmState } from "@/lib/crm-actions";

const initial: CrmState = { ok: false, message: "" };

export function NuevaEmpresaForm({ canManageCommission = true }: { canManageCommission?: boolean }) {
  const [state, action, pending] = useActionState(createCompanyRedirectAction, initial);
  const [kind, setKind] = useState<string>("anunciante");
  const showCommission = canManageCommission && kind === "agencia";

  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-xs">
        Nombre *
        <input name="name" required maxLength={200} placeholder="Acme S.A.C." className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
      </label>
      <div className="flex flex-col gap-1 text-xs">
        Tipo
        <input type="hidden" name="kind" value={kind} />
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
          <SelectTrigger aria-label="Tipo" className="h-9 w-56 bg-background text-sm">
            <SelectValue placeholder="Elegir tipo…" />
          </SelectTrigger>
          <SelectContent>
            {COMPANY_KINDS.map((k) => (
              <SelectItem key={k} value={k}>{COMPANY_KIND_LABELS[k]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {showCommission && (
        <label className="flex flex-col gap-1 text-xs">
          Comisión agencia (% sobre bruto)
          <span className="flex items-center gap-1">
            <input
              name="agency_commission_pct"
              inputMode="decimal"
              placeholder="p. ej. 15"
              aria-label="Comisión agencia en porcentaje"
              className="h-9 w-32 rounded-lg border border-border bg-background px-2.5 text-sm"
            />
            <span className="text-muted-foreground">%</span>
          </span>
          <span className="text-[11px] text-muted-foreground">
            Solo agencias. Vacío = sin acuerdo (0% efectivo). Solo owner/admin.
          </span>
        </label>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          ID fiscal
          <input name="tax_id" maxLength={40} placeholder="20123456789" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Dominio
          <input name="domain" maxLength={253} placeholder="acme.pe" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Email
          <input name="email" maxLength={320} placeholder="contacto@acme.pe" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Teléfono
          <input name="phone" maxLength={40} placeholder="+51…" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Ciudad
          <input name="city" maxLength={120} placeholder="Lima" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          País (ISO2)
          <input name="country" maxLength={2} placeholder="PE" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        Dirección
        <input name="address" maxLength={300} className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
      </label>
      {state.message && (
        <p className="text-xs text-destructive" role="alert">{state.message}</p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Creando…" : "Crear empresa"}</Button>
      </div>
    </form>
  );
}
