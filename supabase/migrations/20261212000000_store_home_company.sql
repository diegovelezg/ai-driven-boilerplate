-- sys_stores.home_company_id: empresa propia de la cuenta (operadora).
-- Dato configurado: qué compañía es "la casa" para defaults (p. ej. filtro
-- de proveedor en Ocupación). NULL = sin configurar (default = todos).
alter table sys_stores add column if not exists home_company_id uuid references crm_companies (id) on delete set null;

-- Backfill no destructivo: solo NULLs, match exacto insensible a mayúsculas
-- entre tienda y compañía proveedora del mismo tenant.
update sys_stores s
set home_company_id = m.id
from (
  select distinct on (c.store_id) c.store_id, c.id
  from crm_companies c
  join sys_stores s2 on s2.id = c.store_id
  where c.kind = 'proveedor' and lower(btrim(c.name)) = lower(btrim(s2.name))
  order by c.store_id, c.name
) m
where s.id = m.store_id and s.home_company_id is null;
