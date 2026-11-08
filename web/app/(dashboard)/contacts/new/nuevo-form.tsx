"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ComboboxField } from "@/components/combobox-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toTitleCase } from "@/lib/format";
import { createContactRedirectAction, type CrmState } from "@/lib/crm-actions";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";

const initial: CrmState = { ok: false, message: "" };

type ContactField = "company" | "email" | "phone";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function fieldsFromContactMessage(msg: string): ContactField[] {
  if (/empresa/i.test(msg)) return ["company"];
  if (/teléfono|telefono/i.test(msg) && /email/i.test(msg)) return ["email", "phone"];
  if (/email/i.test(msg)) return ["email"];
  if (/teléfono|telefono/i.test(msg)) return ["phone"];
  return [];
}

export function NuevoContactoForm({
  companies,
  jobTitles,
  initialCompanyId = "",
}: {
  companies: Array<{ id: string; name: string }>;
  jobTitles: string[];
  initialCompanyId?: string;
}) {
  const [state, action, pending] = useActionState(createContactRedirectAction, initial);
  const [company, setCompany] = useState(initialCompanyId);
  const [jobTitle, setJobTitle] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const { invalid, mark, clear, bad, focusFirst } = useInvalidFields<ContactField>();
  const formRef = useRef<HTMLFormElement>(null);
  const companyName = companies.find((c) => c.id === company)?.name;

  const ready = company !== "" && (email.trim() !== "" || phone.trim() !== "");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const keys: ContactField[] = [];
    const msgs: string[] = [];
    if (!company) {
      keys.push("company");
      msgs.push("Elige la empresa.");
    }
    if (!email.trim() && !phone.trim()) {
      keys.push("email", "phone");
      msgs.push("Email o teléfono requerido.");
    } else if (email.trim() && !EMAIL_RE.test(email.trim())) {
      keys.push("email");
      msgs.push("Email inválido.");
    }
    if (keys.length > 0) {
      e.preventDefault();
      mark(keys);
      toastFormError(keys.length === 1 ? "Revisa el campo marcado" : "Revisa los campos marcados", msgs.join(" "));
      focusFirst(formRef, keys.map((k) => (k === "company" ? "company_id" : k)));
    }
  }

  useEffect(() => {
    if (!state.message || state.ok) return;
    const keys = fieldsFromContactMessage(state.message);
    mark(keys);
    toastFormError("No se pudo crear el contacto", state.message);
  }, [state, mark]);

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-1 text-xs">
        Empresa *
        <input type="hidden" name="company_id" value={company} />
        <Select value={company} onValueChange={(v) => { if (v) { setCompany(v); clear("company"); } }} disabled={pending}>
          <SelectTrigger aria-label="Empresa" aria-invalid={invalid.has("company")} className={invalid.has("company") ? bad("company").trim() : undefined}>
            {/* Nombre explícito: el valor resuelto por defecto muestra el UUID
                cuando los ítems del portal aún no están montados. */}
            <SelectValue placeholder="Elegir empresa…">{companyName ? toTitleCase(companyName) : undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {companies.map((c) => (
              <SelectItem key={c.id} value={c.id}>{toTitleCase(c.name)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          Nombre
          <input name="first_name" maxLength={120} placeholder="Ana" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Apellido
          <input name="last_name" maxLength={120} placeholder="Quispe" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Email
          <input name="email" maxLength={320} placeholder="ana@acme.pe" value={email} onChange={(e) => { setEmail(e.target.value); clear("email"); }} aria-invalid={invalid.has("email")} className={`h-9 rounded-lg border border-border bg-background px-2.5 text-sm${bad("email")}`} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Teléfono
          <input name="phone" type="tel" maxLength={40} placeholder="+51…" value={phone} onChange={(e) => { setPhone(e.target.value); clear("phone"); }} aria-invalid={invalid.has("phone")} className={`h-9 rounded-lg border border-border bg-background px-2.5 text-sm${bad("phone")}`} />
        </label>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="flex min-w-0 flex-col gap-1 text-xs">
          Cargo
          <input type="hidden" name="job_title" value={jobTitle} />
          <ComboboxField
            items={jobTitles}
            value={jobTitle}
            onChange={setJobTitle}
            placeholder="Compras, Gerencia…"
            emptyText={jobTitle.trim() ? "Enter para usar este cargo." : "Sin cargos registrados."}
            customLabel={(q) => <>Usar “{q}”</>}
            ariaLabel="Cargo"
            disabled={pending}
          />
        </div>
        <div className="flex h-9 items-center gap-2">
          <input type="hidden" name="is_primary" value={isPrimary ? "on" : ""} />
          <Checkbox
            id="nuevo-contacto-is-primary"
            checked={isPrimary}
            onCheckedChange={(v) => setIsPrimary(v === true)}
            disabled={pending}
            aria-label="Contacto principal"
          />
          <Label htmlFor="nuevo-contacto-is-primary" className="text-xs font-normal">
            Principal
          </Label>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Email o teléfono requerido. Solo un contacto puede ser principal por empresa.
      </p>
      <div>
        <Button type="submit" disabled={pending || !ready} title={!ready ? "Elige empresa y agrega email o teléfono" : undefined}>{pending ? "Creando…" : "Crear contacto"}</Button>
      </div>
    </form>
  );
}
