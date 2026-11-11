-- Vínculo explícito agencia ↔ anunciante (pre-OI).
-- Ex-post la red se derivaba solo de io_orders (advertiser/billing/agency);
-- eso impedía registrar la relación comercial antes de la primera orden.
-- Tabla puente explícita + backfill desde OIs existentes (origin='oi').
-- Solo ADD (sin DROP): no aplica la política de DROP seguro.

create table if not exists crm_company_links (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references sys_stores (id) on delete cascade,
  agency_company_id uuid not null references crm_companies (id) on delete cascade,
  advertiser_company_id uuid not null references crm_companies (id) on delete cascade,
  origin text not null default 'manual' check (origin in ('manual', 'oi')),
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (agency_company_id <> advertiser_company_id)
);

create unique index if not exists crm_company_links_store_pair_uidx
  on crm_company_links (store_id, agency_company_id, advertiser_company_id);
create index if not exists crm_company_links_store_agency_idx
  on crm_company_links (store_id, agency_company_id);
create index if not exists crm_company_links_store_advertiser_idx
  on crm_company_links (store_id, advertiser_company_id);

-- Requisito para FKs compuestas futuras (convención 20261213).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crm_company_links_store_uq') then
    alter table crm_company_links add constraint crm_company_links_store_uq unique (store_id, id);
  end if;
end $$;

-- Same-store compuesto (convención 20261213): imposible colgar un vínculo
-- a empresas de otro tenant. Check-only; el borrado lo gobierna CASCADE.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crm_company_links_agency_same_store_fk') then
    alter table crm_company_links add constraint crm_company_links_agency_same_store_fk
      foreign key (store_id, agency_company_id) references crm_companies (store_id, id)
      on update cascade on delete no action;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crm_company_links_advertiser_same_store_fk') then
    alter table crm_company_links add constraint crm_company_links_advertiser_same_store_fk
      foreign key (store_id, advertiser_company_id) references crm_companies (store_id, id)
      on update cascade on delete no action;
  end if;
end $$;

drop trigger if exists crm_company_links_updated_at on crm_company_links;
create trigger crm_company_links_updated_at
  before update on crm_company_links
  for each row execute function sys_set_updated_at();

alter table crm_company_links enable row level security;

drop policy if exists tenant_isolation on crm_company_links;
create policy tenant_isolation on crm_company_links
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));

-- Backfill idempotente desde OIs existentes (origin='oi').
-- Fuente 1 (flujo nuevo): intermediaria vinculada distinta del contratante.
--   anunciante+intermediaria → (agency, advertiser=coalesce(advertiser,billing)).
--   agencia que factura marca (advertiser null) o directa (agency=billing) se excluyen solas.
-- Fuente 2 (histórico pre-agency_company_id): advertiser <> billing → (billing como agencia, advertiser).
insert into crm_company_links (store_id, agency_company_id, advertiser_company_id, origin)
select distinct
  o.store_id,
  o.agency_company_id,
  coalesce(o.advertiser_company_id, o.billing_company_id),
  'oi'
from io_orders o
where o.agency_company_id is not null
  and o.billing_company_id is not null
  and o.agency_company_id <> o.billing_company_id
  and coalesce(o.advertiser_company_id, o.billing_company_id) is not null
  and o.agency_company_id <> coalesce(o.advertiser_company_id, o.billing_company_id)
on conflict (store_id, agency_company_id, advertiser_company_id) do nothing;

insert into crm_company_links (store_id, agency_company_id, advertiser_company_id, origin)
select distinct
  o.store_id,
  o.billing_company_id,
  o.advertiser_company_id,
  'oi'
from io_orders o
where o.advertiser_company_id is not null
  and o.billing_company_id is not null
  and o.advertiser_company_id <> o.billing_company_id
on conflict (store_id, agency_company_id, advertiser_company_id) do nothing;
