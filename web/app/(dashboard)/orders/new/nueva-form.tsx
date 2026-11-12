"use client";

import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { SubmitButton } from "@/components/buttons";
import { Checkbox } from "@/components/ui/checkbox";
import { AppSelect } from "@/components/ui/app-select";
import { AppCard } from "@/components/app-card";
import { ComboboxField } from "@/components/combobox-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "cn";
import { addDays, formatDate, formatNumber, parseISODate, toTitleCase } from "@/lib/format";
import { Money } from "@/components/money";
import { normalizeCurrency } from "@/lib/currency";import { createOrderRedirectAction } from "@/lib/order-actions";
import { PantallaDrawer } from "../../screens/pantalla-drawer";
import {
  OrderScreensTable,
  PeriodDatePicker,
  ScreenCalendarDialog,
  ScreenMultiSelect,
  useScreenAvailability,
  type ScreenPick,
} from "../order-screens";
import { plural } from "../order-screens/types";
import type { CrmState } from "@/lib/crm-actions";
import { FIELD_ERR_CLS, toastFormError, useInvalidFields } from "@/components/ui/form-feedback";

const initial: CrmState = { ok: false, message: "" };

type Screen = ScreenPick;

interface CompanyContact {
  id: string;
  company_id: string | null;
  name: string;
  role: string | null;
  email: string | null;
  companyName: string;
}


