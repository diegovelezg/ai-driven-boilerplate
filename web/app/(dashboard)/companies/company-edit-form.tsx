"use client";

import { Input } from "@/components/ui/input";

import { useState, useTransition } from "react";
import { Save } from "lucide-react";
import { CancelButton, SubmitButton } from "@/components/buttons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COUNTRIES } from "@/lib/countries";
import { taxIdLabel } from "@/lib/tax-id";
import { toast } from "@/components/ui/toast";
import { updateCompanyAction, type CrmState } from "@/lib/crm-actions";
import {
  FIELD_ERR_CLS,
  fieldsFromMessage,
  validateCompanyFields,
  type CompanyFieldKey,
} from "./company-validation";

export interface CompanyEditInitial {
  name: string;
  legal_name: string;
  tax_id: string;
  domain: string;
  phone: string;
  city: string;
  country: string;
  address: string;
}

/** Edición inline de la ficha (drawer). Solo seller+ (el padre hace gating). */
export function CompanyEditForm({
  companyId,
  initial,
  onSaved,
  onCancel,
}: {
  companyId: string;
  initial: CompanyEditInitial;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [legalName, setLegalName] = useState(initial.legal_name);
  const [taxId, setTaxId] = useState(initial.tax_id);
  const [domain, setDomain] = useState(initial.domain);
  const [phone, setPhone] = useState(initial.phone);
  const [city, setCity] = useState(initial.city);
  const [country, setCountry] = useState(initial.country);
  const [address, setAddress] = useState(initial.address);
  const [pending, startTransition] = useTransition();
  const [invalid, setInvalid] = useState<Set<CompanyFieldKey>>(new Set());

  const bad = (k: CompanyFieldKey) => (invalid.has(k) ? ` ${FIELD_ERR_CLS}` : "");
  const clear = (k: CompanyFieldKey) =>
    invalid.has(k) &&
    setInvalid((p) => {
      const n = new Set(p);
      n.delete(k);
      return n;
    });

  function save() {
    const errs = validateCompanyFields({ name, legalName, taxId, domain, address, city, country });
    if (errs.length > 0) {
      setInvalid(new Set(errs.map((r) => r.key)));
      toast.add({
        title: errs.length === 1 ? "Revisa el campo marcado" : "Revisa los campos marcados",
        description: errs.map((r) => r.message).join(" "),
        type: "error",
      });
      return;
    }
    startTransition(async () => {
      const res: CrmState = await updateCompanyAction({
        companyId,
        patch: {
          name: name.trim(),
          legal_name: legalName.trim() || null,
          tax_id: taxId.trim() || null,
          domain: domain.trim() || null,
          phone: phone.trim() || null,
          city: city.trim() || null,
          country: country.trim() || null,
          address: address.trim() || null,
        },
      });
      if (!res.ok) {
        const keys = fieldsFromMessage(res.message);
        setInvalid(new Set(keys));
        toast.add({ title: "No se pudo guardar", description: res.message, type: "error" });
        return;
      }
      onSaved?.();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="form-field">
          Nombre comercial *
          <Input value={name} onChange={(e) => { setName(e.target.value); clear("name"); }} maxLength={200} disabled={pending} aria-invalid={invalid.has("name")} className={`${bad("name")}`} />
        </label>
        <label className="form-field">
          Razón social *
          <Input value={legalName} onChange={(e) => { setLegalName(e.target.value); clear("legalName"); }} maxLength={200} disabled={pending} aria-invalid={invalid.has("legalName")} className={`${bad("legalName")}`} />
        </label>
        <label className="form-field">
          {taxIdLabel(country)} *
          <Input value={taxId} onChange={(e) => { setTaxId(e.target.value); clear("taxId"); }} maxLength={40} disabled={pending} aria-invalid={invalid.has("taxId")} className={`${bad("taxId")}`} />
        </label>
        <label className="form-field">
          Web
          <Input value={domain} onChange={(e) => { setDomain(e.target.value); clear("domain"); }} maxLength={253} placeholder="acme.pe" disabled={pending} aria-invalid={invalid.has("domain")} className={`${bad("domain")}`} />
        </label>
        <label className="form-field">
          Teléfono
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" maxLength={40} disabled={pending} />
        </label>
        <label className="form-field sm:col-span-2">
          Dirección *
          <Input value={address} onChange={(e) => { setAddress(e.target.value); clear("address"); }} maxLength={300} disabled={pending} aria-invalid={invalid.has("address")} className={`${bad("address")}`} />
        </label>
        <label className="form-field">
          Ciudad *
          <Input value={city} onChange={(e) => { setCity(e.target.value); clear("city"); }} maxLength={120} disabled={pending} aria-invalid={invalid.has("city")} className={`${bad("city")}`} />
        </label>
        <div className="form-field">
          País *
          <Select
            value={country.trim().toUpperCase() || "__none"}
            onValueChange={(v) => {
              if (!v) return;
              setCountry(v === "__none" ? "" : v);
              clear("country");
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
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton onClick={save} pending={pending} disabled={!name.trim() || !legalName.trim() || !taxId.trim() || !address.trim() || !city.trim() || !country.trim()} title={!name.trim() ? "Completa el nombre comercial para continuar" : !legalName.trim() ? "Completa la razón social para continuar" : !taxId.trim() ? "Completa el ID fiscal para continuar" : !address.trim() ? "Completa la dirección para continuar" : !city.trim() ? "Completa la ciudad para continuar" : !country.trim() ? "Elige el país para continuar" : undefined}><Save aria-hidden />Guardar</SubmitButton>
        <CancelButton onCancel={onCancel} disabled={pending} />
      </div>
    </div>
  );
}
