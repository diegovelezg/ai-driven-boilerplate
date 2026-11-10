-- Datos de contacto y firma para la Nota de Pedido (ficha de la orden).
-- Todo nullable y sin backfill: la ficha los pide al preparar el borrador
-- para firma; lo ausente se muestra "—" en el PDF, nunca se inventa.
alter table io_orders
  add column if not exists billing_address text,
  add column if not exists contact_name text,
  add column if not exists contact_phone text,
  add column if not exists contact_email text,
  add column if not exists signer_name text,
  add column if not exists signer_role text,
  add column if not exists signer_email text,
  add column if not exists manager_name text,
  add column if not exists manager_role text,
  add column if not exists manager_email text;
