-- Cuentas que atiende un contacto de agencia (contacto → anunciante).
-- Una agencia atiende 1+ anunciantes y cada ejecutivo puede llevar solo una
-- parte de la cartera: el contacto cuelga de la agencia (crm_contacts.company_id)
-- y esta tabla declara a qué anunciantes atiende.
-- Regla de negocio (se valida en el action, no en DDL de kinds):
--   1) el contacto pertenece a una empresa kind='agencia';
--   2) el destino es kind='anunciante';
--   3) el par (agencia, anunciante) ya existe en crm_company_links
--      (primero se vinculan las empresas, luego se asignan sus contactos).
-- Sin filas = sin asignación declarada (no se asume "atiende a todos").
-- Solo ADD (sin DROP): no aplica la política de DROP seguro.

create table if not exists crm_contact_accounts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references sys_stores (id) on delete cascade,
  contact_id uuid not null references crm_contacts (id) on delete cascade,
  agency_company_id uuid not null references crm_companies (id) on delete cascade,
  advertiser_company_id uuid not null references crm_companies (id) on delete cascade,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (agency_company_id <> advertiser_company_id)
);

-- Un contacto no duplica la misma cuenta (la agencia va implícita en el par).
create unique index if not exists crm_contact_accounts_store_contact_adv_uidx
  on crm_contact_accounts (store_id, contact_id, advertiser_company_id);
create index if not exists crm_contact_accounts_store_contact_idx
  on crm_contact_accounts (store_id, contact_id);
create index if not exists crm_contact_accounts_store_advertiser_idx
  on crm_contact_accounts (store_id, advertiser_company_id);

-- Requisito para FKs compuestas futuras (convención 20261213).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crm_contact_accounts_store_uq') then
    alter table crm_contact_accounts add constraint crm_contact_accounts_store_uq unique (store_id, id);
  end if;
end $$;

-- Same-store compuesto (convención 20261213): imposible colgar una cuenta
-- a contacto o empresas de otro tenant. Check-only; el borrado lo gobierna CASCADE.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crm_contact_accounts_contact_same_store_fk') then
    alter table crm_contact_accounts add constraint crm_contact_accounts_contact_same_store_fk
      foreign key (store_id, contact_id) references crm_contacts (store_id, id)
      on update cascade on delete no action;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crm_contact_accounts_agency_same_store_fk') then
    alter table crm_contact_accounts add constraint crm_contact_accounts_agency_same_store_fk
      foreign key (store_id, agency_company_id) references crm_companies (store_id, id)
      on update cascade on delete no action;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crm_contact_accounts_advertiser_same_store_fk') then
    alter table crm_contact_accounts add constraint crm_contact_accounts_advertiser_same_store_fk
      foreign key (store_id, advertiser_company_id) references crm_companies (store_id, id)
      on update cascade on delete no action;
  end if;
end $$;

drop trigger if exists crm_contact_accounts_updated_at on crm_contact_accounts;
create trigger crm_contact_accounts_updated_at
  before update on crm_contact_accounts
  for each row execute function sys_set_updated_at();

alter table crm_contact_accounts enable row level security;

drop policy if exists tenant_isolation on crm_contact_accounts;
create policy tenant_isolation on crm_contact_accounts
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