export function NuevaOrdenForm({
  companies,
  brands,
  screens,
  defaultCurrency = "PEN",
}: {
  companies: Array<{ id: string; name: string; kind: string | null }>;
  brands: string[];
  screens: Screen[];
  defaultCurrency?: string;
}) {
  const [state, action, pending] = useActionState(createOrderRedirectAction, initial);
  const [advertiserId, setAdvertiserId] = useState<string>("");
  const [company, setCompany] = useState<string>("");
  const [brand, setBrand] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [agencyId, setAgencyId] = useState<string>("");
  const [agencySelf, setAgencySelf] = useState<boolean>(true);
  const [pocId, setPocId] = useState<string>("");
  const [signerId, setSignerId] = useState<string>("");
  const [paymentId, setPaymentId] = useState<string>("");
  const [managerId, setManagerId] = useState<string>("");
  const [billingDoc, setBillingDoc] = useState<string>("");
  const [billingDetail, setBillingDetail] = useState<string>("");
  const [invoiceRegistration, setInvoiceRegistration] = useState<string>("");
  const [billingPortal, setBillingPortal] = useState<string>("");
  const [contratanteContacts, setContratanteContacts] = useState<CompanyContact[]>([]);
  const [agencyContacts, setAgencyContacts] = useState<CompanyContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  // Fallo de red/API al traer la ficha: se pinta error, nunca se confunde
  // con "la empresa no tiene contactos" (ese es otro aviso, con enlace).
  const [contactsError, setContactsError] = useState(false);
  // Intermediaria efectiva: el contratante (check) o la agencia definida.
  const agencyRealId = !agencySelf && agencyId !== "" ? agencyId : null;
  const [paymentTerms, setPaymentTerms] = useState<string>("");
  const [currency, setCurrency] = useState<string>(normalizeCurrency(defaultCurrency, "PEN"));
  const [starts, setStarts] = useState<string>("");
  const [ends, setEnds] = useState<string>("");
  const [selected, setSelected] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [calScreenId, setCalScreenId] = useState<string | null>(null);
  const [detailScreenId, setDetailScreenId] = useState<string | null>(null);
  const [availableOnly, setAvailableOnly] = useState(false);
  const { invalid, mark, clear, focusFirst } = useInvalidFields<"company" | "advertiser">();
  const formRef = useRef<HTMLFormElement>(null);

  const {
    dias,
    checking,
    availError,
    occupancy,
    occupiedOf,
    untilOf,
    occupiedCount,
    periodLabel,
    commonWindowFor,
    nextWindowLabelFor,
    ensureOccupancy,
  } = useScreenAvailability({ screens, starts, ends });

  // Agencias del tenant para vincular intermediaria (o texto manual si no existe).
  const agencies = companies.filter((c) => c.kind === "agencia");
  // Bloque 1: anunciantes (Coca-Cola…) + marca libre (Fanta…).
  const advertisers = companies.filter((c) => c.kind === "anunciante");
  // Bloque 2: el contratante es el propio anunciante (directo) o una agencia.
  // Sin anunciante elegido, el picker se deshabilita: primero el bloque 1.
  const self = advertiserId ? companies.find((c) => c.id === advertiserId) : undefined;
  const contratanteOpts =
    self && !agencies.some((c) => c.id === self.id) ? [self, ...agencies] : agencies;
  // Responsable: de la intermediaria (o del contratante si es él).
  const managerOpts = agencySelf ? contratanteContacts : agencyContacts;

  // Contactos por bloque: cada empresa seleccionada trae los suyos
  // (contratante → POC/firmante/pago; intermediaria → responsable).
  useEffect(() => {
    const ids = [company, agencyRealId].filter((x): x is string => !!x);
    if (ids.length === 0) {
      setContratanteContacts([]);
      setAgencyContacts([]);
      return;
    }
    let alive = true;
    setContactsLoading(true);
    setContactsError(false);
    void Promise.all(
      ids.map((id) =>
        fetch(`/api/companies/${id}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
          .then((detail) => ({ id, detail })),
      ),
    )
      .then((pairs) => {
        if (!alive) return;
        const byCompany = new Map<string, CompanyContact[]>();
        let companyFailed = false;
        for (const { id, detail: d } of pairs) {
          if (!d) {
            if (id === company) companyFailed = true;
            continue;
          }
          const co = d.company as Record<string, unknown> | undefined;
          const cid = typeof co?.id === "string" ? co.id : "";
          const cname = toTitleCase(typeof co?.name === "string" && co.name ? co.name : "");
          const opts: CompanyContact[] = [];
          for (const c of ((d.contacts ?? []) as Array<Record<string, unknown>>)) {
            const first = typeof c.first_name === "string" ? c.first_name.trim() : "";
            const last = typeof c.last_name === "string" ? c.last_name.trim() : "";
            const email = typeof c.email === "string" && c.email.trim() ? c.email.trim() : null;
            opts.push({
              id: String(c.id),
              company_id: typeof c.company_id === "string" ? c.company_id : cid || null,
              name: [first, last].filter(Boolean).join(" ") || email || "—",
              role: typeof c.job_title === "string" && c.job_title.trim() ? c.job_title.trim() : null,
              email,
              companyName: cname,
            });
          }
          if (cid) byCompany.set(cid, opts);
        }
        const cc = company ? (byCompany.get(company) ?? []) : [];
        // Check ON (es el contratante): responsable sale del contratante.
        const ac = agencySelf ? cc : agencyRealId ? (byCompany.get(agencyRealId) ?? []) : [];
        setContratanteContacts(cc);
        setContactsError(companyFailed);
        setAgencyContacts(agencySelf ? [] : ac);
        // Limpia selecciones huérfanas al cambiar de empresa.
        const keepIn = (opts: CompanyContact[]) => (prev: string) =>
          prev !== "" && !opts.some((o) => o.id === prev) ? "" : prev;
        setPocId(keepIn(cc));
        setSignerId(keepIn(cc));
        setPaymentId(keepIn(cc));
        setManagerId(keepIn(ac));
      })
      .finally(() => {
        if (alive) setContactsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [company, agencySelf, agencyId]);

  // Error del server: borde + toast + foco (el botón ya se deshabilita con `missing`).
  useEffect(() => {
    if (!state.message || state.ok) return;
    // "El contratante debe ser el propio anunciante…" menciona ambos: manda
    // el contratante (el anunciante va en su propia rama).
    if (/empresa|contratante|compa[ñn][íi]a|company/i.test(state.message)) {
      mark(["company"]);
      focusFirst(formRef, ["company_id"]);
    } else if (/anunciante|advertiser/i.test(state.message)) {
      mark(["advertiser"]);
      focusFirst(formRef, ["advertiser_company_id"]);
    }
    toastFormError("No se pudo crear la orden", state.message);
  }, [state, mark, focusFirst]);

  // Precarga el precio de la BD (price_pen) al elegir pantallas, sin pisar
  // lo que el vendedor ya digitó o editó.
  const priceById = useMemo(() => new Map(screens.map((s) => [s.id, s.price_pen])), [screens]);
  useEffect(() => {
    setPrices((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of selected) {
        if (next[id] !== undefined && String(next[id]).trim() !== "") continue;
        const p = priceById.get(id);
        if (p !== null && p !== undefined && Number.isFinite(Number(p)) && Number(p) > 0) {
          next[id] = String(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selected, priceById]);

  const periodReady = dias !== null;

  const openCalendar = (id: string) => {
    setCalScreenId(id);
    ensureOccupancy(id);
  };

  /** Mueve el periodo a un inicio dado, conservando la duración. */
  const applyWindow = (windowStart: string) => {
    if (dias === null) return;
    setStarts(windowStart);
    setEnds(addDays(windowStart, dias - 1));
  };

  const toggleScreen = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const rows = selected
    .map((id) => screens.find((s) => s.id === id))
    .filter((s): s is Screen => Boolean(s));

  const priceOf = (id: string) => {
    const n = Number(String(prices[id] ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const lineTotalOf = (id: string) => {
    const unit = priceOf(id);
    return unit !== null && dias !== null ? unit * dias : 0;
  };
  const invalidRows = rows.filter((r) => priceOf(r.id) === null);
  const total = rows.reduce((a, r) => a + lineTotalOf(r.id), 0);

  const blockedRows = rows.filter((r) => occupiedOf(r.id).length > 0);

  /** Próximo hueco común a todas las elegidas (misma duración). */
  const commonWindow = commonWindowFor(selected);
  const nextWindowLabel = nextWindowLabelFor(selected);

  const missing: string[] = [];
  if (!advertiserId) missing.push("anunciante");
  if (!company) missing.push("quién firma");
  if (!brand.trim()) missing.push("marca");
  if (!paymentTerms) missing.push("condición de pago");
  if (pocId === "") missing.push("contacto contratante");
  if (signerId === "") missing.push("firmante");
  if (billingDoc === "") missing.push("documento para facturación");
  if (!agencySelf && agencyId === "") missing.push("empresa intermediaria");
  if (dias === null) missing.push("el periodo");
  if (rows.length === 0) missing.push("al menos una pantalla");
  else if (invalidRows.length > 0) missing.push(`precio de ${invalidRows.length} pantalla${plural(invalidRows.length)}`);
  if (blockedRows.length > 0) missing.push(`${blockedRows.length} pantalla${plural(blockedRows.length)} ocupada${plural(blockedRows.length)} en ese periodo`);
  const canSubmit = !pending && !checking && missing.length === 0;

  // Defensa cliente: el botón ya se deshabilita con `missing`, pero un
  // submit directo (Enter) también marca borde + toast + foco.
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (company && advertiserId) return;
    e.preventDefault();
    mark([...(!advertiserId ? ["advertiser" as const] : []), ...(!company ? ["company" as const] : [])]);
    toastFormError(
      "Revisa el campo marcado",
      !advertiserId ? "Elige el anunciante de la orden." : "Elige quién firma la orden.",
    );
    focusFirst(formRef, ["advertiser_company_id", "company_id"]);
  }

  return (
    <>
    <form ref={formRef} action={action} onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <AppCard title="Anunciante">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="form-field">
            Anunciante *
            <input type="hidden" name="advertiser_company_id" value={advertiserId} />
            <Select
              value={advertiserId}
              onValueChange={(v) => {
                if (!v) return;
                setAdvertiserId(v);
                clear("advertiser");
                // Directo por default: si no había contratante o era el
                // anunciante anterior, el contratante sigue al anunciante.
                if (!company || company === advertiserId) setCompany(v);
              }}
              items={Object.fromEntries(advertisers.map((c) => [c.id, toTitleCase(c.name)]))}
              disabled={pending}
            >
              <SelectTrigger aria-label="Anunciante" aria-invalid={invalid.has("advertiser")} data-field="advertiser_company_id" className={cn("w-full", invalid.has("advertiser") && FIELD_ERR_CLS)}>
                <SelectValue placeholder="Coca-Cola…" />
              </SelectTrigger>
              <SelectContent>
                {advertisers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{toTitleCase(c.name)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="form-field">
            Marca *
            <input type="hidden" name="brand" value={brand} />
            <ComboboxField
              items={brands}
              value={brand}
              onChange={setBrand}
              placeholder="Fanta…"
              emptyText="Sin marcas registradas."
              displayItem={toTitleCase}
              ariaLabel="Marca"
              disabled={pending}
            />
          </div>
        </div>
      </AppCard>

      <AppCard title="Contratante">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="form-field">
            Contratante *
            <input type="hidden" name="company_id" value={company} />
            <Select
              value={company}
              onValueChange={(v) => { if (v) { setCompany(v); clear("company"); } }}
              items={Object.fromEntries(contratanteOpts.map((c) => [c.id, toTitleCase(c.name)]))}
              disabled={pending || !advertiserId}
            >
              <SelectTrigger aria-label="Contratante" aria-invalid={invalid.has("company")} data-field="company_id" className={cn("w-full", invalid.has("company") && FIELD_ERR_CLS)}>
                <SelectValue placeholder={advertiserId ? "El anunciante (directo) o una agencia…" : "Elige primero el anunciante…"} />
              </SelectTrigger>
              <SelectContent>
                {contratanteOpts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{toTitleCase(c.name)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="form-field">
            Condición de pago *
              <input type="hidden" name="payment_terms_days" value={paymentTerms} />
              <Select
                value={paymentTerms}
                onValueChange={(v) => setPaymentTerms(v ?? "")}
                items={{ "0": "Contado", "30": "30 días", "60": "60 días", "90": "90 días" }}
                disabled={pending}
              >
                <SelectTrigger aria-label="Condición de pago" className="w-full">
                  <SelectValue placeholder="Elegir condición…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Contado</SelectItem>
                  <SelectItem value="30">30 días</SelectItem>
                  <SelectItem value="60">60 días</SelectItem>
                  <SelectItem value="90">90 días</SelectItem>
                </SelectContent>
              </Select>
          </div>
          <div className="form-field">
            Moneda de la orden *
              <input type="hidden" name="currency" value={currency} />
              <Select
                value={currency}
                onValueChange={(v) => v && setCurrency(String(v).toUpperCase())}
                items={{ PEN: "PEN — Soles", USD: "USD — Dólares" }}
                disabled={pending}
              >
                <SelectTrigger aria-label="Moneda de la orden" className="w-full">
                  <SelectValue placeholder="Moneda…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PEN">PEN — Soles</SelectItem>
                  <SelectItem value="USD">USD — Dólares</SelectItem>
                </SelectContent>
              </Select>
          </div>
          <ContactPicker
            label="Contacto contratante"
            field="billing_contact_id"
            value={pocId}
            onChange={setPocId}
            options={contratanteContacts}
            disabled={pending}
            required
          />
          <ContactPicker
            label="Firmante"
            field="signer_contact_id"
            value={signerId}
            onChange={setSignerId}
            options={contratanteContacts}
            disabled={pending}
            required
          />
          <label className="form-field sm:col-span-2">
            Notas
            <input type="hidden" name="notes" value={notes} />
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              disabled={pending}
              placeholder="Observaciones para la nota de pedido…"
              aria-label="Notas"

            />
          </label>
        </div>
        {contactsLoading ? (
          <p className="mt-2 text-xs text-muted-foreground" role="status">Cargando contactos…</p>
        ) : contactsError ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            No se pudieron cargar los contactos de esta empresa. Vuelve a elegirla o recarga la página.
          </p>
        ) : company && contratanteContacts.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Esta empresa aún no tiene contactos: crea el primero y vuelve a esta orden.{" "}
            <Link href={`/contacts/new?company=${company}`} className="font-medium underline underline-offset-2">
              Crear contacto
            </Link>
          </p>
        ) : null}
      </AppCard>

      <AppCard title="Facturación">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="form-field">
            Documento para facturación *
            <input type="hidden" name="billing_doc" value={billingDoc} />
            <AppSelect
              value={billingDoc}
              onChange={setBillingDoc}
              options={[
                { value: "orden_medios", label: "Orden de Medios" },
                { value: "orden_compra", label: "Orden de Compra" },
                { value: "contrato", label: "Contrato" },
              ]}
              placeholder="Elegir documento…"
              ariaLabel="Documento para facturación"
              disabled={pending}
              allowClear={false}
            />
          </div>
          <label className="form-field sm:col-span-2">
            Indicaciones para facturación
            <input type="hidden" name="billing_detail" value={billingDetail} />
            <Input
              value={billingDetail}
              onChange={(e) => setBillingDetail(e.target.value)}
              maxLength={500}
              disabled={pending}
              placeholder="HES, una factura por OC…"
              aria-label="Indicaciones para facturación"

            />
          </label>
          <label className="form-field sm:col-span-2">
            Observaciones para registro de factura
            <input type="hidden" name="invoice_registration" value={invoiceRegistration} />
            <Input
              value={invoiceRegistration}
              onChange={(e) => setInvoiceRegistration(e.target.value)}
              maxLength={500}
              disabled={pending}
              placeholder="Envíe su factura a más tardar el día 3…"
              aria-label="Observaciones para registro de factura"

            />
          </label>
          <ContactPicker
            label="Contacto de pago"
            field="payment_contact_id"
            value={paymentId}
            onChange={setPaymentId}
            options={contratanteContacts}
            disabled={pending}
          />
          <label className="form-field sm:col-span-2">
            Correo electrónico y/o portal
            <input type="hidden" name="billing_portal_email" value={billingPortal} />
            <Input
              value={billingPortal}
              onChange={(e) => setBillingPortal(e.target.value)}
              maxLength={320}
              disabled={pending}
              placeholder="Empresa | correo…"
              aria-label="Correo electrónico y/o portal"

            />
          </label>
        </div>
      </AppCard>

      <AppCard title="Intermediario">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <label className="flex cursor-pointer flex-row items-center gap-2 text-sm">
            <Checkbox
              checked={agencySelf}
              onCheckedChange={(v) => {
                const on = v === true;
                setAgencySelf(on);
                if (on) {
                  setAgencyId("");
                  setManagerId("");
                }
              }}
              disabled={pending}
              aria-label="Es contratante"
            />
            Es contratante
            <input type="hidden" name="agency_is_self" value={agencySelf ? "1" : ""} />
          </label>
          {!agencySelf && (
            <div className="form-field w-full flex-1 sm:min-w-[220px]">
              Empresa intermediaria *
              <input type="hidden" name="agency_company_id" value={agencyId === "" ? "" : agencyId} />
              <AppSelect
                value={agencyId}
                onChange={setAgencyId}
                options={agencies.map((c) => ({ value: c.id, label: toTitleCase(c.name) }))}
                placeholder="Elegir agencia…"
                ariaLabel="Agencia intermediaria"
                disabled={pending}
                allowClear={false}
              />
            </div>
          )}
          {!agencySelf && (
            <div className="min-w-[220px] flex-1">
              <ContactPicker
                label="Persona responsable"
                field="manager_contact_id"
                value={managerId}
                onChange={setManagerId}
                options={managerOpts}
                disabled={pending}
              />
            </div>
          )}
        </div>
      </AppCard>

      <AppCard title="Periodo">
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-[1fr_1fr_0.5fr]">
            <PeriodDatePicker
              label="Inicio *"
              pickerLabel="Inicio del periodo"
              value={starts}
              disabled={pending}
              disabledDays={ends ? (d) => d > (parseISODate(ends) ?? d) : undefined}
              onChange={setStarts}
            />
            <PeriodDatePicker
              label="Fin *"
              pickerLabel="Fin del periodo"
              value={ends}
              disabled={pending}
              disabledDays={starts ? (d) => d < (parseISODate(starts) ?? d) : undefined}
              onChange={setEnds}
            />
            <div className="form-field col-span-2 sm:col-span-1">
              Días
              <output
                aria-label="Días del periodo"
                aria-live="polite"
                className="flex h-9 items-center rounded-lg border border-border bg-muted/40 px-2.5 text-sm text-muted-foreground tabular-nums"
              >
                {dias ?? "—"}
              </output>
            </div>
          </div>
        </div>
      </AppCard>

      <AppCard title={`Pantallas *${rows.length > 0 ? ` (${formatNumber(rows.length)})` : ""}`}>
        <div className="flex flex-col gap-4">
          {screens.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Sin pantallas activas. Registra pantallas en Inventario antes de crear la orden.
            </p>
          ) : (
            <ScreenMultiSelect
              screens={screens}
              selected={selected}
              onToggle={toggleScreen}
              onSetAll={setSelected}
              onClear={() => setSelected([])}
              occupiedOf={occupiedOf}
              untilOf={untilOf}
              onShowCalendar={openCalendar}
              availableOnly={availableOnly}
              onToggleAvailableOnly={() => setAvailableOnly((v) => !v)}
              periodReady={periodReady}
              occupiedCount={occupiedCount}
              periodLabel={periodLabel}
              nextWindowLabel={nextWindowLabel}
              onApplyWindow={commonWindow ? () => applyWindow(commonWindow) : null}
              availError={availError}
              isChecking={checking}
              disabled={pending}
            />
          )}
          {checking && (
            <p className="text-xs text-muted-foreground" role="status">Verificando disponibilidad…</p>
          )}
          {rows.length > 0 && (
            <>
              {rows.map((s) => (
                <span key={s.id} hidden aria-hidden>
                  <input type="hidden" name="screen_id" value={s.id} />
                  <input type="hidden" name="line_starts_at" value={starts} />
                  <input type="hidden" name="line_ends_at" value={ends} />
                  <input type="hidden" name="line_cant_dias" value={dias ?? ""} />
                  <input type="hidden" name="line_total" value={dias !== null && priceOf(s.id) !== null ? String((priceOf(s.id) as number) * (dias as number)) : ""} />
                </span>
              ))}
              <OrderScreensTable
                rows={rows}
                prices={prices}
                dias={dias}
                currency={currency}
                occupiedOf={occupiedOf}
                checking={checking}
                commonWindow={commonWindow}
                onApplyWindow={commonWindow ? () => applyWindow(commonWindow) : null}
                onPriceChange={(id, v) => setPrices((p) => ({ ...p, [id]: v }))}
                onRemove={toggleScreen}
                onCalendar={openCalendar}
                onDetail={setDetailScreenId}
                disabled={pending}
                pending={pending}
              />
            </>
          )}
        </div>
      </AppCard>

      <div className="flex flex-col gap-1.5">
        <div>
          <SubmitButton pending={pending} disabled={!canSubmit} title={!canSubmit ? `Falta: ${missing.join(", ")}` : undefined} pendingLabel="Creando…">
            <Plus aria-hidden />
            <>Crear orden{total > 0 ? <> · <Money amountMinor={Math.round(total * 100)} currency={currency} /></> : null}</>
          </SubmitButton>
        </div>
        {!canSubmit && !pending && (
          <p className="text-xs text-muted-foreground">Falta: {missing.join(", ")}.</p>
        )}
      </div>

      <ScreenCalendarDialog
        screen={screens.find((s) => s.id === calScreenId) ?? null}
        ranges={calScreenId ? occupancy[calScreenId] : undefined}
        loaded={calScreenId ? calScreenId in occupancy : false}
        duration={dias ?? 0}
        periodStarts={starts}
        periodEnds={ends}
        onApply={(w) => {
          applyWindow(w);
          setCalScreenId(null);
        }}
        onClose={() => setCalScreenId(null)}
      />
      {detailScreenId && (
        <PantallaDrawer screenId={detailScreenId} onClose={() => setDetailScreenId(null)} />
      )}
    </form>
    </>
  );
}

function ContactPicker({
  label,
  field,
  value,
  onChange,
  options,
  disabled,
  required,
}: {
  label: string;
  field: string;
  value: string;
  onChange: (v: string) => void;
  options: CompanyContact[];
  disabled?: boolean;
  required?: boolean;
}) {
  const optionLabel = (c: CompanyContact) => (c.email ? `${c.name} (${c.email})` : c.name);
  return (
    <div className="form-field">
      {label}{required ? " *" : ""}
      <input type="hidden" name={field} value={value} />
      <AppSelect
        value={value}
        onChange={onChange}
        options={options.map((c) => ({ value: c.id, label: optionLabel(c) }))}
        placeholder="Sin definir…"
        ariaLabel={label}
        disabled={disabled}
      />
    </div>
  );
}
