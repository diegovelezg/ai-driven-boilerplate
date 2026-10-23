-- Log explícito de decisiones de sync en login (debug multi-tenant).
-- Hoy las omisiones (`sync-reciente`, `run-en-curso`, `sin-conexion`...) solo
-- quedaban en `.data/sync.log` (efímero en contenedores) y consola: en prod es
-- imposible responder "¿por qué la tienda B no sincronizó a las 11:00?".
-- Esta tabla lo persiste por tienda (service_role la escribe, best-effort).
create table login_sync_decisions (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid references stores (id) on delete cascade,
  user_id           uuid,
  sync              boolean not null,
  reason            text not null,
  has_running       boolean not null default false,
  last_sync_done_at timestamptz,
  omit_detail       text,
  created_at        timestamptz not null default now()
);

alter table login_sync_decisions enable row level security;
create index login_sync_decisions_store_created_idx
  on login_sync_decisions (store_id, created_at desc);

-- Lectura por tenant (la escritura la hace service_role, que bypasa RLS).
create policy tenant_isolation on login_sync_decisions
  for all to authenticated
  using (store_id is not null and public.is_store_member(store_id))
  with check (store_id is not null and public.is_store_member(store_id));
