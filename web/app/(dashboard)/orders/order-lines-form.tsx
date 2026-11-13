"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { CancelButton, SubmitButton } from "@/components/buttons";
import { AppCard } from "@/components/app-card";
import { updateOrderLinesAction } from "@/lib/order-actions";
import { toastFormError } from "@/components/ui/form-feedback";
import { addDays, diffDaysInclusive, displayEndOfSafe, formatNumber, isoDayPart, parseISODate } from "@/lib/format";
import { Money } from "@/components/money";
import { PantallaDrawer } from "../screens/pantalla-drawer";
import {
  OrderScreensTable,
  PeriodDatePicker,
  ScreenCalendarDialog,
  ScreenMultiSelect,
  useScreenAvailability,
  type ScreenPick,
} from "./order-screens";
import { plural } from "./order-screens/types";
import { parseSlotsInput } from "@/lib/order-lines";

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Edición de pantallas de un borrador (drawer).
 *  SSOT: mismo flujo que nueva orden — periodo global, combo estándar con
 *  disponibilidad, tabla precio/día × días = subtotal, calendario por fila.
 *  El reemplazo es atómico vía `io_replace_lines` con anti-sobreventa
 *  (excluye la propia orden). Solo borradores sin facturas ni reservas
 *  (lo exige el servidor). */
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
  screens: ScreenPick[];
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const screensById = useMemo(() => new Map(screens.map((s) => [s.id, s])), [screens]);

  // Meta de las líneas actuales (para pantallas fuera del top 200/inactivas
  // y para preservar notas): nombre/detalle/notas + total original + slots.
  const initialMeta = useMemo(() => {
    const m = new Map<string, { name: string | null; detail: string | null; notes: string | null; starts: string; ends: string; totalMajor: number | null; slots: number }>();
    for (const l of initialLines) {
      const sid = typeof l.screen_id === "string" ? l.screen_id : "";
      if (!sid || m.has(sid)) continue;
      const starts = typeof l.starts_at === "string" ? (isoDayPart(l.starts_at) ?? "") : "";
      const endsRaw = typeof l.ends_at === "string" ? l.ends_at : "";
      const ends = displayEndOfSafe(endsRaw) ?? isoDayPart(endsRaw) ?? "";
      const rateMinor = Number(l.rate_minor ?? NaN);
      const totalMajor = Number.isFinite(rateMinor) ? rateMinor / 100 : null;
      const rawSlots = Number(l.cant_slots);
      m.set(sid, {
        name: typeof l.screen_name === "string" ? l.screen_name : null,
        detail: typeof l.screen_detail === "string" ? l.screen_detail : null,
        notes: typeof l.notes === "string" && l.notes.trim() ? l.notes : null,
        starts,
        ends,
        totalMajor,
        slots: Number.isSafeInteger(rawSlots) && rawSlots >= 1 && rawSlots <= 100 ? rawSlots : 1,
      });
    }
    return m;
  }, [initialLines]);

  // Pantalla resoluble: del picker o fallback (línea existente fuera del top).
  const resolveScreen = (id: string): ScreenPick | null => {
    const s = screensById.get(id);
    if (s) return s;
    const meta = initialMeta.get(id);
    if (!meta) return null;
    return { id, name: meta.name ?? "—", detail: meta.detail, code: null, price_pen: null };
  };

  const initialSelected = useMemo(() => {
    const ids: string[] = [];
    for (const l of initialLines) {
      const sid = typeof l.screen_id === "string" ? l.screen_id : "";
      if (sid && !ids.includes(sid)) ids.push(sid);
    }
    return ids;
  }, [initialLines]);

  // Periodo global: si todas las líneas comparten el mismo, se hereda;
  // si es heterogéneo o vacío, se pide explícito (no se unifica en silencio).
  const initialPeriod = useMemo(() => {
    const startsList = uniq([...initialMeta.values()].map((m) => m.starts).filter(Boolean));
    const endsList = uniq([...initialMeta.values()].map((m) => m.ends).filter(Boolean));
    if (startsList.length === 1 && endsList.length === 1) {
      return { starts: startsList[0], ends: endsList[0] };
    }
    return { starts: "", ends: "" };
  }, [initialMeta]);

  const [starts, setStarts] = useState(initialPeriod.starts);
  const [ends, setEnds] = useState(initialPeriod.ends);
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const [prices, setPrices] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const id of initialSelected) {
      const meta = initialMeta.get(id);
      if (!meta || meta.totalMajor === null) continue;
      const diasLine = diffDaysInclusive(meta.starts, meta.ends);
      if (diasLine !== null && diasLine > 0 && meta.totalMajor > 0) {
        const unit = meta.totalMajor / diasLine / meta.slots;
        if (Number.isFinite(unit) && unit > 0) out[id] = String(Math.round(unit * 100) / 100);
      }
    }
    return out;
  });
  const [slots, setSlots] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialSelected.map((id) => [id, String(initialMeta.get(id)?.slots ?? 1)]),
    ),
  );
  const [notesById] = useState<Record<string, string | null>>(() =>
    Object.fromEntries([...initialMeta.entries()].map(([id, m]) => [id, m.notes])),
  );
  const [availableOnly, setAvailableOnly] = useState(false);
  const [calScreenId, setCalScreenId] = useState<string | null>(null);
  const [detailScreenId, setDetailScreenId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const {
    dias,
    checking,
    availError,
    occupancy,
    occupiedOf,
    untilOf,
    remainingOf,
    capacityOf,
    occupiedCount,
    periodLabel,
    commonWindowFor,
    nextWindowLabelFor,
    ensureOccupancy,
  } = useScreenAvailability({ screens, starts, ends, slots, excludeIoId: orderId });

  // Precarga el precio de la BD (price_pen) y 1 slot al elegir pantallas,
  // sin pisar lo que el vendedor ya digitó o lo que viene de las líneas actuales.
  const priceById = useMemo(() => new Map(screens.map((s) => [s.id, s.price_pen])), [screens]);
  useEffect(() => {
    setPrices((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of selected) {
        if (next[id] !== undefined && String(next[id]).trim() !== "") continue;
        const p = priceById.get(id);
        if (p !== null && p !== undefined && Number.isFinite(Number(p)) && Number(p) > 0) {
          next[id] = String(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setSlots((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of selected) {
        if (next[id] === undefined) {
          next[id] = "1";
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selected, priceById]);

  const periodReady = dias !== null;
  const rows = useMemo(
    () => selected.map(resolveScreen).filter((s): s is ScreenPick => s !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, screensById, initialMeta],
  );

  const priceOf = (id: string) => {
    const n = Number(String(prices[id] ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const slotsOf = (id: string) => parseSlotsInput(slots[id]);
  const invalidRows = rows.filter((r) => priceOf(r.id) === null);
  const invalidSlotsRows = rows.filter((r) => slotsOf(r.id) === null);
  const blockedRows = rows.filter((r) => occupiedOf(r.id).length > 0);
  const commonWindow = commonWindowFor(selected);
  const nextWindowLabel = nextWindowLabelFor(selected);
  const total = rows.reduce((a, r) => {
    const unit = priceOf(r.id);
    const qty = slotsOf(r.id);
    return a + (unit !== null && qty !== null && dias !== null ? unit * dias * qty : 0);
  }, 0);

  const heterogeneous = initialPeriod.starts === "" && initialLines.length > 0;

  function applyWindow(windowStart: string) {
    if (dias === null) return;
    setStarts(windowStart);
    setEnds(addDays(windowStart, dias - 1));
  }

  const openCalendar = (id: string) => {
    setCalScreenId(id);
    const q = slotsOf(id);
    ensureOccupancy(id, q === null ? undefined : q);
  };

  const toggleScreen = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const missing: string[] = [];
  if (dias === null) missing.push("el periodo");
  if (rows.length === 0) missing.push("al menos una pantalla");
  else if (invalidRows.length > 0) missing.push(`precio de ${invalidRows.length} pantalla${plural(invalidRows.length)}`);
  else if (invalidSlotsRows.length > 0) missing.push(`slots de ${invalidSlotsRows.length} pantalla${plural(invalidSlotsRows.length)} (1–100)`);
  if (blockedRows.length > 0) missing.push(`${blockedRows.length} pantalla${plural(blockedRows.length)} sin cupo en ese periodo`);
  const canSubmit = !pending && !checking && missing.length === 0;

  function save() {
    if (dias === null || rows.length === 0 || invalidRows.length > 0 || invalidSlotsRows.length > 0 || blockedRows.length > 0) {
      toastFormError("Revisa las pantallas", `Falta: ${missing.join(", ")}.`);
      return;
    }
    startTransition(async () => {
      const res = await updateOrderLinesAction({
        orderId,
        lines: rows.map((r) => ({
          screen_id: r.id,
          starts,
          ends,
          total: String((priceOf(r.id) as number) * (dias as number) * (slotsOf(r.id) as number)),
          slots: slotsOf(r.id) as number,
          notes: notesById[r.id] ?? null,
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
    <>
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <AppCard title="Periodo">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-[1fr_1fr_0.5fr]">
            <PeriodDatePicker
              label="Inicio *"
              pickerLabel="Inicio del periodo"
              value={starts}
              disabled={pending}
              disabledDays={ends ? (d) => d > (parseISODate(ends) ?? d) : undefined}
              onChange={setStarts}
            />
            <PeriodDatePicker
              label="Fin *"
              pickerLabel="Fin del periodo"
              value={ends}
              disabled={pending}
              disabledDays={starts ? (d) => d < (parseISODate(starts) ?? d) : undefined}
              onChange={setEnds}
            />
            <div className="form-field col-span-2 sm:col-span-1">
              Días
              <output
                aria-label="Días del periodo"
                aria-live="polite"
                className="flex h-9 items-center rounded-lg border border-border bg-muted/40 px-2.5 text-sm text-muted-foreground tabular-nums"
              >
                {dias ?? "—"}
              </output>
            </div>
          </div>
          {heterogeneous && (
            <p className="mt-2 text-xs text-muted-foreground">
              Las líneas traían periodos distintos: define el periodo único que aplicará a todas.
            </p>
          )}
        </AppCard>

        <AppCard title={`Pantallas *${rows.length > 0 ? ` (${formatNumber(rows.length)})` : ""}`}>
          <div className="flex flex-col gap-4">
            {screens.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Sin pantallas activas. Registra pantallas en Inventario antes de editar la orden.
              </p>
            ) : (
              <ScreenMultiSelect
                screens={screens}
                selected={selected}
                onToggle={toggleScreen}
                onSetAll={setSelected}
                onClear={() => setSelected([])}
                occupiedOf={occupiedOf}
                untilOf={untilOf}
                remainingOf={remainingOf}
                capacityOf={capacityOf}
                onShowCalendar={openCalendar}
                availableOnly={availableOnly}
                onToggleAvailableOnly={() => setAvailableOnly((v) => !v)}
                periodReady={periodReady}
                occupiedCount={occupiedCount}
                periodLabel={periodLabel}
                nextWindowLabel={nextWindowLabel}
                onApplyWindow={commonWindow ? () => applyWindow(commonWindow) : null}
                availError={availError}
                isChecking={checking}
                disabled={pending}
              />
            )}
            {checking && (
              <p className="text-xs text-muted-foreground" role="status">Verificando disponibilidad…</p>
            )}
            {rows.length > 0 && (
              <OrderScreensTable
                rows={rows}
                prices={prices}
                slots={slots}
                dias={dias}
                currency={orderCurrency}
                occupiedOf={occupiedOf}
                remainingOf={remainingOf}
                capacityOf={capacityOf}
                checking={checking}
                commonWindow={commonWindow}
                onApplyWindow={commonWindow ? () => applyWindow(commonWindow) : null}
                onPriceChange={(id, v) => setPrices((p) => ({ ...p, [id]: v }))}
                onSlotsChange={(id, v) => setSlots((p) => ({ ...p, [id]: v }))}
                onRemove={toggleScreen}
                onCalendar={openCalendar}
                onDetail={setDetailScreenId}
                disabled={pending}
                pending={pending}
              />
            )}
          </div>
        </AppCard>

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton pending={pending} disabled={!canSubmit} title={!canSubmit ? `Falta: ${missing.join(", ")}` : undefined} pendingLabel="Guardando…">
            <Plus aria-hidden />
            <>Guardar{total > 0 ? <> · <Money amountMinor={Math.round(total * 100)} currency={orderCurrency} /></> : null}</>
          </SubmitButton>
          <CancelButton onCancel={onCancel} disabled={pending} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatNumber(rows.length)} línea{plural(rows.length)}
          </span>
        </div>
        {!canSubmit && !pending && (
          <p className="text-xs text-muted-foreground">Falta: {missing.join(", ")}.</p>
        )}
      </form>

      <ScreenCalendarDialog
        screen={screensById.get(calScreenId ?? "") ?? resolveScreen(calScreenId ?? "")}
        ranges={calScreenId ? occupancy[calScreenId] : undefined}
        loaded={calScreenId ? calScreenId in occupancy : false}
        duration={dias ?? 0}
        periodStarts={starts}
        periodEnds={ends}
        capacity={calScreenId ? capacityOf(calScreenId) : null}
        minFree={calScreenId ? remainingOf(calScreenId) : null}
        onApply={(w) => {
          applyWindow(w);
          setCalScreenId(null);
        }}
        onSelectRange={(from, to) => {
          setStarts(from);
          setEnds(to);
        }}
        onClose={() => setCalScreenId(null)}
      />
      {detailScreenId && (
        <PantallaDrawer screenId={detailScreenId} onClose={() => setDetailScreenId(null)} />
      )}
    </>
  );
}
