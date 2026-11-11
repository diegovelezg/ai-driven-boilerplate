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
import { ADVERTISER_CATEGORIES } from "@/lib/advertiser-categories";
import { PROVIDER_TYPES } from "@/lib/provider-types";
import { COUNTRIES } from "@/lib/countries";
import { taxIdLabel } from "@/lib/tax-id";
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
  const [legalOk, setLegalOk] = useState(false);
  const [taxOk, setTaxOk] = useState(false);
  const [addressOk, setAddressOk] = useState(false);
  const [cityOk, setCityOk] = useState(false);
  const [categoryIab, setCategoryIab] = useState<string>("");
  const [providerType, setProviderType] = useState<string>("");
  const [invalid, setInvalid] = useState<Set<CompanyFieldKey>>(new Set());
  const formRef = useRef<HTMLFormElement>(null);
  const showCommission = canManageCommission && kind === "agencia";
  const needCategory = kind === "anunciante" && !categoryIab;
  const needProviderType = kind === "proveedor" && !providerType;
  const countryOk = country !== "" && country !== "__none";
  const missingClass = needCategory
    ? "Elige la categoría del anunciante para continuar"
    : needProviderType
      ? "Elige el tipo de proveedor para continuar"
      : !nameOk
        ? "Completa el nombre comercial para continuar"
        : !legalOk
          ? "Completa la razón social para continuar"
          : !taxOk
            ? "Completa el ID fiscal para continuar"
            : !addressOk
              ? "Completa la dirección para continuar"
              : !cityOk
                ? "Completa la ciudad para continuar"
                : !countryOk
                  ? "Elige el país para continuar"
                  : undefined;

  const bad = (k: CompanyFieldKey) => (invalid.has(k) ? ` ${FIELD_ERR_CLS}` : "");

  function fail(keys: CompanyFieldKey[], title: string, description: string) {
    setInvalid(new Set(keys));
    toast.add({ title, description, type: "error" });
    const first = keys[0];
    const name =
      first === "kind" ? "kind"
      : first === "legalName" ? "legal_name"
      : first === "taxId" ? "tax_id"
      : first === "commission" ? "agency_commission_pct"
      : first === "category" ? "category_iab"
      : first === "providerType" ? "provider_type"
      : first;
    formRef.current?.querySelector<HTMLElement>(`[name="${name}"]`)?.focus();
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const fd = new FormData(e.currentTarget);
    const errs = validateCompanyFields({
      name: String(fd.get("name") ?? ""),
      legalName: String(fd.get("legal_name") ?? ""),
      taxId: String(fd.get("tax_id") ?? ""),
      domain: String(fd.get("domain") ?? ""),
      address: String(fd.get("address") ?? ""),
      city: String(fd.get("city") ?? ""),
      country: String(fd.get("country") ?? ""),
      commission: showCommission ? String(fd.get("agency_commission_pct") ?? "") : "",
      kind,
      categoryIab: String(fd.get("category_iab") ?? ""),
      providerType: String(fd.get("provider_type") ?? ""),
    });
    failSubmit(e, errs, fail);
  }

  // Errores del server action (p. ej. Web inválida, sin permiso): mismo
  // tratamiento, borde + toast en vez de texto inline.
  useServerFieldErrors(state, fieldsFromMessage, setInvalid, "No se pudo crear la empresa");

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
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
        {kind === "anunciante" && (
          <div className="form-field">
            Categoría *
            <input type="hidden" name="category_iab" value={categoryIab} />
            <Select
              value={categoryIab || null}
              onValueChange={(v) => {
                if (!v) return;
                setCategoryIab(v);
                if (invalid.has("category")) setInvalid((p) => { const n = new Set(p); n.delete("category"); return n; });
              }}
              items={Object.fromEntries(
                [...ADVERTISER_CATEGORIES]
                  .sort((a, b) => a.name_es.localeCompare(b.name_es, "es"))
                  .map((c) => [c.code, c.name_es]),
              )}
              disabled={pending}
            >
              <SelectTrigger aria-label="Categoría" aria-invalid={invalid.has("category")} className={`w-full${invalid.has("category") ? ` ${FIELD_ERR_CLS}` : ""}`}>
                <SelectValue placeholder="Elegir categoría…" />
              </SelectTrigger>
              <SelectContent>
                {[...ADVERTISER_CATEGORIES]
                  .sort((a, b) => a.name_es.localeCompare(b.name_es, "es"))
                  .map((c) => (
                    <SelectItem key={c.code} value={c.code}>{c.name_es}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {kind === "proveedor" && (
          <div className="form-field">
            Tipo de proveedor *
            <input type="hidden" name="provider_type" value={providerType} />
            <Select
              value={providerType || null}
              onValueChange={(v) => {
                if (!v) return;
                setProviderType(v);
                if (invalid.has("providerType")) setInvalid((p) => { const n = new Set(p); n.delete("providerType"); return n; });
              }}
              items={Object.fromEntries(
                PROVIDER_TYPES.map((t) => [t.code, t.name_es]),
              )}
              disabled={pending}
            >
              <SelectTrigger aria-label="Tipo de proveedor" aria-invalid={invalid.has("providerType")} className={`w-full${invalid.has("providerType") ? ` ${FIELD_ERR_CLS}` : ""}`}>
                <SelectValue placeholder="Elegir tipo…" />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((t) => (
                  <SelectItem key={t.code} value={t.code}>{t.name_es}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
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
      <label className="form-field">
        Nombre comercial *
        <Input name="name" maxLength={200} placeholder="Acme" aria-invalid={invalid.has("name")} onChange={(e) => { setNameOk(e.target.value.trim().length > 0); if (invalid.has("name")) setInvalid((p) => { const n = new Set(p); n.delete("name"); return n; }); }} className={`${bad("name")}`} />
      </label>
      <label className="form-field">
        Razón social *
        <Input name="legal_name" maxLength={200} placeholder="Acme S.A.C." aria-invalid={invalid.has("legalName")} onChange={(e) => { setLegalOk(e.target.value.trim().length > 0); if (invalid.has("legalName")) setInvalid((p) => { const n = new Set(p); n.delete("legalName"); return n; }); }} className={`${bad("legalName")}`} />
      </label>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="form-field">
          {taxIdLabel(country)} *
          <Input name="tax_id" maxLength={40} placeholder="20123456789" aria-invalid={invalid.has("taxId")} onChange={(e) => { setTaxOk(e.target.value.trim().length > 0); if (invalid.has("taxId")) setInvalid((p) => { const n = new Set(p); n.delete("taxId"); return n; }); }} className={`${bad("taxId")}`} />
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
          Dirección *
          <Input name="address" maxLength={300} placeholder="Av. …" aria-invalid={invalid.has("address")} onChange={(e) => { setAddressOk(e.target.value.trim().length > 0); if (invalid.has("address")) setInvalid((p) => { const n = new Set(p); n.delete("address"); return n; }); }} className={`${bad("address")}`} />
        </label>
        <label className="form-field">
          Ciudad *
          <Input name="city" maxLength={120} placeholder="Lima" aria-invalid={invalid.has("city")} onChange={(e) => { setCityOk(e.target.value.trim().length > 0); if (invalid.has("city")) setInvalid((p) => { const n = new Set(p); n.delete("city"); return n; }); }} className={`${bad("city")}`} />
        </label>
        <div className="form-field">
          País *
          <input type="hidden" name="country" value={country === "__none" ? "" : country} />
          <Select
            value={country === "" ? "__none" : country}
            onValueChange={(v) => {
              if (!v) return;
              setCountry(v);
              if (invalid.has("country")) setInvalid((p) => { const n = new Set(p); n.delete("country"); return n; });
            }}
            items={{
              __none: "Sin especificar",
              ...Object.fromEntries(
                COUNTRIES.map((c) => [c.code, `${c.code} — ${c.name}`]),
              ),
            }}
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
        <SubmitButton pending={pending} disabled={!nameOk || !legalOk || !taxOk || !addressOk || !cityOk || !countryOk || needCategory || needProviderType} title={missingClass} pendingLabel="Creando…">
          <Plus aria-hidden />
          Crear empresa
        </SubmitButton>
      </div>
    </form>
  );
}
