"use client";

import { useEffect, useState, useTransition } from "react";
import { Building2, ExternalLink, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { updateCustomerAction } from "@/lib/customer-actions";
import { reenrichDomainAction } from "@/lib/enrich-actions";
import type { EditableCustomer, ManualField } from "@/lib/customers-db";
import { formatMoney } from "@/lib/medusa";
import type {
  CustomerOrder,
  CustomerRfm,
} from "@/app/api/customers/[id]/orders/route";
import type { CustomerFirmographics } from "@/app/api/customers/[id]/firmographics/route";
import { CustomerChat } from "./customer-chat";

const FIELDS: Array<{ key: ManualField; label: string; placeholder: string }> = [
  { key: "first_name", label: "Nombre", placeholder: "Nombre" },
  { key: "last_name", label: "Apellido", placeholder: "Apellido" },
  { key: "phone", label: "Teléfono", placeholder: "+51 …" },
  { key: "company_name", label: "Empresa", placeholder: "Empresa" },
];

function effStr(c: EditableCustomer, key: ManualField): string {
  switch (key) {
    case "first_name":
      return c.firstName ?? "";
    case "last_name":
      return c.lastName ?? "";
    case "phone":
      return c.phone ?? "";
    case "company_name":
      return c.companyName ?? "";
    case "customer_type":
      return c.customerType;
  }
}

function baseStr(c: EditableCustomer, key: ManualField): string {
  switch (key) {
    case "first_name":
      return c.base.firstName ?? "";
    case "last_name":
      return c.base.lastName ?? "";
    case "phone":
      return c.base.phone ?? "";
    case "company_name":
      return c.base.companyName ?? "";
    case "customer_type":
      return c.base.customerType;
  }
}

function FieldMeta({
  overridden,
  willRevert,
  onRevert,
  label,
}: {
  overridden: boolean;
  willRevert: boolean;
  onRevert: () => void;
  label: string;
}) {
  return (
    <span className="flex h-5 items-center">
      {overridden ? (
        <span className="flex items-center gap-1.5">
          <Badge variant="secondary" className="font-normal">
            Editado
          </Badge>
          <button
            type="button"
            onClick={onRevert}
            title="Volver al valor de Medusa"
            aria-label={`Revertir ${label} a valor de Medusa`}
            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Undo2 className="size-3.5" aria-hidden />
          </button>
        </span>
      ) : (
        willRevert && (
          <Badge variant="outline" className="font-normal">
            Revierte al guardar
          </Badge>
        )
      )}
    </span>
  );
}

function DatosTab({ customer, onClose }: { customer: EditableCustomer; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Record<ManualField, string>>({
    first_name: effStr(customer, "first_name"),
    last_name: effStr(customer, "last_name"),
    phone: effStr(customer, "phone"),
    company_name: effStr(customer, "company_name"),
    customer_type: effStr(customer, "customer_type"),
  });
  const [reverted, setReverted] = useState<ManualField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isOverridden = (key: ManualField) =>
    customer.manualFields.includes(key) && !reverted.includes(key);

  const markRevert = (key: ManualField) => {
    setReverted((r) => (r.includes(key) ? r : [...r, key]));
    setDrafts((d) => ({ ...d, [key]: baseStr(customer, key) }));
    setError(null);
  };

  const setDraft = (key: ManualField, v: string) => {
    setDrafts((d) => ({ ...d, [key]: v }));
    if (v !== baseStr(customer, key)) {
      setReverted((r) => r.filter((k) => k !== key));
    }
    setError(null);
  };

  const ALL_KEYS: ManualField[] = [...FIELDS.map((f) => f.key), "customer_type"];

  const diff = () => {
    const values: Partial<Record<ManualField, string>> = {};
    const reverts: ManualField[] = [];
    for (const key of ALL_KEYS) {
      if (drafts[key] === baseStr(customer, key)) {
        if (customer.manualFields.includes(key) || reverted.includes(key)) {
          reverts.push(key);
        }
      } else if (drafts[key] !== effStr(customer, key)) {
        values[key] = drafts[key];
      }
    }
    return { values, reverts };
  };

  const save = () => {
    const { values, reverts } = diff();
    if (Object.keys(values).length === 0 && reverts.length === 0) {
      onClose();
      return;
    }
    startTransition(async () => {
      const res = await updateCustomerAction({ id: customer.dbId, values, reverts });
      if (res.ok) onClose();
      else setError(res.message);
    });
  };

  const { values: pendingValues, reverts: pendingReverts } = diff();
  const dirty = Object.keys(pendingValues).length > 0 || pendingReverts.length > 0;

  const renderTextField = (
    key: (typeof FIELDS)[number]["key"],
    label: string,
    placeholder: string,
  ) => (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={`cm-${key}`} className="text-[13px]">
          {label}
        </Label>
        <FieldMeta
          overridden={isOverridden(key)}
          willRevert={reverted.includes(key)}
          onRevert={() => markRevert(key)}
          label={label}
        />
      </div>
      <Input
        id={`cm-${key}`}
        value={drafts[key]}
        onChange={(e) => setDraft(key, e.target.value)}
        placeholder={placeholder}
        disabled={isPending}
        className="h-10"
      />
      {isOverridden(key) && baseStr(customer, key) !== drafts[key] && (
        <p className="text-xs text-muted-foreground">Medusa: {baseStr(customer, key) || "—"}</p>
      )}
    </div>
  );

  return (
    <div className="grid gap-5 px-8 py-6">
      <div className="grid gap-4 sm:grid-cols-2">
        {renderTextField("first_name", "Nombre", "Nombre")}
        {renderTextField("last_name", "Apellido", "Apellido")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {renderTextField("phone", "Teléfono", "+51 …")}
        {renderTextField("company_name", "Empresa", "Empresa")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="cm-type" className="text-[13px]">
              Tipo
            </Label>
            <FieldMeta
              overridden={isOverridden("customer_type")}
              willRevert={reverted.includes("customer_type")}
              onRevert={() => markRevert("customer_type")}
              label="Tipo"
            />
          </div>
          <Select
            value={drafts.customer_type}
            onValueChange={(v) => {
              if (v) setDraft("customer_type", v);
            }}
            disabled={isPending}
          >
            <SelectTrigger id="cm-type" className="h-10 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="B2C">B2C · Consumidor final</SelectItem>
              <SelectItem value="B2B">B2B · Empresa</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="hidden items-end pb-1 text-xs text-muted-foreground sm:flex">
          Lo editado se conserva ante el sync de Medusa.
        </p>
      </div>

      <EnrichedCompany
        dbId={customer.dbId}
        onUseCompany={(name) => setDraft("company_name", name)}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-3 pt-1">
        <Button variant="outline" onClick={onClose} disabled={isPending} className="h-10 px-5">
          Cancelar
        </Button>
        <Button onClick={save} disabled={isPending || !dirty} className="h-10 px-6">
          {isPending ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </div>
  );
}

/** Empresa enriquecida por dominio (read-only). Solo se muestra si el dominio es de negocio. */
function EnrichedCompany({
  dbId,
  onUseCompany,
}: {
  dbId: string;
  onUseCompany: (name: string) => void;
}) {
  const [data, setData] = useState<CustomerFirmographics | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [reloading, startReenrich] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/customers/${dbId}/firmographics`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive) setData(j as CustomerFirmographics | null);
      })
      .catch(() => {
        if (alive) setData(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dbId, reloadKey]);

  if (loading || !data || !data.enrichable) return null;

  const runReenrich = () => {
    startReenrich(async () => {
      const r = await reenrichDomainAction(data.domain);
      if (r.ok) setReloadKey((k) => k + 1);
      else setMsg(r.message);
    });
  };

  const meta = [data.industry, data.location, data.size && `tamaño ${data.size}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[13px] font-medium">
          <Building2 className="size-3.5 text-primary" aria-hidden />
          Empresa (enriquecido)
        </p>
        {data.enriched && data.confidence !== null && (
          <span className="text-[11px] text-muted-foreground">
            confianza {Math.round(data.confidence * 100)}%
          </span>
        )}
      </div>

      {data.enriched ? (
        <div className="mt-3 grid gap-2">
          <p className="text-sm font-semibold">{data.companyName ?? "—"}</p>
          {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
          {data.description && <p className="text-[13px]">{data.description}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <a
              href={data.sourceUrl ?? `https://${data.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
            >
              {data.domain}
              <ExternalLink className="size-3" aria-hidden />
            </a>
            <span className="flex gap-2">
              {data.companyName && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onUseCompany(data.companyName as string)}
                >
                  Usar como Empresa
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={reloading}
                onClick={runReenrich}
              >
                {reloading ? "Re-enriqueciendo…" : "Re-enriquecer"}
              </Button>
            </span>
          </div>
          {msg && <p className="text-xs text-destructive">{msg}</p>}
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Dominio {data.domain} · sin enriquecer aún.
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={reloading}
            onClick={runReenrich}
          >
            {reloading ? "Enriqueciendo…" : "Enriquecer"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ScoreBadge({ axis, score }: { axis: "R" | "F" | "M"; score: number | null }) {
  if (score === null) return null;
  const label = axis === "R" ? "Recencia" : axis === "F" ? "Frecuencia" : "Monetario";
  return (
    <Badge
      variant="secondary"
      className="ml-2 align-middle font-normal tabular-nums"
      title={`${label}: ${score}/5 vs la tienda`}
    >
      {axis}
      {score}
    </Badge>
  );
}

function ComprasTab({ dbId }: { dbId: string }) {
  const [orders, setOrders] = useState<CustomerOrder[] | null>(null);
  const [summary, setSummary] = useState<CustomerRfm | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/customers/${dbId}/orders`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { orders?: CustomerOrder[]; summary?: CustomerRfm };
        if (alive) {
          setOrders(j.orders ?? []);
          setSummary(j.summary ?? null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "No se pudo cargar.");
      });
    return () => {
      alive = false;
    };
  }, [dbId]);

  if (error) return <p className="px-8 py-6 text-sm text-destructive">{error}</p>;
  if (!orders || !summary)
    return <p className="px-8 py-6 text-sm text-muted-foreground">Cargando compras…</p>;

  const recencyLabel =
    summary.recencyDays === null
      ? "—"
      : summary.recencyDays === 0
        ? "hoy"
        : summary.recencyDays === 1
          ? "ayer"
          : `hace ${summary.recencyDays} días`;

  return (
    <div className="grid gap-6 px-8 py-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-semibold tabular-nums">
              {formatMoney(summary.monetary, summary.currency)}
              <ScoreBadge axis="M" score={summary.m} />
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Compras</p>
            <p className="text-xl font-semibold tabular-nums">
              {summary.frequency}
              <ScoreBadge axis="F" score={summary.f} />
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Ticket prom.</p>
            <p className="text-xl font-semibold tabular-nums">
              {formatMoney(summary.avgTicket, summary.currency)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Última compra</p>
            <p className="text-xl font-semibold">
              {recencyLabel}
              <ScoreBadge axis="R" score={summary.r} />
            </p>
          </div>
        </div>
        <Badge variant="outline" className="text-[13px] font-normal" title="Segmento RFM simplificado">
          {summary.segment}
        </Badge>
      </div>

      {orders.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin compras registradas.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-3">Fecha</TableHead>
              <TableHead className="px-3">Detalle</TableHead>
              <TableHead className="px-3 text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o, i) => (
              <TableRow key={i}>
                <TableCell className="whitespace-nowrap px-3 py-2.5 text-[13px] tabular-nums">
                  {o.date ? o.date.slice(0, 10) : "—"}
                </TableCell>
                <TableCell
                  className="max-w-0 truncate px-3 py-2.5 text-[13px] text-muted-foreground"
                  title={o.items.map((it) => `${it.title} x${it.quantity}`).join("; ")}
                >
                  {o.items.length > 0
                    ? o.items.map((it) => `${it.title} x${it.quantity}`).join(" · ")
                    : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap px-3 py-2.5 text-right text-[13px] tabular-nums">
                  {formatMoney(o.total, o.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function CustomerDrawer({
  customer,
  onClose,
}: {
  customer: EditableCustomer;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"datos" | "compras" | "chat">("datos");

  const displayName = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
  const initials = (displayName || customer.email)
    .replace(/[^a-zA-Záéíóúñü@. ]/g, "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 data-[side=right]:sm:max-w-[min(920px,94vw)]">
        <div className="flex items-center gap-4 px-8 pt-6 pb-5">
          <div
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold tracking-wide text-primary"
          >
            {initials || "—"}
          </div>
          <div className="min-w-0 pr-8">
            <SheetTitle className="truncate text-lg">{displayName || "Sin nombre"}</SheetTitle>
            <SheetDescription className="truncate">{customer.email}</SheetDescription>
          </div>
        </div>

        <div className="flex gap-6 border-b px-8" role="tablist" aria-label="Ficha del customer">
          {(["datos", "compras", "chat"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`relative py-3 text-sm transition-colors ${
                tab === t ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "datos" ? "Datos" : t === "compras" ? "Compras" : "Agente"}
              {tab === t && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {tab === "datos" ? (
            <DatosTab customer={customer} onClose={onClose} />
          ) : tab === "compras" ? (
            <ComprasTab dbId={customer.dbId} />
          ) : (
            <CustomerChat
              dbId={customer.dbId}
              customerName={displayName || customer.email}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
