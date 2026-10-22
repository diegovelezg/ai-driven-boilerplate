-- Bootstrap multiuser por tenant (fail-closed en app desde multiuser).
-- Usuarios autenticados SIN membresía heredan las tiendas existentes: eso
-- equivale al acceso que tenían con el bypass legacy de la app (ver
-- `web/lib/api/guard.ts`). Idempotente (ON CONFLICT DO NOTHING) y solo
-- afecta a usuarios sin NINGUNA membresía: no toca asignaciones existentes
-- ni a tenants creados después (esos se asignan explícitamente).
insert into public.merchant_users (store_id, user_id)
select s.id, u.id
from auth.users u
cross join public.stores s
where not exists (
  select 1 from public.merchant_users m where m.user_id = u.id
)
on conflict (store_id, user_id) do nothing;
