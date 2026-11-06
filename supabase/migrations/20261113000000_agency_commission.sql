-- Comisión de agencia: acuerdo a nivel empresa + override a nivel IO.
-- Modelo acordado:
--   companies.agency_commission_pct = % por defecto cuando esa empresa actúa
--     como billing_company (agencia). NULL = sin acuerdo = 0.
--   insertion_orders.commission_pct = override por contrato. NULL = heredar
--     de billing_company.
-- Cálculo: % sobre tarifa bruta (suma insertion_order_lines.rate_minor).
--   commission = round(bruto * pct / 100); neto = bruto - commission.
-- Facturación: neto a la agencia (agency_orders/invoices por el neto).

alter table companies add column if not exists agency_commission_pct numeric(5,2)
  check (agency_commission_pct is null or (agency_commission_pct >= 0 and agency_commission_pct <= 100));

alter table insertion_orders add column if not exists commission_pct numeric(5,2)
  check (commission_pct is null or (commission_pct >= 0 and commission_pct <= 100));

comment on column companies.agency_commission_pct is 'Acuerdo por defecto cuando actúa como agencia (billing). NULL=0.';
comment on column insertion_orders.commission_pct is 'Override por IO. NULL=heredar de billing_company.';
