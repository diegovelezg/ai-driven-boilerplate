"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createOrderRedirectAction } from "@/lib/order-actions";
import type { CrmState } from "@/lib/crm-actions";

const initial: CrmState = { ok: false, message: "" };

interface Screen {
  id: string;
  name: string;
}

interface Line {
  key: number;
  screen: string;
}

export function NuevaOrdenForm({
  companies,
  brands,
  screens,
}: {
  companies: Array<{ id: string; name: string; kind: string | null }>;
  brands: string[];
  screens: Screen[];
}) {
  const [state, action, pending] = useActionState(createOrderRedirectAction, initial);
  const [company, setCompany] = useState<string>("");
  const [lines, setLines] = useState<Line[]>([{ key: 0, screen: "" }]);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-xs">
        Contratante (quién firma) *
        <input type="hidden" name="company_id" value={company} />
        <Select value={company} onValueChange={(v) => v && setCompany(v)} disabled={pending}>
          <SelectTrigger aria-label="Contratante" className="h-9 bg-background text-sm">
            <SelectValue placeholder="Agencia o anunciante…" />
          </SelectTrigger>
          <SelectContent>
            {companies.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[11px] text-muted-foreground">Si es agencia, la factura va a ella; si es anunciante, directo.</span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          Marca
          <input name="brand" maxLength={120} placeholder="Tottus" list="orden-marcas" autoComplete="off" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
          <datalist id="orden-marcas">
            {brands.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Condición de pago
          <input name="payment_terms" maxLength={120} placeholder="Crédito a 30 días" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium">Pantallas *</span>
        {screens.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Sin pantallas activas. Importa el inventario en /inventario antes de crear la orden.
          </p>
        )}
        {lines.map((l, i) => (
          <div key={l.key} className="grid grid-cols-[1fr_auto] items-end gap-2 rounded-lg border border-border/60 p-2.5">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1 text-xs sm:col-span-2">
                Pantalla
                <input type="hidden" name="screen_id" value={l.screen} />
                <Select
                  value={l.screen}
                  onValueChange={(v) => v && setLines((prev) => prev.map((p) => (p.key === l.key ? { ...p, screen: v } : p)))}
                  disabled={pending}
                >
                  <SelectTrigger aria-label={`Pantalla línea ${i + 1}`} className="h-9 bg-background text-sm">
                    <SelectValue placeholder="Elegir pantalla…" />
                  </SelectTrigger>
                  <SelectContent>
                    {screens.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex flex-col gap-1 text-xs">
                Inicio
                <input type="date" name="line_starts_at" required className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Fin
                <input type="date" name="line_ends_at" required className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm" />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Total (S/)
                <input name="line_total" required inputMode="decimal" placeholder="2000" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm tabular-nums" />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Días
                <input name="line_cant_dias" inputMode="numeric" placeholder="—" className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm tabular-nums" />
              </label>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Quitar línea ${i + 1}`}
              disabled={pending || lines.length <= 1}
              onClick={() => setLines((prev) => prev.filter((p) => p.key !== l.key))}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setLines((prev) => [...prev, { key: Math.max(...prev.map((p) => p.key)) + 1, screen: "" }])}
          >
            <Plus aria-hidden /> Agregar pantalla
          </Button>
        </div>
      </div>

      {state.message && (
        <p className="text-xs text-destructive" role="alert">{state.message}</p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Creando…" : "Crear orden"}</Button>
      </div>
    </form>
  );
}
