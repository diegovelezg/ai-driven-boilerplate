-- Reparación 0019: la moda inicial contó órdenes TEST e inválidas.
-- 13 customers quedaron mal atribuidos (12 con 0 compras reales con país,
-- 1 volteado por votos de prueba). Esta migración recalcula con la regla
-- del sync (solo reales) y refresca lo desnormalizado (señales, acciones,
-- leads) desde customers.country. En BDs frescas es no-op (0019 ya es
-- estricta): existe para las ya rellenadas con la regla laxa.

-- 1) Sin órdenes reales → null (comodín, se ven en todo filtro).
update customers c
set country = null
where c.country is not null
  and not exists (
    select 1 from orders o
    where o.customer_id = c.id
      and o.country is not null
      and coalesce(o.is_test, false) = false
      and coalesce(lower(o.status), '') not in ('canceled', 'cancelled', 'archived', 'requires_action')
      and coalesce(lower(o.payment_status), '') not in ('canceled', 'cancelled', 'failed')
  );

-- 2) Moda real para todos (corrige volteados por votos de prueba).
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
  and c.country is distinct from agg.top_country;

-- 3) Refresca lo desnormalizado (is distinct from cubre nulls en ambos sentidos).
update churn_signals s
set country = c.country
from customers c
where s.customer_id = c.id
  and s.country is distinct from c.country;

update proposed_actions a
set country = c.country
from customers c
where a.customer_id = c.id
  and a.country is distinct from c.country;

update proposed_leads l
set country = agg.top_country
from (
  select lead_id, country as top_country
  from (
    select l2.id as lead_id,
      c.country,
      row_number() over (partition by l2.id order by count(*) desc, c.country asc) as rn
    from proposed_leads l2
    join lateral (
      select s.value ->> 'domain' as domain
      from jsonb_array_elements(
        case when jsonb_typeof(coalesce(l2.evidence_json, '{}'::jsonb) -> 'similar') = 'array'
          then coalesce(l2.evidence_json, '{}'::jsonb) -> 'similar'
          else '[]'::jsonb
        end
      ) s
    ) refs on refs.domain is not null and refs.domain <> ''
    join customers c on c.store_id = l2.store_id
      and lower(split_part(c.email, '@', 2)) = lower(refs.domain)
      and c.country is not null
    group by l2.id, c.country
  ) ranked
  where rn = 1
) agg
where l.id = agg.lead_id
  and l.country is distinct from agg.top_country;
