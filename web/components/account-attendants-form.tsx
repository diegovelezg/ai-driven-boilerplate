"use client";

import { useState, useTransition } from "react";
import { CancelButton, SubmitButton } from "@/components/buttons";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { setAccountAttendantsAction } from "@/lib/crm-actions";
import { toastFormError } from "@/components/ui/form-feedback";
import { toTitleCase } from "@/lib/format";

/** Vista anunciante: qué contactos de UNA de sus agencias lo atienden.
 *  Solo ofrece contactos de esa agencia; el vínculo agencia ↔ anunciante
 *  debe existir (el action lo exige, salvo vaciado total). */
export function AccountAttendantsForm({
  agencyCompanyId,
  agencyName,
  advertiserCompanyId,
  team,
  initialContactIds,
  onSaved,
  onCancel,
}: {
  agencyCompanyId: string;
  agencyName: string;
  advertiserCompanyId: string;
  team: Array<{ id: string; name: string; isPrimary: boolean }>;
  initialContactIds: string[];
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([...initialContactIds]);
  const [pending, startTransition] = useTransition();
  const initialKey = [...initialContactIds].sort().join(",");
  const dirty = [...selected].sort().join(",") !== initialKey;

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function save() {
    startTransition(async () => {
      const res = await setAccountAttendantsAction({
        agencyCompanyId,
        advertiserCompanyId,
        contactIds: selected,
      });
      if (!res.ok) {
        toastFormError("No se pudieron guardar los atendidos", res.message);
        return;
      }
      toast.add({ title: "Atendidos actualizados", description: res.message, type: "success" });
      onSaved?.();
    });
  }

  if (team.length === 0) {
    return (
      <div className="flex flex-col gap-3 rounded-lg bg-muted/40 px-3 py-3">
        <p className="text-sm text-muted-foreground">
          {toTitleCase(agencyName)} aún no tiene contactos registrados.
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
        Contactos de <span className="font-medium">{toTitleCase(agencyName)}</span> que atienden esta cuenta:
      </p>
      <div className="flex flex-col gap-2">
        {team.map((m) => {
          const checked = selected.includes(m.id);
          return (
            <div key={m.id} className="flex h-9 items-center gap-2">
              <Checkbox
                id={`att-${agencyCompanyId}-${m.id}`}
                checked={checked}
                onCheckedChange={() => toggle(m.id)}
                disabled={pending}
                aria-label={`${m.name} atiende esta cuenta`}
              />
              <Label htmlFor={`att-${agencyCompanyId}-${m.id}`} className="font-normal">
                {toTitleCase(m.name)}
                {m.isPrimary && <span className="text-xs text-muted-foreground"> · principal</span>}
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
          title={!dirty ? "Sin cambios en los atendidos" : undefined}
        >
          Guardar atendidos
        </SubmitButton>
        <CancelButton onCancel={onCancel} disabled={pending} />
      </div>
    </div>
  );
}
