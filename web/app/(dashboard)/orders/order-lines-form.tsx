"use client";

import { Input } from "@/components/ui/input";

import { useRef, useState, useTransition } from "react";
import { Plus, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CancelButton, SubmitButton } from "@/components/buttons";
import { AppSelect } from "@/components/ui/app-select";
import { updateOrderLinesAction } from "@/lib/order-actions";
import { validateOrderLines } from "@/lib/order-lines";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";
import { displayEndOfSafe, formatMoney, formatNumber, isoDayPart } from "@/lib/format";

interface Row {
  key: string;
  screen_id: string;
  screen_name: string | null;
  starts: string;
  ends: string;
  total: string;
  notes: string;
}

function toRow(l: Record<string, unknown>, key: string, screensById?: Map<string, string>): Row {
  const screenId = typeof l.screen_id === "string" ? l.screen_id : "";
  const rateMinor = Number(l.rate_minor ?? NaN);
  return {
    key,
    screen_id: screenId,
    screen_name: typeof l.screen_name === "string" ? l.screen_name : (screensById?.get(screenId) ?? null),
    starts: typeof l.starts_at === "string" ? (isoDayPart(l.starts_at) ?? "") : "",
    ends: typeof l.ends_at === "string" ? (displayEndOfSafe(l.ends_at) ?? "") : "",
    total: Number.isFinite(rateMinor) ? String(rateMinor / 100) : "",
    notes: typeof l.notes === "string" ? l.notes : "",
  };
}

/** Edición de pantallas de un borrador (drawer): periodos y totales por
 *  línea, quitar y agregar. Solo seller+ (el padre hace gating) y solo
 *  borradores sin facturas ni reservas (lo exige el servidor).
 *  El reemplazo es atómico vía `io_replace_lines` con anti-sobreventa. */
export function OrderLinesForm({
  orderId,
  orderCurrency,
  initialLines,
  screens,
  onSaved,
  onCancel,
}: {
  orderId: string;
  orderCurrency: string;
  initialLines: Array<Record<string, unknown>>;
  screens: Array<{ id: string; name: string; price_pen: number | null }>;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const screensById = new Map(screens.map((s) => [s.id, s.name]));
  const [rows, setRows] = useState<Row[]>(() =>
    initialLines.map((l, i) => toRow(l, `l${i}`, screensById)),
  );
  const [addId, setAddId] = useState("");
  const [pending, startTransition] = useTransition();
  const { invalid, mark, clear, bad, focusFirst } = useInvalidFields<string>();
  const formRef = useRef<HTMLFormElement>(null);

  const setRow = (index: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    for (const f of Object.keys(patch)) clear(`line-${index}-${f}`);
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
  };

  const addRow = () => {
    if (!addId) return;
    setRows((prev) => [
      ...prev,
      {
        key: `n${Date.now()}`,
        screen_id: addId,
        screen_name: screensById.get(addId) ?? null,
        starts: "",
        ends: "",
        total: "",
        notes: "",
      },
    ]);
    setAddId("");
  };

  const grossMajor = rows.reduce((a, r) => {
    const n = Number(String(r.total).trim().replace(",", "."));
    return a + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);

  function save() {
    const problems = validateOrderLines(
      rows.map((r) => ({ screen_id: r.screen_id, starts: r.starts, ends: r.ends, total: r.total, notes: r.notes })),
    );
    if (problems.length > 0) {
      mark(problems.map((p) => p.key));
      toastFormError("Revisa las líneas marcadas", problems.map((p) => p.message).join(" "));
      focusFirst(formRef, problems.map((p) => p.key));
      return;
    }
    startTransition(async () => {
      const res = await updateOrderLinesAction({
        orderId,
        lines: rows.map((r) => ({
          screen_id: r.screen_id,
          starts: r.starts,
          ends: r.ends,
          total: r.total,
          notes: r.notes.trim() || null,
        })),
      });
      if (!res.ok) {
        toastFormError("No se pudieron guardar las pantallas", res.message);
        return;
      }
      onSaved?.();
    });
  }

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {rows.length === 0 && (
        <p className="rounded-lg bg-muted/40 px-3 py-3 text-[13px] text-muted-foreground">
          Sin pantallas: agrega al menos una para guardar.
        </p>
      )}
      {rows.map((r, i) => (
        <fieldset key={r.key} className="grid grid-cols-1 gap-4 rounded-lg bg-muted/40 px-3 py-3 sm:grid-cols-2">
          <legend className="sr-only">Línea {i + 1}</legend>
          <p className="break-words text-sm font-medium sm:col-span-2" title={r.screen_name ?? undefined}>
            {i + 1}. {r.screen_name ?? "—"}
          </p>
          <label className="form-field">
            Inicio *
            <Input
              type="date"
              name={`line-${i}-starts`}
              value={r.starts}
              onChange={(e) => setRow(i, { starts: e.target.value })}
              disabled={pending}
              aria-invalid={invalid.has(`line-${i}-starts`)}
              className={`${bad(`line-${i}-starts`)}`}
            />
          </label>
          <label className="form-field">
            Fin *
            <Input
              type="date"
              name={`line-${i}-ends`}
              value={r.ends}
              onChange={(e) => setRow(i, { ends: e.target.value })}
              disabled={pending}
              aria-invalid={invalid.has(`line-${i}-ends`)}
              className={`${bad(`line-${i}-ends`)}`}
            />
          </label>
          <label className="form-field">
            Total * ({orderCurrency})
            <Input
              name={`line-${i}-total`}
              value={r.total}
              onChange={(e) => setRow(i, { total: e.target.value })}
              disabled={pending}
              inputMode="decimal"
              placeholder="2000"
              aria-invalid={invalid.has(`line-${i}-total`)}
              className={`text-right tabular-nums${bad(`line-${i}-total`)}`}
            />
          </label>
          <div className="flex items-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeRow(r.key)}
              disabled={pending}
              aria-label={`Quitar línea ${i + 1}`}
              title="Quitar (por error al registrar)"
            >
              <X aria-hidden />
              Quitar
            </Button>
          </div>
        </fieldset>
      ))}

      <div className="flex flex-wrap items-end gap-2">
        <div className="form-field w-full flex-1 sm:min-w-[220px]">
          Agregar pantalla
          <AppSelect
            value={addId}
            onChange={setAddId}
            options={screens.map((s) => ({ value: s.id, label: s.name }))}
            placeholder="Elegir pantalla…"
            ariaLabel="Pantalla a agregar"
            disabled={pending}
            allowClear={false}
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addRow} disabled={pending || !addId}>
          <Plus aria-hidden />
          Agregar
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pending={pending}>
          <Save aria-hidden />
          {`Guardar${grossMajor > 0 ? ` · ${formatMoney(Math.round(grossMajor * 100), orderCurrency)}` : ""}`}
        </SubmitButton>
        <CancelButton onCancel={onCancel} disabled={pending} />
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatNumber(rows.length)} línea{rows.length === 1 ? "" : "s"}
        </span>
      </div>
    </form>
  );
}
