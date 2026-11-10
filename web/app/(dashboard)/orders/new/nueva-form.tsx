"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CalendarDays, CalendarIcon, Check, ChevronsUpDown, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectionBadge } from "@/components/badges";
import { Checkbox } from "@/components/ui/checkbox";
import { AppSelect } from "@/components/ui/app-select";
import { AppCard } from "@/components/app-card";
import { Calendar } from "@/components/ui/calendar";
import { ComboboxField } from "@/components/combobox-field";
import {
  Dialog,
  DrawerDialogContent as DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableRow,
  DataTableTd,
  DataTableTh,
} from "@/components/data-table";
import { SectionHeading } from "@/components/section-heading";
import { cn } from "cn";
import { es } from "react-day-picker/locale";
import { addDays, diffDaysInclusive, formatDate, formatMoney, formatNumber, parseISODate, toISODateLocal, toTitleCase } from "@/lib/format";
import { filterPickScreens } from "@/lib/screen-pick";
import { normalizeCurrency } from "@/lib/currency";import { createOrderRedirectAction, checkAvailabilityAction, getScreenOccupancyAction } from "@/lib/order-actions";
import { PantallaDrawer } from "../../screens/pantalla-drawer";
import type { ScreenConflict } from "@/lib/availability";
import {
  firstFreeDay,
  nextFreeWindow,
  todayLima,
  unionRanges,
  type OccupiedRange,
} from "@/lib/availability-utils";
import type { CrmState } from "@/lib/crm-actions";
import { FIELD_ERR_CLS, toastFormError, useInvalidFields } from "@/components/ui/form-feedback";

const initial: CrmState = { ok: false, message: "" };

interface Screen {
  id: string;
  name: string;
  detail: string | null;
  price_pen: number | null;
}

interface CompanyContact {
  id: string;
  company_id: string | null;
  name: string;
  role: string | null;
  email: string | null;
  companyName: string;
}

