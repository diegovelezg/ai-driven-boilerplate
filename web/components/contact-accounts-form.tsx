"use client";

import { useState, useTransition } from "react";
import { CancelButton, SubmitButton } from "@/components/buttons";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { setContactAccountsAction } from "@/lib/crm-actions";
import { toastFormError } from "@/components/ui/form-feedback";
import { toTitleCase } from "@/lib/format";

/** Asigna a qué anunciantes atiende un contacto de agencia.
 *  Solo ofrece anunciantes ya vinculados a la agencia (tab Vínculos):
 *  primero se vinculan las empresas, luego se asignan sus contactos.
 *  Set vacío = sin asignación declarada. */
export function ContactAccountsForm({
  contactId,
  advertiserOptions,
  initialAdvertiserIds,
  contactLabel,
  onSaved,
  onCancel,
}: {
  contactId: string;
  advertiserOptions: Array<{ id: string; name: string }>;
  initialAdvertiserIds: string[];
  contactLabel: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([...initialAdvertiserIds]);
  const [pending, startTransition] = useTransition();
  const initialKey = [...initialAdvertiserIds].sort().join(",");
  const dirty = [...selected].sort().join(",") !== initialKey;

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function save() {
    startTransition(async () => {
      const res = await setContactAccountsAction({ contactId, advertiserCompanyIds: selected });
      if (!res.ok) {
        toastFormError("No se pudieron guardar las cuentas", res.message);
        return;
      }
      toast.add({ title: "Cuentas actualizadas", description: res.message, type: "success" });
      onSaved?.();
    });
  }

  if (advertiserOptions.length === 0) {
    return (
      <div className="flex flex-col gap-3 rounded-lg bg-muted/40 px-3 py-3">
        <p className="text-sm text-muted-foreground">
          Sin anunciantes vinculados: primero vincula la agencia con sus anunciantes y luego asigna sus contactos.
        </p>
        <div>
          <CancelButton onCancel={onCancel} disabled={pending} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted/40 px-3 py-3">
      <p className="text-sm">
        Cuentas que atiende <span className="font-medium">{contactLabel}</span>:
      </p>
      <div className="flex flex-col gap-2">
        {advertiserOptions.map((o) => {
          const checked = selected.includes(o.id);
          return (
            <div key={o.id} className="flex h-9 items-center gap-2">
              <Checkbox
                id={`cta-${contactId}-${o.id}`}
                checked={checked}
                onCheckedChange={() => toggle(o.id)}
                disabled={pending}
                aria-label={`${contactLabel} atiende a ${o.name}`}
              />
              <Label htmlFor={`cta-${contactId}-${o.id}`} className="font-normal">
                {toTitleCase(o.name)}
              </Label>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton
          onClick={save}
          pending={pending}
          disabled={!dirty}
          title={!dirty ? "Sin cambios en las cuentas" : undefined}
        >
          Guardar cuentas
        </SubmitButton>
        <CancelButton onCancel={onCancel} disabled={pending} />
      </div>
    </div>
  );
}
