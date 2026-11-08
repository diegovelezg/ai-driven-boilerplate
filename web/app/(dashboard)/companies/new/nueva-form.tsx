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
import { RestrictedVisibilityBadge } from "@/components/role-badges";
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        {showCommission && (
          <label className="flex flex-col gap-1 text-xs">
            <span className="flex flex-wrap items-center gap-2">
              Comisión %
              <RestrictedVisibilityBadge minRole="admin" />
            </span>
            <span className="flex items-center gap-1">
              <input
                name="agency_commission_pct"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="p. ej. 15"
                aria-label="Comisión agencia en porcentaje"
                className="h-9 w-32 rounded-lg border border-border bg-background px-2.5 text-center text-sm tabular-nums"
              />
              <span className="text-muted-foreground">%</span>
            </span>
          </label>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          ID fiscal
          <input name="tax_id" maxLength={40} placeholder="20123456789" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Web
          <input name="domain" maxLength={253} placeholder="acme.pe" inputMode="url" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Teléfono
          <input name="phone" type="tel" maxLength={40} placeholder="+51…" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          Dirección
          <input name="address" maxLength={300} placeholder="Av. …" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Ciudad
          <input name="city" maxLength={120} placeholder="Lima" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          País (ISO2)
          <input name="country" maxLength={2} minLength={2} pattern="[A-Za-z]{2}" placeholder="PE" autoComplete="country" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm uppercase" />
        </label>
      </div>
      {state.message && (
        <p className="text-xs text-destructive" role="alert">{state.message}</p>
      )}
      <div>
        <Button type="submit" disabled={pending}>{pending ? "Creando…" : "Crear empresa"}</Button>
      </div>
    </form>
  );
}