function PeriodDatePicker({
  label,
  value,
  onChange,
  disabled,
  disabledDays,
  pickerLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  disabledDays?: (date: Date) => boolean;
  pickerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseISODate(value);

  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs">
      {label}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              aria-label={pickerLabel}
              className={cn(
                "h-9 w-full justify-start bg-background px-2.5 text-sm font-normal",
                !selected && "text-muted-foreground",
              )}
            >
              <CalendarIcon aria-hidden />
              {selected ? formatDate(value) : "Elegir…"}
            </Button>
          }
        />
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            locale={es}
            selected={selected}
            disabled={disabledDays}
            onSelect={(d) => {
              if (d) {
                onChange(toISODateLocal(d));
                setOpen(false);
              }
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ScreenMultiSelect({
  screens,
  selected,
  onToggle,
  onSetAll,
  onClear,
  occupiedOf,
  untilOf,
  onShowCalendar,
  availableOnly,
  onToggleAvailableOnly,
  periodReady,
  occupiedCount,
  periodLabel,
  nextWindowLabel,
  onApplyWindow,
  availError,
  isChecking,
  disabled,
}: {
  screens: Screen[];
  selected: string[];
  onToggle: (id: string) => void;
  onSetAll: (ids: string[]) => void;
  onClear: () => void;
  occupiedOf: (id: string) => ScreenConflict[];
  untilOf: (id: string) => string | null;
  onShowCalendar: (id: string) => void;
  availableOnly: boolean;
  onToggleAvailableOnly: () => void;
  periodReady: boolean;
  occupiedCount: number;
  periodLabel: string | null;
  nextWindowLabel: string | null;
  onApplyWindow: (() => void) | null;
  availError: string | null;
  isChecking: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => filterPickScreens(screens, q), [screens, q]);
  const visible = useMemo(
    () => (availableOnly && periodReady ? filtered.filter((s) => occupiedOf(s.id).length === 0) : filtered),
    [filtered, availableOnly, periodReady, occupiedOf],
  );

  const set = useMemo(() => new Set(selected), [selected]);
  const allFilteredIn = visible.length > 0 && visible.every((s) => set.has(s.id));

  const label =
    selected.length === 0
      ? "Elegir pantallas…"
      : `${formatNumber(selected.length)} seleccionada${selected.length === 1 ? "" : "s"}${
          periodReady && occupiedCount > 0 ? ` · ${formatNumber(occupiedCount)} ocupada${plural(occupiedCount)}` : ""
        }`;

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              aria-label="Elegir pantallas"
              className={cn(
                "h-9 w-full justify-between bg-background px-2.5 text-sm font-normal",
                selected.length === 0 && "text-muted-foreground",
              )}
            >
              <span className="truncate">{label}</span>
              <ChevronsUpDown aria-hidden className="shrink-0 opacity-50" />
            </Button>
          }
        />
        <PopoverContent align="start" className="w-[min(24rem,calc(100vw-3rem))] p-2">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar por nombre, código, ubicación…"
              aria-label="Buscar pantallas"
              autoComplete="off"
              className="h-9 w-full rounded-lg border border-border bg-background pr-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
            />
          </div>
          <div className="flex items-center justify-between gap-2 px-1 pt-2 pb-1">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {formatNumber(visible.length)} de {formatNumber(screens.length)}
            </span>
            <div className="flex items-center gap-1">
              <label className="flex cursor-pointer items-center gap-1.5 pr-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={availableOnly}
                  onChange={onToggleAvailableOnly}
                  disabled={!periodReady}
                  aria-label="Solo disponibles en el periodo"
                  className="size-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed"
                />
                Solo disponibles
              </label>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={allFilteredIn}
                onClick={() =>
                  onSetAll([...selected, ...visible.map((s) => s.id).filter((id) => !set.has(id) && occupiedOf(id).length === 0)])
                }
              >
                <Check aria-hidden />
                Todas
              </Button>
              <Button type="button" variant="ghost" size="xs" disabled={selected.length === 0} onClick={onClear}>
                <X aria-hidden />
                Ninguna
              </Button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto" role="group" aria-label="Pantallas disponibles">
            {!periodReady && (
              <p className="px-2 pt-1 pb-2 text-[11px] text-muted-foreground">
                Elige Inicio y Fin para ver disponibilidad.
              </p>
            )}
            {visible.map((s) => {
              const checked = set.has(s.id);
              const occupied = periodReady ? occupiedOf(s.id) : [];
              const blocked = occupied.length > 0 && !checked;
              const until = untilOf(s.id);
              const note = occupied.length > 0
                ? `No disponible · ${[occupied[0].io_number, occupied[0].brand].filter(Boolean).join(" · ") || "ocupada"}${until ? ` · hasta ${formatDate(until)}` : ""}`
                : null;
              return (
                <div
                  key={s.id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1.5",
                    blocked ? "opacity-60" : "hover:bg-muted/60",
                  )}
                >
                  <label
                    aria-disabled={blocked}
                    className={cn(
                      "flex min-w-0 flex-1 cursor-pointer items-center gap-2.5",
                      blocked && "cursor-not-allowed",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={blocked}
                      onChange={() => onToggle(s.id)}
                      aria-label={blocked ? `${s.name} (no disponible en ese periodo)` : s.name}
                      className="size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-xs font-medium">{s.name}</span>
                        {checked && <Check aria-hidden className="size-3.5 shrink-0 text-primary" />}
                      </span>
                      {note && <span className="truncate text-[11px] text-destructive">{note}</span>}
                    </span>
                    {s.detail && (
                      <span className="max-w-[40%] truncate text-[11px] text-muted-foreground">{s.detail}</span>
                    )}
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Ver disponibilidad de ${s.name}`}
                    title="Ver disponibilidad"
                    onClick={() => onShowCalendar(s.id)}
                    className="shrink-0"
                  >
                    <CalendarDays aria-hidden />
                  </Button>
                </div>
              );
            })}
            {visible.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {availableOnly && periodReady
                  ? "Todo lo filtrado está ocupado en ese periodo. Prueba otras fechas."
                  : "Sin resultados para esa búsqueda."}
              </p>
            )}
          </div>
          {periodReady && !isChecking && !availError && occupiedCount === 0 && (
            <p className="flex items-center gap-1 px-2 text-[11px] text-emerald-700 tabular-nums" role="status">
              <Check aria-hidden className="size-3.5" />
              Todo libre en {periodLabel}
            </p>
          )}
          {periodReady && !isChecking && availError && (
            <p className="px-2 text-[11px] text-amber-700" role="alert">
              {availError} Se revalida al crear.
            </p>
          )}
          {periodReady && occupiedCount > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-destructive/5 px-2.5 py-2">
              <p className="text-[11px] text-destructive tabular-nums">
                {formatNumber(occupiedCount)} ocupada{plural(occupiedCount)} en {periodLabel}
              </p>
              {nextWindowLabel && onApplyWindow && (
                <Button type="button" size="xs" variant="outline" onClick={onApplyWindow}>
                  <ArrowRight aria-hidden />
                  {nextWindowLabel}
                </Button>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Pantallas elegidas">
          {selected.map((id) => {
            const s = screens.find((x) => x.id === id);
            if (!s) return null;
            return (
              <SelectionBadge
                key={id}
                label={s.name}
                removeLabel={`Quitar ${s.name}`}
                onRemove={() => onToggle(id)}
                disabled={disabled}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Calendario de disponibilidad de una pantalla: ocupado tachado, periodo elegido en rango. */
function ScreenCalendarDialog({
  screen,
  ranges,
  loaded,
  duration,
  periodStarts,
  periodEnds,
  onApply,
  onClose,
}: {
  screen: Screen | null;
  ranges: OccupiedRange[] | undefined;
  loaded: boolean;
  duration: number;
  periodStarts: string;
  periodEnds: string;
  onApply: (starts: string) => void;
  onClose: () => void;
}) {
  const booked = (ranges ?? []).flatMap((r) => {
    const from = parseISODate(r.starts);
    const to = parseISODate(r.ends);
    return from && to ? [{ from, to }] : [];
  });
  const periodFrom = parseISODate(periodStarts);
  const periodTo = parseISODate(periodEnds);
  const today = todayLima();
  const free = screen && loaded && ranges ? firstFreeDay(ranges, today) : null;
  const windowStart = screen && loaded && ranges && duration > 0
    ? nextFreeWindow(ranges, today, duration)
    : null;

  return (
    <Dialog open={screen !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-auto max-w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>{screen?.name ?? "Disponibilidad"}</DialogTitle>
          <DialogDescription>
            {screen?.detail ?? ""}
            {loaded && ranges && ranges.length === 0 && " · libre en todo lo visible."}
          </DialogDescription>
        </DialogHeader>
        {!loaded || !ranges ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Cargando disponibilidad…</p>
        ) : (
          <div className="flex flex-col gap-2">
            <Calendar
              mode="range"
              locale={es}
              selected={periodFrom ? { from: periodFrom, to: periodTo } : undefined}
              modifiers={{ booked }}
              modifiersClassNames={{ booked: "bg-destructive/10 text-destructive line-through" }}
              disabled={booked}
            />
            <p className="text-[11px] text-muted-foreground tabular-nums">
              <span className="mr-1 inline-block size-2.5 rounded-sm bg-destructive/20 align-middle" aria-hidden />
              ocupado · libre desde {free ? formatDate(free) : "—"}
              {windowStart && (
                <> · hueco de {formatNumber(duration)} día{plural(duration)}: {formatDate(windowStart)}</>
              )}
            </p>
            {windowStart && (
              <div>
                <Button type="button" size="sm" variant="outline" onClick={() => onApply(windowStart)}>
                  <CalendarDays aria-hidden />
                  Usar {formatDate(windowStart)} → {formatDate(addDays(windowStart, duration - 1))}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function NuevaOrdenForm({
  companies,
  brands,
  screens,
  defaultCurrency = "PEN",
}: {
  companies: Array<{ id: string; name: string; kind: string | null }>;
  brands: string[];
  screens: Screen[];
  defaultCurrency?: string;
}) {
  const [state, action, pending] = useActionState(createOrderRedirectAction, initial);
  const [company, setCompany] = useState<string>("");
  const [brand, setBrand] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [agencyId, setAgencyId] = useState<string>("");
  const [agencySelf, setAgencySelf] = useState<boolean>(true);
  const [pocId, setPocId] = useState<string>("");
  const [signerId, setSignerId] = useState<string>("");
  const [paymentId, setPaymentId] = useState<string>("");
  const [managerId, setManagerId] = useState<string>("");
  const [billingDoc, setBillingDoc] = useState<string>("");
  const [billingDetail, setBillingDetail] = useState<string>("");
  const [invoiceRegistration, setInvoiceRegistration] = useState<string>("");
  const [billingPortal, setBillingPortal] = useState<string>("");
  const [contratanteContacts, setContratanteContacts] = useState<CompanyContact[]>([]);
  const [agencyContacts, setAgencyContacts] = useState<CompanyContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  // Intermediaria efectiva: el contratante (check) o la agencia definida.
  const agencyRealId = !agencySelf && agencyId !== "" ? agencyId : null;
  const [paymentTerms, setPaymentTerms] = useState<string>("");
  const [currency, setCurrency] = useState<string>(normalizeCurrency(defaultCurrency, "PEN"));
  const [starts, setStarts] = useState<string>("");
  const [ends, setEnds] = useState<string>("");
  const [selected, setSelected] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<ScreenConflict[]>([]);
  const [checking, setChecking] = useState(false);
  const [availError, setAvailError] = useState<string | null>(null);
  const [occupancy, setOccupancy] = useState<Record<string, OccupiedRange[]>>({});
  const [calScreenId, setCalScreenId] = useState<string | null>(null);
  const [detailScreenId, setDetailScreenId] = useState<string | null>(null);
  const [availableOnly, setAvailableOnly] = useState(false);
  const { invalid, mark, clear, focusFirst } = useInvalidFields<"company">();
  const formRef = useRef<HTMLFormElement>(null);

  const dias = diffDaysInclusive(starts, ends);

  // Agencias del tenant para vincular intermediaria (o texto manual si no existe).
  const agencies = companies.filter((c) => c.kind === "agencia");
  // Responsable: de la intermediaria (o del contratante si es él).
  const managerOpts = agencySelf ? contratanteContacts : agencyContacts;

  // Contactos por bloque: cada empresa seleccionada trae los suyos
  // (contratante → POC/firmante/pago; intermediaria → responsable).
  useEffect(() => {
    const ids = [company, agencyRealId].filter((x): x is string => !!x);
    if (ids.length === 0) {
      setContratanteContacts([]);
      setAgencyContacts([]);
      return;
    }
    let alive = true;
    setContactsLoading(true);
    void Promise.all(
      ids.map((id) => fetch(`/api/companies/${id}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)),
    )
      .then((details) => {
        if (!alive) return;
        const byCompany = new Map<string, CompanyContact[]>();
        for (const d of details) {
          if (!d) continue;
          const co = d.company as Record<string, unknown> | undefined;
          const cid = typeof co?.id === "string" ? co.id : "";
          const cname = toTitleCase(typeof co?.name === "string" && co.name ? co.name : "");
          const opts: CompanyContact[] = [];
          for (const c of ((d.contacts ?? []) as Array<Record<string, unknown>>)) {
            const first = typeof c.first_name === "string" ? c.first_name.trim() : "";
            const last = typeof c.last_name === "string" ? c.last_name.trim() : "";
            const email = typeof c.email === "string" && c.email.trim() ? c.email.trim() : null;
            opts.push({
              id: String(c.id),
              company_id: typeof c.company_id === "string" ? c.company_id : cid || null,
              name: [first, last].filter(Boolean).join(" ") || email || "—",
              role: typeof c.job_title === "string" && c.job_title.trim() ? c.job_title.trim() : null,
              email,
              companyName: cname,
            });
          }
          if (cid) byCompany.set(cid, opts);
        }
        const cc = company ? (byCompany.get(company) ?? []) : [];
        // Check ON (es el contratante): responsable sale del contratante.
        const ac = agencySelf ? cc : agencyRealId ? (byCompany.get(agencyRealId) ?? []) : [];
        setContratanteContacts(cc);
        setAgencyContacts(agencySelf ? [] : ac);
        // Limpia selecciones huérfanas al cambiar de empresa.
        const keepIn = (opts: CompanyContact[]) => (prev: string) =>
          prev !== "" && !opts.some((o) => o.id === prev) ? "" : prev;
        setPocId(keepIn(cc));
        setSignerId(keepIn(cc));
        setPaymentId(keepIn(cc));
        setManagerId(keepIn(ac));
      })
      .finally(() => {
        if (alive) setContactsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [company, agencySelf, agencyId]);

  // Error del server: borde + toast + foco (el botón ya se deshabilita con `missing`).
  useEffect(() => {
    if (!state.message || state.ok) return;
    if (/empresa|contratante|compa[ñn][íi]a|company/i.test(state.message)) {
      mark(["company"]);
      focusFirst(formRef, ["company_id"]);
    }
    toastFormError("No se pudo crear la orden", state.message);
  }, [state, mark, focusFirst]);

  // Precarga el precio de la BD (price_pen) al elegir pantallas, sin pisar
  // lo que el vendedor ya digitó o editó.
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
  }, [selected, priceById]);

  // Disponibilidad del periodo (debounce): ocupada = visible pero no seleccionable.
  // Trae choques del periodo + ocupación de todas las pantallas (calendarios y
  // próximo hueco). Todo setState vive en el callback del debounce (el repo
  // prohíbe setState síncrono en el cuerpo del effect); el server action
  // revalida al crear.
  useEffect(() => {
    const h = setTimeout(async () => {
      if (dias === null) {
        setConflicts([]);
        setChecking(false);
        setAvailError(null);
        return;
      }
      setChecking(true);
      try {
        const anchor = todayLima();
        const ids = screens.map((s) => s.id);
        const [res, occ] = await Promise.all([
          checkAvailabilityAction({ starts, ends }),
          getScreenOccupancyAction({ screenIds: ids, from: anchor }),
        ]);
        if (res.ok) {
          setConflicts(res.conflicts);
          setAvailError(null);
        } else {
          setAvailError(res.message || "No se pudo verificar disponibilidad.");
        }
        if (occ.ok) {
          setOccupancy((prev) => {
            const next: Record<string, OccupiedRange[]> = { ...prev, ...occ.occupancy };
            for (const id of ids) next[id] ??= [];
            return next;
          });
        }
      } catch {
        setAvailError("No se pudo verificar disponibilidad.");
      } finally {
        setChecking(false);
      }
    }, 400);
    return () => clearTimeout(h);
  }, [starts, ends, dias, screens]);

  const conflictBy = useMemo(() => {
    const m = new Map<string, ScreenConflict[]>();
    for (const c of conflicts) {
      const list = m.get(c.screen_id) ?? [];
      list.push(c);
      m.set(c.screen_id, list);
    }
    return m;
  }, [conflicts]);
  const occupiedOf = (id: string): ScreenConflict[] => conflictBy.get(id) ?? [];
  const untilOf = (id: string): string | null => {
    const list = conflictBy.get(id);
    if (!list || list.length === 0) return null;
    return list.reduce((a, b) => (a > b ? a : b)).ends;
  };

  const openCalendar = (id: string) => {
    setCalScreenId(id);
    if (!(id in occupancy)) {
      void getScreenOccupancyAction({ screenIds: [id], from: todayLima() }).then((res) => {
        if (res.ok) {
          setOccupancy((prev) => {
            const next: Record<string, OccupiedRange[]> = { ...prev, ...res.occupancy };
            next[id] ??= [];
            return next;
          });
        }
      });
    }
  };

  /** Mueve el periodo a un inicio dado, conservando la duración. */
  const applyWindow = (windowStart: string) => {
    if (dias === null) return;
    setStarts(windowStart);
    setEnds(addDays(windowStart, dias - 1));
  };

  const toggleScreen = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const rows = selected
    .map((id) => screens.find((s) => s.id === id))
    .filter((s): s is Screen => Boolean(s));

  const priceOf = (id: string) => {
    const n = Number(String(prices[id] ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const lineTotalOf = (id: string) => {
    const unit = priceOf(id);
    return unit !== null && dias !== null ? unit * dias : 0;
  };
  const invalidRows = rows.filter((r) => priceOf(r.id) === null);
  const total = rows.reduce((a, r) => a + lineTotalOf(r.id), 0);

  const blockedRows = rows.filter((r) => occupiedOf(r.id).length > 0);

  /** Próximo hueco común a todas las elegidas (misma duración). */
  const commonWindow =
    blockedRows.length > 0 && dias !== null && rows.every((r) => r.id in occupancy)
      ? nextFreeWindow(unionRanges(rows.map((r) => occupancy[r.id])), starts, dias)
      : null;
  const occupiedCount = dias !== null ? screens.filter((s) => conflictBy.has(s.id)).length : 0;
  const periodLabel = dias !== null ? `${formatDate(starts)}→${formatDate(ends)}` : null;
  const nextWindowLabel =
    commonWindow && dias !== null
      ? `Mover al próximo hueco: ${formatDate(commonWindow)} → ${formatDate(addDays(commonWindow, dias - 1))}`
      : null;

  const missing: string[] = [];
  if (!company) missing.push("quién firma");
  if (!brand.trim()) missing.push("marca");
  if (!paymentTerms) missing.push("condición de pago");
  if (pocId === "") missing.push("contacto contratante");
  if (signerId === "") missing.push("firmante");
  if (billingDoc === "") missing.push("documento para facturación");
  if (!agencySelf && agencyId === "") missing.push("empresa intermediaria");
  if (dias === null) missing.push("el periodo");
  if (rows.length === 0) missing.push("al menos una pantalla");
  else if (invalidRows.length > 0) missing.push(`precio de ${invalidRows.length} pantalla${plural(invalidRows.length)}`);
  if (blockedRows.length > 0) missing.push(`${blockedRows.length} pantalla${plural(blockedRows.length)} ocupada${plural(blockedRows.length)} en ese periodo`);
  const canSubmit = !pending && !checking && missing.length === 0;

  // Defensa cliente: el botón ya se deshabilita con `missing`, pero un
  // submit directo (Enter) también marca borde + toast + foco.
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (company) return;
    e.preventDefault();
    mark(["company"]);
    toastFormError("Revisa el campo marcado", "Elige quién firma la orden.");
    focusFirst(formRef, ["company_id"]);
  }

  return (
    <>
    <form ref={formRef} action={action} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <AppCard title="Contratante">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex min-w-0 flex-col gap-1 text-xs">
            Contratante *
            <input type="hidden" name="company_id" value={company} />
            <Select
              value={company}
              onValueChange={(v) => { if (v) { setCompany(v); clear("company"); } }}
              items={Object.fromEntries(companies.map((c) => [c.id, toTitleCase(c.name)]))}
              disabled={pending}
            >
              <SelectTrigger aria-label="Contratante" aria-invalid={invalid.has("company")} data-field="company_id" className={cn("w-full", invalid.has("company") && FIELD_ERR_CLS)}>
                <SelectValue placeholder="Agencia o anunciante…" />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{toTitleCase(c.name)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex min-w-0 flex-col gap-1 text-xs">
            Marca *
            <input type="hidden" name="brand" value={brand} />
            <ComboboxField
              items={brands}
              value={brand}
              onChange={setBrand}
              placeholder="Tottus…"
              emptyText="Sin marcas registradas."
              displayItem={toTitleCase}
              ariaLabel="Marca"
              disabled={pending}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-xs">
            Condición de pago *
              <input type="hidden" name="payment_terms_days" value={paymentTerms} />
              <Select
                value={paymentTerms}
                onValueChange={(v) => setPaymentTerms(v ?? "")}
                items={{ "0": "Contado", "30": "30 días", "60": "60 días", "90": "90 días" }}
                disabled={pending}
              >
                <SelectTrigger aria-label="Condición de pago" className="w-full">
                  <SelectValue placeholder="Elegir condición…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Contado</SelectItem>
                  <SelectItem value="30">30 días</SelectItem>
                  <SelectItem value="60">60 días</SelectItem>
                  <SelectItem value="90">90 días</SelectItem>
                </SelectContent>
              </Select>
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-xs">
            Moneda de la orden *
              <input type="hidden" name="currency" value={currency} />
              <Select
                value={currency}
                onValueChange={(v) => v && setCurrency(String(v).toUpperCase())}
                items={{ PEN: "PEN — Soles", USD: "USD — Dólares" }}
                disabled={pending}
              >
                <SelectTrigger aria-label="Moneda de la orden" className="w-full">
                  <SelectValue placeholder="Moneda…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PEN">PEN — Soles</SelectItem>
                  <SelectItem value="USD">USD — Dólares</SelectItem>
                </SelectContent>
              </Select>
          </div>
          <ContactPicker
            label="Contacto contratante"
            field="billing_contact_id"
            value={pocId}
            onChange={setPocId}
            options={contratanteContacts}
            disabled={pending}
            required
          />
          <ContactPicker
            label="Firmante"
            field="signer_contact_id"
            value={signerId}
            onChange={setSignerId}
            options={contratanteContacts}
            disabled={pending}
            required
          />
          <label className="flex min-w-0 flex-col gap-1 text-xs sm:col-span-2 lg:col-span-4">
            Notas
            <input type="hidden" name="notes" value={notes} />
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              disabled={pending}
              placeholder="Observaciones para la nota de pedido…"
              aria-label="Notas"
              className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm"
            />
          </label>
        </div>
        {contactsLoading ? (
          <p className="mt-2 text-[11px] text-muted-foreground" role="status">Cargando contactos…</p>
        ) : company && contratanteContacts.length === 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            El contratante no tiene contactos. Créalos en Empresas → Contactos.
          </p>
        ) : null}
      </AppCard>

      <AppCard title="Facturación">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex min-w-0 flex-col gap-1 text-xs">
            Documento para facturación *
            <input type="hidden" name="billing_doc" value={billingDoc} />
            <AppSelect
              value={billingDoc}
              onChange={setBillingDoc}
              options={[
                { value: "orden_medios", label: "Orden de Medios" },
                { value: "orden_compra", label: "Orden de Compra" },
                { value: "contrato", label: "Contrato" },
              ]}
              placeholder="Elegir documento…"
              ariaLabel="Documento para facturación"
              disabled={pending}
              allowClear={false}
            />
          </div>
          <label className="flex min-w-0 flex-col gap-1 text-xs sm:col-span-2 lg:col-span-3">
            Indicaciones para facturación
            <input type="hidden" name="billing_detail" value={billingDetail} />
            <input
              value={billingDetail}
              onChange={(e) => setBillingDetail(e.target.value)}
              maxLength={500}
              disabled={pending}
              placeholder="HES, una factura por OC…"
              aria-label="Indicaciones para facturación"
              className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs sm:col-span-2 lg:col-span-4">
            Observaciones para registro de factura
            <input type="hidden" name="invoice_registration" value={invoiceRegistration} />
            <input
              value={invoiceRegistration}
              onChange={(e) => setInvoiceRegistration(e.target.value)}
              maxLength={500}
              disabled={pending}
              placeholder="Envíe su factura a más tardar el día 3…"
              aria-label="Observaciones para registro de factura"
              className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm"
            />
          </label>
          <ContactPicker
            label="Contacto de pago"
            field="payment_contact_id"
            value={paymentId}
            onChange={setPaymentId}
            options={contratanteContacts}
            disabled={pending}
          />
          <label className="flex min-w-0 flex-col gap-1 text-xs sm:col-span-2">
            Correo electrónico y/o portal
            <input type="hidden" name="billing_portal_email" value={billingPortal} />
            <input
              value={billingPortal}
              onChange={(e) => setBillingPortal(e.target.value)}
              maxLength={320}
              disabled={pending}
              placeholder="Empresa | correo…"
              aria-label="Correo electrónico y/o portal"
              className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm"
            />
          </label>
        </div>
      </AppCard>

      <AppCard title="Intermediario">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <label className="flex cursor-pointer flex-row items-center gap-2 text-xs">
            <Checkbox
              checked={agencySelf}
              onCheckedChange={(v) => {
                const on = v === true;
                setAgencySelf(on);
                if (on) {
                  setAgencyId("");
                  setManagerId("");
                }
              }}
              disabled={pending}
              aria-label="Es contratante"
            />
            Es contratante
            <input type="hidden" name="agency_is_self" value={agencySelf ? "1" : ""} />
          </label>
          {!agencySelf && (
            <div className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs">
              Empresa intermediaria *
              <input type="hidden" name="agency_company_id" value={agencyId === "" ? "" : agencyId} />
              <AppSelect
                value={agencyId}
                onChange={setAgencyId}
                options={agencies.map((c) => ({ value: c.id, label: toTitleCase(c.name) }))}
                placeholder="Elegir agencia…"
                ariaLabel="Agencia intermediaria"
                disabled={pending}
                allowClear={false}
              />
            </div>
          )}
          {!agencySelf && (
            <div className="min-w-[220px] flex-1">
              <ContactPicker
                label="Persona responsable"
                field="manager_contact_id"
                value={managerId}
                onChange={setManagerId}
                options={managerOpts}
                disabled={pending}
              />
            </div>
          )}
        </div>
      </AppCard>

      <AppCard title="Periodo">
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-3 gap-2">
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
            <div className="flex min-w-0 flex-col gap-1 text-xs">
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
        </div>
      </AppCard>

      <AppCard title={`Pantallas *${rows.length > 0 ? ` (${formatNumber(rows.length)})` : ""}`}>
        <div className="flex flex-col gap-4">
          {screens.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Sin pantallas activas. Registra pantallas en Inventario antes de crear la orden.
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
              onShowCalendar={openCalendar}
              availableOnly={availableOnly}
              onToggleAvailableOnly={() => setAvailableOnly((v) => !v)}
              periodReady={dias !== null}
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
            <p className="text-[11px] text-muted-foreground" role="status">Verificando disponibilidad…</p>
          )}
          {rows.length > 0 && (
            <section className="flex flex-col gap-2" aria-label="Detalle por pantalla">
              <SectionHeading title="Detalle por pantalla" hint={`Precio por día × ${dias !== null ? `${formatNumber(dias)} días` : "días del periodo"}.`} />
              {blockedRows.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-destructive/5 px-2.5 py-2">
                  <p className="text-xs text-destructive">
                    {blockedRows.length} ocupada{plural(blockedRows.length)} en ese periodo.
                  </p>
                  {dias !== null && (commonWindow ? (
                    <Button type="button" size="xs" variant="outline" onClick={() => applyWindow(commonWindow)}>
                      <ArrowRight aria-hidden />
                      Mover al próximo hueco: {formatDate(commonWindow)} → {formatDate(addDays(commonWindow, dias - 1))}
                    </Button>
                  ) : checking ? (
                    <span className="text-[11px] text-muted-foreground">Buscando hueco común…</span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">Sin hueco común libre en 12 meses.</span>
                  ))}
                </div>
              )}
              <DataTable>
            <DataTableHeader>
              <DataTableTh>Pantalla</DataTableTh>
              <DataTableTh numeric>Precio/día * ({currency})</DataTableTh>
              <DataTableTh numeric>Días</DataTableTh>
              <DataTableTh numeric>Subtotal ({currency})</DataTableTh>
              <DataTableTh aria-label="Acciones" />
            </DataTableHeader>
            <DataTableBody>
              {rows.map((s) => {
                const hits = occupiedOf(s.id);
                return (
                  <DataTableRow
                    key={s.id}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("input,button")) return;
                      setDetailScreenId(s.id);
                    }}
                    className={cn(hits.length > 0 && "bg-destructive/5", "cursor-pointer")}
                  >
                    <DataTableTd className="font-medium" title={s.detail ?? undefined}>
                      {s.name}
                      {hits.length > 0 && (
                        <span className="block text-[11px] font-normal text-destructive">
                          Ocupada · {[hits[0].io_number, hits[0].brand].filter(Boolean).join(" · ") || "otro periodo"} — quítala o cambia fechas
                        </span>
                      )}
                    </DataTableTd>
                  <DataTableTd numeric>
                    <input type="hidden" name="screen_id" value={s.id} />
                    <input type="hidden" name="line_starts_at" value={starts} />
                    <input type="hidden" name="line_ends_at" value={ends} />
                    <input type="hidden" name="line_cant_dias" value={dias ?? ""} />
                    <input type="hidden" name="line_total" value={dias !== null && priceOf(s.id) !== null ? String((priceOf(s.id) as number) * (dias as number)) : ""} />
                    <input
                      value={prices[s.id] ?? ""}
                      onChange={(e) => setPrices((p) => ({ ...p, [s.id]: e.target.value }))}
                      disabled={pending || hits.length > 0}
                      inputMode="decimal"
                      placeholder={s.price_pen !== null && Number.isFinite(Number(s.price_pen)) ? String(s.price_pen) : "2000"}
                      aria-label={`Precio por día ${s.name}`}
                      className="h-9 w-28 rounded-lg border border-border bg-background px-2.5 text-right text-sm tabular-nums"
                    />
                  </DataTableTd>
                  <DataTableTd numeric className="tabular-nums">
                    {dias ?? "—"}
                  </DataTableTd>
                  <DataTableTd numeric className="tabular-nums">
                    {dias !== null && priceOf(s.id) !== null
                      ? formatMoney(Math.round((priceOf(s.id) as number) * (dias as number) * 100), currency)
                      : "—"}
                  </DataTableTd>
                  <DataTableTd className="w-20">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Ver disponibilidad de ${s.name}`}
                        title="Ver disponibilidad"
                        disabled={pending}
                        onClick={() => openCalendar(s.id)}
                      >
                        <CalendarDays aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Quitar ${s.name}`}
                        disabled={pending}
                        onClick={() => toggleScreen(s.id)}
                      >
                        <X aria-hidden />
                      </Button>
                    </div>
                  </DataTableTd>
                </DataTableRow>
              );
            })}
              <DataTableRow className="bg-muted/30 font-medium">
                <DataTableTd colSpan={3}>
                  Total · {formatNumber(rows.length)} pantalla{plural(rows.length)}
                  {dias !== null ? ` × ${formatNumber(dias)} días` : ""}
                </DataTableTd>
                <DataTableTd numeric className="tabular-nums whitespace-nowrap">
                  {total > 0 ? formatMoney(Math.round(total * 100), currency) : "—"}
                </DataTableTd>
                <DataTableTd />
              </DataTableRow>
            </DataTableBody>
          </DataTable>
            </section>
          )}
        </div>
      </AppCard>

      <div className="flex flex-col gap-1.5">
        <div>
          <Button type="submit" disabled={!canSubmit} title={!canSubmit ? `Falta: ${missing.join(", ")}` : undefined}>
            <Plus aria-hidden />
            {pending ? "Creando…" : `Crear orden${total > 0 ? ` · ${formatMoney(Math.round(total * 100), currency)}` : ""}`}
          </Button>
        </div>
        {!canSubmit && !pending && (
          <p className="text-[11px] text-muted-foreground">Falta: {missing.join(", ")}.</p>
        )}
      </div>

      <ScreenCalendarDialog
        screen={screens.find((s) => s.id === calScreenId) ?? null}
        ranges={calScreenId ? occupancy[calScreenId] : undefined}
        loaded={calScreenId ? calScreenId in occupancy : false}
        duration={dias ?? 0}
        periodStarts={starts}
        periodEnds={ends}
        onApply={(w) => {
          applyWindow(w);
          setCalScreenId(null);
        }}
        onClose={() => setCalScreenId(null)}
      />
      {detailScreenId && (
        <PantallaDrawer screenId={detailScreenId} onClose={() => setDetailScreenId(null)} />
      )}
    </form>
    </>
  );
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function ContactPicker({
  label,
  field,
  value,
  onChange,
  options,
  disabled,
  required,
}: {
  label: string;
  field: string;
  value: string;
  onChange: (v: string) => void;
  options: CompanyContact[];
  disabled?: boolean;
  required?: boolean;
}) {
  const optionLabel = (c: CompanyContact) => (c.email ? `${c.name} (${c.email})` : c.name);
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs">
      {label}{required ? " *" : ""}
      <input type="hidden" name={field} value={value} />
      <AppSelect
        value={value}
        onChange={onChange}
        options={options.map((c) => ({ value: c.id, label: optionLabel(c) }))}
        placeholder="Sin definir…"
        ariaLabel={label}
        disabled={disabled}
      />
    </div>
  );
}
