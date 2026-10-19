-- Market Ecuador (EC, USD) por tienda + backfill de país.
-- Contexto: TuPantalla opera PE (PEN) + MX (MXN); EC (USD, dólar) entra como
-- tercer mercado. El sync crea markets desde Medusa regions, pero la fila EC
-- debe existir aunque Medusa aún no exponga la región: source='manual' no es
-- pisada por el sync (upsert por store_id,source,source_id).
-- Idempotente: ON CONFLICT DO NOTHING + updates solo donde country is null.

-- 1) Fila EC por cada store existente.
insert into market_regions (store_id, source, source_id, name, currency, countries)
select s.id, 'manual', 'EC', 'EC', 'usd', array['EC']
from stores s
on conflict (store_id, source, source_id) do nothing;

-- 2) Órdenes del market EC sin país (las que lleguen por sync/manual).
update orders o
set country = 'EC'
from market_regions m
where o.market_id = m.id
  and m.source_id = 'EC'
  and o.country is null;

-- 3) Customers con órdenes EC reales (misma regla que 20261016000019:
-- sin test, sin canceladas/archivadas, sin pago fallido) y sin país.
update customers c
set country = agg.top_country
from (
  select customer_id, country as top_country
  from (
    select customer_id, country,
      row_number() over (partition by customer_id order by count(*) desc, country asc) as rn
    from orders
    where country = 'EC'
      and coalesce(is_test, false) = false
      and coalesce(lower(status), '') not in ('canceled', 'cancelled', 'archived', 'requires_action')
      and coalesce(lower(payment_status), '') not in ('canceled', 'cancelled', 'failed')
    group by customer_id, country
  ) ranked
  where rn = 1
) agg
where c.id = agg.customer_id
  and c.country is null;
