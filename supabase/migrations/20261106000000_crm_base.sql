-- CRM base: empresas 1-N contactos + roles (cliente/proveedor/...).
-- Una misma empresa puede ser cliente Y proveedor a la vez: el rol vive en
-- `company_roles` (una fila activa por rol), no en un boolean/enum de companies.
-- No toca `customers/orders` (motor de retención intacto).
-- RLS: tenant_isolation por store_id, como el resto de tablas con store_id.

create table companies (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  tax_id text,                       -- ID fiscal según país
  domain text,                       -- lowercase, sin www (para dedupe/enriquecimiento)
  email text,
  phone text,
  address text,
  city text,
  country text,                      -- ISO2
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index companies_store_name_idx on companies (store_id, name);
create unique index companies_store_tax_uidx on companies (store_id, tax_id) where tax_id is not null;
create unique index companies_store_domain_uidx on companies (store_id, domain) where domain is not null;

create table contacts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  company_id uuid references companies (id) on delete set null,
  first_name text,
  last_name text,
  email text,
  phone text,
  job_title text,
  is_primary boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);
create index contacts_store_company_idx on contacts (store_id, company_id);
create index contacts_store_email_idx on contacts (store_id, email) where email is not null;
-- Un solo contacto principal por empresa (los sueltos company_id null no compiten).
create unique index contacts_company_primary_uidx on contacts (company_id) where is_primary and company_id is not null;

-- Roles vigentes: prospect | customer | supplier | partner | competitor.
-- Histórico con valid_from/valid_to; activo = valid_to IS NULL.
create table company_roles (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  company_id uuid not null references companies (id) on delete cascade,
  role text not null check (role in ('prospect', 'customer', 'supplier', 'partner', 'competitor')),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from)
);
create index company_roles_store_role_idx on company_roles (store_id, role) where valid_to is null;
create index company_roles_company_idx on company_roles (company_id) where valid_to is null;
-- Una fila activa por (empresa, rol). El historial se conserva cerrando valid_to.
create unique index company_roles_active_uidx on company_roles (company_id, role) where valid_to is null;

create trigger companies_updated_at
  before update on companies
  for each row execute function set_updated_at();
create trigger contacts_updated_at
  before update on contacts
  for each row execute function set_updated_at();

alter table companies enable row level security;
alter table contacts enable row level security;
alter table company_roles enable row level security;

create policy tenant_isolation on companies
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on contacts
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on company_roles
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
