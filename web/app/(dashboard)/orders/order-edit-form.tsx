"use client";

import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

import { useEffect, useRef, useState, useTransition } from "react";
import { Save } from "lucide-react";
import { CancelButton, RetryButton, SubmitButton } from "@/components/buttons";
import { updateOrderAction } from "@/lib/order-actions";
import { AppCard, AppCardState } from "@/components/app-card";
import { Checkbox } from "@/components/ui/checkbox";
import { AppSelect } from "@/components/ui/app-select";
import {
  fieldsFromMessage,
  ORDER_TERMS_OPTIONS,
  validateOrderFields,
  type OrderFieldKey,
  type OrderFieldValues,
} from "./order-validation";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";

type NpTextKey = Exclude<OrderFieldKey, "brand" | "terms" | "notes" | "doc_orden_medios" | "doc_orden_compra" | "doc_contrato" | "agency_company_id" | "commission_pct" | "billing_contact_id" | "signer_contact_id" | "payment_contact_id" | "manager_contact_id">;

const NP_LIMITS: Record<NpTextKey, number> = {
  billing_portal_email: 320,
  billing_detail: 500,
  invoice_registration: 500,
};

const NP_TEXT_KEYS = Object.keys(NP_LIMITS) as NpTextKey[];

/** Meta para el editor: agencias del tenant + contactos del caso.
 *  El drawer abre SIN estos datos (perf 2026-11-09); se piden al montar. */
type OrderMeta = {
  agencies: Array<{ id: string; name: string; commission_pct: number | null }>;
  order_contacts: Array<{ id: string; company_name: string | null; name: string; role: string | null; email: string | null }>;
};

/** Edición inline de la ficha (drawer): marca, pago, notas + datos NP
 *  (dirección, contacto y firma para la nota de pedido). Solo seller+
 *  (el padre hace gating). Todo lo NP es opcional. */
