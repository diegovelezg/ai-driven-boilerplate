-- Auth de merchants + RLS por tenant (Fase 3 inicio).
-- merchant_users = qué auth.users ve cada store. La membresía la gestiona
-- service_role (sin policies de escritura para authenticated: nadie se auto-agrega).
-- Tablas con store_id: aislamiento total. messages cuelga de conversations.
-- domains / vertical_profiles son globales por diseño: lectura para
-- authenticated, escritura solo service_role (sin policy de escritura = denegada).

create table merchant_users (
  store_id uuid not null references stores (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);
create index merchant_users_user_idx on merchant_users (user_id);

alter table merchant_users enable row level security;

-- Helper estable para policies (evita recursión RLS: merchant_users también tiene RLS).
create or replace function public.is_store_member(sid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from merchant_users
    where store_id = sid and user_id = auth.uid()
  )
$$;

-- El merchant ve sus propias membresías (para resolver ?store= y el login).
create policy merchant_users_self_read on merchant_users
  for select to authenticated using (user_id = auth.uid());

-- Aislamiento por tenant: todas las tablas con store_id directo.
create policy tenant_isolation on stores
  for all to authenticated using (public.is_store_member(id)) with check (public.is_store_member(id));
create policy tenant_isolation on channels
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on market_regions
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on customers
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on orders
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on customer_aliases
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on background_runs
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on churn_signals
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on proposed_actions
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on proposed_leads
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on store_profiles
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy tenant_isolation on conversations
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));

-- messages no tiene store_id: hereda vía su conversación.
create policy tenant_isolation on messages
  for all to authenticated
  using (
    exists (
      select 1 from conversations c
      where c.id = conversation_id and public.is_store_member(c.store_id)
    )
  )
  with check (
    exists (
      select 1 from conversations c
      where c.id = conversation_id and public.is_store_member(c.store_id)
    )
  );

-- Globales: lectura para merchants autenticados, escritura solo service_role.
create policy global_read on domains
  for select to authenticated using (true);
create policy global_read on vertical_profiles
  for select to authenticated using (true);
