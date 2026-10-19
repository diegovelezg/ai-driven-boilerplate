"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { AppTooltip } from "@/components/ui/app-tooltip";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney, type CanonicalCustomer } from "@/lib/medusa";
import { formatNumber } from "@/lib/format";
import type {
  CustomerFilters,
  CustomersSortDir,
  CustomersSortKey,
  EditableCustomer,
} from "@/lib/customers-db";
import { ventanaLabel, type CustomerPredictionLite } from "@/lib/customer-predictions";
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
  /** Filtro global por mercado (?market= del header): se preserva al navegar. */
  marketId: string | null;
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
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const cancelRef = useRef(false);

  const commit = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const next = draft.trim().replace(/\s+/g, " ");
    if (next === value) {
      setEditing(false);
    } else {
      setSaving(true);
      const res = await onSave(next);
      setSaving(false);
      if (res.ok) setEditing(false);
      else setError(res.message);
    }
    busyRef.current = false;
  };

  const handleBlur = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      busyRef.current = false;
      setEditing(false);
      setError(null);
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
            setError(null);
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
      <AppTooltip tip={error ?? "Enter guarda · Escape cancela · vacío = valor de Medusa"}>
        <Input
          autoFocus
          value={draft}
          disabled={saving}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape") {
              cancelRef.current = true;
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-invalid={error ? true : undefined}
          className={`h-7 px-1.5 ${error ? "border-destructive" : ""}`}
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
  marketId,
  preds,
  ventana7,
  seguimiento,
  valorByType,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState(q);

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
      if (marketId) params.set("market", marketId);
      return params.toString();
    },
    [q, page, sortKey, sortDir, filters, marketId],
  );

  // El sort ordena en servidor (Supabase) sobre todos los datos, no solo la página.
  const toggleSort = (key: CustomersSortKey) => {
    const nextDir: CustomersSortDir =
      sortKey === key && sortDir === "asc" ? "desc" : "asc";
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

  // Sincroniza el input cuando el `q` commiteado cambia por navegación externa
  // (botones paginación, atrás/adelante). setState en callback: sin cascading render.
  useEffect(() => {
    const t = setTimeout(() => setQuery((prev) => (prev === q ? prev : q)), 0);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (query === q) return;
    const t = setTimeout(() => {
      startTransition(() => {
        router.replace(`/customers?${buildParams({ q: query, page: 1 })}`);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [query, q, router, buildParams]);

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

  const getSortIcon = (column: CustomersSortKey) => {
    if (sortKey !== column)
      return <ChevronsUpDown className="size-3.5 opacity-40" aria-hidden />;
    return sortDir === "asc" ? (
      <ArrowUp className="size-3.5" aria-hidden />
    ) : (
      <ArrowDown className="size-3.5" aria-hidden />
    );
  };

  const sortButtonClass = (column: CustomersSortKey, alignRight = false) =>
    `inline-flex items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-medium tracking-wide uppercase hover:text-foreground ${
      alignRight ? "flex-row-reverse" : ""
    } ${sortKey === column ? "text-foreground" : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl bg-muted/30 p-3 ring-1 ring-border/60">
        <div className="relative max-w-sm flex-1 basis-52">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) setQuery("");
            }}
            placeholder="Buscar por email, nombre, empresa o qué es…"
            className="bg-background pr-8"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Limpiar búsqueda"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <Select
          value={filters.decision ?? "all"}
          onValueChange={(v) => setFilter({ decision: v === "all" ? null : v })}
        >
          <SelectTrigger className="w-44 bg-background" aria-label="Filtrar por decisión del motor">
            <SelectValue placeholder="Decisión">
              {(value) =>
                value === "all"
                  ? "Toda decisión"
                  : value === "actuar"
                    ? "Para actuar"
                    : value === "vigilar"
                      ? "Vigilar"
                      : value === "no-tocar"
                        ? "No tocar (todos)"
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
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toda decisión</SelectItem>
            <SelectItem value="actuar">Para actuar</SelectItem>
            <SelectItem value="vigilar">Vigilar</SelectItem>
            <SelectItem value="no-tocar">No tocar (todos)</SelectItem>
            <SelectItem value="organico">· volverán solos</SelectItem>
            <SelectItem value="dormido">· dormidos</SelectItem>
            <SelectItem value="contactado_reciente">· contactados</SelectItem>
            <SelectItem value="sin_canal">· sin canal</SelectItem>
          </SelectContent>
        </Select>
        <AppTooltip tip="Vigilar que entra en ventana en 7 días">
          <span className="inline-flex">
            <Button
              variant={filters.vista === "ventana7" ? "default" : "outline"}
              size="sm"
              disabled={isPending}
              onClick={() => setFilter({ vista: filters.vista === "ventana7" ? null : "ventana7" })}
            >
              Entran en ventana (7d)
            </Button>
          </span>
        </AppTooltip>
        <AppTooltip tip="Vigilar cercano: recuperables o p alta (mismo corte que el héroe)">
          <span className="inline-flex">
            <Button
              variant={filters.vista === "seguimiento" ? "default" : "outline"}
              size="sm"
              disabled={isPending}
              onClick={() => setFilter({ vista: filters.vista === "seguimiento" ? null : "seguimiento" })}
            >
              Seguimiento cercano
            </Button>
          </span>
        </AppTooltip>
        <Select
          value={filters.ritmo ?? "all"}
          onValueChange={(v) => setFilter({ ritmo: v === "all" ? null : v })}
        >
          <SelectTrigger className="w-44 bg-background" aria-label="Filtrar por ritmo de recompra">
            <SelectValue placeholder="Ritmo">
              {(value) =>
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
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todo ritmo</SelectItem>
            <SelectItem value="con-ritmo">Con ritmo</SelectItem>
            <SelectItem value="primera">Primera recompra</SelectItem>
            <SelectItem value="sin-compras">Sin compras</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.ventana ?? "all"}
          onValueChange={(v) => setFilter({ ventana: v === "all" ? null : v })}
        >
          <SelectTrigger className="w-36 bg-background" aria-label="Filtrar por ventana de recompra">
            <SelectValue placeholder="Ventana">
              {(value) =>
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
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toda ventana</SelectItem>
            <SelectItem value="antes">Antes</SelectItem>
            <SelectItem value="en">En ventana</SelectItem>
            <SelectItem value="pasada">Pasada</SelectItem>
            <SelectItem value="dormido">Dormido</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.banda ?? "all"}
          onValueChange={(v) => setFilter({ banda: v === "all" ? null : v })}
        >
          <SelectTrigger className="w-44 bg-background" aria-label="Filtrar por banda de propensión">
            <SelectValue placeholder="Banda">
              {(value) =>
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
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toda banda</SelectItem>
            <SelectItem value="organico-probable">Volverán solos</SelectItem>
            <SelectItem value="recuperable">Recuperables</SelectItem>
            <SelectItem value="lejos">Lejos</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.elegibilidad ?? "all"}
          onValueChange={(v) => setFilter({ elegibilidad: v === "all" ? null : v })}
        >
          <SelectTrigger className="w-40 bg-background" aria-label="Filtrar por elegibilidad de contacto">
            <SelectValue placeholder="Elegibilidad">
              {(value) =>
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
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toda elegibilidad</SelectItem>
            <SelectItem value="ok">Contactables</SelectItem>
            <SelectItem value="sin-canal">Sin canal</SelectItem>
            <SelectItem value="contacto-reciente">Contacto reciente</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.decil ?? "all"}
          onValueChange={(v) => setFilter({ decil: v === "all" ? null : v })}
        >
          <SelectTrigger className="w-36 bg-background" aria-label="Filtrar por decil de valor">
            <SelectValue placeholder="Valor">
              {(value) =>
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
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todo valor</SelectItem>
            <SelectItem value="alto">Alto (8-10)</SelectItem>
            <SelectItem value="medio">Medio (4-7)</SelectItem>
            <SelectItem value="bajo">Bajo (1-3)</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.customerType ?? "all"}
          onValueChange={(v) => setFilter({ customerType: v === "all" ? null : v })}
        >
          <SelectTrigger className="w-36 bg-background" aria-label="Filtrar por tipo de cliente">
            <SelectValue placeholder="Tipo">
              {(value) =>
                value === "all"
                  ? "B2B + B2C"
                  : value === "B2B"
                    ? "B2B · Empresas"
                    : value === "B2C"
                      ? "B2C · Consumidores"
                      : String(value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">B2B + B2C</SelectItem>
            <SelectItem value="B2B">B2B · Empresas</SelectItem>
            <SelectItem value="B2C">B2C · Consumidores</SelectItem>
          </SelectContent>
        </Select>
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
          Seguimiento cercano: ~{formatNumber(seguimiento.n)} clientes · ~{formatMoney(seguimiento.sumaMinor, shopCurrency)} en juego.
        </p>
      )}

      {valorByType && (
        <p className="text-[13px] text-muted-foreground tabular-nums">
          ¿Qué tipo vale más? B2B: {formatNumber(valorByType.b2b.n)} · {formatMoney(valorByType.b2b.minor, shopCurrency)} — B2C: {formatNumber(valorByType.b2c.n)} · {formatMoney(valorByType.b2c.minor, shopCurrency)} (facturación bruta acumulada{valorByType.truncated ? ", parcial: universo mayor al CAP" : ""}{valorByType.otherCurrency > 0 ? `; ${formatNumber(valorByType.otherCurrency)} en otra moneda fuera de la suma` : ""}).
        </p>
      )}

      <AppCard variant="table">
        <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-3 h-12" aria-sort={sortKey === "email" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("email")} className={sortButtonClass("email")} aria-label="Ordenar por email">
                    Email {getSortIcon("email")}
                  </button>
                </TableHead>
                <TableHead className="px-3 h-12" aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("name")} className={sortButtonClass("name")} aria-label="Ordenar por nombre">
                    Nombre {getSortIcon("name")}
                  </button>
                </TableHead>
                <TableHead className="hidden h-12 px-3 2xl:table-cell" aria-sort={sortKey === "phone" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("phone")} className={sortButtonClass("phone")} aria-label="Ordenar por teléfono">
                    Teléfono {getSortIcon("phone")}
                  </button>
                </TableHead>
                <TableHead className="hidden h-12 px-3 2xl:table-cell" aria-sort={sortKey === "company" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("company")} className={sortButtonClass("company")} aria-label="Ordenar por empresa">
                    Empresa {getSortIcon("company")}
                  </button>
                </TableHead>
                <TableHead className="px-3 h-12 text-right" aria-sort={sortKey === "orders" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("orders")} className={sortButtonClass("orders", true)} aria-label="Ordenar por compras">
                    Compras {getSortIcon("orders")}
                  </button>
                </TableHead>
                <TableHead className="px-3 h-12 text-right" aria-sort={sortKey === "total" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("total")} className={sortButtonClass("total", true)} aria-label="Ordenar por total">
                    Total {getSortIcon("total")}
                  </button>
                </TableHead>
                <TableHead className="px-3 h-12 text-[11px] tracking-wide uppercase">Decisión</TableHead>
                <TableHead className="px-3 h-12 text-[11px] tracking-wide uppercase">Ventana</TableHead>
                <TableHead className="px-3 h-12 text-right" aria-sort={sortKey === "valor" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("valor")} className={sortButtonClass("valor", true)} aria-label="Ordenar por valor esperado">
                    Valor esp. {getSortIcon("valor")}
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className="cursor-pointer"
                >
                  <TableCell className="max-w-[220px] truncate px-3 py-4 font-medium">{c.email}</TableCell>
                  <TableCell className="px-3 py-4 text-muted-foreground">
                    <div className="max-w-[170px] truncate">
                      <EditableCell value={displayName(c)} onSave={saveName(c)} />
                    </div>
                  </TableCell>
                  <TableCell className="hidden px-3 py-4 text-muted-foreground 2xl:table-cell">
                    <EditableCell
                      value={c.phone ?? ""}
                      onSave={(v) =>
                        updateCustomerAction({ id: c.dbId, values: { phone: v } })
                      }
                    />
                  </TableCell>
                  <TableCell className="hidden px-3 py-4 text-muted-foreground 2xl:table-cell">
                    <div className="max-w-[190px] truncate">
                      <EditableCell
                        value={c.companyName ?? ""}
                        onSave={(v) =>
                          updateCustomerAction({ id: c.dbId, values: { company_name: v } })
                        }
                      />
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-4 text-right tabular-nums">
                    {formatNumber(c.ordersCount)}
                  </TableCell>
                  <TableCell className="px-3 py-4 text-right tabular-nums">
                    {formatMoney(c.totalSpent, c.currency)}
                  </TableCell>
                  <TableCell className="px-3 py-4 text-[13px]">
                    {decisionChip(preds[c.dbId]?.decision)}
                  </TableCell>
                  <TableCell className="px-3 py-4 text-[13px] text-muted-foreground tabular-nums">
                    {ventanaLabel(preds[c.dbId])}
                  </TableCell>
                  <TableCell className="px-3 py-4 text-right tabular-nums">
                    {preds[c.dbId]?.valorEsperadoMinor != null
                      ? formatMoney(preds[c.dbId].valorEsperadoMinor as number, c.currency)
                      : <span className="text-muted-foreground/60">—</span>}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                    {q ? `Sin resultados para “${q}”.` : "Sin customers en Medusa."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
