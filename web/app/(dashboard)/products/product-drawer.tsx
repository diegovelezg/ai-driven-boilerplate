"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, Package, ShoppingBag, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SortHeaderButton, type SortDir } from "@/components/data-table";
import { DrawerShell } from "@/components/drawer-shell";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/section-heading";
import {
  DrawerTable,
  DrawerTableBody,
  DrawerTableHeader,
  DrawerTableRow,
  DrawerTableTd,
  DrawerTableTh,
} from "@/components/drawer-table";
import { formatMoney, formatNumber } from "@/lib/format";
import type { ProductWithStats } from "@/lib/product-stats";
import type { ProductDetailDTO } from "@/app/api/products/[id]/detail/route";
import { ProductChat } from "./product-chat";

type Tab = "resumen" | "movimientos" | "clientes" | "agentes";

const DRAWER_PAGE_SIZE = 20;

function DrawerSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative max-w-xs flex-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) onChange("");
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 bg-background pr-8 text-[13px]"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Limpiar búsqueda"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

function DrawerPager({ page, totalPages, total, onPrev, onNext }: { page: number; totalPages: number; total: number; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground tabular-nums">
        Página {formatNumber(page)} de {formatNumber(totalPages)} · {formatNumber(total)} registros
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={onPrev}>
          Anterior
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={onNext}>
          Siguiente
        </Button>
      </div>
    </div>
  );
}

function ResumenTab({ summary, detail }: { summary: ProductWithStats; detail: ProductDetailDTO | null }) {
  return (
    <div className="flex flex-col gap-7">
      <section aria-label="Ventas">
        <SectionHeading title="Lo vendido" tone="emerald" />
        <div className="mt-2 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {[
            { label: "Cant. total", value: formatNumber(summary.qty_all) },
            { label: "Monto total", value: summary.currency ? formatMoney(summary.revenue_all, summary.currency) : "—" },
            { label: "Cant. 30d", value: formatNumber(summary.qty_30d) },
            { label: "Compradores", value: formatNumber(summary.buyers_all) },
          ].map((k) => (
            <div key={k.label} className="rounded-lg border px-3 py-2.5">
              <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{k.label}</p>
              <p className="mt-0.5 text-base font-semibold tabular-nums">{k.value}</p>
            </div>
          ))}
        </div>
        {detail && detail.statsByCurrency.length > 1 && (
          <div className="mt-2">
            <DrawerTable>
              <DrawerTableHeader>
                <DrawerTableTh>Moneda</DrawerTableTh>
                <DrawerTableTh numeric>Cant.</DrawerTableTh>
                <DrawerTableTh numeric>Monto</DrawerTableTh>
                <DrawerTableTh numeric>30d</DrawerTableTh>
              </DrawerTableHeader>
              <DrawerTableBody>
                {detail.statsByCurrency.map((s) => (
                  <DrawerTableRow key={s.currency}>
                    <DrawerTableTd>{s.currency.toUpperCase()}</DrawerTableTd>
                    <DrawerTableTd numeric>{formatNumber(s.qtyAll)}</DrawerTableTd>
                    <DrawerTableTd numeric>{formatMoney(s.revenueAll, s.currency)}</DrawerTableTd>
                    <DrawerTableTd numeric>{formatNumber(s.qty30d)}</DrawerTableTd>
                  </DrawerTableRow>
                ))}
              </DrawerTableBody>
            </DrawerTable>
          </div>
        )}
      </section>

      {!detail && (
        <p className="text-[13px] text-muted-foreground">Cargando detalle…</p>
      )}
    </div>
  );
}

