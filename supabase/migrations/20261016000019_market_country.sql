-- País atribuido por mercado + backfill desde markets.
-- Contexto: Medusa v1/v2 y Shopify exponen el país en lugares distintos
-- (shipping/billing country_code, market.countries, region name); el sync
-- resuelve un ISO2 canónico por orden (ver resolveOrderCountry en
-- web/lib/medusa.ts) y la moda por customer. Esta migración:
-- 1) añade customers.country (ISO2 atribuido, null = sin compras/sin país),
-- 2) rellena orders.country donde el market lo identifica (countries=[XX]
--    o nombre ISO2 de 2 letras como "PE"/"MX"),
-- 3) rellena customers.country con la moda de sus órdenes.

alter table customers add column if not exists country text;

-- País implícito del market: countries con un único ISO2 válido, si no
-- nombre ISO2 de 2 letras (convención Medusa/Shopify "PE", "MX", "CL"...).
-- Nunca se escribe un valor no-ISO2 (misma regla que resolveOrderCountry).
create or replace function implicit_market_country(
  mkt_countries text[],
  mkt_name text
) returns text language plpgsql immutable as $$
begin
  if array_length(mkt_countries, 1) = 1 and upper(mkt_countries[1]) ~ '^[A-Z]{2}$' then
    return upper(mkt_countries[1]);
  end if;
  if mkt_name ~ '^[A-Za-z]{2}$' then
    return upper(mkt_name);
  end if;
  return null;
end $$;

-- 2) Órdenes sin país pero con market identificable (idempotente).
update orders o
set country = implicit_market_country(m.countries, m.name)
from market_regions m
where o.market_id = m.id
  and o.country is null
  and implicit_market_country(m.countries, m.name) is not null;

-- 3) Customers: moda del país de sus ÓRDENES REALES (misma regla que el
-- sync: sin test, sin canceladas/archivadas, sin pago fallido). Un customer
-- con solo órdenes de prueba queda null = comodín (se ve en todo filtro).
update customers c
set country = agg.top_country
from (
  select customer_id, country as top_country
  from (
    select customer_id, country,
      row_number() over (partition by customer_id order by count(*) desc, country asc) as rn
    from orders
    where country is not null
      and coalesce(is_test, false) = false
      and coalesce(lower(status), '') not in ('canceled', 'cancelled', 'archived', 'requires_action')
      and coalesce(lower(payment_status), '') not in ('canceled', 'cancelled', 'failed')
    group by customer_id, country
  ) ranked
  where rn = 1
) agg
where c.id = agg.customer_id
  and (c.country is null or c.country is distinct from agg.top_country);

create index if not exists customers_store_country_idx on customers (store_id, country);

drop function if exists implicit_market_country(text[], text);
