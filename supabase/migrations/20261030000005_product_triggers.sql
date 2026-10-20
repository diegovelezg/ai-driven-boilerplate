-- Hardening products/product_stats (review P2-2, P1-1):
-- 1. is_active es derivado: se recalcula en CUALQUIER update (antes solo al
--    cambiar platform_status/override, y un update directo lo divergía).
-- 2. Co-tenancy: product_stats.store_id debe igualar products.store_id.
create or replace function set_product_is_active()
returns trigger language plpgsql as $$
begin
  new.is_active := coalesce(
    new.is_active_override,
    not (lower(coalesce(new.platform_status, '')) in (
      'draft', 'proposed', 'rejected', 'inactive',
      'archived', 'disabled', 'deleted'
    ))
  );
  return new;
end $$;
drop trigger if exists products_is_active on products;
create trigger products_is_active
  before insert or update on products
  for each row execute function set_product_is_active();

create or replace function check_product_stats_tenancy()
returns trigger language plpgsql as $$
declare
  v_store uuid;
begin
  select store_id into v_store from products where id = new.product_id;
  if v_store is null or v_store <> new.store_id then
    raise exception 'product_stats cross-tenant: % no es de %', new.product_id, new.store_id;
  end if;
  return new;
end $$;
drop trigger if exists product_stats_tenancy on product_stats;
create trigger product_stats_tenancy
  before insert or update of product_id, store_id on product_stats
  for each row execute function check_product_stats_tenancy();
