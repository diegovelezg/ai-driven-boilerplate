"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney, type CanonicalCustomer } from "@/lib/medusa";

interface Props {
  rows: CanonicalCustomer[];
  totalCount: number;
  q: string;
  page: number;
  pageSize: number;
}

type SortKey = "email" | "name" | "phone" | "company" | "orders" | "total";

export function CustomersView({ rows, totalCount, q, page, pageSize }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState(q);

  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    }
  };

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
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        params.set("page", "1");
        router.replace(`/customers?${params.toString()}`);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [query, q, router]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const goTo = (next: number) => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    params.set("page", String(next));
    startTransition(() => {
      router.replace(`/customers?${params.toString()}`);
    });
  };

  const displayName = (c: CanonicalCustomer) =>
    [c.firstName, c.lastName].filter(Boolean).join(" ");

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    const valueOf = (c: CanonicalCustomer): string | number => {
      switch (sortKey) {
        case "email":
          return c.email.toLowerCase();
        case "name":
          return displayName(c).toLowerCase();
        case "phone":
          return (c.phone ?? "").toLowerCase();
        case "company":
          return (c.companyName ?? "").toLowerCase();
        case "orders":
          return c.ordersCount;
        case "total":
          return c.totalSpent;
      }
    };
    return [...rows].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
    });
  }, [rows, sortKey, sortDir]);

  const getSortIcon = (column: SortKey) => {
    if (sortKey !== column)
      return <ChevronsUpDown className="size-3.5 opacity-40" aria-hidden />;
    return sortDir === "asc" ? (
      <ArrowUp className="size-3.5" aria-hidden />
    ) : (
      <ArrowDown className="size-3.5" aria-hidden />
    );
  };

  const sortButtonClass = (column: SortKey, alignRight = false) =>
    `inline-flex items-center gap-1 rounded px-1 py-1 text-left font-medium hover:text-foreground ${
      alignRight ? "flex-row-reverse" : ""
    } ${sortKey === column ? "text-foreground" : ""}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-sm flex-1">
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
        <span className="text-xs text-muted-foreground tabular-nums">
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
              {sortedRows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="px-4 py-4 font-medium">{c.email}</TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">
                    {displayName(c) || "—"}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">{c.phone ?? "—"}</TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">
                    {c.companyName ?? "—"}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-right tabular-nums">
                    {c.ordersCount}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-right tabular-nums">
                    {formatMoney(c.totalSpent, c.currency)}
                  </TableCell>
                </TableRow>
              ))}
              {sortedRows.length === 0 && (
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
    </div>
  );
}
