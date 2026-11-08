"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COMPANY_KINDS, COMPANY_KIND_LABELS } from "@/lib/crm";
import { COUNTRIES } from "@/lib/countries";
import { RestrictedVisibilityBadge } from "@/components/role-badges";
import { createCompanyRedirectAction, type CrmState } from "@/lib/crm-actions";
import {
  FIELD_ERR_CLS,
  fieldsFromMessage,
  validateCompanyFields,
  type CompanyFieldKey,
} from "../company-validation";

const initial: CrmState = { ok: false, message: "" };

const baseInput = "h-9 rounded-lg border border-border bg-background px-2.5 text-sm";

export function NuevaEmpresaForm({ canManageCommission = true, defaultCountry = "PE" }: { canManageCommission?: boolean; defaultCountry?: string }) {
  const [state, action, pending] = useActionState(createCompanyRedirectAction, initial);
  const [kind, setKind] = useState<string>("anunciante");
  const normalizedDefault = String(defaultCountry ?? "").trim().toUpperCase();
  const [country, setCountry] = useState<string>(/^[A-Z]{2}$/.test(normalizedDefault) ? normalizedDefault : "PE");
  const [nameOk, setNameOk] = useState(false);
  const [invalid, setInvalid] = useState<Set<CompanyFieldKey>>(new Set());
  const formRef = useRef<HTMLFormElement>(null);
  const showCommission = canManageCommission && kind === "agencia";

  const bad = (k: CompanyFieldKey) => (invalid.has(k) ? ` ${FIELD_ERR_CLS}` : "");

  function fail(keys: CompanyFieldKey[], title: string, description: string) {
    setInvalid(new Set(keys));
    toast.add({ title, description, type: "error" });
    const first = keys[0];
    formRef.current?.querySelector<HTMLElement>(`[name="${first === "kind" ? "kind" : first === "commission" ? "agency_commission_pct" : first}"]`)?.focus();
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const fd = new FormData(e.currentTarget);
    const errs = validateCompanyFields({
      name: String(fd.get("name") ?? ""),
      domain: String(fd.get("domain") ?? ""),
      country: String(fd.get("country") ?? ""),
      commission: showCommission ? String(fd.get("agency_commission_pct") ?? "") : "",
    });
    if (errs.length > 0) {
      e.preventDefault();
      fail(
        errs.map((r) => r.key),
        errs.length === 1 ? "Revisa el campo marcado" : "Revisa los campos marcados",
        errs.map((r) => r.message).join(" "),
      );
    }
  }

  // Errores del server action (p. ej. Web inválida, sin permiso): mismo
  // tratamiento, borde + toast en vez de texto inline.
  useEffect(() => {
    if (!state.message || state.ok) return;
    const keys = fieldsFromMessage(state.message);
    setInvalid(new Set(keys));
    toast.add({ title: "No se pudo crear la empresa", description: state.message, type: "error" });
  }, [state]);

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-xs">
        Nombre *
        <input name="name" maxLength={200} placeholder="Acme S.A.C." aria-invalid={invalid.has("name")} onChange={(e) => { setNameOk(e.target.value.trim().length > 0); if (invalid.has("name")) setInvalid((p) => { const n = new Set(p); n.delete("name"); return n; }); }} className={`${baseInput}${bad("name")}`} />
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
            <SelectTrigger aria-label="Tipo" aria-invalid={invalid.has("kind")} className={invalid.has("kind") ? FIELD_ERR_CLS : undefined}>
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
                placeholder="p. ej. 15"
                aria-label="Comisión agencia en porcentaje"
                aria-invalid={invalid.has("commission")}
                onChange={() => invalid.has("commission") && setInvalid((p) => { const n = new Set(p); n.delete("commission"); return n; })}
                className={`h-9 w-32 rounded-lg border border-border bg-background px-2.5 text-center text-sm tabular-nums${bad("commission")}`}
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
          <input name="domain" maxLength={253} placeholder="acme.pe" inputMode="url" aria-invalid={invalid.has("domain")} onChange={() => invalid.has("domain") && setInvalid((p) => { const n = new Set(p); n.delete("domain"); return n; })} className={`${baseInput}${bad("domain")}`} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Teléfono
          <input name="phone" type="tel" maxLength={40} placeholder="+51…" className={baseInput} />
        </label>
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          Dirección
          <input name="address" maxLength={300} placeholder="Av. …" className={baseInput} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Ciudad
          <input name="city" maxLength={120} placeholder="Lima" className={baseInput} />
        </label>
        <div className="flex flex-col gap-1 text-xs">
          País
          <input type="hidden" name="country" value={country === "__none" ? "" : country} />
          <Select
            value={country === "" ? "__none" : country}
            onValueChange={(v) => {
              if (!v) return;
              setCountry(v);
              if (invalid.has("country")) setInvalid((p) => { const n = new Set(p); n.delete("country"); return n; });
            }}
            items={Object.fromEntries(
              COUNTRIES.map((c) => [c.code, `${c.code} — ${c.name}`]),
            )}
            disabled={pending}
          >
            <SelectTrigger aria-label="País" aria-invalid={invalid.has("country")} className={`w-full${invalid.has("country") ? ` ${FIELD_ERR_CLS}` : ""}`}>
              <SelectValue placeholder="Elegir país…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Sin especificar</SelectItem>
              {COUNTRIES.map((c) => (
                <SelectItem key={c.code} value={c.code}>{c.code} — {c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Button type="submit" disabled={pending || !nameOk} title={!nameOk ? "Completa el nombre para continuar" : undefined}>{pending ? "Creando…" : "Crear empresa"}</Button>
      </div>
    </form>
  );
}
