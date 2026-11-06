-- CRM prolijo: idempotencia real + puentes que faltaban. No toca motor (customers/orders intactos).
-- 1) companies.external_ref (el import Sheet/CSV ya lo promete en template pero se descartaba).
-- 2) Dedupe de contactos por empresa (email/phone) a nivel BD.
-- 3) campaigns.primary_contact_id -> contacts (quién firmó / a quién contactar).
-- 4) customers.company_id -> companies (puente legacy ecommerce <-> CRM, nullable, SET NULL).

-- 1) external_ref en empresas (idempotencia Sheet/CSV).
alter table companies add column if not exists external_ref text;
create unique index if not exists companies_store_ref_uidx
  on companies (store_id, external_ref) where external_ref is not null;

-- 2) Un contacto no se duplica dentro de su empresa por email ni por teléfono.
--    Expression index para email case-insensitive; phone exacto (ya viene trimmed).
create unique index if not exists contacts_company_email_uidx
  on contacts (company_id, lower(email)) where company_id is not null and email is not null;
create unique index if not exists contacts_company_phone_uidx
  on contacts (company_id, phone) where company_id is not null and phone is not null;
-- Contactos sueltos (sin empresa): evita duplicados por email dentro del tenant.
create unique index if not exists contacts_store_email_uidx
  on contacts (store_id, lower(email)) where company_id is null and email is not null;

-- 3) Campaña -> contacto principal (nullable, SET NULL al borrar el contacto).
alter table campaigns add column if not exists primary_contact_id uuid references contacts (id) on delete set null;
create index if not exists campaigns_store_contact_idx on campaigns (store_id, primary_contact_id)
  where primary_contact_id is not null;

-- 4) Puente customers (legacy ecommerce) -> companies (CRM). Nullable, best-effort.
alter table customers add column if not exists company_id uuid references companies (id) on delete set null;
create index if not exists customers_store_company_idx on customers (store_id, company_id)
  where company_id is not null;

-- Backfill best-effort en la misma migración: casa por nombre normalizado (lower+trim+colapsa espacios).
-- Solo donde customers.company_id is null y existe una única empresa candidata en el tenant.
-- Si hay varias (duplicados legacy por nombre), no toca nada: lo resuelve el backfill manual.
update customers c
set company_id = sub.id
from (
  select distinct on (c2.id)
    c2.id as customer_id, co.id as id
  from customers c2
  join companies co
    on co.store_id = c2.store_id
    and lower(co.name) = lower(btrim(regexp_replace(coalesce(c2.company_name, ''), '\s+', ' ', 'g')))
  where c2.company_id is null
    and nullif(btrim(regexp_replace(coalesce(c2.company_name, ''), '\s+', ' ', 'g')), '') is not null
  order by c2.id, co.created_at
) sub
where c.id = sub.customer_id;
