-- Re-backfill de sys_stores.home_company_id (empresa propia del tenant).
-- El backfill original (20261212) solo cubrió las compañías existentes en ese
-- momento; las creadas después (p. ej. "Smart Media" como proveedor de su
-- propio tenant) quedaron con home_company_id NULL y el default de proveedor
-- (Inventario/Ocupación) degradaba a "todos" en vez de la empresa propia.
-- Solo UPDATE de NULLs (idempotente, sin DROP): el trigger
-- sys_stores_home_company_same_store valida el same-store.
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
