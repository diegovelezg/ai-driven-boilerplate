"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateOrderAction } from "@/lib/order-actions";
import { toastFormError } from "@/components/ui/form-feedback";

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

  function save() {
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
        toastFormError("No se pudo guardar la orden", res.message);
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
          Marca
          <input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={200} disabled={pending} className={inputCls} />
        </label>
        <div className="flex min-w-0 flex-col gap-1 text-xs">
          Condición de pago
          <input type="hidden" name="payment_terms_days" value={terms} />
          <Select value={terms} onValueChange={(v) => setTerms(v ?? "")} disabled={pending}>
            <SelectTrigger aria-label="Condición de pago" className="w-full">
              <SelectValue placeholder="Elegir condición…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Sin definir</SelectItem>
              {TERMS.map((t) => (
                <SelectItem key={t} value={t}>{t === "0" ? "Contado" : `${t} días`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          Notas
          <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} disabled={pending} className={inputCls} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={pending}>{pending ? "Guardando…" : "Guardar"}</Button>
        <Button variant="outline" onClick={onCancel} disabled={pending}>Cancelar</Button>
      </div>
    </div>
  );
}
