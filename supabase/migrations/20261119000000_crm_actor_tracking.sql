-- Auditoría de empresas y contactos: quién crea / edita.
-- Mismo patrón que órdenes (`*_by` = email de sesión, null sin sesión).
alter table companies
  add column if not exists created_by text,
  add column if not exists updated_by text;

alter table contacts
  add column if not exists created_by text,
  add column if not exists updated_by text;
