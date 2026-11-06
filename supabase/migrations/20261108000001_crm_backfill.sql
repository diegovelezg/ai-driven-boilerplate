-- Backfill CRM desde customers (B2B-only). Idempotente: re-ejecutable sin duplicar.
-- 1 empresa por (store, nombre normalizado) desde la company efectiva
-- (manual_edits.company_name ?? company_name). Rol `customer` + 1 contacto por
-- customer con empresa. Principal = mayor total_spent por empresa.
-- No toca customers/orders (motor intacto).
-- OJO: 3 statements separados (no un solo WITH): los CTEs data-modifying
-- comparten snapshot con el query principal y no verían sus propias filas.

-- Empresa efectiva por customer: override manual > base.
-- 1) Empresas.
with eff as (
  select
    c.store_id,
    nullif(btrim(regexp_replace(
      coalesce(nullif(c.manual_edits->>'company_name', ''), c.company_name, ''), '\s+', ' ', 'g'
    ), ''), '') as company_display,
    nullif(btrim(c.email), '') as email,
    nullif(btrim(c.country), '') as country,
    c.total_spent
  from customers c
),
named as (
  select e.*, lower(e.company_display) as gkey
  from eff e
  where e.company_display is not null
),
ranked as (
  -- rn = 1: fila de mayor gasto del grupo (display).
  select n.*,
    row_number() over (
      partition by n.store_id, n.gkey
      order by n.total_spent desc nulls last
    ) as rn
  from named n
),
grp as (
  select distinct on (r.store_id, r.gkey)
    r.store_id, r.gkey, r.company_display as name
  from ranked r
  order by r.store_id, r.gkey, r.rn
),
-- Dominio de la empresa: moda de dominios de email del grupo, solo si está
-- en `domains` como negocio/institucional (evita webmails como "empresa").
grp_domain as (
  select distinct on (n.store_id, n.gkey)
    n.store_id, n.gkey, lower(split_part(n.email, '@', 2)) as domain
  from named n
  join domains d
    on d.domain = lower(split_part(n.email, '@', 2))
    and d.domain_type in ('business', 'institutional')
  where n.email like '%@%.%'
  group by n.store_id, n.gkey, lower(split_part(n.email, '@', 2))
  order by n.store_id, n.gkey, count(*) desc
),
-- País moda del grupo (puede ser null).
grp_country as (
  select distinct on (n.store_id, n.gkey)
    n.store_id, n.gkey, n.country
  from named n
  where n.country is not null
  group by n.store_id, n.gkey, n.country
  order by n.store_id, n.gkey, count(*) desc
)
insert into companies (store_id, name, domain, country, notes)
select g.store_id, g.name, gd.domain, gc.country, 'Backfill desde customers (ecommerce)'
from grp g
left join grp_domain gd on gd.store_id = g.store_id and gd.gkey = g.gkey
left join grp_country gc on gc.store_id = g.store_id and gc.gkey = g.gkey
where not exists (
  select 1 from companies c2
  where c2.store_id = g.store_id and lower(c2.name) = g.gkey
);

-- 2) Toda empresa backfilleada es cliente (compró por ecommerce).
insert into company_roles (store_id, company_id, role, notes)
select c.store_id, c.id, 'customer', 'Backfill: compradora por ecommerce'
from companies c
where c.notes = 'Backfill desde customers (ecommerce)'
  and not exists (
    select 1 from company_roles r
    where r.company_id = c.id and r.role = 'customer' and r.valid_to is null
  );

-- 3) 1 contacto por customer con empresa (con email o teléfono).
-- Principal = mayor gasto del grupo, solo si la empresa aún no tiene uno.
with eff as (
  select
    c.store_id,
    nullif(btrim(regexp_replace(
      coalesce(nullif(c.manual_edits->>'company_name', ''), c.company_name, ''), '\s+', ' ', 'g'
    ), ''), '') as company_display,
    coalesce(nullif(c.manual_edits->>'first_name', ''), c.first_name) as first_name,
    coalesce(nullif(c.manual_edits->>'last_name', ''), c.last_name) as last_name,
    nullif(btrim(c.email), '') as email,
    coalesce(nullif(c.manual_edits->>'phone', ''), c.phone) as phone,
    c.total_spent
  from customers c
),
named as (
  select e.*, lower(e.company_display) as gkey
  from eff e
  where e.company_display is not null
),
ranked as (
  select n.*,
    row_number() over (
      partition by n.store_id, n.gkey
      order by n.total_spent desc nulls last
    ) as rn
  from named n
),
-- Una empresa canónica por grupo (la de menor id: join determinístico).
co_pick as (
  select distinct on (c.store_id, lower(c.name))
    c.store_id, lower(c.name) as gkey, c.id as company_id
  from companies c
  order by c.store_id, lower(c.name), c.id
)
insert into contacts (store_id, company_id, first_name, last_name, email, phone, is_primary, notes)
select
  n.store_id,
  p.company_id,
  nullif(btrim(coalesce(n.first_name, '')), ''),
  nullif(btrim(coalesce(n.last_name, '')), ''),
  n.email,
  nullif(btrim(coalesce(n.phone, '')), ''),
  n.rn = 1
    and not exists (select 1 from contacts k where k.company_id = p.company_id and k.is_primary),
  'Backfill desde customers (ecommerce)'
from ranked n
join co_pick p on p.store_id = n.store_id and p.gkey = n.gkey
where (n.email is not null or nullif(btrim(coalesce(n.phone, '')), '') is not null)
  and not exists (
    select 1 from contacts k
    where k.store_id = n.store_id
      and k.company_id = p.company_id
      and coalesce(lower(k.email), '') = coalesce(lower(n.email), '')
      and coalesce(k.phone, '') = coalesce(nullif(btrim(coalesce(n.phone, '')), ''), '')
  );
