-- Opción B: intermediaria como empresa vinculada (trazable + % heredado).
-- `agency_company_id` gana al texto libre (`intermediary_name`) en PDF y ficha.
-- Comisión efectiva (ver lib/agency-commission.ts): override `commission_pct`
-- > default de la intermediaria > (billing si es agencia) > 0. Solo informativa.
alter table io_orders
  add column if not exists agency_company_id uuid references crm_companies (id) on delete set null;

create index if not exists io_orders_store_agency_idx on io_orders (store_id, agency_company_id);

-- Same-store compuesto (convención 20261213): imposible colgar la orden a
-- una agencia de otro tenant. Check-only; el borrado lo gobierna SET NULL.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'io_orders_agency_same_store_fk') then
    alter table io_orders add constraint io_orders_agency_same_store_fk
      foreign key (store_id, agency_company_id) references crm_companies (store_id, id)
      on update cascade on delete no action;
  end if;
end $$;
