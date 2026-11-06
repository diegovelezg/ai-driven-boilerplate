"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { AppCardState } from "@/components/app-card";
import { DrawerShell } from "@/components/drawer-shell";
import { Badge } from "@/components/ui/badge";
import { Steps } from "@/components/steps";
import { SectionHeading } from "@/components/section-heading";
import { DrawerTable, DrawerTableBody, DrawerTableHeader, DrawerTableRow, DrawerTableTd, DrawerTableTh } from "@/components/drawer-table";
import { ORDER_STEPS, ORDER_STAGE_LABELS, orderStage } from "@/lib/order-stage";
import { formatMoney } from "@/lib/format";

interface Detail {
  order: Record<string, unknown>;
  advertiser_name: string | null;
  billing_name: string | null;
  lines: Array<Record<string, unknown>>;
  agency_orders: Array<Record<string, unknown>>;
  creatives: Array<Record<string, unknown>>;
  bookings_count: number;
  photos_count: number;
  invoices: Array<Record<string, unknown>>;
}

function str(v: unknown): string {
  return typeof v === "string" && v ? v : "—";
}

export function OrdenDrawer({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/ordenes/${orderId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("No se pudo cargar la orden.");
      setDetail((await res.json()) as Detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "DB read failed");
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const o = detail?.order;
  const lines = detail?.lines ?? [];
  const oms = detail?.agency_orders ?? [];
  const creatives = detail?.creatives ?? [];
  const invoices = detail?.invoices ?? [];
  const pendingCreative = creatives.some((c) => c.qc_status !== "approved" || c.legal_status !== "approved");
  const gross = lines.reduce((a, l) => a + Number(l.rate_minor ?? 0), 0);
  const st = o
    ? orderStage({
        status: (o.status as string | null) ?? null,
        signed: o.status === "signed",
        hasOm: oms.length > 0,
        materialsOk: creatives.length > 0 && !pendingCreative,
        ended: o.ends_at ? Date.parse(String(o.ends_at)) <= Date.now() : false,
        certified: (detail?.photos_count ?? 0) > 0,
        paid: invoices.some((v) => String(v.status) === "paid"),
      })
    : null;

  return (
    <DrawerShell
      onClose={onClose}
      size="wide"
      avatar={<FileText className="size-5" aria-hidden />}
      title={o ? String(o.io_number ?? "Orden") : "Orden"}
      description={o ? [detail?.billing_name, typeof o.brand === "string" ? o.brand : null].filter(Boolean).join(" · ") || "—" : "Cargando…"}
      badges={
        st && (
          <Badge variant="secondary" className="font-normal">
            {ORDER_STAGE_LABELS[st.stage]}
          </Badge>
        )
      }
    >
      {error && <AppCardState>{error}</AppCardState>}
      {!error && !detail && <AppCardState>Cargando orden…</AppCardState>}

      {detail && o && st && (
        <>
          {st.index >= 0 && <Steps steps={[...ORDER_STEPS]} current={st.index} />}

          <section className="flex flex-col gap-2">
            <SectionHeading title="Ficha" hint="Fechas inclusivas de la OI." />
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Periodo</dt><dd className="tabular-nums">{str(o.starts_at)} → {str(o.ends_at)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Bruto</dt><dd className="tabular-nums">{gross > 0 ? formatMoney(gross, "PEN") : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Anunciante</dt><dd className="text-xs">{detail.advertiser_name ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Facturar a</dt><dd className="text-xs">{detail.billing_name ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Pago</dt><dd className="text-xs">{str(o.payment_terms)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Firma</dt><dd className="text-xs">{str(o.signed_at)}</dd></div>
            </dl>
          </section>

          <section className="flex flex-col gap-2">
            <SectionHeading title={`Líneas (${lines.length})`} hint="Pantalla + periodo + tarifa y total." />
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin líneas.</p>
            ) : (
              <DrawerTable>
                <DrawerTableHeader>
                  <DrawerTableTh>Pantalla</DrawerTableTh>
                  <DrawerTableTh>Periodo</DrawerTableTh>
                  <DrawerTableTh numeric>Total</DrawerTableTh>
                </DrawerTableHeader>
                <DrawerTableBody>
                  {lines.map((l) => (
                    <DrawerTableRow key={String(l.id)}>
                      <DrawerTableTd className="font-medium">{str(l.screen_name)}</DrawerTableTd>
                      <DrawerTableTd className="text-xs tabular-nums">
                        {str(l.starts_at).slice(0, 10)} → {str(l.ends_at).slice(0, 10)}
                      </DrawerTableTd>
                      <DrawerTableTd numeric className="tabular-nums">
                        {formatMoney(l.rate_minor as number, "PEN")}
                      </DrawerTableTd>
                    </DrawerTableRow>
                  ))}
                </DrawerTableBody>
              </DrawerTable>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <SectionHeading title={`Autorización (${oms.length})`} hint="OM/OC de la agencia. Sin OM la orden no avanza." />
            {oms.length === 0 ? (
              <p className="text-sm text-muted-foreground">Falta registrar el OM/OC.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {oms.map((m) => (
                  <li key={String(m.id)} className="flex justify-between gap-3">
                    <span>{str(m.kind)} {str(m.code)}</span>
                    <span className="text-xs text-muted-foreground">{str(m.portal)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <SectionHeading title={`Materiales (${creatives.length})`} hint="QC + aprobación legal por pieza." />
            {creatives.length === 0 ? (
              <p className="text-sm text-muted-foreground">Falta subir el material.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {creatives.map((c) => (
                  <li key={String(c.id)} className="flex justify-between gap-3">
                    <span>{str(c.name)}</span>
                    <span className="text-xs text-muted-foreground">QC {str(c.qc_status)} · Legal {str(c.legal_status)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <SectionHeading title="Certificación y cobranza" hint="Foto check + PoP, luego factura." />
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">Reservas</dt><dd className="tabular-nums">{detail.bookings_count}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Fotos check</dt><dd className="tabular-nums">{detail.photos_count}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Facturas</dt>
                <dd className="text-xs">
                  {invoices.length === 0
                    ? "Sin facturas."
                    : invoices.map((v) => `${str(v.number)} (${str(v.status)})`).join(" · ")}
                </dd>
              </div>
            </dl>
            {typeof o.notes === "string" && o.notes && (
              <p className="text-xs text-muted-foreground">{o.notes}</p>
            )}
          </section>
        </>
      )}
    </DrawerShell>
  );
}
