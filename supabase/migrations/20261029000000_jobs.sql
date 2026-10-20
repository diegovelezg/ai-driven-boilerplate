-- Jobs garantizados sin depender del login (issue #24).
-- Web encola, scheduler programa, worker ejecuta. Postgres como queue
-- transaccional (sin Redis): claim con FOR UPDATE SKIP LOCKED, retries con
-- backoff exponencial + DLQ (`dead`), idempotencia por
-- (store_id, idempotency_key).
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores (id) on delete cascade,
  kind text not null
    check (kind in ('sync', 'morning', 'enrichment', 'scout', 'strategist', 'copywriter', 'prospect')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'error', 'dead')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_id uuid null,
  idempotency_key text null,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null,
  last_error text null
);

-- Un job diario por store: el segundo insert del día es no-op.
create unique index if not exists jobs_store_idempotency_uniq
  on jobs (store_id, idempotency_key)
  where idempotency_key is not null;

-- Poll del worker: queued/error listos, más viejos primero.
create index if not exists jobs_claim_idx
  on jobs (status, available_at, created_at)
  where status in ('queued', 'error');

-- RLS: lectura por membresía (cinta/observabilidad); escritura solo
-- service_role (bypassa RLS). Sin policies de escritura para authenticated.
alter table jobs enable row level security;

drop policy if exists jobs_member_read on jobs;
create policy jobs_member_read on jobs
  for select to authenticated using (public.is_store_member(store_id));

-- Claim atómico para N workers concurrentes (SKIP LOCKED evita doble
-- ejecución; el idempotency_key del día evita duplicados lógicos).
create or replace function public.claim_next_job(p_kinds text[] default null)
returns jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v jobs%rowtype;
begin
  select * into v
  from jobs
  where status in ('queued', 'error')
    and available_at <= now()
    and (p_kinds is null or kind = any (p_kinds))
  order by available_at asc, created_at asc
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update jobs
  set status = 'running',
      attempts = v.attempts + 1,
      started_at = coalesce(v.started_at, now()),
      updated_at = now()
  where id = v.id
  returning * into v;

  return v;
end;
$$;

-- Solo el worker (service_role) claimea: por defecto las funciones son
-- ejecutables por PUBLIC (cualquier authenticated/anon las llamaría vía
-- PostgREST: robo de ejecución y spam cross-tenant).
revoke all on function public.claim_next_job(text[]) from public, anon, authenticated;
grant execute on function public.claim_next_job(text[]) to service_role;

-- Scheduler diario por tenant (pg_cron vive en self-hosted/Coolify, no en el
-- CLI local): encola 1 `morning` por store con idempotency del día.
-- No corre automáticamente al migrar; programarlo una vez en la DB de prod:
--   select cron.schedule('morning-daily', '0 11 * * *', $$select public.enqueue_daily_morning()$$);
-- 11:00 UTC = 06:00 America/Lima (sin DST). Ver docs/coolify.md §8.
create or replace function public.enqueue_daily_morning()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  day_key text := 'morning-' || to_char((now() at time zone 'America/Lima'), 'YYYY-MM-DD');
begin
  with ins as (
    insert into jobs (store_id, kind, idempotency_key, payload)
    select id, 'morning', day_key, jsonb_build_object('date', to_char((now() at time zone 'America/Lima'), 'YYYY-MM-DD'))
    from stores
    on conflict (store_id, idempotency_key) where idempotency_key is not null do nothing
    returning 1
  )
  select count(*) into n from ins;
  return n;
end;
$$;

-- Solo pg_cron (vía postgres) y el worker (service_role) programan el diario:
-- la función es SECURITY DEFINER e inserta para TODOS los stores (bypassa
-- RLS), así que no debe ser ejecutable por authenticated/anon.
revoke all on function public.enqueue_daily_morning() from public, anon, authenticated;
grant execute on function public.enqueue_daily_morning() to service_role, postgres;