function MovimientosTab({ detail, summary }: { detail: ProductDetailDTO | null; summary: ProductWithStats }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<"date" | "qty" | "price" | "revenue">("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
    setExpanded(null);
  }, [query, detail]);

  const toggle = (key: typeof sortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const dir = sortDir === "asc" ? 1 : -1;
    const filtered = (detail?.movements ?? []).filter((m) => {
      if (!q) return true;
      const hay = [
        m.placedAt ?? "",
        m.meta?.contiene ?? "",
        m.meta?.categoria ?? "",
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "date":
          return ((a.placedAt ?? "") < (b.placedAt ?? "") ? -1 : (a.placedAt ?? "") > (b.placedAt ?? "") ? 1 : 0) * dir;
        case "qty":
          return (a.qty - b.qty) * dir;
        case "price":
          return (a.unitPrice - b.unitPrice) * dir;
        case "revenue":
          return (a.revenue - b.revenue) * dir;
        default:
          return 0;
      }
    });
  }, [detail, query, sortKey, sortDir]);

  if (!detail) return <p className="text-[13px] text-muted-foreground">Cargando movimientos…</p>;

  const totalPages = Math.max(1, Math.ceil(rows.length / DRAWER_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = rows.slice((safePage - 1) * DRAWER_PAGE_SIZE, safePage * DRAWER_PAGE_SIZE);

  if (detail.movements.length === 0) {
    return <p className="text-[13px] text-muted-foreground">Sin ventas registradas para este ítem.</p>;
  }
  // La lista trae TODOS los movimientos de lo escaneado (paginados de 20 en
  // 20): su suma sí es comparable con "Cant." de la tabla. Solo difiere si el
  // escaneo topó el CAP o si hay filtro de búsqueda activo.
  const visibleQty = rows.reduce((s, m) => s + m.qty, 0);
  const matchedTotal = detail.totalMatchedMovements ?? rows.length;
  const matchedQty = detail.totalMatchedQty ?? visibleQty;
  const scanTruncated = detail.scanTruncated ?? false;
  const productIndexTruncated = (detail as { productIndexTruncated?: boolean }).productIndexTruncated ?? false;
  const searching = rows.length !== detail.movements.length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {formatNumber(matchedTotal)} movimientos en lo escaneado
        ({formatNumber(detail.scannedOrders ?? 0)} órdenes) · Suma: {formatNumber(matchedQty)}
        {" "}· Total histórico (tabla): {formatNumber(summary.qty_all)}
        {scanTruncated ? " · escaneo topado (CAP 3k): hay más fuera de lo escaneado" : ""}
        {productIndexTruncated ? " · catálogo topado (índice 5k): el match por ID puede estar parcial" : ""}
        {searching ? ` · Viendo ${formatNumber(rows.length)} filtrados (suman ${formatNumber(visibleQty)})` : ""}.
      </p>
      <DrawerSearch value={query} onChange={setQuery} placeholder="Buscar en movimientos…" />
      <DrawerTable>
        <DrawerTableHeader>
          <DrawerTableTh className="w-8" aria-label="Expandir" />
          <DrawerTableTh aria-sort={sortKey === "date" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
            <SortHeaderButton active={sortKey === "date"} dir={sortDir} onClick={() => toggle("date")} ariaLabel="Ordenar por fecha">Fecha</SortHeaderButton>
          </DrawerTableTh>
          <DrawerTableTh numeric aria-sort={sortKey === "qty" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
            <SortHeaderButton active={sortKey === "qty"} dir={sortDir} alignRight onClick={() => toggle("qty")} ariaLabel="Ordenar por cantidad">Cant.</SortHeaderButton>
          </DrawerTableTh>
          <DrawerTableTh numeric aria-sort={sortKey === "price" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
            <SortHeaderButton active={sortKey === "price"} dir={sortDir} alignRight onClick={() => toggle("price")} ariaLabel="Ordenar por precio">Precio</SortHeaderButton>
          </DrawerTableTh>
          <DrawerTableTh numeric aria-sort={sortKey === "revenue" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
            <SortHeaderButton active={sortKey === "revenue"} dir={sortDir} alignRight onClick={() => toggle("revenue")} ariaLabel="Ordenar por monto">Monto</SortHeaderButton>
          </DrawerTableTh>
        </DrawerTableHeader>
        <DrawerTableBody>
          {paged.map((m, i) => (
            <Fragment key={`${m.placedAt ?? "?"}-${i}`}>
              <DrawerTableRow
                onClick={() => setExpanded((e) => (e === i ? null : i))}
                className="cursor-pointer"
              >
                <DrawerTableTd className="text-muted-foreground">
                  {m.meta && (
                    <ChevronDown
                      className={`size-4 transition-transform ${expanded === i ? "rotate-180" : ""}`}
                      aria-hidden
                    />
                  )}
                </DrawerTableTd>
                <DrawerTableTd>{m.placedAt ? m.placedAt.slice(0, 10) : "—"}</DrawerTableTd>
                <DrawerTableTd numeric>{formatNumber(m.qty)}</DrawerTableTd>
                <DrawerTableTd numeric>{m.currency ? formatMoney(m.unitPrice, m.currency) : "—"}</DrawerTableTd>
                <DrawerTableTd numeric>{m.currency ? formatMoney(m.revenue, m.currency) : "—"}</DrawerTableTd>
              </DrawerTableRow>
              {expanded === i && m.meta && (
                <DrawerTableRow className="bg-muted/20">
                  <DrawerTableTd colSpan={5}>
                    <p className="mb-1.5 text-[11px] tracking-wide text-muted-foreground uppercase">Contenido (key elegida en settings)</p>
                    <div className="flex flex-col gap-1.5 text-[13px]">
                      {m.meta.contiene && (
                        <p><span className="text-muted-foreground">Contiene: </span>{m.meta.contiene}</p>
                      )}
                      {m.meta.categoria && (
                        <p><span className="text-muted-foreground">Categoría: </span>{m.meta.categoria}</p>
                      )}
                    </div>
                  </DrawerTableTd>
                </DrawerTableRow>
              )}
            </Fragment>
          ))}
          {paged.length === 0 && (
            <DrawerTableRow>
              <DrawerTableTd colSpan={5} className="text-center text-muted-foreground">
                Sin resultados para esa búsqueda.
              </DrawerTableTd>
            </DrawerTableRow>
          )}
        </DrawerTableBody>
      </DrawerTable>
      <DrawerPager page={safePage} totalPages={totalPages} total={rows.length} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => Math.min(totalPages, p + 1))} />
    </div>
  );
}

function ClientesTab({ detail }: { detail: ProductDetailDTO | null }) {
  const [sortKey, setSortKey] = useState<"name" | "qty" | "revenue">("revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [query, detail]);

  const toggle = (key: typeof sortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const dir = sortDir === "asc" ? 1 : -1;
    const filtered = (detail?.buyers ?? []).filter((b) => {
      if (!q) return true;
      return `${b.name} ${b.email} ${b.company ?? ""}`.toLowerCase().includes(q);
    });
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.name.localeCompare(b.name, "es") * dir;
        case "qty":
          return (a.qty - b.qty) * dir || a.name.localeCompare(b.name, "es");
        case "revenue":
          return (a.revenue - b.revenue) * dir || a.name.localeCompare(b.name, "es");
        default:
          return 0;
      }
    });
  }, [detail, query, sortKey, sortDir]);

  if (!detail) return <p className="text-[13px] text-muted-foreground">Cargando compradores…</p>;
  if (detail.buyers.length === 0) {
    return <p className="text-[13px] text-muted-foreground">Sin compradores identificados para este ítem.</p>;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / DRAWER_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = rows.slice((safePage - 1) * DRAWER_PAGE_SIZE, safePage * DRAWER_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-3">
      <DrawerSearch value={query} onChange={setQuery} placeholder="Buscar comprador…" />
      <DrawerTable>
        <DrawerTableHeader>
          <DrawerTableTh aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
            <SortHeaderButton active={sortKey === "name"} dir={sortDir} onClick={() => toggle("name")} ariaLabel="Ordenar por comprador">Comprador</SortHeaderButton>
          </DrawerTableTh>
          <DrawerTableTh numeric aria-sort={sortKey === "qty" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
            <SortHeaderButton active={sortKey === "qty"} dir={sortDir} alignRight onClick={() => toggle("qty")} ariaLabel="Ordenar por cantidad">Cant.</SortHeaderButton>
          </DrawerTableTh>
          <DrawerTableTh numeric aria-sort={sortKey === "revenue" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
            <SortHeaderButton active={sortKey === "revenue"} dir={sortDir} alignRight onClick={() => toggle("revenue")} ariaLabel="Ordenar por monto">Monto</SortHeaderButton>
          </DrawerTableTh>
        </DrawerTableHeader>
        <DrawerTableBody>
          {paged.map((b) => (
            <DrawerTableRow key={b.customerId}>
              <DrawerTableTd>
                <span className="font-medium">{b.name}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  {b.email}
                  {b.company ? ` · ${b.company}` : ""}
                </span>
              </DrawerTableTd>
              <DrawerTableTd numeric>{formatNumber(b.qty)}</DrawerTableTd>
              <DrawerTableTd numeric>{formatMoney(b.revenue, b.currency)}</DrawerTableTd>
            </DrawerTableRow>
          ))}
          {paged.length === 0 && (
            <DrawerTableRow>
              <DrawerTableTd colSpan={3} className="text-center text-muted-foreground">
                Sin resultados para esa búsqueda.
              </DrawerTableTd>
            </DrawerTableRow>
          )}
        </DrawerTableBody>
      </DrawerTable>
      <DrawerPager page={safePage} totalPages={totalPages} total={rows.length} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => Math.min(totalPages, p + 1))} />
    </div>
  );
}

