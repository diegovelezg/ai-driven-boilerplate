import { connection } from "next/server";
import type { Metadata } from "next";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getOrderDetail } from "@/lib/orders-db";
import {
  displayStoreName,
  getMyActiveStore,
  requireMyStoreAccess,
} from "@/lib/tenant";
import { normalizeCurrency } from "@/lib/currency";
import {
  diffDaysInclusive,
  displayEndOfSafe,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  paymentTermsLabel,
  splitIgv,
  toTitleCase,
} from "@/lib/format";
import { parseOrderSnapshot } from "@/lib/order-snapshot";
import { taxIdLabel } from "@/lib/tax-id";
import { taxNameForCountry, vatRateForCountry } from "@/lib/tax-rate";
import { PrintButton } from "./print-button";

export const instant = false;

/** Título para la pestaña y el nombre sugerido al guardar el PDF. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  try {
    const { id } = await params;
    const { getSupabase } = await import("@/lib/supabase");
    const db = getSupabase();
    const { data } = await db.from("io_orders").select("io_number,store_id").eq("id", id).maybeSingle();
    if (!data) return { title: "Nota de pedido" };
    const storeId = String((data as Record<string, unknown>).store_id ?? "");
    if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
      return { title: "Nota de pedido" };
    }
    return { title: `Nota de pedido ${String((data as Record<string, unknown>).io_number ?? "")}` };
  } catch {
    return { title: "Nota de pedido" };
  }
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  signed: "Firmada",
  cancelled: "Cancelada",
};

function str(v: unknown): string {
  return typeof v === "string" && v ? v : "—";
}

function money(minor: unknown, currency: string): string {
  const n = Number(minor);
  return Number.isFinite(n) ? formatMoney(n, currency, 2) : "—";
}

/** GET visual: /orders/:id/print — Nota de Pedido lista para "Exportar
 *  PDF" (diálogo de impresión del navegador → Guardar como PDF). Fuera del
 *  grupo (dashboard): sin sidebar/header para que el papel salga limpio.
 *  Solo lectura: exige membresía a la tienda (404 idéntico sin acceso,
 *  como /api/orders/:id). Estructura y wording según la Nota de Pedido de
 *  alquiler y producción vigente (secciones I–X). Solo campos con dato
 *  real: lo ausente se muestra "—", nunca se inventa. */
