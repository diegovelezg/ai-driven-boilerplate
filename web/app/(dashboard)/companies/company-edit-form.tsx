"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { updateCompanyAction, type CrmState } from "@/lib/crm-actions";

export interface CompanyEditInitial {
  name: string;
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
  const [taxId, setTaxId] = useState(initial.tax_id);
  const [domain, setDomain] = useState(initial.domain);
  const [phone, setPhone] = useState(initial.phone);
  const [city, setCity] = useState(initial.city);
  const [country, setCountry] = useState(initial.country);
  const [address, setAddress] = useState(initial.address);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    setMsg(null);
    if (!name.trim()) {
      setMsg("Nombre requerido.");
      return;
    }
    startTransition(async () => {
      const res: CrmState = await updateCompanyAction({
        companyId,
        patch: {
          name: name.trim(),
          tax_id: taxId.trim() || null,
          domain: domain.trim() || null,
          phone: phone.trim() || null,
          city: city.trim() || null,
          country: country.trim() || null,
          address: address.trim() || null,
        },
      });
      setMsg(res.message);
      if (res.ok) onSaved?.();
    });
  }

  const inputCls = "h-9 rounded-lg border border-border bg-background px-2.5 text-sm";

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          Nombre *
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} disabled={pending} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          ID fiscal
          <input value={taxId} onChange={(e) => setTaxId(e.target.value)} maxLength={40} disabled={pending} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Web
          <input value={domain} onChange={(e) => setDomain(e.target.value)} maxLength={253} placeholder="acme.pe" disabled={pending} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Teléfono
          <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" maxLength={40} disabled={pending} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          Dirección
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} disabled={pending} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Ciudad
          <input value={city} onChange={(e) => setCity(e.target.value)} maxLength={120} disabled={pending} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          País (ISO2)
          <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))} maxLength={2} placeholder="PE" disabled={pending} className={`${inputCls} uppercase`} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={pending}>{pending ? "Guardando…" : "Guardar"}</Button>
        <Button variant="outline" onClick={onCancel} disabled={pending}>Cancelar</Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}
