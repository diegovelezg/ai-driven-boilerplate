-- Roles por membresía (B2B): owner > admin > seller > viewer.
-- Base para separar features por rol más adelante (FEATURE_MIN_ROLE en lib/roles.ts).
-- Bootstrap: el miembro más antiguo de cada tienda pasa a owner; el resto, seller.
alter table merchant_users add column if not exists role text not null default 'seller';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'merchant_users_role_check') then
    alter table merchant_users add constraint merchant_users_role_check check (role in ('owner', 'admin', 'seller', 'viewer'));
  end if;
end $$;

-- El miembro más antiguo de cada tienda es el owner inicial.
update merchant_users m
set role = 'owner'
where m.created_at = (select min(m2.created_at) from merchant_users m2 where m2.store_id = m.store_id)
  and m.role is distinct from 'owner';

-- Rol del usuario actual en una tienda (para RLS futura y checks app).
create or replace function public.my_store_role(sid uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from merchant_users
  where store_id = sid and user_id = auth.uid()
  limit 1
$$;
