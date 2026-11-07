-- Auditoría de documentos de la orden: quién adjuntó cada registro.
-- Mismo patrón que io_actor_tracking (20261118): `*_by` guarda el email de la
-- sesión Supabase (legible sin join), null sin sesión resoluble (seed, jobs).
alter table agency_orders
  add column if not exists created_by text;
alter table creatives
  add column if not exists created_by text;
alter table photo_checks
  add column if not exists created_by text;
