"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { FIELD_ERR_CLS, toastFormError, useInvalidFields } from "@/components/ui/form-feedback";
import { SectionHeading } from "@/components/section-heading";
import { updateDefaultSlotsAction } from "@/lib/store-settings-actions";
import { DEFAULT_SLOTS_PER_SCREEN } from "@/lib/store-slots";
import { cn } from "@/lib/utils";

type Field = "slots";

export function InventoryPanel({
  storeId,
  initialSlots,
  canEdit,
}: {
  storeId: string | null;
  initialSlots: number;
  canEdit: boolean;
}) {
  const [slots, setSlots] = useState(String(initialSlots));
  const [pending, start] = useTransition();
  const router = useRouter();
  const { invalid, mark, clear } = useInvalidFields<Field>();
  const isBad = invalid.has("slots");

  const n = Number(slots.trim());
  const valid = Number.isSafeInteger(n) && n >= 1 && n <= 100;
  const changed = slots.trim() !== String(initialSlots);
  const disabled = pending || !canEdit || !storeId || !valid || !changed;

  function missingWhy(): string {
    if (!canEdit) return "Requiere rol admin o propietario.";
    if (!storeId) return "Sin tienda activa.";
    if (!valid) return "Indica un entero 1..100.";
    if (!changed) return "Sin cambios.";
    return "Guardar espacios";
  }

  function save() {
    if (!storeId) return;
    if (!valid) {
      mark(["slots" as Field]);
      toastFormError("Revisa los espacios", "Indica un entero entre 1 y 100.");
      return;
    }
    clear("slots");
    start(async () => {
      const res = await updateDefaultSlotsAction({ storeId, slots: n }).catch(() => ({
        ok: false,
        message: "Error.",
      }));
      if (!res.ok) {
        mark(["slots" as Field]);
        toastFormError("No se pudo guardar", res.message);
        return;
      }
      toast.add({ title: "Inventario actualizado", description: res.message, type: "success" });
      router.refresh();
    });
  }

  return (
    <section aria-label="Inventario" className="flex w-full max-w-2xl flex-col gap-4">
      <SectionHeading
        title="Espacios por pantalla"
        hint="Cuántos espacios puedes vender de la misma pantalla en un mismo día. 1 slot = 1 espacio."
        tone="primary"
      />
      <AppCard
        title="Capacidad por defecto"
        description={`Fallback por tenant cuando la pantalla no tiene slots propios. Default ${DEFAULT_SLOTS_PER_SCREEN}.`}
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <label className="grid min-w-0 content-start gap-1.5 text-xs" htmlFor="default-slots">
            Espacios por pantalla y día
            <input
              id="default-slots"
              data-field="slots"
              aria-invalid={isBad}
              inputMode="numeric"
              disabled={pending || !canEdit}
              value={slots}
              onChange={(e) => {
                setSlots(e.target.value);
                clear("slots");
              }}
              placeholder={String(DEFAULT_SLOTS_PER_SCREEN)}
              className={cn(
                "h-9 w-32 rounded-md border border-input bg-input/20 px-2.5 text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
                isBad && FIELD_ERR_CLS,
              )}
            />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={disabled} title={missingWhy()}>
            <Save aria-hidden />
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </form>
        {!valid && <p className="text-xs text-destructive">Entero entre 1 y 100.</p>}
        {!canEdit && <p className="text-xs text-muted-foreground">Solo lectura: requiere admin o propietario.</p>}
      </AppCard>
    </section>
  );
}
