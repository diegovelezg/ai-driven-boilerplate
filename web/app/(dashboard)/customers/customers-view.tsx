"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
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
  CustomerFilterMeta,
  CustomerFilters,
  CustomersSortDir,
  CustomersSortKey,
  EditableCustomer,
} from "@/lib/customers-db";
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
  meta: CustomerFilterMeta | null;
  shopCurrency: string | null;
  /** Filtro global por mercado (?market= del header): se preserva al navegar. */
  marketId: string | null;
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

export function CustomersView({
  rows,
  totalCount,
  q,
  page,
  pageSize,
  sortKey,
  sortDir,
  filters,
  meta,
  shopCurrency,
  marketId,
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
      segment?: string | null;
      ticket?: string | null;
      freq?: string | null;
      vip?: boolean | null;
    }) => {
      const params = new URLSearchParams();
      const nextQ = overrides.q ?? q;
      if (nextQ.trim()) params.set("q", nextQ.trim());
      params.set("page", String(overrides.page ?? page));
      params.set("sort", overrides.sort ?? sortKey);
      params.set("dir", overrides.dir ?? sortDir);
      const seg = overrides.segment !== undefined ? overrides.segment : filters.segment;
      if (seg) params.set("segment", seg);
      const tick = overrides.ticket !== undefined ? overrides.ticket : (
        filters.ticketTier === null ? null : String(filters.ticketTier)
      );
      if (tick) params.set("ticket", tick);
      const fr = overrides.freq !== undefined ? overrides.freq : (
        filters.freqBucket === null ? null : String(filters.freqBucket)
      );
      if (fr) params.set("freq", fr);
      const vip = overrides.vip !== undefined ? overrides.vip : (
        filters.noLosPierdas ? true : null
      );
      if (vip) params.set("vip", "1");
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

  const setFilter = (patch: { segment?: string | null; ticket?: string | null; freq?: string | null; vip?: boolean | null }) => {
    startTransition(() => {
      router.replace(`/customers?${buildParams({ page: 1, ...patch })}`);
    });
  };

  const ticketOptions = (() => {
    if (!meta?.tierBounds) return [];
    const [q1, med, q3] = meta.tierBounds;
    const f = (n: number) => formatMoney(n, shopCurrency);
    return [
      { value: "0", label: `Q1 · ticket ≤ ${f(q1)}` },
      { value: "1", label: `Q2 · ${f(q1)}–${f(med)}` },
      { value: "2", label: `Q3 · ${f(med)}–${f(q3)}` },
      { value: "3", label: `Q4 · ticket > ${f(q3)}` },
    ];
  })();
  const filtersActive =
    filters.segment !== null ||
    filters.ticketTier !== null ||
    filters.freqBucket !== null ||
    filters.noLosPierdas;

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
            placeholder="Buscar por email, nombre o teléfono…"
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
          value={filters.segment ?? "all"}
          onValueChange={(v) => setFilter({ segment: v === "all" ? null : v })}
          disabled={!meta}
        >
          <SelectTrigger className="w-44" aria-label="Filtrar por segmento RFM">
            <SelectValue placeholder="Segmento" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los segmentos</SelectItem>
            {(meta?.segments ?? []).map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.key} ({s.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.ticketTier === null ? "all" : String(filters.ticketTier)}
          onValueChange={(v) => setFilter({ ticket: v === "all" ? null : v })}
          disabled={ticketOptions.length === 0}
        >
          <SelectTrigger className="w-44" aria-label="Filtrar por cuartil de ticket">
            <SelectValue placeholder="Ticket" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los tickets</SelectItem>
            {ticketOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.freqBucket === null ? "all" : String(filters.freqBucket)}
          onValueChange={(v) => setFilter({ freq: v === "all" ? null : v })}
          disabled={!meta}
        >
          <SelectTrigger className="w-40" aria-label="Filtrar por frecuencia de compra">
            <SelectValue placeholder="Frecuencia" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toda frecuencia</SelectItem>
            {(meta?.freqBuckets ?? []).map((b, i) => (
              <SelectItem key={b.label} value={String(i)}>
                {b.label} ({b.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => setFilter({ segment: null, ticket: null, freq: null, vip: null })}
          >
            Limpiar
          </Button>
        )}
        <Button
          variant={filters.noLosPierdas ? "default" : "outline"}
          size="sm"
          disabled={isPending}
          onClick={() => setFilter({ vip: filters.noLosPierdas ? null : true })}
          title="Top gasto + inactivos: prioridad de recuperación personal"
        >
          No los pierdas{meta ? ` (${meta.noLosPierdas})` : ""}
        </Button>
        <span className="ms-auto text-xs text-muted-foreground tabular-nums">
          {isPending
            ? "Buscando…"
            : `${totalCount} resultado${totalCount === 1 ? "" : "s"}`}
        </span>
      </div>

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
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
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
          tierBounds={meta?.tierBounds ?? null}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
