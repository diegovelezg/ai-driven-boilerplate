"use client";

import { useCallback, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { Input } from "@/components/ui/input";
import { FilterToggleButton } from "@/components/filter-button";
import { FilterSearch } from "@/components/filter-search";
import { FilterSelect, SelectItem } from "@/components/filter-select";
import { toast } from "@/components/ui/toast";
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableRow,
  DataTableTd,
  DataTableTh,
  SortHeaderButton,
} from "@/components/data-table";
import type { CanonicalCustomer } from "@/lib/canonical";
import { formatMoney, formatNumber } from "@/lib/format";
import type {
  CustomerFilters,
  CustomersSortDir,
  CustomersSortKey,
  EditableCustomer,
} from "@/lib/customers-db";
import { ventanaLabel, type CustomerPredictionLite } from "@/lib/customer-predictions";
import { DECISION_COPY } from "@/lib/decision-copy";
import {
  updateCustomerAction,
  type UpdateCustomerState,
} from "@/lib/customer-actions";
import { CustomerDrawer } from "./customer-drawer";

interface Props {
  rows: EditableCustomer[];
  totalCount: number;
  q: string;
  page: number;
  pageSize: number;
  sortKey: CustomersSortKey;
  sortDir: CustomersSortDir;
  filters: CustomerFilters;
  shopCurrency: string | null;
  /** Foto del día del motor por dbId (solo filas visibles). */
  preds: Record<string, CustomerPredictionLite>;
  /** Resumen "entran en ventana en 7 días" (solo con ?vista=ventana7). */
  ventana7: { n: number; sumaMinor: number } | null;
  /** Resumen "seguimiento cercano" (solo con ?vista=seguimiento, issue #21). */
  seguimiento: { n: number; sumaMinor: number } | null;
  /** Facturación bruta por tipo efectivo (issue #14A). */
  valorByType: {
    b2b: { n: number; minor: number };
    b2c: { n: number; minor: number };
    otherCurrency: number;
    truncated: boolean;
  } | null;
}

/** Celda con edición inline: click -> input; Enter/blur guarda, Escape cancela. */
function EditableCell({
  value,
  onSave,
}: {
  value: string;
  onSave: (draft: string) => Promise<UpdateCustomerState>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const cancelRef = useRef(false);

  const commit = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const next = draft.trim().replace(/\s+/g, " ");
    if (next === value) {
      setEditing(false);
      busyRef.current = false;
      return;
    }
    setSaving(true);
    try {
      const res = await onSave(next);
      if (res.ok) {
        setEditing(false);
        toast.add({ title: "Guardado", description: res.message, type: "success" });
      } else
        toast.add({
          title: "No se pudo guardar",
          description: res.message,
          type: "error",
        });
    } catch (e) {
      toast.add({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : "Error inesperado.",
        type: "error",
      });
    } finally {
      setSaving(false);
      busyRef.current = false;
    }
  };

  const handleBlur = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      busyRef.current = false;
      setEditing(false);
      return;
    }
    void commit();
  };

  if (!editing) {
    return (
      <AppTooltip tip="Click para editar">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setDraft(value);
            setEditing(true);
          }}
          className="block w-full cursor-text rounded px-1 py-0.5 text-left hover:bg-accent"
        >
          {value || <span className="text-muted-foreground/60">—</span>}
        </button>
      </AppTooltip>
    );
  }
  return (
    <span onClick={(e) => e.stopPropagation()} className="block">
      <AppTooltip tip="Enter guarda · Escape cancela · vacío = valor base">
        <Input
          autoFocus
          value={draft}
          disabled={saving}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape") {
              cancelRef.current = true;
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="h-7 px-1.5"
        />
      </AppTooltip>
    </span>
  );
}

/** Chip de decisión del motor (texto llano, sin scores ni segmentos internos). */
function decisionChip(decision: string | undefined): ReactNode {
  const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium";
  switch (decision) {
    case "actuar":
      return <span className={`${pill} bg-primary/10 text-primary`}>Para actuar</span>;
    case "revision_humana":
      return (
        <span className={`${pill} bg-violet-500/10 text-violet-600 dark:text-violet-400`}>
          Revisar 1 a 1
        </span>
      );
    case "vigilar":
      return (
        <span className={`${pill} bg-amber-500/10 text-amber-600 dark:text-amber-400`}>
          Vigilar
        </span>
      );
    case "organico":
      return (
        <span className={`${pill} bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`}>
          Volverá solo
        </span>
      );
    case "dormido":
      return <span className={`${pill} bg-muted text-muted-foreground`}>Dormido</span>;
    case "sin_canal":
      return (
        <span className={`${pill} bg-rose-500/10 text-rose-600 dark:text-rose-400`}>
          Sin canal
        </span>
      );
    case "contactado_reciente":
      return (
        <span className={`${pill} bg-sky-500/10 text-sky-600 dark:text-sky-400`}>
          Contactado
        </span>
      );
    default:
      return <span className="text-muted-foreground/60">—</span>;
  }
}

