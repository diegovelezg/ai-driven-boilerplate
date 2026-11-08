"use client";

import { useRef, useState, useTransition } from "react";
import { Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateOrderAction } from "@/lib/order-actions";
import {
  fieldsFromMessage,
  validateOrderFields,
  type OrderFieldKey,
} from "./order-validation";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";

const TERMS = ["0", "30", "60", "90"] as const;

/** Edición inline de la ficha (drawer): marca, pago y notas. Solo seller+ (el padre hace gating). */
export function OrderEditForm({
  orderId,
  initial,
  onSaved,
  onCancel,
}: {
  orderId: string;
  initial: { brand: string; payment_terms_days: string; notes: string };
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const [brand, setBrand] = useState(initial.brand);
  const [terms, setTerms] = useState(initial.payment_terms_days === "" ? "__none" : initial.payment_terms_days);
  const [notes, setNotes] = useState(initial.notes);
  const [pending, startTransition] = useTransition();
  const { invalid, mark, clear, bad, focusFirst } = useInvalidFields<OrderFieldKey>();
  const formRef = useRef<HTMLFormElement>(null);

  function save() {
    const problems = validateOrderFields({ brand, terms, notes });
    if (problems.length > 0) {
      const keys = [...new Set(problems.map((p) => p.key))];
      mark(keys);
      toastFormError("Revisa los campos marcados", problems.map((p) => p.message).join(" "));
      focusFirst(formRef, keys);
      return;
    }
    startTransition(async () => {
      const res = await updateOrderAction({
        orderId,
        patch: {
          brand: brand.trim() || null,
          payment_terms_days: terms === "__none" ? null : terms,
          notes: notes.trim() || null,
        },
      });
      if (!res.ok) {
        const keys = fieldsFromMessage(res.message);
        if (keys.length > 0) {
          mark(keys);
          focusFirst(formRef, keys);
        }
        toastFormError("No se pudo guardar la orden", res.message);
        return;
      }
      onSaved?.();
    });
  }

  const inputCls = "h-9 rounded-lg border border-border bg-background px-2.5 text-sm";

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          Marca
          <input
            name="brand"
            value={brand}
            onChange={(e) => { setBrand(e.target.value); clear("brand"); }}
            maxLength={200}
            disabled={pending}
            aria-invalid={invalid.has("brand")}
            className={`${inputCls}${bad("brand")}`}
          />
        </label>
        <div className="flex min-w-0 flex-col gap-1 text-xs">
          Condición de pago
          <Select value={terms} onValueChange={(v) => { setTerms(v ?? ""); clear("terms"); }} disabled={pending}>
            <SelectTrigger name="terms" aria-label="Condición de pago" aria-invalid={invalid.has("terms")} className={bad("terms").trim() || undefined}>
              <SelectValue placeholder="Elegir condición…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Sin definir</SelectItem>
              {TERMS.map((t) => (
                <SelectItem key={t} value={t}>{t === "0" ? "Contado" : `${t} días`}</SelectItem>
              ))}
              {!TERMS.includes(terms as (typeof TERMS)[number]) && terms !== "__none" && terms !== "" && (
                <SelectItem value={terms}>{/^\d+$/.test(terms) ? `${terms} días` : terms}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          Notas
          <input
            name="notes"
            value={notes}
            onChange={(e) => { setNotes(e.target.value); clear("notes"); }}
            maxLength={2000}
            disabled={pending}
            aria-invalid={invalid.has("notes")}
            className={`${inputCls}${bad("notes")}`}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}><Save aria-hidden />{pending ? "Guardando…" : "Guardar"}</Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}><X aria-hidden />Cancelar</Button>
      </div>
    </form>
  );
}
