-- Sección III de la Nota de Pedido (condiciones de facturación).
-- Documentos como booleanos (checkboxes que marca el vendedor); el resto
-- texto libre nullable sin backfill: lo ausente se muestra "—" en el PDF.
alter table io_orders
  add column if not exists doc_orden_medios boolean,
  add column if not exists doc_orden_compra boolean,
  add column if not exists doc_contrato boolean,
  add column if not exists billing_portal_email text,
  add column if not exists payment_contact text,
  add column if not exists billing_detail text,
  add column if not exists invoice_registration text;

alter table io_orders alter column doc_orden_medios set default false;
alter table io_orders alter column doc_orden_compra set default false;
alter table io_orders alter column doc_contrato set default false;

update io_orders set doc_orden_medios = false where doc_orden_medios is null;
update io_orders set doc_orden_compra = false where doc_orden_compra is null;
update io_orders set doc_contrato = false where doc_contrato is null;