export function OrderEditForm({
  orderId,
  initial,
  canEditCommission = false,
  onSaved,
  onCancel,
}: {
  orderId: string;
  initial: {
    brand: string;
    payment_terms_days: string;
    notes: string;
    doc_orden_medios: boolean;
    doc_orden_compra: boolean;
    doc_contrato: boolean;
    billing_company_id: string;
    agency_company_id: string;
    commission_pct: string;
    billing_contact_id: string;
    signer_contact_id: string;
    payment_contact_id: string;
    manager_contact_id: string;
  } & Record<NpTextKey, string>;
  /** Override de comisión por orden: solo admin (como el default por empresa). */
  canEditCommission?: boolean;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  // Agencias + contactos diferidos: el drawer abre sin ellos; el editor
  // los pide al montar (perf 2026-11-09).
  const [meta, setMeta] = useState<OrderMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaNonce, setMetaNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/orders/${orderId}/meta`, { cache: "no-store", signal: ac.signal });
        if (!res.ok) throw new Error("No se pudieron cargar agencias y contactos.");
        if (alive) setMeta((await res.json()) as OrderMeta);
      } catch (e) {
        if (!ac.signal.aborted && alive) setMetaError(e instanceof Error ? e.message : "No se pudieron cargar los datos.");
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [orderId, metaNonce ]);
  const agencies = meta?.agencies ?? [];
  const orderContacts = meta?.order_contacts ?? [];
  const [brand, setBrand] = useState(initial.brand);
  const [terms, setTerms] = useState(initial.payment_terms_days);
  const [notes, setNotes] = useState(initial.notes);
  const [np, setNp] = useState<Record<NpTextKey, string>>(() =>
    Object.fromEntries(NP_TEXT_KEYS.map((k) => [k, initial[k]])) as Record<NpTextKey, string>,
  );
  // Documento único como en nueva orden. Combo heredado (p. ej. OM+OC):
  // se muestra el primero y NO se reescribe salvo cambio explícito.
  const initialDoc = initial.doc_orden_medios
    ? "orden_medios"
    : initial.doc_orden_compra
      ? "orden_compra"
      : initial.doc_contrato
        ? "contrato"
        : "";
  const [doc, setDoc] = useState(initialDoc);
  const [docTouched, setDocTouched] = useState(false);
  const [agencyId, setAgencyId] = useState(initial.agency_company_id);
  // Check "es el contratante" (default): sin vínculo previo se asume el contratante.
  const [agencySelf, setAgencySelf] = useState(
    initial.agency_company_id === "" || initial.agency_company_id === initial.billing_company_id,
  );
  const [commission, setCommission] = useState(initial.commission_pct);
  // % configurado de la intermediaria definida (solo informativo cuando el
  // input está vacío: hereda; al escribir se vuelve override explícito).
  const agencyDefaultPct =
    !agencySelf && agencyId !== ""
      ? (agencies.find((a) => a.id === agencyId)?.commission_pct ?? null)
      : null;
  const commissionDisplay =
    commission !== "" ? commission : agencyDefaultPct !== null ? String(agencyDefaultPct) : "";
  const [billingContact, setBillingContact] = useState(initial.billing_contact_id);
  const [signerContact, setSignerContact] = useState(initial.signer_contact_id);
  const [paymentContact, setPaymentContact] = useState(initial.payment_contact_id);
  const [managerContact, setManagerContact] = useState(initial.manager_contact_id);
  const [pending, startTransition] = useTransition();
  const { invalid, mark, clear, bad, focusFirst } = useInvalidFields<OrderFieldKey>();
  const formRef = useRef<HTMLFormElement>(null);

  function set(key: NpTextKey, value: string) {
    setNp((prev) => ({ ...prev, [key]: value }));
    clear(key);
  }

  function save() {
    if (!agencySelf && agencyId === "") {
      mark(["agency_company_id"]);
      toastFormError("Revisa el campo marcado", "Define la intermediaria o marca que es el contratante.");
      focusFirst(formRef, ["agency_company_id"]);
      return;
    }
    const resolvedAgency = agencySelf ? initial.billing_company_id : agencyId;
    const values: OrderFieldValues = {
      brand,
      terms,
      notes,
      ...np,
      doc_orden_medios: docTouched ? doc === "orden_medios" : initial.doc_orden_medios,
      doc_orden_compra: docTouched ? doc === "orden_compra" : initial.doc_orden_compra,
      doc_contrato: docTouched ? doc === "contrato" : initial.doc_contrato,
      agency_company_id: resolvedAgency,
      commission_pct: commission,
      billing_contact_id: billingContact,
      signer_contact_id: signerContact,
      payment_contact_id: paymentContact,
      manager_contact_id: managerContact,
    };
    const problems = validateOrderFields(values);
    if (problems.length > 0) {
      const keys = [...new Set(problems.map((p) => p.key))];
      mark(keys);
      toastFormError("Revisa los campos marcados", problems.map((p) => p.message).join(" "));
      focusFirst(formRef, keys);
      return;
    }
    startTransition(async () => {
      const res = await updateOrderAction({
        orderId,
        patch: {
          brand: brand.trim() || null,
          payment_terms_days: terms === "" ? null : terms,
          notes: notes.trim() || null,
          ...(docTouched
            ? {
                doc_orden_medios: doc === "orden_medios",
                doc_orden_compra: doc === "orden_compra",
                doc_contrato: doc === "contrato",
              }
            : {}),
          billing_portal_email: np.billing_portal_email.trim() || null,
          billing_detail: np.billing_detail.trim() || null,
          invoice_registration: np.invoice_registration.trim() || null,
          agency_company_id: resolvedAgency === "" ? null : resolvedAgency,
          // Override solo admin y solo con intermediaria definida: el resto
          // de roles ni lo envía (el servidor lo exige igual por defensa
          // en profundidad).
          ...(canEditCommission && !agencySelf
            ? { commission_pct: commission.trim() === "" ? null : commission.trim() }
            : {}),
          billing_contact_id: billingContact === "" ? null : billingContact,
          signer_contact_id: signerContact === "" ? null : signerContact,
          payment_contact_id: paymentContact === "" ? null : paymentContact,
          // Sin responsable si la intermediaria es el contratante.
          manager_contact_id: agencySelf ? null : managerContact === "" ? null : managerContact,
        },
      });
      if (!res.ok) {
        const keys = fieldsFromMessage(res.message);
        if (keys.length > 0) {
          mark(keys);
          focusFirst(formRef, keys);
        }
        toastFormError("No se pudo guardar la orden", res.message);
        return;
      }
      onSaved?.();
    });
  }

  const contactLabel = (c: { name: string; email: string | null }) =>
    c.email ? `${c.name} (${c.email})` : c.name;

  const contactOptions = (value: string, missingLabel: string) => [
    ...orderContacts.map((c) => ({ value: c.id, label: contactLabel(c) })),
    ...(!orderContacts.some((c) => c.id === value) && value !== ""
      ? [{ value, label: missingLabel }]
      : []),
  ];

  const contactSelect = (
    key: "billing_contact_id" | "signer_contact_id" | "payment_contact_id" | "manager_contact_id",
    label: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div key={key} className="form-field">
      {label}
      <AppSelect
        value={value}
        onChange={(v) => { onChange(v); clear(key); }}
        options={contactOptions(value, "Contacto eliminado")}
        placeholder="Sin definir…"
        ariaLabel={label}
        name={key}
        disabled={pending}
        invalid={invalid.has(key)}
      />
    </div>
  );

  const field = (
    key: NpTextKey,
    label: string,
    opts?: { type?: string; inputMode?: "email" | "tel" | "text"; span?: boolean },
  ) => (
    <label key={key} className={`form-field${opts?.span ? " sm:col-span-2" : ""}`}>
      {label}
      <Input
        name={key}
        type={opts?.type ?? "text"}
        inputMode={opts?.inputMode}
        value={np[key]}
        onChange={(e) => set(key, e.target.value)}
        maxLength={NP_LIMITS[key]}
        disabled={pending}
        aria-invalid={invalid.has(key)}
        className={`${bad(key)}`}
      />
    </label>
  );

  if (!meta && !metaError) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando formulario">
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="flex flex-col gap-4">
        <AppCardState>{metaError ?? "No se pudieron cargar los datos."}</AppCardState>
        <div className="flex flex-wrap gap-2">
          <RetryButton
            onRetry={() => {
              setMetaError(null);
              setMetaNonce((n) => n + 1);
            }}
          />
          <CancelButton onCancel={() => onCancel?.()} />
        </div>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <AppCard title="Contratante">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="form-field">
          Marca
          <Input
            name="brand"
            value={brand}
            onChange={(e) => { setBrand(e.target.value); clear("brand"); }}
            maxLength={200}
            disabled={pending}
            aria-invalid={invalid.has("brand")}
            className={`${bad("brand")}`}
          />
        </label>
        <div className="form-field">
          Condición de pago
          <AppSelect
            value={terms}
            onChange={(v) => { setTerms(v); clear("terms"); }}
            options={[
              ...ORDER_TERMS_OPTIONS.map((t) => ({ value: t, label: t === "0" ? "Contado" : `${t} días` })),
              ...(![...ORDER_TERMS_OPTIONS, ""].includes(terms)
                ? [{ value: terms, label: /^\d+$/.test(terms) ? `${terms} días` : terms }]
                : []),
            ]}
            placeholder="Elegir condición…"
            ariaLabel="Condición de pago"
            name="terms"
            disabled={pending}
            invalid={invalid.has("terms")}
          />
        </div>
        <label className="form-field sm:col-span-2">
          Notas
          <Textarea
            name="notes"
            value={notes}
            onChange={(e) => { setNotes(e.target.value); clear("notes"); }}
            maxLength={2000}
            disabled={pending}
            aria-invalid={invalid.has("notes")}
            className={`${bad("notes")}`}
          />
        </label>
        {contactSelect("billing_contact_id", "Contacto contratante", billingContact, setBillingContact)}
        {contactSelect("signer_contact_id", "Firmante", signerContact, setSignerContact)}
      </div>
      </AppCard>

      <AppCard title="Facturación">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="form-field">
          Documento para facturación
          <AppSelect
            value={doc}
            onChange={(v) => { setDoc(v); setDocTouched(true); }}
            options={[
              { value: "orden_medios", label: "Orden de Medios" },
              { value: "orden_compra", label: "Orden de Compra" },
              { value: "contrato", label: "Contrato" },
            ]}
            placeholder="Elegir documento…"
            ariaLabel="Documento para facturación"
            disabled={pending}
          />
        </div>
        {field("billing_detail", "Indicaciones para facturación", { span: true })}
        {field("invoice_registration", "Observaciones para registro de factura", { span: true })}
        {contactSelect("payment_contact_id", "Contacto de pago", paymentContact, setPaymentContact)}
        {field("billing_portal_email", "Correo electrónico y/o portal")}
        {orderContacts.length === 0 && (
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Sin contactos en las empresas del caso. Créalos en Empresas → Contactos.
          </p>
        )}
      </div>
      </AppCard>

      <AppCard title="Intermediario">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex cursor-pointer flex-row items-center gap-2 text-sm sm:col-span-2">
          <Checkbox
            checked={agencySelf}
            onCheckedChange={(v) => {
              const on = v === true;
              setAgencySelf(on);
              if (on) {
                setAgencyId("");
                setManagerContact("");
                setCommission("");
              }
              clear("agency_company_id");
            }}
            disabled={pending}
            aria-label="Es contratante"
          />
          Es contratante
        </label>
        {!agencySelf && (
          <div className="form-field sm:col-span-2">
            Empresa intermediaria *
            <AppSelect
              value={agencyId}
              onChange={(v) => { setAgencyId(v); setCommission(""); clear("agency_company_id"); }}
              options={[
                ...agencies.map((a) => ({
                  value: a.id,
                  label: `${a.name}${a.commission_pct !== null ? ` · ${a.commission_pct}%` : ""}`,
                })),
                ...(!agencies.some((a) => a.id === agencyId) && agencyId !== ""
                  ? [{ value: agencyId, label: "Agencia eliminada" }]
                  : []),
              ]}
              placeholder="Elegir agencia…"
              ariaLabel="Agencia intermediaria"
              name="agency_company_id"
              disabled={pending}
              invalid={invalid.has("agency_company_id")}
              allowClear={false}
            />
          </div>
        )}
        {!agencySelf && canEditCommission && (
        <label className="form-field">
          Comisión override %
          <span className="flex items-center gap-1">
            <Input
              name="commission_pct"
              value={commissionDisplay}
              onChange={(e) => { setCommission(e.target.value.replace(/[^0-9]/g, "").slice(0, 3)); clear("commission_pct"); }}
              maxLength={3}
              disabled={pending}
              inputMode="numeric"
              placeholder="Vacío = hereda"
              aria-label="Comisión de la orden en porcentaje"
              aria-invalid={invalid.has("commission_pct")}
              className={` w-28 text-center tabular-nums${bad("commission_pct")}`}
            />
            <span className="text-muted-foreground">%</span>
          </span>
        </label>
        )}
        {!agencySelf && contactSelect("manager_contact_id", "Persona responsable", managerContact, setManagerContact)}
      </div>
      </AppCard>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pending={pending}><Save aria-hidden />Guardar</SubmitButton>
        <CancelButton onCancel={onCancel} disabled={pending} />
      </div>
    </form>
  );
}
