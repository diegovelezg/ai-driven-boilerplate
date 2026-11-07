-- Condición de pago como días (entero) para poder calcular vencimientos.
-- Estándar: 0 = Contado, N = crédito a N días (net-N). El texto libre anterior
-- ("Crédito a 30 días", "60 días") no era computable: el texto es solo display.
-- La columna `payment_terms` (text) queda como historia legacy, sin lecturas.
alter table insertion_orders
  add column if not exists payment_terms_days int
  check (payment_terms_days is null or payment_terms_days >= 0);

-- Backfill desde el texto legacy: "contado" → 0, primer número → N días.
update insertion_orders
set payment_terms_days = case
  when payment_terms ilike '%contado%' then 0
  when substring(payment_terms from '\d+') is not null then (substring(payment_terms from '\d+'))::int
  else null
end
where payment_terms_days is null and payment_terms is not null;
