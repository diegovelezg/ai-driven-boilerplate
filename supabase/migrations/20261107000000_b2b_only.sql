-- Sistema B2B-only: todo customer es empresa, todo tenant vende a empresas.
-- El sync nunca escribió customer_type (solo classify), así que el CHECK es seguro.
alter table customers alter column customer_type set default 'B2B';
update customers set customer_type = 'B2B' where customer_type is distinct from 'B2B';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_customer_type_b2b') then
    alter table customers add constraint customers_customer_type_b2b check (customer_type = 'B2B');
  end if;
end $$;

-- Perfiles: defaults y datos a B2B (se dejan los CHECKs permisivos por compat;
-- la capa app solo ofrece B2B). company_required pasa a true por defecto.
alter table store_profiles alter column business_model set default 'b2b';
alter table store_profiles alter column archetype set default 'b2b_recurrente';
alter table store_profiles alter column company_required set default true;
update store_profiles set business_model = 'b2b' where business_model is distinct from 'b2b';
update store_profiles set archetype = 'b2b_recurrente' where archetype in ('b2c_consumible', 'hibrido');
update store_profiles set archetype = 'b2b_proyecto' where archetype in ('b2c_moda', 'b2c_durable');
update store_profiles set company_required = true where company_required is distinct from true;
