"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
      <button
        type="button"
        title="Click para editar"
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
    );
  }
  return (
    <span onClick={(e) => e.stopPropagation()} className="block">
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
        title={error ?? "Enter guarda · Escape cancela · vacío = valor de Medusa"}
        className={`h-7 px-1.5 ${error ? "border-destructive" : ""}`}
      />
    </span>
  );
}

/** Chip de decisión del motor (texto llano, sin scores ni segmentos internos). */
function decisionChip(decision: string | undefined): ReactNode {
  switch (decision) {
    case "actuar":
      return <span className="font-medium">Para actuar</span>;
    case "revision_humana":
      return <span className="font-medium">Revisar 1 a 1</span>;
    case "vigilar":
      return <span className="text-muted-foreground">Vigilar</span>;
    case "organico":
      return <span className="text-muted-foreground">Volverá solo</span>;
    case "dormido":
      return <span className="text-muted-foreground">Dormido</span>;
    case "sin_canal":
      return <span className="text-muted-foreground">Sin canal</span>;
    case "contactado_reciente":
      return <span className="text-muted-foreground">Contactado</span>;
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

  const setFilter = (patch: { decision?: string | null; vista?: string | null; ritmo?: string | null }) => {
    startTransition(() => {
      router.replace(`/customers?${buildParams({ page: 1, ...patch })}`);
    });
  };

  const filtersActive = filters.decision !== null || filters.vista !== null || filters.ritmo !== null;

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
    `inline-flex items-center gap-1 rounded px-1 py-1 text-left font-medium hover:text-foreground ${
      alignRight ? "flex-row-reverse" : ""
    } ${sortKey === column ? "text-foreground" : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm flex-1 basis-52">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) setQuery("");
            }}
            placeholder="Buscar por email, nombre, empresa o qué es…"
            className="pr-8"
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
          <SelectTrigger className="w-44" aria-label="Filtrar por decisión del motor">
            <SelectValue placeholder="Decisión" />
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
        <Button
          variant={filters.vista === "ventana7" ? "default" : "outline"}
          size="sm"
          disabled={isPending}
          onClick={() => setFilter({ vista: filters.vista === "ventana7" ? null : "ventana7" })}
          title="Vigilar que entra en ventana en 7 días"
        >
          Entran en ventana (7d)
        </Button>
        <Select
          value={filters.ritmo ?? "all"}
          onValueChange={(v) => setFilter({ ritmo: v === "all" ? null : v })}
        >
          <SelectTrigger className="w-44" aria-label="Filtrar por ritmo de recompra">
            <SelectValue placeholder="Ritmo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todo ritmo</SelectItem>
            <SelectItem value="con-ritmo">Con ritmo</SelectItem>
            <SelectItem value="primera">Primera recompra</SelectItem>
            <SelectItem value="sin-compras">Sin compras</SelectItem>
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => setFilter({ decision: null, vista: null, ritmo: null })}
          >
            Limpiar
          </Button>
        )}
        <span className="ms-auto text-xs text-muted-foreground tabular-nums">
          {isPending
            ? "Buscando…"
            : `${totalCount} resultado${totalCount === 1 ? "" : "s"}`}
        </span>
      </div>

      {filters.vista === "ventana7" && ventana7 && (
        <p className="text-[13px] text-muted-foreground tabular-nums">
          Próximos 7 días: ~{ventana7.n} clientes · ~{formatMoney(ventana7.sumaMinor, shopCurrency)} en juego.
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4 h-12" aria-sort={sortKey === "email" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("email")} className={sortButtonClass("email")} aria-label="Ordenar por email">
                    Email {getSortIcon("email")}
                  </button>
                </TableHead>
                <TableHead className="px-4 h-12" aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("name")} className={sortButtonClass("name")} aria-label="Ordenar por nombre">
                    Nombre {getSortIcon("name")}
                  </button>
                </TableHead>
                <TableHead className="px-4 h-12" aria-sort={sortKey === "phone" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("phone")} className={sortButtonClass("phone")} aria-label="Ordenar por teléfono">
                    Teléfono {getSortIcon("phone")}
                  </button>
                </TableHead>
                <TableHead className="px-4 h-12" aria-sort={sortKey === "company" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("company")} className={sortButtonClass("company")} aria-label="Ordenar por empresa">
                    Empresa {getSortIcon("company")}
                  </button>
                </TableHead>
                <TableHead className="px-4 h-12 text-right" aria-sort={sortKey === "orders" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("orders")} className={sortButtonClass("orders", true)} aria-label="Ordenar por compras">
                    Compras {getSortIcon("orders")}
                  </button>
                </TableHead>
                <TableHead className="px-4 h-12 text-right" aria-sort={sortKey === "total" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("total")} className={sortButtonClass("total", true)} aria-label="Ordenar por total">
                    Total {getSortIcon("total")}
                  </button>
                </TableHead>
                <TableHead className="px-4 h-12">Decisión</TableHead>
                <TableHead className="px-4 h-12">Ventana</TableHead>
                <TableHead className="px-4 h-12 text-right" aria-sort={sortKey === "valor" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
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
                  <TableCell className="px-4 py-4 font-medium">{c.email}</TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">
                    <EditableCell value={displayName(c)} onSave={saveName(c)} />
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">
                    <EditableCell
                      value={c.phone ?? ""}
                      onSave={(v) =>
                        updateCustomerAction({ id: c.dbId, values: { phone: v } })
                      }
                    />
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">
                    <EditableCell
                      value={c.companyName ?? ""}
                      onSave={(v) =>
                        updateCustomerAction({ id: c.dbId, values: { company_name: v } })
                      }
                    />
                  </TableCell>
                  <TableCell className="px-4 py-4 text-right tabular-nums">
                    {c.ordersCount}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-right tabular-nums">
                    {formatMoney(c.totalSpent, c.currency)}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-[13px]">
                    {decisionChip(preds[c.dbId]?.decision)}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-[13px] text-muted-foreground tabular-nums">
                    {ventanaLabel(preds[c.dbId])}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-right tabular-nums">
                    {preds[c.dbId]?.valorEsperadoMinor != null
                      ? formatMoney(preds[c.dbId].valorEsperadoMinor as number, c.currency)
                      : <span className="text-muted-foreground/60">—</span>}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                    {q ? `Sin resultados para “${q}”.` : "Sin customers en Medusa."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          Página {page} de {totalPages}
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