export function CustomersView({
  rows,
  totalCount,
  q,
  page,
  pageSize,
  sortKey,
  sortDir,
  filters,
  shopCurrency,
  preds,
  ventana7,
  seguimiento,
  valorByType,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const buildParams = useCallback(
    (overrides: {
      q?: string;
      page?: number;
      sort?: string;
      dir?: string;
      decision?: string | null;
      vista?: string | null;
      ritmo?: string | null;
      customerType?: string | null;
      ventana?: string | null;
      banda?: string | null;
      elegibilidad?: string | null;
      decil?: string | null;
    }) => {
      const params = new URLSearchParams();
      const nextQ = overrides.q ?? q;
      if (nextQ.trim()) params.set("q", nextQ.trim());
      params.set("page", String(overrides.page ?? page));
      params.set("sort", overrides.sort ?? sortKey);
      params.set("dir", overrides.dir ?? sortDir);
      const dec = overrides.decision !== undefined ? overrides.decision : filters.decision;
      if (dec) params.set("decision", dec);
      const vis = overrides.vista !== undefined ? overrides.vista : filters.vista;
      if (vis) params.set("vista", vis);
      const rit = overrides.ritmo !== undefined ? overrides.ritmo : filters.ritmo;
      if (rit) params.set("ritmo", rit);
      const tip = overrides.customerType !== undefined ? overrides.customerType : filters.customerType;
      if (tip) params.set("tipo", tip);
      const ven = overrides.ventana !== undefined ? overrides.ventana : filters.ventana;
      if (ven) params.set("ventana", ven);
      const ban = overrides.banda !== undefined ? overrides.banda : filters.banda;
      if (ban) params.set("banda", ban);
      const ele = overrides.elegibilidad !== undefined ? overrides.elegibilidad : filters.elegibilidad;
      if (ele) params.set("elegibilidad", ele);
      const dcl = overrides.decil !== undefined ? overrides.decil : filters.decil;
      if (dcl) params.set("decil", dcl);
      return params.toString();
    },
    [q, page, sortKey, sortDir, filters],
  );

  // El sort ordena en servidor (Supabase) sobre todos los datos, no solo la página.
  // Como Catálogo: texto ASC primero; números DESC primero (lo más valioso).
  const toggleSort = (key: CustomersSortKey) => {
    let nextDir: CustomersSortDir;
    if (key === sortKey) {
      nextDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      nextDir = key === "email" || key === "name" || key === "phone" || key === "company" ? "asc" : "desc";
    }
    startTransition(() => {
      router.replace(`/customers?${buildParams({ page: 1, sort: key, dir: nextDir })}`);
    });
  };

  const setFilter = (patch: { decision?: string | null; vista?: string | null; ritmo?: string | null; customerType?: string | null; ventana?: string | null; banda?: string | null; elegibilidad?: string | null; decil?: string | null }) => {
    startTransition(() => {
      router.replace(`/customers?${buildParams({ page: 1, ...patch })}`);
    });
  };

  const filtersActive = filters.decision !== null || filters.vista !== null || filters.ritmo !== null || filters.customerType !== null || filters.ventana !== null || filters.banda !== null || filters.elegibilidad !== null || filters.decil !== null;

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const goTo = (next: number) => {
    startTransition(() => {
      router.replace(`/customers?${buildParams({ page: next })}`);
    });
  };

  const displayName = (c: CanonicalCustomer) =>
    [c.firstName, c.lastName].filter(Boolean).join(" ");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  // Inline "Nombre": un solo input "Nombre Apellido" (parte por primer espacio).
  const saveName = (c: EditableCustomer) => (full: string) => {
    const parts = full.split(/\s+/).filter(Boolean);
    return updateCustomerAction({
      id: c.dbId,
      values: {
        first_name: parts[0] ?? "",
        last_name: parts.slice(1).join(" "),
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <FilterSearch
          initialValue={q}
          placeholder="Buscar por email, nombre, empresa o qué es…"
          ariaLabel="Buscar clientes"
          onSearch={(value) => {
            startTransition(() => {
              router.replace(`/customers?${buildParams({ q: value, page: 1 })}`);
            });
          }}
        />
        <FilterSelect
          value={filters.decision ?? "all"}
          onChange={(v) => setFilter({ decision: v === "all" ? null : v })}
          ariaLabel="Filtrar por decisión del motor"
          placeholder="Decisión"
          display={(value) =>
            value === "all"
              ? "Toda decisión"
              : value === "actuar"
                ? "Para actuar"
                : value === "vigilar"
                  ? "Vigilar"
                  : value === "no-tocar"
                    ? "Sin nada que hacer"
                    : value === "organico"
                      ? "· Volverán solos"
                      : value === "dormido"
                        ? "· Dormidos"
                        : value === "contactado_reciente"
                          ? "· Contactados"
                          : value === "sin_canal"
                            ? "· Sin canal"
                            : String(value)
          }
        >
          <SelectItem value="all">Toda decisión</SelectItem>
          <SelectItem value="actuar">Para actuar</SelectItem>
          <SelectItem value="vigilar">Vigilar</SelectItem>
          <SelectItem value="no-tocar">Sin nada que hacer</SelectItem>
          <SelectItem value="organico">· volverán solos</SelectItem>
          <SelectItem value="dormido">· dormidos</SelectItem>
          <SelectItem value="contactado_reciente">· contactados</SelectItem>
          <SelectItem value="sin_canal">· sin canal</SelectItem>
        </FilterSelect>
        <FilterToggleButton
          active={filters.vista === "ventana7"}
          disabled={isPending}
          tip="Vigilar que entra en ventana en 7 días"
          onClick={() => setFilter({ vista: filters.vista === "ventana7" ? null : "ventana7" })}
        >
          Entran en ventana (7d)
        </FilterToggleButton>
        <FilterToggleButton
          active={filters.vista === "seguimiento"}
          disabled={isPending}
          tip="Pueden necesitar mensaje pronto (mismo corte que el héroe)"
          onClick={() => setFilter({ vista: filters.vista === "seguimiento" ? null : "seguimiento" })}
        >
          Pueden necesitar pronto
        </FilterToggleButton>
        <FilterSelect
          value={filters.ritmo ?? "all"}
          onChange={(v) => setFilter({ ritmo: v === "all" ? null : v })}
          ariaLabel="Filtrar por ritmo de recompra"
          placeholder="Ritmo"
          display={(value) =>
            value === "all"
              ? "Todo ritmo"
              : value === "con-ritmo"
                ? "Con ritmo"
                : value === "primera"
                  ? "Primera recompra"
                  : value === "sin-compras"
                    ? "Sin compras"
                    : String(value)
          }
        >
          <SelectItem value="all">Todo ritmo</SelectItem>
          <SelectItem value="con-ritmo">Con ritmo</SelectItem>
          <SelectItem value="primera">Primera recompra</SelectItem>
          <SelectItem value="sin-compras">Sin compras</SelectItem>
        </FilterSelect>
        <FilterSelect
          value={filters.ventana ?? "all"}
          onChange={(v) => setFilter({ ventana: v === "all" ? null : v })}
          ariaLabel="Filtrar por ventana de recompra"
          widthClass="w-36"
          placeholder="Ventana"
          display={(value) =>
            value === "all"
              ? "Toda ventana"
              : value === "antes"
                ? "Antes"
                : value === "en"
                  ? "En ventana"
                  : value === "pasada"
                    ? "Pasada"
                    : value === "dormido"
                      ? "Dormido"
                      : String(value)
          }
        >
          <SelectItem value="all">Toda ventana</SelectItem>
          <SelectItem value="antes">Antes</SelectItem>
          <SelectItem value="en">En ventana</SelectItem>
          <SelectItem value="pasada">Pasada</SelectItem>
          <SelectItem value="dormido">Dormido</SelectItem>
        </FilterSelect>
        <FilterSelect
          value={filters.banda ?? "all"}
          onChange={(v) => setFilter({ banda: v === "all" ? null : v })}
          ariaLabel="Filtrar por banda de propensión"
          placeholder="Banda"
          display={(value) =>
            value === "all"
              ? "Toda banda"
              : value === "organico-probable"
                ? "Volverán solos"
                : value === "recuperable"
                  ? "Recuperables"
                  : value === "lejos"
                    ? "Lejos"
                    : String(value)
          }
        >
          <SelectItem value="all">Toda banda</SelectItem>
          <SelectItem value="organico-probable">Volverán solos</SelectItem>
          <SelectItem value="recuperable">Recuperables</SelectItem>
          <SelectItem value="lejos">Lejos</SelectItem>
        </FilterSelect>
        <FilterSelect
          value={filters.elegibilidad ?? "all"}
          onChange={(v) => setFilter({ elegibilidad: v === "all" ? null : v })}
          ariaLabel="Filtrar por elegibilidad de contacto"
          widthClass="w-40"
          placeholder="Elegibilidad"
          display={(value) =>
            value === "all"
              ? "Toda elegibilidad"
              : value === "ok"
                ? "Contactables"
                : value === "sin-canal"
                  ? "Sin canal"
                  : value === "contacto-reciente"
                    ? "Contacto reciente"
                    : String(value)
          }
        >
          <SelectItem value="all">Toda elegibilidad</SelectItem>
          <SelectItem value="ok">Contactables</SelectItem>
          <SelectItem value="sin-canal">Sin canal</SelectItem>
          <SelectItem value="contacto-reciente">Contacto reciente</SelectItem>
        </FilterSelect>
        <FilterSelect
          value={filters.decil ?? "all"}
          onChange={(v) => setFilter({ decil: v === "all" ? null : v })}
          ariaLabel="Filtrar por decil de valor"
          widthClass="w-36"
          placeholder="Valor"
          display={(value) =>
            value === "all"
              ? "Todo valor"
              : value === "alto"
                ? "Valor alto (8-10)"
                : value === "medio"
                  ? "Valor medio (4-7)"
                  : value === "bajo"
                    ? "Valor bajo (1-3)"
                    : String(value)
          }
        >
          <SelectItem value="all">Todo valor</SelectItem>
          <SelectItem value="alto">Alto (8-10)</SelectItem>
          <SelectItem value="medio">Medio (4-7)</SelectItem>
          <SelectItem value="bajo">Bajo (1-3)</SelectItem>
        </FilterSelect>
        <FilterSelect
          value={filters.customerType ?? "all"}
          onChange={(v) => setFilter({ customerType: v === "all" ? null : v })}
          ariaLabel="Filtrar por tipo de empresa"
          widthClass="w-36"
          placeholder="Tipo"
          display={(value) =>
            value === "all"
              ? "B2B · Empresas"
              : value === "B2B"
                ? "B2B · Empresas"
                : String(value)
          }
        >
          <SelectItem value="all">B2B · Empresas</SelectItem>
          <SelectItem value="B2B">B2B · Empresas</SelectItem>
        </FilterSelect>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => setFilter({ decision: null, vista: null, ritmo: null, customerType: null, ventana: null, banda: null, elegibilidad: null, decil: null })}
          >
            Limpiar
          </Button>
        )}
        <span className="ms-auto text-xs text-muted-foreground tabular-nums">
          {isPending
            ? "Buscando…"
            : `${formatNumber(totalCount)} resultado${totalCount === 1 ? "" : "s"}`}
        </span>
      </div>

      {filters.vista === "ventana7" && ventana7 && (
        <p className="text-[13px] text-muted-foreground tabular-nums">
          Próximos 7 días: ~{formatNumber(ventana7.n)} clientes · ~{formatMoney(ventana7.sumaMinor, shopCurrency)} en juego.
        </p>
      )}

      {filters.vista === "seguimiento" && seguimiento && (
        <p className="text-[13px] text-muted-foreground tabular-nums">
          <AppTooltip tip={DECISION_COPY.puedenNecesitar.tip} contentClassName="max-w-sm">
            <span>Pueden necesitar pronto</span>
          </AppTooltip>
          : ~{formatNumber(seguimiento.n)} clientes · ~{formatMoney(seguimiento.sumaMinor, shopCurrency)} en juego.
        </p>
      )}

      {valorByType && (
        <p className="text-[13px] text-muted-foreground tabular-nums">
          Facturación bruta B2B: {formatNumber(valorByType.b2b.n)} empresas · {formatMoney(valorByType.b2b.minor, shopCurrency)} (acumulada{valorByType.truncated ? ", parcial: universo mayor al CAP" : ""}{valorByType.otherCurrency > 0 ? `; ${formatNumber(valorByType.otherCurrency)} en otra moneda fuera de la suma` : ""}).
        </p>
      )}

      <AppCard variant="table">
        <DataTable>
          <DataTableHeader>
            <DataTableTh aria-sort={sortKey === "email" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "email"} dir={sortDir} onClick={() => toggleSort("email")} ariaLabel="Ordenar por email">
                Email
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "name"} dir={sortDir} onClick={() => toggleSort("name")} ariaLabel="Ordenar por nombre">
                Nombre
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh className="hidden 2xl:table-cell" aria-sort={sortKey === "phone" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "phone"} dir={sortDir} onClick={() => toggleSort("phone")} ariaLabel="Ordenar por teléfono">
                Teléfono
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh className="hidden 2xl:table-cell" aria-sort={sortKey === "company" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "company"} dir={sortDir} onClick={() => toggleSort("company")} ariaLabel="Ordenar por empresa">
                Empresa
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "orders" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "orders"} dir={sortDir} alignRight onClick={() => toggleSort("orders")} ariaLabel="Ordenar por compras">
                Compras
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "total" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "total"} dir={sortDir} alignRight onClick={() => toggleSort("total")} ariaLabel="Ordenar por total">
                Total
              </SortHeaderButton>
            </DataTableTh>
            <DataTableTh>Decisión</DataTableTh>
            <DataTableTh>Ventana</DataTableTh>
            <DataTableTh numeric aria-sort={sortKey === "valor" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <SortHeaderButton active={sortKey === "valor"} dir={sortDir} alignRight onClick={() => toggleSort("valor")} ariaLabel="Ordenar por valor esperado">
                Valor esp.
              </SortHeaderButton>
            </DataTableTh>
          </DataTableHeader>
          <DataTableBody>
            {rows.map((c) => (
              <DataTableRow
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className="cursor-pointer"
              >
                <DataTableTd className="max-w-[220px] truncate px-3 py-4 font-medium">{c.email}</DataTableTd>
                <DataTableTd className="px-3 py-4 text-muted-foreground">
                  <div className="max-w-[170px] truncate">
                    <EditableCell value={displayName(c)} onSave={saveName(c)} />
                  </div>
                </DataTableTd>
                <DataTableTd className="hidden px-3 py-4 text-muted-foreground 2xl:table-cell">
                  <EditableCell
                    value={c.phone ?? ""}
                    onSave={(v) =>
                      updateCustomerAction({ id: c.dbId, values: { phone: v } })
                    }
                  />
                </DataTableTd>
                <DataTableTd className="hidden px-3 py-4 text-muted-foreground 2xl:table-cell">
                  <div className="max-w-[190px] truncate">
                    <EditableCell
                      value={c.companyName ?? ""}
                      onSave={(v) =>
                        updateCustomerAction({ id: c.dbId, values: { company_name: v } })
                      }
                    />
                  </div>
                </DataTableTd>
                <DataTableTd numeric className="px-3 py-4 tabular-nums">
                  {formatNumber(c.ordersCount)}
                </DataTableTd>
                <DataTableTd numeric className="px-3 py-4 tabular-nums">
                  {formatMoney(c.totalSpent, c.currency)}
                </DataTableTd>
                <DataTableTd className="px-3 py-4 text-[13px]">
                  {decisionChip(preds[c.dbId]?.decision)}
                </DataTableTd>
                <DataTableTd className="px-3 py-4 text-[13px] text-muted-foreground tabular-nums">
                  {ventanaLabel(preds[c.dbId])}
                </DataTableTd>
                <DataTableTd numeric className="px-3 py-4 tabular-nums">
                  {preds[c.dbId]?.valorEsperadoMinor != null
                    ? formatMoney(preds[c.dbId].valorEsperadoMinor as number, c.currency)
                    : <span className="text-muted-foreground/60">—</span>}
                </DataTableTd>
              </DataTableRow>
            ))}
            {rows.length === 0 && (
              <DataTableRow>
                <DataTableTd colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                  {q ? `Sin resultados para “${q}”.` : "Sin customers."}
                </DataTableTd>
              </DataTableRow>
            )}
          </DataTableBody>
        </DataTable>
      </AppCard>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          Página {formatNumber(page)} de {formatNumber(totalPages)}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || isPending}
            onClick={() => goTo(page - 1)}
          >
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || isPending}
            onClick={() => goTo(page + 1)}
          >
            Siguiente
          </Button>
        </div>
      </div>

      {selected && (
        <CustomerDrawer
          key={selected.id}
          customer={selected}
          initialTab="compras"
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
