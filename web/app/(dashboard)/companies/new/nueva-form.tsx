"use client";

import { Input } from "@/components/ui/input";

import { useActionState, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { SubmitButton } from "@/components/buttons";
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
import { failSubmit, useServerFieldErrors } from "@/components/ui/form-feedback";

const initial: CrmState = { ok: false, message: "" };

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
    failSubmit(e, errs, fail);
  }

  // Errores del server action (p. ej. Web inválida, sin permiso): mismo
  // tratamiento, borde + toast en vez de texto inline.
  useServerFieldErrors(state, fieldsFromMessage, setInvalid, "No se pudo crear la empresa");

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <label className="form-field">
        Nombre *
        <Input name="name" maxLength={200} placeholder="Acme S.A.C." aria-invalid={invalid.has("name")} onChange={(e) => { setNameOk(e.target.value.trim().length > 0); if (invalid.has("name")) setInvalid((p) => { const n = new Set(p); n.delete("name"); return n; }); }} className={`${bad("name")}`} />
      </label>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="form-field">
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
            <SelectTrigger aria-label="Tipo" aria-invalid={invalid.has("kind")} className={`w-full${invalid.has("kind") ? ` ${FIELD_ERR_CLS}` : ""}`}>
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
          <label className="form-field">
            <span className="flex flex-wrap items-center gap-2">
              Comisión %
              <RestrictedVisibilityBadge minRole="admin" />
            </span>
            <span className="flex items-center gap-1">
              <Input
                name="agency_commission_pct"
                inputMode="numeric"
                placeholder="p. ej. 15"
                aria-label="Comisión agencia en porcentaje"
                aria-invalid={invalid.has("commission")}
                onChange={() => invalid.has("commission") && setInvalid((p) => { const n = new Set(p); n.delete("commission"); return n; })}
                className={`w-32 text-center tabular-nums${bad("commission")}`}
              />
              <span className="text-muted-foreground">%</span>
            </span>
          </label>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="form-field">
          ID fiscal
          <Input name="tax_id" maxLength={40} placeholder="20123456789" />
        </label>
        <label className="form-field">
          Web
          <Input name="domain" maxLength={253} placeholder="acme.pe" inputMode="url" aria-invalid={invalid.has("domain")} onChange={() => invalid.has("domain") && setInvalid((p) => { const n = new Set(p); n.delete("domain"); return n; })} className={`${bad("domain")}`} />
        </label>
        <label className="form-field">
          Teléfono
          <Input name="phone" type="tel" maxLength={40} placeholder="+51…" />
        </label>
        <label className="form-field sm:col-span-2">
          Dirección
          <Input name="address" maxLength={300} placeholder="Av. …" />
        </label>
        <label className="form-field">
          Ciudad
          <Input name="city" maxLength={120} placeholder="Lima" />
        </label>
        <div className="form-field">
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
        <SubmitButton pending={pending} disabled={!nameOk} title={!nameOk ? "Completa el nombre para continuar" : undefined} pendingLabel="Creando…">
          <Plus aria-hidden />
          Crear empresa
        </SubmitButton>
      </div>
    </form>
  );
}
