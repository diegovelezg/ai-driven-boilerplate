-- Auditoría de órdenes: quién crea / edita / cambia estado.
-- Sigue el patrón `approved_by/at`, `closed_by` (issues #19, tracking 20261103):
-- `*_by` guarda el email de la sesión Supabase (legible sin join), null cuando
-- no hay sesión resoluble (seed con service_role, jobs). Nunca un valor inventado.
alter table insertion_orders
  add column if not exists created_by text,
  add column if not exists updated_by text;