export default async function OrderPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ store?: string }>;
}) {
  await connection();
  const { id } = await params;
  const sp = await searchParams;

  if (!isSupabaseConfigured()) {
    return <PrintError message="Base de datos no disponible." />;
  }
  const { active } = await getMyActiveStore(sp.store ?? null);
  const storeId = active?.id ?? null;
  if (!storeId) return <PrintError message="Sin tienda conectada." />;
  if ((await requireMyStoreAccess(storeId).catch(() => false)) === false) {
    return <PrintError message="Orden no encontrada." />;
  }
  let detail: Awaited<ReturnType<typeof getOrderDetail>>;
  try {
    detail = await getOrderDetail(storeId, id);
  } catch {
    return <PrintError message="No se pudo cargar la orden." />;
  }
  if (!detail) return <PrintError message="Orden no encontrada." />;

  const storeName = active ? displayStoreName(active) : "—";
  const o = detail.order;
  // Snapshot al firmar gana al dato vivo (documento inmutable; resiste archivo
  // o cambio de empresas/contactos). Sin snapshot: dato vivo.
  const snap = parseOrderSnapshot(o.snapshot_json);
  const currency = normalizeCurrency(
    (snap?.currency ?? (o.currency as string | null | undefined) ?? "PEN"),
  );
  const lines = detail.lines;
  const liveGross = lines.reduce((a, l) => a + Number(l.rate_minor ?? 0), 0);
  const gross = snap?.gross_minor ?? liveGross;
  const tenantCountry = active?.shop_country ?? null;
  const { net, igv, total } = splitIgv(gross, tenantCountry);
  const taxName = taxNameForCountry(tenantCountry);
  const taxPct = Math.round(vatRateForCountry(tenantCountry) * 100);
  const status = String(o.status ?? "");
  const isDraft = status === "draft";
  const ioNumber = String(o.io_number ?? "Orden");
  const brand =
    typeof o.brand === "string" && o.brand ? toTitleCase(o.brand) : "—";
  const advertiser = toTitleCase(snap ? snap.advertiser.name : detail.advertiser_name);
  const billing = toTitleCase(snap ? snap.billing.name : detail.billing_name);
  const billingTax = snap ? snap.billing.tax_id : detail.billing_tax_id;
  const billingCountry = snap ? snap.billing.country : detail.billing_country;
  const fiscalLabel = taxIdLabel(billingCountry);
  const cityLine = [
    snap ? snap.billing.city : detail.billing_city,
    snap ? snap.billing.country : detail.billing_country,
  ]
    .filter(Boolean)
    .join(" · ");
  const termsDays = snap
    ? snap.payment_terms_days
    : typeof o.payment_terms_days === "number"
      ? (o.payment_terms_days as number)
      : null;
  const terms = termsDays !== null ? paymentTermsLabel(termsDays) : snap ? "—" : str(o.payment_terms);
  const notes =
    typeof o.notes === "string" && o.notes.trim() ? o.notes.trim() : null;
  const txt = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  // Opción B: solo intermediaria vinculada (columnas de texto eliminadas).
  const linkedAgencyName = (snap ? snap.agency?.name : detail.agency_name) ?? null;
  const linkedAgencyTax = (snap ? snap.agency?.tax_id : detail.agency_tax_id) ?? null;
  const hasIntermediary = Boolean(linkedAgencyName);
  // Dirección: solo lectura desde la empresa (sin columna en la orden).
  const billingAddress = detail.billing_company_address;
  // Solo contactos vinculados (columnas de texto eliminadas).
  const snapContacts = snap?.contacts ?? null;
  const pocRef = snapContacts?.billing ?? detail.contacts.billing;
  const pocName = pocRef?.name ?? null;
  const pocPhone = pocRef?.phone ?? null;
  const pocEmail = pocRef?.email ?? null;
  const hasContact = Boolean(billingAddress || pocName || pocPhone || pocEmail);
  const signerRef = snapContacts?.signer ?? detail.contacts.signer;
  const signerName = signerRef?.name ?? null;
  const signerRole = signerRef?.role ?? null;
  const signerEmail = signerRef?.email ?? null;
  const managerRef = snapContacts?.manager ?? detail.contacts.manager;
  const managerName = managerRef?.name ?? null;
  const managerRole = managerRef?.role ?? null;
  const managerEmail = managerRef?.email ?? null;
  // Sin responsable si la intermediaria es el contratante.
  const orderAgencyId = typeof o.agency_company_id === "string" && o.agency_company_id ? o.agency_company_id : null;
  const orderBillingId = typeof o.billing_company_id === "string" && o.billing_company_id ? o.billing_company_id : null;
  const hideManager = !!orderAgencyId && orderAgencyId === orderBillingId;
  const hasSigners = Boolean(
    signerName ||
      signerRole ||
      signerEmail ||
      (!hideManager && (managerName || managerRole || managerEmail)),
  );
  const paymentLink = snapContacts?.payment ?? detail.contacts.payment;
  const paymentLine = paymentLink
    ? [paymentLink.name, paymentLink.email].filter(Boolean).join(" ")
    : null;
  const now = formatDateTime(new Date().toISOString());
  const moneyLabel =
    currency === "PEN"
      ? "Soles"
      : currency === "USD"
        ? "Dólares americanos"
        : currency;

  return (
    <main
      aria-label={`Nota de pedido ${ioNumber}`}
      style={{
        maxWidth: "820px",
        margin: "0 auto",
        padding: "32px 28px",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        color: "#111",
        fontSize: "12.5px",
        lineHeight: 1.5,
        background: "#fff",
      }}
    >
      <div className="print:hidden" style={{ marginBottom: "20px" }}>
        <PrintButton />
      </div>

      <header style={{ marginBottom: "14px" }}>
        <p style={{ fontSize: "11px", color: "#555", margin: 0 }}>
          {storeName} · Orden {ioNumber} · {STATUS_LABEL[status] ?? status}
        </p>
        <h1
          style={{
            fontSize: "20px",
            margin: "4px 0",
            textTransform: "uppercase",
            letterSpacing: "0.02em",
          }}
        >
          Nota de pedido de alquiler y producción de publicidad
        </h1>
        {isDraft && (
          <p style={{ margin: "4px 0 0", fontSize: "12px", fontWeight: 600 }}>
            Borrador previo a la firma — no válido como comprobante.
          </p>
        )}
        <dl style={{ display: "flex", gap: "24px", margin: "8px 0 0" }}>
          <div>
            <dt style={headDt}>Fecha </dt>
            <dd style={{ display: "inline", margin: 0, fontWeight: 600 }}>
              {formatDate(o.created_at)}
            </dd>
          </div>
          <div>
            <dt style={headDt}>Cliente / Marca </dt>
            <dd style={{ display: "inline", margin: 0, fontWeight: 600 }}>
              {brand}
            </dd>
          </div>
        </dl>
      </header>

      <NpSection n="I" title="Acuerdo de servicios de alquiler y producción">
        <NpGrid
          rows={[
            ["Razón social", advertiser],
            ["Marca", brand],
            ["Tipo de moneda", moneyLabel],
            ...(hasSigners
              ? ([
                  ["Firmante", signerName ?? "—"],
                  ["Cargo del firmante", signerRole ?? "—"],
                  ["Correo del firmante", signerEmail ?? "—"],
                  ...(!hideManager
                    ? ([
                        ["Persona responsable", managerName ?? "—"],
                        ["Cargo del responsable", managerRole ?? "—"],
                        ["Correo del responsable", managerEmail ?? "—"],
                      ] as Array<[string, React.ReactNode]>)
                    : []),
                ] as Array<[string, React.ReactNode]>)
              : []),
          ]}
        />
      </NpSection>

      <NpSection n="II" title="Datos del cliente a facturar">
        <NpGrid
          rows={[
            ["Razón social", billing],
            [fiscalLabel, billingTax ?? "—"],
            ["Ciudad", cityLine || "—"],
            ["Dirección", billingAddress ?? "—"],
            ...(hasContact
              ? ([
                  ["Persona de contacto", pocName ?? "—"],
                  ["Teléfono", pocPhone ?? "—"],
                  ["Correo electrónico", pocEmail ?? "—"],
                ] as Array<[string, React.ReactNode]>)
              : []),
          ]}
        />
      </NpSection>

      <NpSection n="III" title="Condiciones de facturación">
        <NpGrid
          rows={[
            [
              "Documento para facturación",
              <>
                {o.doc_orden_medios === true ? <b>(X)</b> : "( )"} Orden
                Medios · {o.doc_orden_compra === true ? <b>(X)</b> : "( )"}{" "}
                Orden de Compra ·{" "}
                {o.doc_contrato === true ? <b>(X)</b> : "( )"} Contrato
              </>,
            ],
            [
              `Valor total del contrato (sin ${taxName})`,
              gross > 0 ? `${money(net, currency)} ${currency}` : "—",
            ],
            ["Condición de pago", terms],
            ["Correo electrónico y/o portal", txt(o.billing_portal_email) ?? "—"],
            ["Contacto de pago", paymentLine ?? "—"],
            ["Detalle de facturación", txt(o.billing_detail) ?? "—"],
            ["Registro de factura", txt(o.invoice_registration) ?? "—"],
          ]}
        />
      </NpSection>

      <NpSection n="IV" title="Intermediario">
        <NpGrid
          rows={[
            [
              "Agencia / central de medios",
              hasIntermediary ? (
                <>
                  <b>(X)</b> Sí · ( ) No
                </>
              ) : (
                <>
                  ( ) Sí · <b>(X)</b> No
                </>
              ),
            ],
            ...(hasIntermediary
              ? ([
                  ["Razón social", toTitleCase(linkedAgencyName)],
                  [taxIdLabel(detail.agency_country ?? billingCountry), linkedAgencyTax ?? "—"],
                ] as Array<[string, React.ReactNode]>)
              : []),
          ]}
        />
      </NpSection>

      <NpSection n="V" title="Tipo de contrato">
        <p style={{ margin: 0 }}>Alquiler de espacio publicitario.</p>
      </NpSection>

      <NpSection
        n="VI"
        title={`Detalle de alquiler de espacios de publicidad (${formatNumber(lines.length)})`}
      >
        {lines.length === 0 ? (
          <p style={{ margin: 0, color: "#555" }}>
            Sin pantallas en esta orden.
          </p>
        ) : (
          <>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "11.5px",
              }}
            >
              <thead>
                <tr>
                  {[
                    "Distrito",
                    "Cod.",
                    "Elemento",
                    "Ubicación",
                    "Fecha inicio",
                    "Fecha fin",
                    "Cant. días",
                    "Slots",
                    "Total",
                  ].map((h, i) => (
                    <th
                      key={h}
                      align={i >= 6 ? "right" : "left"}
                      style={{
                        borderBottom: "1px solid #111",
                        padding: "6px 6px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const fin = displayEndOfSafe(l.ends_at);
                  const dd =
                    typeof l.cant_dias === "number" && l.cant_dias > 0
                      ? l.cant_dias
                      : diffDaysInclusive(
                          typeof l.starts_at === "string"
                            ? l.starts_at
                            : null,
                          fin,
                        );
                  return (
                    <tr key={String(l.id)}>
                      <td style={cell}>{str(l.screen_district)}</td>
                      <td style={cell}>{str(l.screen_code)}</td>
                      <td style={cell}>{str(l.screen_technology)}</td>
                      <td style={cell}>{str(l.screen_venue)}</td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>
                        {formatDate(l.starts_at)}
                      </td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>
                        {fin ? formatDate(fin) : "—"}
                      </td>
                      <td align="right" style={cell}>
                        {dd ?? "—"}
                      </td>
                      <td align="right" style={cell}>
                        {typeof l.cant_slots === "number" && l.cant_slots >= 1 ? l.cant_slots : 1}
                      </td>
                      <td align="right" style={{ ...cell, whiteSpace: "nowrap" }}>
                        {money(l.rate_minor, currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <dl
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "2px",
                alignItems: "flex-end",
                margin: "8px 0 0",
              }}
            >
              <NpTotal
                label={`Total sin ${taxName}`}
                value={`${money(net, currency)} ${currency}`}
              />
              <NpTotal
                label={`${taxName} (${taxPct} %)`}
                value={`${money(igv, currency)} ${currency}`}
              />
              <NpTotal
                label="Total"
                value={`${money(total, currency)} ${currency}`}
                strong
              />
            </dl>
          </>
        )}
      </NpSection>

      <NpSection n="VII" title="Detalle de servicios de producción">
        <p style={{ margin: 0 }}>
          Esta nota no incluye servicios de producción.
        </p>
      </NpSection>

      <NpSection n="VIII" title="Condiciones del servicio">
        <p style={{ margin: 0 }}>
          {txt(o.service_clauses) ??
            `${storeName} podrá reubicar la pauta por fuerza mayor, siempre y cuando el cliente esté conforme con la reubicación. Todo arte pasa por aprobación de ${storeName}.`}
        </p>
      </NpSection>

      <NpSection n="IX" title="Observaciones">
        <p style={{ margin: 0 }}>{notes ?? "Sin observaciones."}</p>
      </NpSection>

      <NpSection n="X" title="Firmas" last>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "32px",
            marginTop: "8px",
          }}
        >
          <div>
            <p style={{ fontWeight: 700, margin: "0 0 44px" }}>Cliente</p>
            <p style={{ margin: 0, color: "#555" }}>
              Firma:{" "}
              <span aria-hidden style={signLine}>
                &nbsp;
              </span>
            </p>
          </div>
          <div>
            <p style={{ fontWeight: 700, margin: "0 0 44px" }}>{storeName}</p>
            <p style={{ margin: 0, color: "#555" }}>
              Firma:{" "}
              <span aria-hidden style={signLine}>
                &nbsp;
              </span>
            </p>
          </div>
        </div>
      </NpSection>

      <footer
        style={{
          borderTop: "1px solid #999",
          marginTop: "16px",
          paddingTop: "8px",
          color: "#555",
          fontSize: "11px",
        }}
      >
        Generado el {now} · Moneda {currency} · Montos sin {taxName} salvo
        indicación.
      </footer>

      <style>{`@media print { .print\\:hidden { display: none !important; } thead { display: table-header-group; } tr { break-inside: avoid; } }`}</style>
    </main>
  );
}

const headDt: React.CSSProperties = {
  display: "inline",
  color: "#555",
  fontSize: "11px",
  textTransform: "uppercase",
};

const cell: React.CSSProperties = {
  borderBottom: "1px solid #ddd",
  padding: "6px",
  verticalAlign: "top",
};

const signLine: React.CSSProperties = {
  display: "inline-block",
  minWidth: "200px",
  borderBottom: "1px solid #111",
};

function NpSection({
  n,
  title,
  last,
  children,
}: {
  n: string;
  title: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={`${n}. ${title}`}
      style={{ marginBottom: last ? 0 : "14px" }}
    >
      <h2
        style={{
          fontSize: "13px",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          borderBottom: "1px solid #111",
          paddingBottom: "3px",
          margin: "0 0 8px",
        }}
      >
        {n}. {title}
      </h2>
      {children}
    </section>
  );
}

function NpGrid({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        gap: "4px 12px",
        margin: 0,
      }}
    >
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt style={{ color: "#555" }}>{k}</dt>
          <dd style={{ margin: 0, fontWeight: 500 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function NpTotal({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: "16px" }}>
      <dt style={{ color: "#555" }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          minWidth: "160px",
          textAlign: "right",
          fontWeight: strong ? 700 : 500,
        }}
      >
        {value}
      </dd>
    </div>
  );
}

function PrintError({ message }: { message: string }) {
  return (
    <main
      style={{
        maxWidth: "640px",
        margin: "48px auto",
        padding: "0 24px",
        fontFamily: "system-ui, sans-serif",
        fontSize: "14px",
      }}
    >
      <p>{message}</p>
    </main>
  );
}