export function ProductDrawer({
  summary,
  market,
  onClose,
}: {
  summary: ProductWithStats;
  market: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("resumen");
  const [detail, setDetail] = useState<ProductDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    fetch(`/api/products/${summary.id}/detail${market ? `?market=${encodeURIComponent(market)}` : ""}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null) as { error?: string } | null)?.error ?? "No se pudo cargar el detalle.");
        return (await r.json()) as ProductDetailDTO;
      })
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "No se pudo cargar el detalle."); });
    return () => { cancelled = true; };
  }, [summary.id, market]);

  const drawerTabs = [
    { id: "resumen", label: "Resumen", icon: Package },
    { id: "movimientos", label: "Movimientos", icon: ShoppingBag },
    { id: "clientes", label: "Clientes", icon: Users },
    { id: "agentes", label: "Agentes", icon: Bot },
  ] as const;

  return (
    <DrawerShell
      onClose={onClose}
      avatar={<Package className="size-5" aria-hidden />}
      title={summary.title}
      description={
        [(detail?.product.platformStatus ?? summary.platform_status), detail?.product.handle].filter(Boolean).join(" · ") || undefined
      }
      badges={
        <>
          <span
            className={
              summary.is_active
                ? "inline-block rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600"
                : "inline-block rounded-full bg-zinc-500/15 px-2 py-0.5 text-xs text-zinc-500"
            }
          >
            {summary.is_active ? "activo" : "inactivo"}
          </span>
        </>
      }
      tabs={[...drawerTabs]}
      tab={tab}
      onTabChange={(id) => setTab(id as Tab)}
      tabListLabel="Detalle del ítem"
      fill={tab === "agentes"}
    >
      {tab === "agentes" ? (
        <ProductChat productId={summary.id} productTitle={summary.title} market={market} />
      ) : (
        <>
          {error && (
            <p className="text-[13px] text-destructive">{error}</p>
          )}
          {tab === "resumen" && !error && <ResumenTab summary={summary} detail={detail} />}
          {tab === "movimientos" && !error && (
            <div className="flex flex-col gap-3">
              <SectionHeading
                title="Movimientos"
                hint="Clic para ver el contenido de esa línea"
                tone="sky"
              />
              <MovimientosTab detail={detail} summary={summary} />
            </div>
          )}
          {tab === "clientes" && !error && (
            <div className="flex flex-col gap-3">
              <SectionHeading title="Quiénes lo compran" hint="Top por monto en lo escaneado" tone="violet" />
              <ClientesTab detail={detail} />
            </div>
          )}
        </>
      )}
    </DrawerShell>
  );
}
