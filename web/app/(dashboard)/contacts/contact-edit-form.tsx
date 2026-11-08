"use client";

import { useState, useTransition } from "react";
import { Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { updateContactAction } from "@/lib/crm-actions";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";
import { validateContactFields } from "./contact-validation";

export interface ContactEditInitial {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  job_title: string;
  is_primary: boolean;
}

/** Edición inline del contacto (drawer). Solo seller+ (el padre hace gating). */
export function ContactEditForm({
  contactId,
  initial,
  onSaved,
  onCancel,
}: {
  contactId: string;
  initial: ContactEditInitial;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const [firstName, setFirstName] = useState(initial.first_name);
  const [lastName, setLastName] = useState(initial.last_name);
  const [email, setEmail] = useState(initial.email);
  const [phone, setPhone] = useState(initial.phone);
  const [jobTitle, setJobTitle] = useState(initial.job_title);
  const [isPrimary, setIsPrimary] = useState(initial.is_primary);
  const [pending, startTransition] = useTransition();
  const { invalid, mark, clear, bad } = useInvalidFields<"email" | "phone">();

  const ready = email.trim() !== "" || phone.trim() !== "";

  function save() {
    const errs = validateContactFields({ email, phone });
    const keys = errs.map((e) => e.key);
    if (keys.length > 0) {
      mark(keys);
      toastFormError(
        keys.length === 1 ? "Revisa el campo marcado" : "Revisa los campos marcados",
        keys.includes("email") && email.trim() ? "Email inválido." : "Email o teléfono requerido.",
      );
      return;
    }
    startTransition(async () => {
      const res = await updateContactAction({
        contactId,
        patch: {
          first_name: firstName.trim() || null,
          last_name: lastName.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          job_title: jobTitle.trim() || null,
          is_primary: isPrimary,
        },
      });
      if (!res.ok) {
        const ks: Array<"email" | "phone"> = /teléfono|telefono/i.test(res.message) && /email/i.test(res.message)
          ? ["email", "phone"]
          : /email/i.test(res.message)
            ? ["email"]
            : /teléfono|telefono/i.test(res.message)
              ? ["phone"]
              : [];
        mark(ks);
        toastFormError("No se pudo guardar el contacto", res.message);
        return;
      }
      onSaved?.();
    });
  }

  const inputCls = "h-9 rounded-lg border border-border bg-background px-2.5 text-sm";

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          Nombre
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={120} disabled={pending} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Apellido
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={120} disabled={pending} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Email
          <input value={email} onChange={(e) => { setEmail(e.target.value); clear("email"); }} maxLength={320} disabled={pending} aria-invalid={invalid.has("email")} className={`${inputCls}${bad("email")}`} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Teléfono
          <input value={phone} onChange={(e) => { setPhone(e.target.value); clear("phone"); }} maxLength={40} disabled={pending} aria-invalid={invalid.has("phone")} className={`${inputCls}${bad("phone")}`} />
        </label>
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          Cargo
          <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={120} placeholder="Compras, Gerencia…" disabled={pending} className={inputCls} />
        </label>
      </div>
      <div className="flex h-9 items-center gap-2">
        <Checkbox
          id="contact-edit-is-primary"
          checked={isPrimary}
          onCheckedChange={(v) => setIsPrimary(v === true)}
          disabled={pending}
          aria-label="Contacto principal"
        />
        <Label htmlFor="contact-edit-is-primary" className="text-xs font-normal">
          Principal
        </Label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={pending || !ready} title={!ready ? "Agrega email o teléfono para continuar" : undefined}><Save aria-hidden />{pending ? "Guardando…" : "Guardar"}</Button>
        <Button variant="outline" onClick={onCancel} disabled={pending}><X aria-hidden />Cancelar</Button>
      </div>
    </div>
  );
}
