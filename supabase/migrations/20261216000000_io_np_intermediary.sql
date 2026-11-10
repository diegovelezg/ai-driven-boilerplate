-- Sección IV de la Nota de Pedido: agencia intermediaria que no factura
-- (p. ej. factura el anunciante directo pero intermedia una central).
-- Texto libre nullable sin backfill: si hay razón social, el PDF marca SÍ.
alter table io_orders
  add column if not exists intermediary_name text,
  add column if not exists intermediary_tax_id text;
